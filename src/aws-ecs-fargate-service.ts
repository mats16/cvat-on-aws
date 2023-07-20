import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudMap from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

interface Volume {
  containerPath: string;
  accessPoint: efs.IAccessPoint;
  readOnly?: boolean;
}

interface FargateServiceBaseProps {
  serviceName?: string;
  cpu?: number;
  memoryLimitMiB?: number;
  cluster: ecs.ICluster;
  containerOptions: Omit<ecs.ContainerDefinitionOptions, 'portMappings'|'logging'>;
  securityGroup?: ec2.ISecurityGroup;
  desiredCount?: number;
  cpuArchitecture?: ecs.CpuArchitecture;
  //enableServiceConnect?: boolean;
  enableExecuteCommand?: boolean;
}

interface WorkerFargateServiceProps extends FargateServiceBaseProps {}

interface HttpFargateServiceProps extends FargateServiceBaseProps {
  containerPort: number;
}

class FargateServiceBase extends Construct {

  /**
   * The name of the service used for ECS Service Connect and CloudMap.
   */
  public readonly serviceName: string;

  /**
   * The security group for this construct.
   */
  public readonly securityGroup: ec2.ISecurityGroup;

  /**
   * The Fargate service in this construct.
   */
  public readonly service: ecs.FargateService;

  /**
   * The Fargate task definition in this construct.
   */
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  /**
   * The logging driver for all containers in this construct.
   */
  public readonly logDriver: ecs.LogDriver;

  constructor(scope: Construct, id: string, props: FargateServiceBaseProps) {
    super(scope, id);

    this.serviceName = props.serviceName || id.toLowerCase();
    const cpu = props.cpu ?? 512;
    const memoryLimitMiB = props.memoryLimitMiB ?? 1024;
    const { cluster, containerOptions, cpuArchitecture } = props;

    this.securityGroup = props.securityGroup ?? new ec2.SecurityGroup(this, 'SecurityGroup', { vpc: cluster.vpc });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.logDriver = new ecs.AwsLogDriver({ logGroup, streamPrefix: 'ecs' });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      runtimePlatform: { cpuArchitecture },
      cpu,
      memoryLimitMiB,
    });

    const containerName = containerOptions.containerName ?? 'app';
    const container = this.taskDefinition.addContainer(containerName, {
      ...containerOptions,
      logging: this.logDriver,
    });
    container.addUlimits({ name: ecs.UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536 });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      securityGroups: [this.securityGroup],
      circuitBreaker: { rollback: true },
      enableECSManagedTags: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      enableExecuteCommand: props.enableExecuteCommand,
      desiredCount: props.desiredCount,
    });
  }

  enableCloudMap(containerPort: number) {
    const cloudMapService = this.service.enableCloudMap({
      name: this.serviceName,
      containerPort,
      dnsRecordType: cloudMap.DnsRecordType.SRV,
      dnsTtl: cdk.Duration.seconds(10),
    });
    (cloudMapService.node.defaultChild as cloudMap.CfnService).addPropertyOverride('DnsConfig.DnsRecords.1', { Type: 'A', TTL: 10 });

    const dnsName = `${cloudMapService.serviceName}.${cloudMapService.namespace.namespaceName}`;
    const endpoint = new Endpoint(dnsName, containerPort);
    return endpoint;
  }

  addVolume(volumeName: string, volume: Volume) {
    const fileSystem = volume.accessPoint.fileSystem;
    const accessPointId = volume.accessPoint.accessPointId;
    this.taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        authorizationConfig: { accessPointId },
        transitEncryption: 'ENABLED',
        rootDirectory: '/',
      },
    });
    this.taskDefinition.defaultContainer?.addMountPoints({
      containerPath: volume.containerPath,
      sourceVolume: volumeName,
      readOnly: volume.readOnly ?? false,
    });
    this.service.connections.allowToDefaultPort(fileSystem);
  }
}

export class WorkerFargateService extends FargateServiceBase {

  /**
   * The security groups which manage the allowed network traffic for the service.
   */
  public readonly connections: ec2.Connections;

  /** Job Worker with Fargate Spot */
  constructor(scope: Construct, id: string, props: WorkerFargateServiceProps) {
    super(scope, id, props);

    (this.service.node.defaultChild as ecs.CfnService).capacityProviderStrategy = [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }];

    this.connections = new ec2.Connections({
      securityGroups: [this.securityGroup],
    });
  }
}

export class HttpFargateService extends FargateServiceBase {

  /**
   * The security groups which manage the allowed network traffic for the service.
   */
  public readonly connections: ec2.Connections;

  /**
   * The CloudMap service endpoint.
   */
  public readonly endpoint: Endpoint;

  /** HTTP Service */
  constructor(scope: Construct, id: string, props: HttpFargateServiceProps) {
    super(scope, id, props);

    const containerPort = props.containerPort;

    const defaultContainer = this.taskDefinition.defaultContainer!;

    const portMappingName = 'http';
    defaultContainer.addPortMappings({
      containerPort,
      name: portMappingName,
      appProtocol: ecs.AppProtocol.http,
    });

    this.endpoint = this.enableCloudMap(containerPort);

    this.connections = new ec2.Connections({
      defaultPort: ec2.Port.tcp(containerPort),
      securityGroups: [this.securityGroup],
    });
  }

  modifyTargetGroup(healthCheck?: elb.HealthCheck) {
    const targetGroup = new elb.ApplicationTargetGroup(this, 'TargetGroup', {
      targetType: elb.TargetType.IP,
      protocol: elb.ApplicationProtocol.HTTP,
      port: this.endpoint.port,
      healthCheck,
      deregistrationDelay: cdk.Duration.seconds(30),
      vpc: this.service.cluster.vpc,
    });
    this.service.attachToApplicationTargetGroup(targetGroup);
    return targetGroup;
  }
}

class Endpoint {
  /**
   * The hostname of the endpoint
   */
  public readonly hostname: string;

  /**
   * The port of the endpoint
   */
  public readonly port: number;

  /**
   * The combination of "HOSTNAME:PORT" for this endpoint
   */
  public readonly socketAddress: string;

  constructor(address: string, port: number) {
    this.hostname = address;
    this.port = port;

    const portDesc = cdk.Token.isUnresolved(port) ? cdk.Token.asString(port) : port;
    this.socketAddress = `${address}:${portDesc}`;
  }
}
