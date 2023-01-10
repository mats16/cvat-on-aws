import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';

interface RedisClusterProps {
  version?: string;
  nodeType?: string;
  nodeCount?: number;
  vpc: ec2.IVpc;
}

export class RedisCluster extends Construct {
  public readonly connections: ec2.Connections;
  public readonly clusterEndpoint: Endpoint;

  constructor(scope: Construct, id: string, props: RedisClusterProps) {
    super(scope, id);

    const vpc = props.vpc;
    const engineVersion = props.version;
    const cacheNodeType = props.nodeType ?? 'cache.t3.micro';
    const numCacheNodes = props.nodeCount ?? 1;

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', { allowAllOutbound: true, vpc });

    const subnets = new elasticache.CfnSubnetGroup(this, 'Subnets', {
      description: `Subnets for ${this.node.path}/Cluster`,
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
    });

    const cluster = new elasticache.CfnCacheCluster(this, 'Cluster', {
      engine: 'redis',
      engineVersion,
      port: 6379,
      cacheNodeType,
      numCacheNodes,
      cacheSubnetGroupName: subnets.ref,
      vpcSecurityGroupIds: [securityGroup.securityGroupId],
    });

    // create a number token that represents the port of the cluster
    const portAttribute = cdk.Token.asNumber(cluster.attrRedisEndpointPort);
    this.clusterEndpoint = new Endpoint(cluster.attrRedisEndpointAddress, portAttribute);
    this.connections = new ec2.Connections({
      securityGroups: [securityGroup],
      defaultPort: ec2.Port.tcp(this.clusterEndpoint.port),
    });

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
