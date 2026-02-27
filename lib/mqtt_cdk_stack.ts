import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * CDK Stack that provisions:
 *  - A VPC with a public subnet
 *  - A small EC2 instance (t3.micro) running Amazon Linux 2023
 *  - An Elastic IP (fixed public IP) attached to the instance
 *  - Mosquitto MQTT broker installed and configured via user data
 *  - A security group that opens port 1883 (MQTT), 8883 (MQTT TLS), and 22 (SSH)
 */
export class MqttCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'MqttVpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ── Security group ──────────────────────────────────────────────────────
    const sg = new ec2.SecurityGroup(this, 'MqttSg', {
      vpc,
      description: 'Allow MQTT (1883) and SSH (22) inbound',
      allowAllOutbound: true,
    });

    // SSH – restrict to your own IP in production
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH');
    // MQTT plain-text
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(1883), 'MQTT');
    // MQTT over TLS (optional, useful for future use)
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8883), 'MQTT TLS');

    // ── User data – install & start Mosquitto ───────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Update packages
      'dnf update -y',
      // Install mosquitto from the standard Amazon Linux repo
      'dnf install -y mosquitto',
      // Allow anonymous connections on the default listener
      "cat > /etc/mosquitto/conf.d/default.conf <<'EOF'",
      'listener 1883',
      'allow_anonymous true',
      'EOF',
      // Enable and start the service
      'systemctl enable mosquitto',
      'systemctl start mosquitto',
    );

    // ── EC2 instance ────────────────────────────────────────────────────────
    const instance = new ec2.Instance(this, 'MqttInstance', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: sg,
      userData,
      // IMDSv2 required for better security
      requireImdsv2: true,
    });

    // ── Elastic IP (fixed public IP) ────────────────────────────────────────
    const eip = new ec2.CfnEIP(this, 'MqttEip', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'MqttEipAssociation', {
      instanceId: instance.instanceId,
      allocationId: eip.attrAllocationId,
    });

    // ── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'MqttPublicIp', {
      value: eip.ref,
      description: 'Fixed public IP address (Elastic IP) of the MQTT broker',
    });
    new cdk.CfnOutput(this, 'MqttBrokerEndpoint', {
      value: cdk.Fn.join('', ['mqtt://', eip.ref, ':1883']),
      description: 'MQTT broker endpoint',
    });
  }
}
