# MQTT_CDK

A TypeScript AWS CDK project that provisions a small EC2 instance with a fixed Elastic IP address running the [Mosquitto](https://mosquitto.org/) MQTT broker.

## What gets deployed

| Resource | Details |
|---|---|
| **VPC** | Single-AZ public VPC (no NAT gateway) |
| **EC2 instance** | `t3.micro`, Amazon Linux 2023 |
| **Elastic IP** | Fixed public IP address attached to the instance |
| **Security group** | Inbound: SSH (22), MQTT (1883), MQTT-TLS (8883) |
| **Mosquitto** | Installed via `dnf`, listening on port 1883 (anonymous mode) |

Stack outputs include the Elastic IP and the full `mqtt://…:1883` endpoint.

---

## Prerequisites

| Tool | Install |
|---|---|
| Node.js 18+ | [nodejs.org](https://nodejs.org/) |
| AWS CLI | [docs.aws.amazon.com/cli](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| AWS CDK v2 | `npm install -g aws-cdk` |

Configure your AWS credentials before deploying:

```bash
aws configure
```

---

## Quickstart (GitHub Codespaces)

This repository includes a [Dev Container](.devcontainer/devcontainer.json) that automatically installs the AWS CDK, AWS CLI, and all Node.js dependencies.

1. Click **Code → Open with Codespaces** in GitHub.
2. Once the Codespace is ready, configure your AWS credentials:

   ```bash
   aws configure
   ```

3. Bootstrap your AWS account (first time only):

   ```bash
   cdk bootstrap
   ```

4. Deploy the stack:

   ```bash
   cdk deploy
   ```

---

## Local setup

```bash
# Clone the repo
git clone https://github.com/DaneEvans/MQTT_CDK.git
cd MQTT_CDK

# Install dependencies
npm install

# Bootstrap (first time per account/region)
cdk bootstrap

# Deploy
cdk deploy
```

---

## Useful CDK commands

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm run watch` | Watch and recompile on change |
| `cdk ls` | List all stacks |
| `cdk synth` | Synthesise CloudFormation template |
| `cdk diff` | Compare deployed stack with current code |
| `cdk deploy` | Deploy the stack to your AWS account |
| `cdk destroy` | Destroy the deployed stack |

---

## Testing

```bash
npm test
```

---

## Connecting to the broker

After `cdk deploy` completes, the stack prints the broker endpoint:

```
Outputs:
MqttCdkStack.MqttPublicIp      = 1.2.3.4
MqttCdkStack.MqttBrokerEndpoint = mqtt://1.2.3.4:1883
```

Use any MQTT client to connect, for example with `mosquitto_pub`:

```bash
mosquitto_pub -h 1.2.3.4 -t test/hello -m "Hello MQTT"
```

> **Note:** For production use, restrict the SSH security-group rule to your own IP, enable TLS on port 8883, and disable anonymous access in `/etc/mosquitto/conf.d/default.conf`.

