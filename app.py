#!/usr/bin/env python3
import aws_cdk as cdk
from mqtt_cdk.mqtt_cdk_stack import MqttCdkStack

app = cdk.App()
MqttCdkStack(app, "MqttCdkStack")
app.synth()
