import { App } from 'aws-cdk-lib';
import { CvatStack } from './cvat-stack';

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new CvatStack(app, 'CVAT', { env: devEnv, cvatVersion: 'dev' });

app.synth();