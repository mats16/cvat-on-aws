import { App } from 'aws-cdk-lib';
import { CvatStack } from './cvat-stack';

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new CvatStack(app, 'Cvat', {
  description: 'Computer Vision Annotation Tool (CVAT) on AWS',
  env: devEnv,
  cvatVersion: 'v2.5.0',
});

app.synth();