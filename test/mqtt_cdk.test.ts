import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { MqttCdkStack } from "../lib/mqtt_cdk_stack";

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new MqttCdkStack(app, "TestStack");
  return Template.fromStack(stack);
}

test("EC2 instance is t3.micro", () => {
  const template = buildTemplate();
  template.hasResourceProperties("AWS::EC2::Instance", {
    InstanceType: "t3.micro",
  });
});

test("Elastic IP is not created", () => {
  const template = buildTemplate();
  template.resourceCountIs("AWS::EC2::EIP", 0);
});

test("EIP association is not created", () => {
  const template = buildTemplate();
  template.resourceCountIs("AWS::EC2::EIPAssociation", 0);
});

test("VPC is created", () => {
  const template = buildTemplate();
  template.resourceCountIs("AWS::EC2::VPC", 1);
});

test("VPC has an Amazon-provided IPv6 CIDR block", () => {
  const template = buildTemplate();
  template.hasResourceProperties("AWS::EC2::VPCCidrBlock", {
    AmazonProvidedIpv6CidrBlock: true,
  });
});

test("EC2 instance has one IPv6 address", () => {
  const template = buildTemplate();
  template.hasResourceProperties("AWS::EC2::Instance", {
    Ipv6AddressCount: 1,
  });
});

test("Security group allows MQTT on port 1883 over IPv6", () => {
  const template = buildTemplate();
  template.hasResourceProperties("AWS::EC2::SecurityGroup", {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        CidrIpv6: "::/0",
        FromPort: 1883,
        ToPort: 1883,
        IpProtocol: "tcp",
      }),
    ]),
  });
});

test("Security group allows all outbound over IPv6", () => {
  const template = buildTemplate();
  template.hasResourceProperties("AWS::EC2::SecurityGroup", {
    SecurityGroupEgress: Match.arrayWith([
      Match.objectLike({
        CidrIpv6: "::/0",
        IpProtocol: "-1",
      }),
    ]),
  });
});

test("Stack outputs MqttBrokerIpv6 and MqttBrokerEndpoint", () => {
  const template = buildTemplate();
  const outputs = template.toJSON().Outputs ?? {};
  expect(outputs).toHaveProperty("MqttBrokerIpv6");
  expect(outputs).toHaveProperty("MqttBrokerEndpoint");
  expect(outputs).toHaveProperty("PositionsApiBaseUrl");
  expect(outputs).toHaveProperty("PositionsTableName");
});

test("DynamoDB table for latest positions is created", () => {
  const template = buildTemplate();
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [{ AttributeName: "senderId", KeyType: "HASH" }],
  });
});

test("Lambda Function URL for positions API is created", () => {
  const template = buildTemplate();
  template.resourceCountIs("AWS::Lambda::Url", 1);
});
