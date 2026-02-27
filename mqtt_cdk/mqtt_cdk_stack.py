import aws_cdk as cdk
from aws_cdk import (
    Stack,
    aws_ec2 as ec2,
)
from constructs import Construct


class MqttCdkStack(Stack):
    """
    CDK Stack that provisions:
      - A VPC with a public subnet
      - A small EC2 instance (t3.micro) running Amazon Linux 2023
      - An Elastic IP (fixed public IP) attached to the instance
      - Mosquitto MQTT broker installed and configured via user data
      - A security group that opens port 1883 (MQTT) and 22 (SSH)
    """

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # ── VPC ───────────────────────────────────────────────────────────────
        vpc = ec2.Vpc(
            self,
            "MqttVpc",
            max_azs=1,
            nat_gateways=0,
            subnet_configuration=[
                ec2.SubnetConfiguration(
                    name="Public",
                    subnet_type=ec2.SubnetType.PUBLIC,
                    cidr_mask=24,
                )
            ],
        )

        # ── Security group ────────────────────────────────────────────────────
        sg = ec2.SecurityGroup(
            self,
            "MqttSg",
            vpc=vpc,
            description="Allow MQTT (1883) and SSH (22) inbound",
            allow_all_outbound=True,
        )
        # SSH – restrict to your own IP in production
        sg.add_ingress_rule(ec2.Peer.any_ipv4(), ec2.Port.tcp(22), "SSH")
        # MQTT plain-text
        sg.add_ingress_rule(ec2.Peer.any_ipv4(), ec2.Port.tcp(1883), "MQTT")
        # MQTT over TLS (optional, useful for future use)
        sg.add_ingress_rule(ec2.Peer.any_ipv4(), ec2.Port.tcp(8883), "MQTT TLS")

        # ── User data – install & start Mosquitto ─────────────────────────────
        user_data = ec2.UserData.for_linux()
        user_data.add_commands(
            # Update packages
            "dnf update -y",
            # Install mosquitto from the standard Amazon Linux repo
            "dnf install -y mosquitto",
            # Allow anonymous connections on the default listener
            "cat > /etc/mosquitto/conf.d/default.conf <<'EOF'\n"
            "listener 1883\n"
            "allow_anonymous true\n"
            "EOF",
            # Enable and start the service
            "systemctl enable mosquitto",
            "systemctl start mosquitto",
        )

        # ── EC2 instance ──────────────────────────────────────────────────────
        instance = ec2.Instance(
            self,
            "MqttInstance",
            instance_type=ec2.InstanceType.of(
                ec2.InstanceClass.T3, ec2.InstanceSize.MICRO
            ),
            machine_image=ec2.MachineImage.latest_amazon_linux2023(),
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC),
            security_group=sg,
            user_data=user_data,
            # IMDSv2 required for better security
            require_imdsv2=True,
        )

        # ── Elastic IP (fixed public IP) ──────────────────────────────────────
        eip = ec2.CfnEIP(self, "MqttEip", domain="vpc")
        ec2.CfnEIPAssociation(
            self,
            "MqttEipAssociation",
            instance_id=instance.instance_id,
            allocation_id=eip.attr_allocation_id,
        )

        # ── Outputs ───────────────────────────────────────────────────────────
        cdk.CfnOutput(
            self,
            "MqttPublicIp",
            value=eip.ref,
            description="Fixed public IP address (Elastic IP) of the MQTT broker",
        )
        cdk.CfnOutput(
            self,
            "MqttBrokerEndpoint",
            value=cdk.Fn.join("", ["mqtt://", eip.ref, ":1883"]),
            description="MQTT broker endpoint",
        )
