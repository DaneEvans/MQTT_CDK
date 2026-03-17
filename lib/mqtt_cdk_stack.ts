import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

/**
 * CDK Stack that provisions:
 *  - A dual-stack VPC with a public subnet
 *  - A small EC2 instance (t3.micro) running Amazon Linux 2
 *  - A public IPv6 address attached to the instance (no billed public IPv4)
 *  - Mosquitto MQTT broker installed and configured via user data
 *  - A security group that opens port 1883 (MQTT) and 22 (SSH) over IPv6
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
    const positionsApiKey = config.api?.key;
    if (!positionsApiKey || typeof positionsApiKey !== "string") {
      throw new Error(
        "config.json is missing api.key (required for Positions API auth)",
      );
    }

    // ── Latest positions storage ────────────────────────────────────────────
    const positionsTable = new dynamodb.Table(this, "LatestPositionsTable", {
      partitionKey: { name: "senderId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── API Lambda (Function URL) ──────────────────────────────────────────
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

    const positionsApiUrl = positionsApiFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedMethods: [lambda.HttpMethod.GET],
        allowedOrigins: ["*"],
      },
    });

    // ── VPC ────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "MqttVpc", {
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      ipv6Addresses: ec2.Ipv6Addresses.amazonProvided(),
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
      description: "Allow MQTT (1883) and SSH (22) inbound over IPv6",
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });

    // SSH over IPv6 for hosts with IPv6 connectivity; SSM remains available without SSH.
    sg.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(22),
      "SSH / EC2 Instance Connect over IPv6",
    );
    // MQTT plain-text over IPv6
    sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(1883), "MQTT over IPv6");
    // MQTT over TLS (optional, useful for future use)
    // sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(8883), "MQTT TLS over IPv6");

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
      "echo 'mqtt-cdk bootstrap v2' > /etc/mqtt-cdk-bootstrap-version",
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
      "listener 1883",
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
      "#!/usr/bin/env python3",
      "import json",
      "import logging",
      "import os",
      "import time",
      "from decimal import Decimal",
      "",
      "import boto3",
      "import paho.mqtt.client as mqtt",
      "",
      "MQTT_HOST = os.environ.get('MQTT_HOST', '127.0.0.1')",
      "MQTT_PORT = int(os.environ.get('MQTT_PORT', '1883'))",
      "MQTT_USERNAME = os.environ.get('MQTT_USERNAME')",
      "MQTT_PASSWORD = os.environ.get('MQTT_PASSWORD')",
      "TABLE_NAME = os.environ['TABLE_NAME']",
      "ALLOWED_CHANNEL = os.environ.get('ALLOWED_CHANNEL', '').strip()",
      "AWS_REGION = os.environ.get('AWS_REGION', 'ap-southeast-2')",
      "LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO').upper()",
      "STATS_LOG_EVERY = int(os.environ.get('STATS_LOG_EVERY', '100'))",
      "",
      "logging.basicConfig(",
      "    level=getattr(logging, LOG_LEVEL, logging.INFO),",
      "    format='%(asctime)s %(levelname)s mqtt-ingest %(message)s',",
      ")",
      "logger = logging.getLogger('mqtt-ingest')",
      "",
      "stats = {",
      "    'received': 0,",
      "    'stored': 0,",
      "    'filtered_channel': 0,",
      "    'non_json': 0,",
      "    'non_position': 0,",
      "    'missing_sender': 0,",
      "    'missing_position': 0,",
      "    'nodeinfo': 0,",
      "}",
      "",
      "ddb = boto3.resource('dynamodb', region_name=AWS_REGION)",
      "table = ddb.Table(TABLE_NAME)",
      "",
      "",
      "def _log_stats_if_needed(reason):",
      "    total = stats['received']",
      "    if total % STATS_LOG_EVERY == 0:",
      "        logger.info('stats reason=%s %s', reason, json.dumps(stats, sort_keys=True))",
      "",
      "",
      "def _node_id(from_int):",
      '    """Convert integer node id to \'!xxxxxxxx\' hex string."""',
      "    return '!' + format(int(from_int) & 0xFFFFFFFF, '08x')",
      "",
      "",
      "def _extract_sender(topic_parts, payload_obj):",
      "    # Use 'from' integer field as the canonical node id (hex with ! prefix)",
      "    if isinstance(payload_obj, dict) and payload_obj.get('from') is not None:",
      "        return _node_id(payload_obj['from'])",
      "    # Fallback: explicit sender field or last topic segment",
      "    if isinstance(payload_obj, dict):",
      "        sender = payload_obj.get('sender') or payload_obj.get('senderId')",
      "        if sender:",
      "            return str(sender)",
      "    if topic_parts:",
      "        return topic_parts[-1]",
      "    return None",
      "",
      "",
      "def _is_position_packet(topic, payload_obj):",
      "    topic_l = topic.lower()",
      "    if '/position/' in topic_l:",
      "        return True",
      "    if not isinstance(payload_obj, dict):",
      "        return False",
      "    packet_type = str(payload_obj.get('type', '')).lower()",
      "    port_num = str(payload_obj.get('portnum', '')).lower()",
      "    if packet_type == 'position' or port_num == 'position_app':",
      "        return True",
      "    pos = payload_obj.get('position')",
      "    if isinstance(pos, dict):",
      "        return True",
      "    keys = {'lat', 'lon', 'latitude', 'longitude', 'latitudeI', 'longitudeI'}",
      "    return any(k in payload_obj for k in keys)",
      "",
      "",
      "def _extract_position(payload_obj):",
      "    if not isinstance(payload_obj, dict):",
      "        return None",
      "",
      "    # Meshtastic JSON format: position fields are nested under 'payload'",
      "    # Older JSON may use a 'position' key; protobuf-decoded may be top-level",
      "    if isinstance(payload_obj.get('payload'), dict):",
      "        src = payload_obj['payload']",
      "    elif isinstance(payload_obj.get('position'), dict):",
      "        src = payload_obj['position']",
      "    else:",
      "        src = payload_obj",
      "",
      "    # Support both snake_case (Meshtastic JSON) and camelCase variants",
      "    lat_i = next((src[k] for k in ('latitude_i', 'latitudeI') if k in src), None)",
      "    lon_i = next((src[k] for k in ('longitude_i', 'longitudeI') if k in src), None)",
      "",
      "    lat = src.get('lat') or src.get('latitude')",
      "    lon = src.get('lon') or src.get('longitude')",
      "",
      "    if lat is None and isinstance(lat_i, (int, float)):",
      "        lat = float(lat_i) / 1e7",
      "    if lon is None and isinstance(lon_i, (int, float)):",
      "        lon = float(lon_i) / 1e7",
      "",
      "    if lat is None or lon is None:",
      "        return None",
      "",
      "    result = {",
      "        'lat': Decimal(str(lat)),",
      "        'lon': Decimal(str(lon)),",
      "    }",
      "",
      "    for camel, snake in [('altitude', 'altitude'), ('satsInView', 'sats_in_view'),",
      "                          ('groundTrack', 'ground_track'), ('groundSpeed', 'ground_speed')]:",
      "        value = next((src[k] for k in (camel, snake) if k in src), None)",
      "        if isinstance(value, (int, float)):",
      "            result[camel] = Decimal(str(value))",
      "",
      "    return result",
      "",
      "",
      "def _is_nodeinfo_packet(topic, payload_obj):",
      "    if '/nodeinfo/' in topic.lower():",
      "        return True",
      "    return isinstance(payload_obj, dict) and payload_obj.get('type') == 'nodeinfo'",
      "",
      "",
      "def _handle_nodeinfo(sender_id, channel, topic, payload_obj):",
      "    payload = payload_obj.get('payload', {})",
      "    longname = payload.get('longname')",
      "    shortname = payload.get('shortname')",
      "    if not longname and not shortname:",
      "        return",
      "    try:",
      "        table.update_item(",
      "            Key={'senderId': sender_id},",
      "            UpdateExpression='SET longname = :l, shortname = :s, channel = if_not_exists(channel, :c), updatedNodeinfoAt = :t',",
      "            ExpressionAttributeValues={",
      "                ':l': longname or '',",
      "                ':s': shortname or '',",
      "                ':c': channel,",
      "                ':t': int(time.time() * 1000),",
      "            },",
      "        )",
      "        stats['nodeinfo'] += 1",
      "        logger.info('nodeinfo stored senderId=%s longname=%s shortname=%s', sender_id, longname, shortname)",
      "    except Exception:",
      "        logger.exception('failed to store nodeinfo senderId=%s topic=%s', sender_id, topic)",
      "",
      "",
      "def on_connect(client, _userdata, _flags, rc):",
      "    if rc == 0:",
      "        client.subscribe('msh/#')",
      "        logger.info('connected to mqtt host=%s port=%s subscribed=msh/# channel_filter=%s table=%s', MQTT_HOST, MQTT_PORT, ALLOWED_CHANNEL or '*', TABLE_NAME)",
      "    else:",
      "        logger.error('mqtt connect failed rc=%s', rc)",
      "",
      "",
      "def on_disconnect(_client, _userdata, rc):",
      "    if rc != 0:",
      "        logger.warning('unexpected mqtt disconnect rc=%s', rc)",
      "",
      "",
      "def on_message(_client, _userdata, msg):",
      "    topic = msg.topic",
      "    topic_parts = topic.split('/')",
      "    channel = topic_parts[1] if len(topic_parts) > 1 else ''",
      "    stats['received'] += 1",
      "",
      "    if ALLOWED_CHANNEL and channel != ALLOWED_CHANNEL:",
      "        stats['filtered_channel'] += 1",
      "        _log_stats_if_needed('filtered_channel')",
      "        return",
      "",
      "    try:",
      "        payload_obj = json.loads(msg.payload.decode('utf-8'))",
      "    except Exception:",
      "        stats['non_json'] += 1",
      "        if stats['non_json'] <= 5 or stats['non_json'] % STATS_LOG_EVERY == 0:",
      "            logger.info('non-json payload dropped topic=%s bytes=%s', topic, len(msg.payload or b''))",
      "        _log_stats_if_needed('non_json')",
      "        return",
      "",
      "    sender_id = _extract_sender(topic_parts, payload_obj)",
      "    if not sender_id:",
      "        stats['missing_sender'] += 1",
      "        _log_stats_if_needed('missing_sender')",
      "        return",
      "",
      "    if _is_nodeinfo_packet(topic, payload_obj):",
      "        _handle_nodeinfo(sender_id, channel, topic, payload_obj)",
      "        return",
      "",
      "    if not _is_position_packet(topic, payload_obj):",
      "        stats['non_position'] += 1",
      "        _log_stats_if_needed('non_position')",
      "        return",
      "",
      "    position = _extract_position(payload_obj)",
      "    if not position:",
      "        stats['missing_position'] += 1",
      "        _log_stats_if_needed('missing_position')",
      "        return",
      "",
      "    item = {",
      "        'senderId': sender_id,",
      "        'channel': channel,",
      "        'topic': topic,",
      "        'updatedAt': int(time.time() * 1000),",
      "        'position': position,",
      "    }",
      "",
      "    try:",
      "        table.put_item(Item=item)",
      "        stats['stored'] += 1",
      "        logger.info('stored senderId=%s channel=%s lat=%s lon=%s updatedAt=%s', sender_id, channel, position.get('lat'), position.get('lon'), item['updatedAt'])",
      "        _log_stats_if_needed('stored')",
      "    except Exception:",
      "        logger.exception('failed to store senderId=%s topic=%s', sender_id, topic)",
      "",
      "",
      "def main():",
      "    logger.info('starting mqtt ingest worker')",
      "    client = mqtt.Client()",
      "    if MQTT_USERNAME:",
      "        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)",
      "    client.on_connect = on_connect",
      "    client.on_disconnect = on_disconnect",
      "    client.on_message = on_message",
      "    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)",
      "    client.loop_forever()",
      "",
      "",
      "if __name__ == '__main__':",
      "    main()",
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
      ipv6AddressCount: 1,
      // IMDSv2 required for better security
      requireImdsv2: true,
      // Force instance replacement when user data changes
      userDataCausesReplacement: true,
    });

    const brokerIpv6Lookup = new cr.AwsCustomResource(
      this,
      "MqttBrokerIpv6Lookup",
      {
        onCreate: {
          service: "EC2",
          action: "describeInstances",
          parameters: { InstanceIds: [instance.instanceId] },
          outputPaths: [
            "Reservations.0.Instances.0.NetworkInterfaces.0.Ipv6Addresses.0.Ipv6Address",
          ],
          physicalResourceId: cr.PhysicalResourceId.of(
            `${cdk.Names.uniqueId(instance)}-ipv6`,
          ),
        },
        onUpdate: {
          service: "EC2",
          action: "describeInstances",
          parameters: { InstanceIds: [instance.instanceId] },
          outputPaths: [
            "Reservations.0.Instances.0.NetworkInterfaces.0.Ipv6Addresses.0.Ipv6Address",
          ],
          physicalResourceId: cr.PhysicalResourceId.of(
            `${cdk.Names.uniqueId(instance)}-ipv6`,
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      },
    );
    const brokerIpv6 = brokerIpv6Lookup.getResponseField(
      "Reservations.0.Instances.0.NetworkInterfaces.0.Ipv6Addresses.0.Ipv6Address",
    );

    // ── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "MqttBrokerIpv6", {
      value: brokerIpv6,
      description:
        "Current public IPv6 address of the MQTT broker (stable for this instance, changes on replacement)",
    });
    new cdk.CfnOutput(this, "MqttBrokerEndpoint", {
      value: cdk.Fn.join("", ["mqtt://[", brokerIpv6, "]:1883"]),
      description: "MQTT broker endpoint over IPv6",
    });
    new cdk.CfnOutput(this, "VerifyMosquittoSSH", {
      value: cdk.Fn.join("", [
        "ssh -i <your-key.pem> ec2-user@",
        "[",
        brokerIpv6,
        "]",
        " 'sudo systemctl status mosquitto'",
      ]),
      description: "SSH command to verify mosquitto is running over IPv6",
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
    new cdk.CfnOutput(this, "PositionsTableName", {
      value: positionsTable.tableName,
      description: "DynamoDB table storing latest position per senderId",
    });
    new cdk.CfnOutput(this, "PositionsApiBaseUrl", {
      value: positionsApiUrl.url,
      description: "Function URL base for positions API",
    });
    new cdk.CfnOutput(this, "PositionsApiGetKeys", {
      value: cdk.Fn.join("", [positionsApiUrl.url, "positions/keys"]),
      description: "Get all sender IDs currently stored",
    });
    new cdk.CfnOutput(this, "PositionsApiGetLatest", {
      value: cdk.Fn.join("", [positionsApiUrl.url, "positions/latest"]),
      description: "Get all latest positions",
    });
    new cdk.CfnOutput(this, "PositionsApiGetBySender", {
      value: cdk.Fn.join("", [positionsApiUrl.url, "positions/<senderId>"]),
      description: "Get latest position by senderId",
    });
    new cdk.CfnOutput(this, "PositionsApiTest", {
      value: cdk.Fn.join("", [positionsApiUrl.url, "test"]),
      description: "Unauthenticated reachability check – no x-api-key needed",
    });
    new cdk.CfnOutput(this, "PositionsApiTestAuth", {
      value: cdk.Fn.join("", [positionsApiUrl.url, "testAuth"]),
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
