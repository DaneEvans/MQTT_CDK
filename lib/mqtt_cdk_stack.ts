import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
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
    const squigglyConsumerUsername =
      config.mqtt?.squigglyConsumer?.username || "meshdev";
    const squigglyConsumerPassword =
      config.mqtt?.squigglyConsumer?.password || "large4cats";
    const mqttUploaderUsername =
      config.mqtt?.uploader?.username || "mqtt-uploader";
    const mqttUploaderPassword =
      config.mqtt?.uploader?.password || "replace-mqtt-uploader-password";
    const squigglyUploaderUsername =
      config.mqtt?.squigglyUploader?.username || "squiggly-uploader";
    const squigglyUploaderPassword =
      config.mqtt?.squigglyUploader?.password ||
      "replace-squiggly-uploader-password";
    const meshAdminUsername = config.mqtt?.meshadmin?.username || "meshadmin";
    const meshAdminPassword =
      config.mqtt?.meshadmin?.password || "replace-meshadmin-password";
    const allowedChannel = config.ingest?.allowedChannel || "ANZ";
    const ingestLogLevel = config.ingest?.logLevel || "INFO";
    const publishTopic = (config.ingest?.publishTopic || "squiggly").trim();
    const positionsApiKey = config.api?.key;
    const apiCustomDomainName = (config.api?.customDomainName || "").trim();
    const apiCertificateArn = (config.api?.certificateArn || "").trim();
    if (!positionsApiKey || typeof positionsApiKey !== "string") {
      throw new Error(
        "config.json is missing api.key (required for Positions API auth)",
      );
    }
    if (
      (apiCustomDomainName && !apiCertificateArn) ||
      (!apiCustomDomainName && apiCertificateArn)
    ) {
      throw new Error(
        "config.json api.customDomainName and api.certificateArn must both be set together",
      );
    }

    // ── Latest positions storage ────────────────────────────────────────────
    const positionsTable = new dynamodb.Table(this, "LatestPositionsTable", {
      partitionKey: { name: "senderId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── API Lambda + API Gateway HTTP API ──────────────────────────────────
    const apiFunctionName = "mqtt-positions-api";

    // Pre-create log group with a sane retention so it exists from deploy.
    const apiLogGroup = new logs.LogGroup(this, "PositionsApiLogGroup", {
      logGroupName: `/aws/lambda/${apiFunctionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const cloudInitInstanceLogGroup = new logs.LogGroup(
      this,
      "CloudInitInstanceLogGroup",
      {
        logGroupName: "/mqtt/ec2/cloud-init-output",
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const syslogInstanceLogGroup = new logs.LogGroup(
      this,
      "SyslogInstanceLogGroup",
      {
        logGroupName: "/mqtt/ec2/syslog",
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const mosquittoSelfCheckLogGroup = new logs.LogGroup(
      this,
      "MosquittoSelfCheckLogGroup",
      {
        logGroupName: "/mqtt/ec2/mosquitto-selfcheck",
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const alarmTopic = new sns.Topic(this, "MqttAlarmTopic", {
      displayName: "MQTT broker alarms",
    });
    alarmTopic.addSubscription(
      new subscriptions.EmailSubscription("dane@goneepic.com"),
    );

    const positionsApiFn = new lambda.Function(this, "PositionsApiFunction", {
      functionName: apiFunctionName,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "lambda", "positions_api"),
      ),
      timeout: cdk.Duration.seconds(10),
      logGroup: apiLogGroup,
      environment: {
        POSITIONS_TABLE_NAME: positionsTable.tableName,
        POSITIONS_API_KEY: positionsApiKey,
      },
    });
    positionsTable.grantReadData(positionsApiFn);

    const positionsHttpApi = new apigwv2.HttpApi(this, "PositionsHttpApi", {
      description: "HTTP API for latest positions endpoints",
      corsPreflight: {
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowOrigins: ["*"],
      },
    });
    const positionsIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "PositionsLambdaIntegration",
      positionsApiFn,
    );
    positionsHttpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.GET],
      integration: positionsIntegration,
    });
    positionsHttpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.GET],
      integration: positionsIntegration,
    });
    const positionsApiBaseUrl = cdk.Fn.join("", [
      positionsHttpApi.apiEndpoint,
      "/",
    ]);

    let positionsApiCustomBaseUrl: string | undefined;
    if (apiCustomDomainName && apiCertificateArn) {
      const positionsApiDomain = new apigwv2.CfnDomainName(
        this,
        "PositionsApiCustomDomain",
        {
          domainName: apiCustomDomainName,
          domainNameConfigurations: [
            {
              certificateArn: apiCertificateArn,
              endpointType: "REGIONAL",
              securityPolicy: "TLS_1_2",
            },
          ],
        },
      );

      const positionsApiDomainMapping = new apigwv2.CfnApiMapping(
        this,
        "PositionsApiCustomDomainMapping",
        {
          apiId: positionsHttpApi.apiId,
          domainName: apiCustomDomainName,
          stage: "$default",
        },
      );
      positionsApiDomainMapping.addDependency(positionsApiDomain);

      positionsApiCustomBaseUrl = `https://${apiCustomDomainName}/`;
      new cdk.CfnOutput(this, "PositionsApiCustomDomainName", {
        value: apiCustomDomainName,
        description: "Configured custom domain name for the positions API",
      });
      new cdk.CfnOutput(this, "PositionsApiCustomDomainTarget", {
        value: positionsApiDomain.attrRegionalDomainName,
        description: "VentraIP DNS target for api CNAME/ALIAS record",
      });
      new cdk.CfnOutput(this, "PositionsApiCustomDomainHostedZoneId", {
        value: positionsApiDomain.attrRegionalHostedZoneId,
        description: "Route53 hosted zone ID for the API custom domain target",
      });
      new cdk.CfnOutput(this, "PositionsApiCustomBaseUrl", {
        value: positionsApiCustomBaseUrl,
        description: "Custom domain base URL for positions API",
      });
    }

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
      description: "Allow MQTT (1883) inbound",
      allowAllOutbound: true,
    });

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
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"),
    );
    positionsTable.grantWriteData(role);

    // ── User data – install & start Mosquitto ───────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -e",
      "export DEBIAN_FRONTEND=noninteractive",
      // Retry helper for apt/network flakiness during first boot.
      'retry() { n=0; until [ "$n" -ge 5 ]; do "$@" && return 0; n=$((n+1)); sleep 10; done; return 1; }',
      // Install broker and Python deps from Ubuntu repos.
      "retry apt-get update -y",
      "retry apt-get install -y mosquitto mosquitto-clients python3 python3-pip wget",
      // Install CloudWatch agent for host log shipping.
      "wget -q https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -O /tmp/amazon-cloudwatch-agent.deb",
      "dpkg -i /tmp/amazon-cloudwatch-agent.deb",
      // Keep Mosquitto setup independent from optional Python package naming differences.
      "apt-get install -y python3-boto3 python3-paho-mqtt || python3 -m pip install --no-cache-dir boto3 paho-mqtt",
      // Fail fast if expected binaries are missing.
      "command -v mosquitto",
      "command -v mosquitto_passwd",
      // Stop mosquitto if it auto-started
      "systemctl stop mosquitto || true",
      // Create password files for mosquitto users
      `mosquitto_passwd -c -b /etc/mosquitto/passwd-public ${mqttUploaderUsername} ${mqttUploaderPassword}`,
      `mosquitto_passwd -b /etc/mosquitto/passwd-public ${squigglyConsumerUsername} ${squigglyConsumerPassword}`,
      `mosquitto_passwd -b /etc/mosquitto/passwd-public ${meshAdminUsername} ${meshAdminPassword}`,
      `mosquitto_passwd -c -b /etc/mosquitto/passwd-internal ${squigglyUploaderUsername} ${squigglyUploaderPassword}`,
      `mosquitto_passwd -b /etc/mosquitto/passwd-internal ${meshAdminUsername} ${meshAdminPassword}`,
      // Public listener ACLs: external uploader can publish everything except squiggly.
      "cat > /etc/mosquitto/acl-public <<EOF",
      `user ${mqttUploaderUsername}`,
      "topic deny squiggly",
      "topic deny squiggly/#",
      "topic write #",
      `user ${squigglyConsumerUsername}`,
      "topic read squiggly",
      "topic read squiggly/#",
      `user ${meshAdminUsername}`,
      "topic readwrite #",
      "EOF",
      // Internal listener ACLs: only local squiggly uploader can read mesh topics and publish squiggly.
      "cat > /etc/mosquitto/acl-internal <<EOF",
      `user ${squigglyUploaderUsername}`,
      "topic read msh/#",
      "topic write squiggly",
      "topic write squiggly/#",
      `user ${meshAdminUsername}`,
      "topic readwrite #",
      "EOF",
      // Ensure required directories exist
      "mkdir -p /var/lib/mosquitto",
      // Configure mosquitto to require authentication and per-listener ACLs
      "cat > /etc/mosquitto/mosquitto.conf <<'EOF'",
      "persistence true",
      "persistence_location /var/lib/mosquitto/",
      "log_dest syslog",
      "per_listener_settings true",
      "listener 1883 0.0.0.0",
      "allow_anonymous false",
      "password_file /etc/mosquitto/passwd-public",
      "acl_file /etc/mosquitto/acl-public",
      "listener 1884 127.0.0.1",
      "allow_anonymous false",
      "password_file /etc/mosquitto/passwd-internal",
      "acl_file /etc/mosquitto/acl-internal",
      "EOF",
      // Self-check: start broker in foreground briefly to validate config.
      // timeout exit code 124 means the process stayed up long enough to pass.
      'bash -lc \'timeout 3 mosquitto -c /etc/mosquitto/mosquitto.conf -v >/var/log/mosquitto-selfcheck.log 2>&1; rc=$?; if [ "$rc" -ne 124 ]; then echo "mosquitto self-check failed rc=$rc"; cat /var/log/mosquitto-selfcheck.log; exit 1; fi\'',
      "chown mosquitto:mosquitto /etc/mosquitto/passwd-public /etc/mosquitto/passwd-internal /etc/mosquitto/acl-public /etc/mosquitto/acl-internal /var/lib/mosquitto || true",
      "chmod 640 /etc/mosquitto/passwd-public /etc/mosquitto/passwd-internal /etc/mosquitto/acl-public /etc/mosquitto/acl-internal",
      // Enable and start the service
      "systemctl enable mosquitto",
      "systemctl restart mosquitto",
      // Surface startup failures directly in cloud-init output.
      "systemctl --no-pager --full status mosquitto || (journalctl -u mosquitto --no-pager -n 200; exit 1)",
      // Install MQTT -> DynamoDB ingest worker
      "cat > /opt/mqtt_ingest.py <<'PYEOF'",
      ...fs
        .readFileSync(
          path.join(__dirname, "..", "lambda", "mqtt_ingest", "mqtt_ingest.py"),
          "utf-8",
        )
        .trimEnd()
        .split("\n"),
      "PYEOF",
      "chmod +x /opt/mqtt_ingest.py",
      "cat > /etc/systemd/system/mqtt-ingest.service <<'EOF'",
      "[Unit]",
      "Description=MQTT position ingest worker",
      "After=network-online.target mosquitto.service",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "Environment=MQTT_HOST=127.0.0.1",
      "Environment=MQTT_PORT=1884",
      `Environment=MQTT_USERNAME=${squigglyUploaderUsername}`,
      `Environment=MQTT_PASSWORD=${squigglyUploaderPassword}`,
      `Environment=TABLE_NAME=${positionsTable.tableName}`,
      `Environment=ALLOWED_CHANNEL=${allowedChannel}`,
      `Environment=PUBLISH_TOPIC=${publishTopic}`,
      `Environment=AWS_REGION=${this.region}`,
      `Environment=LOG_LEVEL=${ingestLogLevel}`,
      "Environment=STATS_LOG_EVERY=100",
      "ExecStart=/usr/bin/python3 /opt/mqtt_ingest.py",
      "Restart=always",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "EOF",
      "systemctl daemon-reload",
      "systemctl enable mqtt-ingest",
      "systemctl restart mqtt-ingest",
      // Ship instance logs to CloudWatch for EC2-level troubleshooting.
      "mkdir -p /opt/aws/amazon-cloudwatch-agent/etc",
      "cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'EOF'",
      "{",
      '  "agent": {',
      '    "run_as_user": "root"',
      "  },",
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      "          {",
      '            "file_path": "/var/log/cloud-init-output.log",',
      `            "log_group_name": "${cloudInitInstanceLogGroup.logGroupName}",`,
      '            "log_stream_name": "{instance_id}",',
      '            "timezone": "UTC"',
      "          },",
      "          {",
      '            "file_path": "/var/log/syslog",',
      `            "log_group_name": "${syslogInstanceLogGroup.logGroupName}",`,
      '            "log_stream_name": "{instance_id}",',
      '            "timezone": "UTC"',
      "          },",
      "          {",
      '            "file_path": "/var/log/mosquitto-selfcheck.log",',
      `            "log_group_name": "${mosquittoSelfCheckLogGroup.logGroupName}",`,
      '            "log_stream_name": "{instance_id}",',
      '            "timezone": "UTC"',
      "          }",
      "        ]",
      "      }",
      "    }",
      "  }",
      "}",
      "EOF",
      "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s",
    );

    // ── EC2 instance ────────────────────────────────────────────────────────
    const instance = new ec2.Instance(this, "MqttInstanceV2", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: sg,
      userData,
      role,
      detailedMonitoring: true,
      // IMDSv2 required for better security
      requireImdsv2: true,
      // Force instance replacement when user data changes
      userDataCausesReplacement: true,
    });

    const cpuCreditBalanceMetric = new cloudwatch.Metric({
      namespace: "AWS/EC2",
      metricName: "CPUCreditBalance",
      dimensionsMap: { InstanceId: instance.instanceId },
      statistic: "Minimum",
      period: cdk.Duration.minutes(5),
    });
    const cpuUtilizationMetric = new cloudwatch.Metric({
      namespace: "AWS/EC2",
      metricName: "CPUUtilization",
      dimensionsMap: { InstanceId: instance.instanceId },
      statistic: "Average",
      period: cdk.Duration.minutes(5),
    });
    const statusCheckFailedMetric = new cloudwatch.Metric({
      namespace: "AWS/EC2",
      metricName: "StatusCheckFailed",
      dimensionsMap: { InstanceId: instance.instanceId },
      statistic: "Maximum",
      period: cdk.Duration.minutes(1),
    });
    const statusCheckFailedSystemMetric = new cloudwatch.Metric({
      namespace: "AWS/EC2",
      metricName: "StatusCheckFailed_System",
      dimensionsMap: { InstanceId: instance.instanceId },
      statistic: "Maximum",
      period: cdk.Duration.minutes(1),
    });
    const statusCheckFailedInstanceMetric = new cloudwatch.Metric({
      namespace: "AWS/EC2",
      metricName: "StatusCheckFailed_Instance",
      dimensionsMap: { InstanceId: instance.instanceId },
      statistic: "Maximum",
      period: cdk.Duration.minutes(1),
    });

    const ec2StatusCheckAlarm = new cloudwatch.Alarm(
      this,
      "Ec2StatusCheckAlarm",
      {
        alarmDescription: "EC2 instance failed one or more status checks",
        metric: statusCheckFailedMetric,
        threshold: 1,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );
    ec2StatusCheckAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(alarmTopic),
    );

    const ec2SystemStatusCheckAlarm = new cloudwatch.Alarm(
      this,
      "Ec2SystemStatusCheckAlarm",
      {
        alarmDescription: "EC2 instance failed system-level status checks",
        metric: statusCheckFailedSystemMetric,
        threshold: 1,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );
    ec2SystemStatusCheckAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(alarmTopic),
    );

    const ec2CpuHighAlarm = new cloudwatch.Alarm(this, "Ec2CpuHighAlarm", {
      alarmDescription: "EC2 instance CPU is sustained above 80%",
      metric: cpuUtilizationMetric,
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    ec2CpuHighAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    const ec2CpuCreditsLowAlarm = new cloudwatch.Alarm(
      this,
      "Ec2CpuCreditsLowAlarm",
      {
        alarmDescription: "EC2 t3 CPU credit balance is low",
        metric: cpuCreditBalanceMetric,
        threshold: 10,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );
    ec2CpuCreditsLowAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(alarmTopic),
    );

    const ec2Dashboard = new cloudwatch.Dashboard(this, "MqttEc2Dashboard", {
      dashboardName: `${cdk.Stack.of(this).stackName}-ec2`,
    });
    ec2Dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "EC2 Health Checks",
        left: [
          statusCheckFailedMetric,
          statusCheckFailedSystemMetric,
          statusCheckFailedInstanceMetric,
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "EC2 CPU",
        left: [cpuUtilizationMetric, cpuCreditBalanceMetric],
      }),
    );

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
        "Command to check installation logs on the instance over SSM",
    });
    new cdk.CfnOutput(this, "Ec2AlarmTopicArn", {
      value: alarmTopic.topicArn,
      description: "SNS topic ARN used by EC2 health and utilization alarms",
    });
    new cdk.CfnOutput(this, "Ec2DashboardName", {
      value: ec2Dashboard.dashboardName,
      description: "CloudWatch dashboard with EC2 health and CPU metrics",
    });
    new cdk.CfnOutput(this, "Ec2CloudInitLogGroup", {
      value: cloudInitInstanceLogGroup.logGroupName,
      description:
        "CloudWatch Logs group for cloud-init output from the EC2 broker",
    });
    new cdk.CfnOutput(this, "Ec2SyslogLogGroup", {
      value: syslogInstanceLogGroup.logGroupName,
      description: "CloudWatch Logs group for EC2 syslog entries",
    });
    new cdk.CfnOutput(this, "Ec2MosquittoSelfCheckLogGroup", {
      value: mosquittoSelfCheckLogGroup.logGroupName,
      description: "CloudWatch Logs group for Mosquitto self-check output",
    });
    new cdk.CfnOutput(this, "IngestServiceLogs", {
      value: "sudo journalctl -u mqtt-ingest -f --no-pager",
      description: "Command to follow MQTT ingest service logs",
    });
    new cdk.CfnOutput(this, "ConnectHint", {
      value: cdk.Fn.join("", [
        'EC2 Console → select instance → Connect → "Session Manager" tab, ',
        "or: aws ssm start-session --target ",
        instance.instanceId,
      ]),
      description: "How to open a shell on the broker instance",
    });
    new cdk.CfnOutput(this, "MqttSquigglyConsumerUsername", {
      value: squigglyConsumerUsername,
      description: "Existing squiggly consumer username (public listener)",
    });
    new cdk.CfnOutput(this, "MqttUploaderUsername", {
      value: mqttUploaderUsername,
      description: "MQTT uploader username (public listener)",
    });
    new cdk.CfnOutput(this, "MqttSquigglyUploaderUsername", {
      value: squigglyUploaderUsername,
      description: "EC2-local squiggly uploader username (internal listener)",
    });
    new cdk.CfnOutput(this, "MqttMeshadminUsername", {
      value: meshAdminUsername,
      description: "Admin MQTT username with full read/write permissions",
    });
    new cdk.CfnOutput(this, "AllowedChannel", {
      value: allowedChannel,
      description: "Only this MQTT channel is ingested for position data",
    });
    new cdk.CfnOutput(this, "PublishTopic", {
      value: publishTopic,
      description:
        "MQTT topic where endpoint-shaped position updates are published",
    });
    new cdk.CfnOutput(this, "PositionsTableName", {
      value: positionsTable.tableName,
      description: "DynamoDB table storing latest position per senderId",
    });
    new cdk.CfnOutput(this, "PositionsApiBaseUrl", {
      value: positionsApiBaseUrl,
      description: "API Gateway HTTP API base URL for positions API",
    });
    new cdk.CfnOutput(this, "PositionsApiPreferredBaseUrl", {
      value: positionsApiCustomBaseUrl || positionsApiBaseUrl,
      description:
        "Preferred API base URL (custom domain when configured, otherwise execute-api)",
    });
    new cdk.CfnOutput(this, "PositionsApiGetKeys", {
      value: cdk.Fn.join("", [positionsApiBaseUrl, "positions/keys"]),
      description: "Get all sender IDs currently stored",
    });
    new cdk.CfnOutput(this, "PositionsApiGetLatest", {
      value: cdk.Fn.join("", [positionsApiBaseUrl, "positions/latest"]),
      description: "Get all latest positions",
    });
    new cdk.CfnOutput(this, "PositionsApiGetBySender", {
      value: cdk.Fn.join("", [positionsApiBaseUrl, "positions/<senderId>"]),
      description: "Get latest position by senderId",
    });
    new cdk.CfnOutput(this, "PositionsApiTest", {
      value: cdk.Fn.join("", [positionsApiBaseUrl, "test"]),
      description: "Unauthenticated reachability check – no x-api-key needed",
    });
    new cdk.CfnOutput(this, "PositionsApiTestAuth", {
      value: cdk.Fn.join("", [positionsApiBaseUrl, "testAuth"]),
      description: "Authenticated test – confirms x-api-key is accepted",
    });
    new cdk.CfnOutput(this, "PositionsApiAuthHeader", {
      value: "x-api-key",
      description: "Include this header on Position API requests",
    });
    new cdk.CfnOutput(this, "PositionsApiLogGroupName", {
      value: apiLogGroup.logGroupName,
      description: "CloudWatch log group for the positions API Lambda",
    });
    new cdk.CfnOutput(this, "PositionsApiTailCommand", {
      value: cdk.Fn.join("", [
        "aws logs tail ",
        apiLogGroup.logGroupName,
        " --follow",
      ]),
      description: "Exact command to tail API Lambda logs",
    });
  }
}
