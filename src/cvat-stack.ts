import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AuroraServerlessV2Cluster } from './aws-aurora-serverless-v2';
import { CloudFront } from './aws-cloudfront';
//import { WorkerEc2Service, HttpEc2Service } from './aws-ecs-ec2-service';
import { WorkerFargateService, HttpFargateService } from './aws-ecs-fargate-service';
import { RedisCluster } from './aws-elasticache';

interface CvatStackProps extends cdk.StackProps {
  cvatVersion?: string;
  multiAZ?: boolean;
}

export class CvatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CvatStackProps = {}) {
    super(scope, id, props);

    const cvatVersion = props.cvatVersion ?? 'dev';
    const multiAZ = props.multiAZ ?? false;

    const uiImage = ecs.ContainerImage.fromRegistry(`cvat/ui:${cvatVersion}`);
    const cvatImage = ecs.ContainerImage.fromAsset('./containers/cvat-server', {
      buildArgs: {
        CVAT_VERSION: 'dev',
      },
    });

    const googleSecret = new OauthSecret(this, 'GoogleOauthSecret', { idpName: 'Google' });
    const githubSecret = new OauthSecret(this, 'GitHubOauthSecret', { idpName: 'GitHub' });

    const oauthDisabled = new cdk.CfnCondition(this, 'OauthDisabled', {
      expression: cdk.Fn.conditionAnd(
        cdk.Fn.conditionEquals(googleSecret.clientId, ''),
        cdk.Fn.conditionEquals(googleSecret.clientSecret, ''),
        cdk.Fn.conditionEquals(githubSecret.clientId, ''),
        cdk.Fn.conditionEquals(githubSecret.clientSecret, ''),
      ),
    });

    const vpc = new ec2.Vpc(this, 'VPC', { natGateways: 1 });

