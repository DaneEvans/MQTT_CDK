import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MqttCdkStack } from '../lib/mqtt_cdk_stack';

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new MqttCdkStack(app, 'TestStack');
  return Template.fromStack(stack);
}

test('EC2 instance is t3.micro', () => {
  const template = buildTemplate();
  template.hasResourceProperties('AWS::EC2::Instance', {
    InstanceType: 't3.micro',
  });
});

test('Elastic IP is created', () => {
  const template = buildTemplate();
  template.resourceCountIs('AWS::EC2::EIP', 1);
});

test('EIP association is created', () => {
  const template = buildTemplate();
  template.resourceCountIs('AWS::EC2::EIPAssociation', 1);
});

test('VPC is created', () => {
  const template = buildTemplate();
  template.resourceCountIs('AWS::EC2::VPC', 1);
});

test('Security group allows MQTT on port 1883', () => {
  const template = buildTemplate();
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({ FromPort: 1883, ToPort: 1883, IpProtocol: 'tcp' }),
    ]),
  });
});

test('Stack outputs MqttPublicIp and MqttBrokerEndpoint', () => {
  const template = buildTemplate();
  const outputs = template.toJSON().Outputs ?? {};
  expect(outputs).toHaveProperty('MqttPublicIp');
  expect(outputs).toHaveProperty('MqttBrokerEndpoint');
});
