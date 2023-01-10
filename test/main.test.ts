import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CvatStack } from '../src/cvat-stack';

test('Snapshot', () => {
  const app = new App();
  const stack = new CvatStack(app, 'test');

  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});