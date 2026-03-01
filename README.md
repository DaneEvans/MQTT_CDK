# MQTT_CDK

A TypeScript AWS CDK project that provisions a small EC2 instance with a fixed Elastic IP address running the [Mosquitto](https://mosquitto.org/) MQTT broker.

## What gets deployed

| Resource           | Details                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **VPC**            | Single-AZ public VPC (no NAT gateway)                                                       |
| **EC2 instance**   | `t3.micro`, Amazon Linux 2                                                                  |
| **Elastic IP**     | Fixed public IP address attached to the instance                                            |
| **Security group** | Inbound: SSH (22), MQTT (1883), MQTT-TLS (8883)                                             |
| **Mosquitto**      | Installed via EPEL (`amazon-linux-extras` + `yum`), listening on port 1883 (anonymous mode) |

Stack outputs include the Elastic IP and the full `mqtt://…:1883` endpoint.

---

## Prerequisites

| Tool        | Install                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Node.js 18+ | [nodejs.org](https://nodejs.org/)                                                                        |
| AWS CLI     | [docs.aws.amazon.com/cli](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| AWS CDK v2  | `npm install -g aws-cdk`                                                                                 |

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

| Command         | Description                              |
| --------------- | ---------------------------------------- |
| `npm run build` | Compile TypeScript                       |
| `npm run watch` | Watch and recompile on change            |
| `cdk ls`        | List all stacks                          |
| `cdk synth`     | Synthesise CloudFormation template       |
| `cdk diff`      | Compare deployed stack with current code |
| `cdk deploy`    | Deploy the stack to your AWS account     |
| `cdk destroy`   | Destroy the deployed stack               |

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

Use any MQTT client to connect with credentials from `config.json`, for example with `mosquitto_pub`:

```bash
# Send a message
mosquitto_pub -h 1.2.3.4 -t test/hello -m "Hello MQTT" -u meshdev -P large4cats

# Subscribe to all topics
mosquitto_sub -h 1.2.3.4 -t '#' -v -u meshdev -P large4cats
```

> **Note:** For production use, restrict the SSH security-group rule to your own IP, enable TLS on port 8883, and disable anonymous access in `/etc/mosquitto/conf.d/default.conf`.

## Notes

using mosquitto
To subscribe (everything)

```
mosquitto_sub -h 54.252.83.244 -t '#' -v -u meshdev -P large4cats
```

Meshtastic settings:
MQTT enabled - true
Address - <ip address>:1883
username - 'meshdev'
pwd - 'large4cats'

Meshtastic seems to connect to it fine, but it appears to be in a binary format, but the text is visible within it. It doesn't want to forward other nodes packets yet - trying moving it to a router_late to fix that ??
Nope, not that. Need 'Settings - Lora - Ok to MQTT' on the sending device.

```
msh/ANZ/2/e/temp/!a0cb10f8
�ˠ�����*
        ��λ��"Cw�05��s=Ҵ�iHXdx��temp    !a0cb10f8

msh/ANZ/2/e/temp/!a0cb10f8
�ˠ����Ooo gghhkjyddgjiik ooo5��s=붢iHXdx��temp  !a0cb10f8
msh/ANZ/2/e/temp/!a0cb10f8
�ˠ����Try json upload5��s=淢iHXdx��temp !a0cb10f8
msh/ANZ/2/e/temp/!a0cb10f8

```
