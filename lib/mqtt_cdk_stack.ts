import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
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
    const mqttUsername = config.mqtt?.username || "meshdev";
    const mqttPassword = config.mqtt?.password || "large4cats";
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
      description: "Allow MQTT (1883) and SSH (22) inbound",
      allowAllOutbound: true,
    });

    // SSH – open for EC2 Instance Connect; restrict to your own IP in production if preferred
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "SSH / EC2 Instance Connect",
    );
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
    positionsTable.grantWriteData(role);

    // ── User data – install & start Mosquitto ───────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Update packages
      "yum update -y",
      // Enable EPEL and install mosquitto
      "amazon-linux-extras install epel -y",
      "yum install -y mosquitto",
      "yum install -y python3 python3-pip",
      "python3 -m pip install --upgrade pip",
      "python3 -m pip install 'paho-mqtt==1.6.1' boto3",
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
      "Environment=MQTT_PORT=1883",
      `Environment=MQTT_USERNAME=${mqttUsername}`,
      `Environment=MQTT_PASSWORD=${mqttPassword}`,
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
    );

    // ── EC2 instance ────────────────────────────────────────────────────────
    const instance = new ec2.Instance(this, "MqttInstanceV2", {
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
    new cdk.CfnOutput(this, "IngestServiceLogs", {
      value: "sudo journalctl -u mqtt-ingest -f --no-pager",
      description: "Command to follow MQTT ingest service logs",
    });
    new cdk.CfnOutput(this, "ConnectHint", {
      value: cdk.Fn.join("", [
        'EC2 Console → select instance → Connect → "Session Manager" tab (no SSH needed), ',
        'or "EC2 Instance Connect" tab (uses the SSH port now open), ',
        "or: aws ssm start-session --target ",
        instance.instanceId,
      ]),
      description: "How to open a shell on the broker instance",
    });
    new cdk.CfnOutput(this, "MqttUsername", {
      value: mqttUsername,
      description: "MQTT broker username",
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
