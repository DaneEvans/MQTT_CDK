#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MqttCdkStack } from '../lib/mqtt_cdk_stack';

const app = new cdk.App();
new MqttCdkStack(app, 'MqttCdkStack');
