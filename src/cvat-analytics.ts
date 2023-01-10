import * as cdk from 'aws-cdk-lib';
import { EbsDeviceVolumeType, Peer } from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { HttpFargateService } from './aws-ecs-fargate-service';

interface AnalyticsProps {
  cluster: ecs.ICluster;
}

export class Analytics extends Construct {
  public readonly logstash: HttpFargateService;
  public readonly searchDomain: opensearch.IDomain;

  constructor(scope: Construct, id: string, props: AnalyticsProps) {
    super(scope, id);

    const masterUserName = 'admin';

    const masterUserSecret = new Secret(this, 'MasterUser', {
      description: 'OpenSearch Master User',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: masterUserName }),
        generateStringKey: 'password',
        passwordLength: 64,
      },
    });

    this.searchDomain = new opensearch.Domain(this, 'Domain', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      version: opensearch.EngineVersion.openSearch('2.3'),
      enableVersionUpgrade: true,
      //zoneAwareness: { availabilityZoneCount: 1 },
      capacity: {
        dataNodeInstanceType: 't3.small.search', // Free Tier
        dataNodes: 1,
      },
      ebs: {
        volumeSize: 10, // Free Tier
        volumeType: EbsDeviceVolumeType.GP3,
      },
      fineGrainedAccessControl: {
        //masterUserArn: masterUserRole.roleArn,
        masterUserName,
        masterUserPassword: masterUserSecret.secretValueFromJson('password'),
      },
      enforceHttps: true,
      nodeToNodeEncryption: true,
      encryptionAtRest: {
        enabled: true,
      },
      accessPolicies: [
        new iam.PolicyStatement({
          principals: [new iam.AnyPrincipal()],
          actions: ['es:*'],
          resources: ['*'],
        }),
      ],
    });

    //const logGroup = new logs.LogGroup(this, 'Logs', {
    //  removalPolicy: cdk.RemovalPolicy.DESTROY,
    //  retention: logs.RetentionDays.ONE_MONTH,
    //});

    const logstashConfig = `input {
      http {
        port => 8080
        codec => json
      }
    }

    filter {
      mutate {
        add_field => { "[@metadata][_id]" => "" }
        add_field => { "logger_name" => "" }
      }
      mutate {
        copy => { "[headers][x_request_id]" => "[@metadata][_id]" }
        copy => { "[extra][logger_name]" => "logger_name" }
      }
      prune {
        blacklist_names => ["type", "logsource", "extra", "program", "pid", "headers"]
      }
      if [logger_name] =~ /cvat.client/ {
        mutate {
          add_field => { "[@metadata][_index]" => "cvat.client.%{+YYYY}.%{+MM}" }
        }
        mutate {
          rename => { "message" => "source_message" }
        }
        json {
          source => "source_message"
        }
        date {
          match => ["time", "ISO8601"]
          remove_field => "time"
        }
        if [payload] {
          ruby {
            code => "
              event.get('payload').each { |key, value|
                event.set(key, value)
              }
            "
          }
        }
        prune {
          blacklist_names => ["level", "host", "logger_name", "path", "port", "stack_info", "payload", "source_message"]
        }
      } else if [logger_name] =~ /cvat.server/ {
        mutate {
          add_field => { "[@metadata][_index]" => "cvat.server.%{+YYYY}.%{+MM}" }
        }
        mutate {
          rename => { "logger_name" => "task_id" }
          gsub => [ "task_id", "cvat.server.task_", "" ]
        }
        mutate {
          convert => { "task_id" => "integer" }
        }
        prune {
          blacklist_names => ["host", "port", "stack_info"]
        }
      } else {
        mutate {
          add_field => { "[@metadata][_index]" => "cvat.other.%{+YYYY}.%{+MM}" }
        }
      }
    }

    output {
      stdout {
        codec => rubydebug
      }

      opensearch {
        index => "%{[@metadata][_index]}"
        document_id => "%{[@metadata][_id]}"
        hosts => ["\${LOGSTASH_OUTPUT_HOST}"]
        user => "\${LOGSTASH_OUTPUT_USER:}"
        password => "\${LOGSTASH_OUTPUT_PASS:}"
        manage_template => false
        ecs_compatibility => disabled
        ssl_certificate_verification => false
      }
    }`;

    this.logstash = new HttpFargateService(this, 'Logstash', {
      cluster: props.cluster,
      memoryLimitMiB: 1024,
      containerOptions: {
        containerName: 'logstash',
        image: ecs.ContainerImage.fromRegistry('opensearchproject/logstash-oss-with-opensearch-output-plugin:8.4.0'),
        environment: {
          CONFIG_STRING: logstashConfig,
          //LS_JAVA_OPTS: '-Xms384m -Xmx384m',
          PIPELINE_ECS_COMPATIBILITY: 'disabled',
          QUEUE_TYPE: 'persisted',
          QUEUE_MAX_BYTES: '384mb',
          QUEUE_CHECKPOINT_WRITES: '20',
          LOGSTASH_OUTPUT_HOST: `https://${this.searchDomain.domainEndpoint}:443`,
        },
        secrets: {
          LOGSTASH_OUTPUT_USER: ecs.Secret.fromSecretsManager(masterUserSecret, 'username'),
          LOGSTASH_OUTPUT_PASS: ecs.Secret.fromSecretsManager(masterUserSecret, 'password'),
        },
      },
      containerPort: 8080,
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
    });
  }
}
