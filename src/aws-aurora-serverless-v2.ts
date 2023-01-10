import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

interface ScalingProps {
  minCapacity: number;
  maxCapacity: number;
}

export class AuroraServerlessV2Cluster extends rds.DatabaseCluster {
  constructor(scope: Construct, id: string, props: rds.DatabaseClusterProps) {
    super(scope, id, props);

    const instances = this.node.children.filter(child => child.node.id.startsWith('Instance')) as rds.CfnDBInstance[];
    instances.map(instance => instance.dbInstanceClass = 'db.serverless');

    this.configureScaling({ maxCapacity: 32, minCapacity: 0.5 });
  }

  configureScaling(props: ScalingProps) {
    const dbCluster = this.node.defaultChild as rds.CfnDBCluster;
    dbCluster.serverlessV2ScalingConfiguration = props;
  }
}
