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
  sourcePath?: string;
  accessPoint?: efs.IAccessPoint;
  readOnly?: boolean;
}

interface Ec2ServiceBaseProps {
  serviceName?: string;
  cpu?: number;
  memoryLimitMiB?: number;
  cluster: ecs.ICluster;
  containerOptions: Omit<ecs.ContainerDefinitionOptions, 'portMappings'|'logging'>;
  securityGroup?: ec2.ISecurityGroup;
  desiredCount?: number;
  daemon?: boolean;
  enableExecuteCommand?: boolean;
}

interface WorkerEc2ServiceProps extends Ec2ServiceBaseProps {}

interface HttpEc2ServiceProps extends Ec2ServiceBaseProps {
  containerPort: number;
}

class Ec2ServiceBase extends Construct {

  /**
   * The name of the service used for ECS Service Connect and CloudMap.
   */
  public readonly serviceName: string;

  /**
   * The security group for this construct.
   */
  public readonly securityGroup: ec2.ISecurityGroup;

  /**
   * The Ec2 service in this construct.
   */
  public readonly service: ecs.Ec2Service;

  /**
   * The Ec2 task definition in this construct.
   */
  public readonly taskDefinition: ecs.Ec2TaskDefinition;

  /**
   * The logging driver for all containers in this construct.
   */
  public readonly logDriver: ecs.LogDriver;

  constructor(scope: Construct, id: string, props: Ec2ServiceBaseProps) {
    super(scope, id);

    this.serviceName = props.serviceName || id.toLowerCase();
    const { cluster, containerOptions } = props;

    const memoryLimitMiB = props.memoryLimitMiB ?? 512;

    this.securityGroup = props.securityGroup ?? new ec2.SecurityGroup(this, 'SecurityGroup', { vpc: cluster.vpc });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.logDriver = new ecs.AwsLogDriver({ logGroup, streamPrefix: 'ecs' });

    this.taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    const containerName = containerOptions.containerName ?? 'app';
    const container = this.taskDefinition.addContainer(containerName, {
      ...containerOptions,
      cpu: props.cpu,
      memoryLimitMiB: memoryLimitMiB,
      logging: this.logDriver,
    });
    container.addUlimits({ name: ecs.UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536 });

    this.service = new ecs.Ec2Service(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      securityGroups: [this.securityGroup],
      circuitBreaker: { rollback: true },
      enableECSManagedTags: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      enableExecuteCommand: props.enableExecuteCommand,
      desiredCount: props.desiredCount,
      daemon: props.daemon,
    });
  }

  //enableServiceConnect(portMappingName?: string) {
  //  const services: ecs.ServiceConnectService[] = [];
  //  if (typeof portMappingName == 'string') {
  //    services.push({
  //      portMappingName,
  //      discoveryName: this.serviceName,
  //      dnsName: this.serviceName,
  //    });
  //  }
  //  this.service.enableServiceConnect({
  //    services,
  //    logDriver: this.logDriver,
  //  });
  //}

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
    const accessPoint = volume.accessPoint;
    if (typeof accessPoint != 'undefined') {
      const fileSystem = accessPoint.fileSystem;
      this.taskDefinition.addVolume({
        name: volumeName,
        efsVolumeConfiguration: {
          fileSystemId: fileSystem.fileSystemId,
          authorizationConfig: {
            accessPointId: accessPoint.accessPointId,
          },
          transitEncryption: 'ENABLED',
          rootDirectory: '/',
        },
      });
      this.service.connections.allowToDefaultPort(fileSystem);
    } else {
      this.taskDefinition.addVolume({
        name: volumeName,
        host: {
          sourcePath: volume.sourcePath,
        },
      });
    }
    this.taskDefinition.defaultContainer?.addMountPoints({
      containerPath: volume.containerPath,
      sourceVolume: volumeName,
      readOnly: volume.readOnly ?? false,
    });
  }
}

export class WorkerEc2Service extends Ec2ServiceBase {

  /**
   * The security groups which manage the allowed network traffic for the service.
   */
  public readonly connections: ec2.Connections;

  constructor(scope: Construct, id: string, props: WorkerEc2ServiceProps) {
    super(scope, id, props);

    this.connections = new ec2.Connections({
      securityGroups: [this.securityGroup],
    });
  }
}

export class HttpEc2Service extends Ec2ServiceBase {

  /**
   * The security groups which manage the allowed network traffic for the service.
   */
  public readonly connections: ec2.Connections;

  /**
   * The CloudMap service endpoint.
   */
  public readonly endpoint: Endpoint;

  constructor(scope: Construct, id: string, props: HttpEc2ServiceProps) {
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
