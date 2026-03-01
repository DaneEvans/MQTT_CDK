import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

/**
 * CDK Stack that provisions:
 *  - A VPC with a public subnet
 *  - A small EC2 instance (t3.micro) running Amazon Linux 2
 *  - An Elastic IP (fixed public IP) attached to the instance
 *  - Mosquitto MQTT broker installed and configured via user data
 *  - A security group that opens port 1883 (MQTT), 8883 (MQTT TLS), and 22 (SSH)
 */
export class MqttCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Load MQTT credentials from config ──────────────────────────────────
    const configPath = path.join(__dirname, "..", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const mqttUsername = config.mqtt?.username || "meshdev";
    const mqttPassword = config.mqtt?.password || "large4cats";

    // ── VPC ────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "MqttVpc", {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ── Security group ──────────────────────────────────────────────────────
    const sg = new ec2.SecurityGroup(this, "MqttSg", {
      vpc,
      description: "Allow MQTT (1883) and SSH (22) inbound",
      allowAllOutbound: true,
    });

    // SSH – restrict to your own IP in production
    // sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), "SSH");
    // MQTT plain-text
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(1883), "MQTT");
    // MQTT over TLS (optional, useful for future use)
    // sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8883), "MQTT TLS");

    // ── IAM Role for SSM Session Manager access ──────────────────────────────
    const role = new iam.Role(this, "MqttInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonSSMManagedInstanceCore",
      ),
    );

    // ── User data – install & start Mosquitto ───────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Update packages
      "yum update -y",
      // Enable EPEL and install mosquitto
      "amazon-linux-extras install epel -y",
      "yum install -y mosquitto",
      // Stop mosquitto if it auto-started
      "systemctl stop mosquitto || true",
      // Create password file for mosquitto
      `mosquitto_passwd -c -b /etc/mosquitto/passwd ${mqttUsername} ${mqttPassword}`,
      // Ensure required directories exist
      "mkdir -p /var/lib/mosquitto",
      // Configure mosquitto to require authentication
      "cat > /etc/mosquitto/mosquitto.conf <<'EOF'",
      "pid_file /var/run/mosquitto.pid",
      "persistence true",
      "persistence_location /var/lib/mosquitto/",
      "log_dest syslog",
      "listener 1883 0.0.0.0",
      "allow_anonymous false",
      "password_file /etc/mosquitto/passwd",
      "EOF",
      "chown mosquitto:mosquitto /etc/mosquitto/passwd /var/lib/mosquitto || true",
      "chmod 640 /etc/mosquitto/passwd",
      // Enable and start the service
      "systemctl enable mosquitto",
      "systemctl restart mosquitto",
    );

    // ── EC2 instance ────────────────────────────────────────────────────────
    const instance = new ec2.Instance(this, "MqttInstance", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: sg,
      userData,
      role,
      // IMDSv2 required for better security
      requireImdsv2: true,
      // Force instance replacement when user data changes
      userDataCausesReplacement: true,
    });

    // ── Elastic IP (fixed public IP) ────────────────────────────────────────
    const eip = new ec2.CfnEIP(this, "MqttEip", { domain: "vpc" });
    new ec2.CfnEIPAssociation(this, "MqttEipAssociation", {
      instanceId: instance.instanceId,
      allocationId: eip.attrAllocationId,
    });

    // ── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "MqttPublicIp", {
      value: eip.ref,
      description: "Fixed public IP address (Elastic IP) of the MQTT broker",
    });
    new cdk.CfnOutput(this, "MqttBrokerEndpoint", {
      value: cdk.Fn.join("", ["mqtt://", eip.ref, ":1883"]),
      description: "MQTT broker endpoint",
    });
    new cdk.CfnOutput(this, "VerifyMosquittoSSH", {
      value: cdk.Fn.join("", [
        "ssh -i <your-key.pem> ec2-user@",
        eip.ref,
        " 'sudo systemctl status mosquitto'",
      ]),
      description: "SSH command to verify mosquitto is running",
    });
    new cdk.CfnOutput(this, "VerifyMosquittoSSM", {
      value: cdk.Fn.join("", [
        "aws ssm start-session --target ",
        instance.instanceId,
        " --document-name AWS-StartInteractiveCommand -- sudo systemctl status mosquitto",
      ]),
      description:
        "AWS Systems Manager command to verify mosquitto (requires AWS CLI)",
    });
    new cdk.CfnOutput(this, "CloudInitLogs", {
      value: "sudo tail -f /var/log/cloud-init-output.log",
      description:
        "Command to check installation logs on the instance (SSH or SSM)",
    });
    new cdk.CfnOutput(this, "MqttUsername", {
      value: mqttUsername,
      description: "MQTT broker username",
    });
  }
}
