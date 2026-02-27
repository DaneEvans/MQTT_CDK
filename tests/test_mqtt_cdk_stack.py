import aws_cdk as cdk
from aws_cdk.assertions import Template
from mqtt_cdk.mqtt_cdk_stack import MqttCdkStack


def _template() -> Template:
    app = cdk.App()
    stack = MqttCdkStack(app, "TestStack")
    return Template.from_stack(stack)


def test_ec2_instance_created():
    template = _template()
    template.has_resource_properties(
        "AWS::EC2::Instance",
        {
            "InstanceType": "t3.micro",
        },
    )


def test_elastic_ip_created():
    template = _template()
    template.has_resource("AWS::EC2::EIP", {})


def test_eip_association_created():
    template = _template()
    template.has_resource("AWS::EC2::EIPAssociation", {})


def test_vpc_created():
    template = _template()
    template.has_resource("AWS::EC2::VPC", {})


def test_security_group_mqtt_port():
    template = _template()
    template.has_resource_properties(
        "AWS::EC2::SecurityGroup",
        {
            "SecurityGroupIngress": cdk.assertions.Match.array_with(
                [
                    cdk.assertions.Match.object_like(
                        {"FromPort": 1883, "ToPort": 1883, "IpProtocol": "tcp"}
                    )
                ]
            )
        },
    )


def test_outputs_exist():
    template = _template()
    outputs = template.to_json().get("Outputs", {})
    assert "MqttPublicIp" in outputs
    assert "MqttBrokerEndpoint" in outputs