    const db = new AuroraServerlessV2Cluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_14_5 }),
      instances: (multiAZ) ? 2 : 1,
      instanceProps: {
        enablePerformanceInsights: true,
        vpc,
      },
      storageEncrypted: true,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      defaultDatabaseName: 'cvat',
    });

    const redis = new RedisCluster(this, 'Redis', {
      version: '7.0',
      nodeType: 'cache.t4g.micro',
      nodeCount: (multiAZ) ? 2 : 1,
      vpc,
    });

    const fileSystem = new efs.FileSystem(this, 'FileSystem', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encrypted: true,
      throughputMode: efs.ThroughputMode.ELASTIC,
      vpc,
    });

    const dataAccessPoint = fileSystem.addAccessPoint('DataAccessPoint', {
      path: '/data',
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '0755' },
    });

    const shareAccessPoint = fileSystem.addAccessPoint('ShareAccessPoint', {
      path: '/share',
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '0755' },
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      containerInsights: true,
      enableFargateCapacityProviders: true,
      defaultCloudMapNamespace: {
        name: 'cvat.local',
      },
      vpc,
    });

    const loadBalancer = new elb.ApplicationLoadBalancer(this, 'LoadBalancer', { internetFacing: true, vpc });
    const cdn = new CloudFront(this, 'CDN', { originLoadBalancer: loadBalancer });

    const cvatServerless = new HttpFargateService(this, 'Serverless', {
      serviceName: 'serverless',
      cluster,
      containerOptions: {
        image: ecs.ContainerImage.fromAsset('./containers/cvat-serverless'),
      },
      containerPort: 8070,
    });
    cvatServerless.taskDefinition.taskRole.attachInlinePolicy(new iam.Policy(this, 'SageMakerPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: [
            'sagemaker:ListEndpoints',
            'sagemaker:ListModels',
            'sagemaker:DescribeEndpoint',
            'sagemaker:DescribeEndpointConfig',
            'sagemaker:DescribeModel',
          ],
          resources: ['*'],
        }),
      ],
    }));

    const cvatServer = new HttpFargateService(this, 'Server', {
      serviceName: 'server',
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      containerOptions: {
        image: cvatImage,
        command: ['-c', 'supervisord/server.conf'],
        environment: {
          CVAT_HOST: cdn.distribution.distributionDomainName,
          CVAT_BASE_URL: `https://${cdn.distribution.distributionDomainName}`,
          DJANGO_MODWSGI_EXTRA_ARGS: '',
          ALLOWED_HOSTS: '*',
          CVAT_REDIS_HOST: redis.clusterEndpoint.hostname,
          CVAT_POSTGRES_HOST: db.clusterEndpoint.hostname,
          ADAPTIVE_AUTO_ANNOTATION: 'false',
          IAM_OPA_BUNDLE: '1',
          // Oauth
          USE_ALLAUTH_SOCIAL_ACCOUNTS: cdk.Fn.conditionIf(oauthDisabled.logicalId, 'False', 'True').toString(),
          // Clam AntiVirus
          CLAM_AV: 'yes',
          // Automatic annotation
          CVAT_SERVERLESS: '1',
          CVAT_NUCLIO_HOST: cvatServerless.endpoint.hostname,
          CVAT_NUCLIO_PORT: cvatServerless.endpoint.port.toString(),
        },
        secrets: {
          CVAT_POSTGRES_DBNAME: ecs.Secret.fromSecretsManager(db.secret!, 'dbname'),
          CVAT_POSTGRES_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
          CVAT_POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
          SOCIAL_AUTH_GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleSecret, 'clientId'),
          SOCIAL_AUTH_GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleSecret, 'clientSecret'),
          SOCIAL_AUTH_GITHUB_CLIENT_ID: ecs.Secret.fromSecretsManager(githubSecret, 'clientId'),
          SOCIAL_AUTH_GITHUB_CLIENT_SECRET: ecs.Secret.fromSecretsManager(githubSecret, 'clientSecret'),
        },
      },
      containerPort: 8080,
    });
    cvatServer.addVolume('data', { containerPath: '/home/django/data', accessPoint: dataAccessPoint });
    cvatServer.addVolume('share', { containerPath: '/home/django/share', accessPoint: shareAccessPoint });

    const cvatUtils = new WorkerFargateService(this, 'Utils', {
      cluster,
      containerOptions: {
        image: cvatImage,
        command: ['-c', 'supervisord/utils.conf'],
        environment: {
          CVAT_HOST: cdn.distribution.distributionDomainName,
          CVAT_REDIS_HOST: redis.clusterEndpoint.hostname,
          CVAT_REDIS_PASSWORD: '',
          CVAT_POSTGRES_HOST: db.clusterEndpoint.hostname,
        },
        secrets: {
          CVAT_POSTGRES_DBNAME: ecs.Secret.fromSecretsManager(db.secret!, 'dbname'),
          CVAT_POSTGRES_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
          CVAT_POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
        },
      },
      securityGroup: cvatServer.securityGroup,
      enableExecuteCommand: true,
    });
    cvatUtils.addVolume('data', { containerPath: '/home/django/data', accessPoint: dataAccessPoint });
    cvatUtils.addVolume('share', { containerPath: '/home/django/share', accessPoint: shareAccessPoint });

    const cvatWorkerImport = new WorkerFargateService(this, 'WorkerImport', {
      cluster,
      containerOptions: {
        image: cvatImage,
        entryPoint: ['/home/django/wait-for-it.sh', `${redis.clusterEndpoint.socketAddress}`, '-t', '0', '--', 'bash', '-ic'],
        command: ['exec python3 ./manage.py rqworker -v 3 import --worker-class cvat.rqworker.DefaultWorker'],
        //command: ['-c', 'supervisord/worker.import.conf'],
        environment: {
          CVAT_HOST: cdn.distribution.distributionDomainName,
          CVAT_REDIS_HOST: redis.clusterEndpoint.hostname,
          CVAT_POSTGRES_HOST: db.clusterEndpoint.hostname,
        },
        secrets: {
          CVAT_POSTGRES_DBNAME: ecs.Secret.fromSecretsManager(db.secret!, 'dbname'),
          CVAT_POSTGRES_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
          CVAT_POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
        },
      },
      securityGroup: cvatServer.securityGroup,
    });
    cvatWorkerImport.addVolume('data', { containerPath: '/home/django/data', accessPoint: dataAccessPoint });
    cvatWorkerImport.addVolume('share', { containerPath: '/home/django/share', accessPoint: shareAccessPoint });

    const cvatWorkerExport = new WorkerFargateService(this, 'WorkerExport', {
      cluster,
      containerOptions: {
        image: cvatImage,
        entryPoint: ['/home/django/wait-for-it.sh', `${redis.clusterEndpoint.socketAddress}`, '-t', '0', '--', 'bash', '-ic'],
        command: ['exec python3 ./manage.py rqworker -v 3 export --worker-class cvat.rqworker.DefaultWorker'],
        //command: ['-c', 'supervisord/worker.export.conf'],
        environment: {
          CVAT_HOST: cdn.distribution.distributionDomainName,
          CVAT_REDIS_HOST: redis.clusterEndpoint.hostname,
          CVAT_POSTGRES_HOST: db.clusterEndpoint.hostname,
        },
        secrets: {
          CVAT_POSTGRES_DBNAME: ecs.Secret.fromSecretsManager(db.secret!, 'dbname'),
          CVAT_POSTGRES_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
          CVAT_POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
        },
      },
      securityGroup: cvatServer.securityGroup,
    });
    cvatWorkerExport.addVolume('data', { containerPath: '/home/django/data', accessPoint: dataAccessPoint });
    cvatWorkerExport.addVolume('share', { containerPath: '/home/django/share', accessPoint: shareAccessPoint });

    const cvatWorkerAnnotation = new WorkerFargateService(this, 'WorkerAnnotation', {
      cluster,
      containerOptions: {
        image: cvatImage,
        entryPoint: ['/home/django/wait-for-it.sh', `${redis.clusterEndpoint.socketAddress}`, '-t', '0', '--', 'bash', '-ic'],
        command: ['exec python3 ./manage.py rqworker -v 3 annotation --worker-class cvat.rqworker.DefaultWorker'],
        //command: ['-c', 'supervisord/worker.annotation.conf'],
        environment: {
          CVAT_HOST: cdn.distribution.distributionDomainName,
          CVAT_REDIS_HOST: redis.clusterEndpoint.hostname,
          CVAT_POSTGRES_HOST: db.clusterEndpoint.hostname,
          // Automatic annotation
          //CVAT_SERVERLESS: '1',
          //CVAT_NUCLIO_HOST: nuclio.endpoint.hostname,
        },
        secrets: {
          CVAT_POSTGRES_DBNAME: ecs.Secret.fromSecretsManager(db.secret!, 'dbname'),
          CVAT_POSTGRES_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
          CVAT_POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
        },
      },
      securityGroup: cvatServer.securityGroup,
    });
    cvatWorkerAnnotation.addVolume('data', { containerPath: '/home/django/data', accessPoint: dataAccessPoint });
    cvatWorkerAnnotation.addVolume('share', { containerPath: '/home/django/share', accessPoint: shareAccessPoint });

    const cvatWorkerWebhooks = new WorkerFargateService(this, 'WorkerWebhooks', {
      serviceName: 'worker-webhooks',
      cluster,
      containerOptions: {
        image: cvatImage,
        entryPoint: ['/home/django/wait-for-it.sh', `${redis.clusterEndpoint.socketAddress}`, '-t', '0', '--', 'bash', '-ic'],
        command: ['exec python3 ./manage.py rqworker -v 3 webhooks'],
        //command: ['-c', 'supervisord/worker.webhooks.conf'],
        environment: {
          CVAT_HOST: cdn.distribution.distributionDomainName,
          CVAT_REDIS_HOST: redis.clusterEndpoint.hostname,
          CVAT_POSTGRES_HOST: db.clusterEndpoint.hostname,
        },
        secrets: {
          CVAT_POSTGRES_DBNAME: ecs.Secret.fromSecretsManager(db.secret!, 'dbname'),
          CVAT_POSTGRES_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
          CVAT_POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
        },
      },
      securityGroup: cvatServer.securityGroup,
    });
    cvatWorkerWebhooks.addVolume('data', { containerPath: '/home/django/data', accessPoint: dataAccessPoint });
    cvatWorkerWebhooks.addVolume('share', { containerPath: '/home/django/share', accessPoint: shareAccessPoint });

    const opa = new HttpFargateService(this, 'OpenPolicyAgent', {
      serviceName: 'opa',
      cluster,
      containerOptions: {
        containerName: 'opa',
        image: ecs.ContainerImage.fromRegistry('openpolicyagent/opa:0.47.4-rootless'),
        command: [
          'run',
          '--server',
          '--set=decision_logs.console=true',
          `--set=services.cvat.url=http://${cvatServer.endpoint.socketAddress}`,
          '--set=bundles.cvat.service=cvat',
          '--set=bundles.cvat.resource=/api/auth/rules',
          '--set=bundles.cvat.polling.min_delay_seconds=5',
          '--set=bundles.cvat.polling.max_delay_seconds=15',
        ],
      },
      containerPort: 8181,
    });
    cvatServer.taskDefinition.defaultContainer?.addEnvironment('IAM_OPA_HOST', `http://${opa.endpoint.socketAddress}`);
    cvatUtils.taskDefinition.defaultContainer?.addEnvironment('IAM_OPA_HOST', `http://${opa.endpoint.socketAddress}`);
    cvatWorkerAnnotation.taskDefinition.defaultContainer?.addEnvironment('IAM_OPA_HOST', `http://${opa.endpoint.socketAddress}`);
    cvatWorkerWebhooks.taskDefinition.defaultContainer?.addEnvironment('IAM_OPA_HOST', `http://${opa.endpoint.socketAddress}`);

    const react = new HttpFargateService(this, 'React', {
      cluster,
      containerOptions: {
        containerName: 'nginx',
        image: uiImage,
      },
      containerPort: 80,
    });

    cvatServer.connections.allowToDefaultPort(db);
    cvatServer.connections.allowToDefaultPort(redis);
    cvatServer.connections.allowToDefaultPort(opa);
    cvatServer.connections.allowToDefaultPort(cvatServerless);

    opa.connections.allowToDefaultPort(cvatServer);

    const reactTargetGroup = react.modifyTargetGroup({
      timeout: cdk.Duration.seconds(2),
      interval: cdk.Duration.seconds(5),
    });

    const serverTargetGroup = cvatServer.modifyTargetGroup({
      path: '/api/server/about',
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 10,
    });

    const listener = loadBalancer.addListener('Listener', {
      port: 80,
      defaultTargetGroups: [reactTargetGroup],
    });

    listener.addTargetGroups('CvatServer1', {
      priority: 20,
      targetGroups: [serverTargetGroup],
      conditions: [elb.ListenerCondition.pathPatterns([
        '/api/*',
        '/git/*',
        '/opencv/*',
        '/static/*',
      ])],
    });

    listener.addTargetGroups('CvatServer2', {
      priority: 30,
      targetGroups: [serverTargetGroup],
      conditions: [elb.ListenerCondition.pathPatterns([
        '/admin*',
        '/documentation/*',
        '/django-rq*',
      ])],
    });

    listener.addAction('DisableSelfRegistration', {
      priority: 1,
      action: elb.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Self-registration is not allowed',
      }),
      conditions: [elb.ListenerCondition.pathPatterns([
        '/api/auth/register*',
      ])],
    });

    const cvatUtilsTaskId = `$(aws ecs list-tasks --cluster ${cluster.clusterName} --service-name ${cvatUtils.service.serviceName} --query "taskArns[0]" --output text)`;
    new cdk.CfnOutput(this, 'CreateSuperuserCommand', { value: `aws ecs execute-command --cluster ${cluster.clusterName} --task ${cvatUtilsTaskId} --container app --interactive --command "python3 ./manage.py createsuperuser"` });
    new cdk.CfnOutput(this, 'Url', { value: `https://${cdn.distribution.distributionDomainName}` });
  }
}

interface OauthSecretProps {
  idpName: string;
}

class OauthSecret extends Secret {
  public readonly clientId: cdk.CfnParameter;
  public readonly clientSecret: cdk.CfnParameter;

  constructor(scope: Construct, id: string, props: OauthSecretProps) {

    const idpName = props.idpName;

    const clientId = new cdk.CfnParameter(scope, idpName + 'ClientId', {
      description: `${idpName} - ClientId`,
      type: 'String',
      default: '',
      noEcho: true,
    });

    const clientSecret = new cdk.CfnParameter(scope, idpName + 'ClientSecret', {
      description: `${idpName} - ClientSecret`,
      type: 'String',
      default: '',
      noEcho: true,
    });

    super(scope, id, {
      description: `${idpName} - ClientId & ClientSecret`,
      secretObjectValue: {
        clientId: cdk.SecretValue.cfnParameter(clientId),
        clientSecret: cdk.SecretValue.cfnParameter(clientSecret),
      },
    });

    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }
}
