# MQTT_CDK

A TypeScript AWS CDK project that provisions a small EC2 instance with a fixed Elastic IP address running the [Mosquitto](https://mosquitto.org/) MQTT broker, plus low-cost latest-position storage and read APIs.

## What gets deployed

| Resource           | Details                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| **VPC**            | Single-AZ public VPC (no NAT gateway)                                                         |
| **EC2 instance**   | `t3.micro`, Amazon Linux 2                                                                    |
| **Elastic IP**     | Fixed public IP address attached to the instance                                              |
| **Security group** | Inbound: SSH (22), MQTT (1883), MQTT-TLS (8883)                                               |
| **Mosquitto**      | Installed via EPEL (`amazon-linux-extras` + `yum`), listening on port 1883 (anonymous mode)   |
| **Ingest worker**  | Python systemd service on EC2; filters one channel and stores only latest position per sender |
| **DynamoDB**       | `PAY_PER_REQUEST` table keyed by `senderId` for latest position records                       |
| **API Gateway API** | Serverless GET endpoints for keys, all latest positions, and position-by-sender              |

Stack outputs include the MQTT endpoint plus API URLs.

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

## Configuration

Set MQTT credentials and channel filter in `config.json`:

```json
{
  "mqtt": {
    "username": "meshdev",
    "password": "large4cats"
  },
  "ingest": {
    "allowedChannel": "ANZ"
  },
  "api": {
    "key": "replace-with-strong-api-key"
  }
}
```

Only packets from `ingest.allowedChannel` are considered for storage.
The ingest worker stores only packets it can parse as JSON position data.

`ingest.logLevel` controls worker verbosity (`INFO` recommended, `DEBUG` for deep troubleshooting).

---

## Meshtastic Payload Reality

Meshtastic MQTT traffic is not always plain JSON:

- You may see binary/protobuf payloads on many topics, especially with encrypted packets.
- Meshtastic topics containing `/e/` are encrypted frames; they are expected to be binary and not JSON.
- This stack currently ingests JSON-decodable packets only.
- If a payload is binary or not JSON, it is dropped and logged as `non-json payload dropped`.
- Position detection currently accepts payloads where one of these is true:
  - `type == position`
  - `portnum == position_app`
  - a `position` object exists
  - direct lat/lon fields exist (`lat`, `lon`, `latitude`, `longitude`, `latitudeI`, `longitudeI`)

So this is not a fake stub, but it is a JSON-first parser and will not decode raw protobuf frames.

---

## Position API

Preferred public hostnames:

- MQTT broker: `mqtt.goneepic.com:1883`

After each deploy, confirm that `mqtt.goneepic.com` still routes to the latest broker endpoint. The API should be consumed using the current `PositionsApiBaseUrl` output from `cdk deploy` unless you add a separate custom domain in front of it.

After deployment, use the stack output `PositionsApiBaseUrl` and append one of:

- `GET /positions/keys` - all stored sender IDs
- `GET /positions/latest` - latest position record for each sender ID
- `GET /positions/{senderId}` - latest position record for one sender ID

Example:

```bash
curl -H "x-api-key: <your-api-key>" "https://<http-api-id>.execute-api.<region>.amazonaws.com/positions/keys"
curl -H "x-api-key: <your-api-key>" "https://<http-api-id>.execute-api.<region>.amazonaws.com/positions/latest"
curl -H "x-api-key: <your-api-key>" "https://<http-api-id>.execute-api.<region>.amazonaws.com/positions/%21a0cb10f8"
```

Requests without the `x-api-key` header (or with an invalid key) return `401 Unauthorized`.

For service-to-service integration, use the OpenAPI spec in [openapi/positions-api.openapi.yaml](/workspaces/MQTT_CDK/openapi/positions-api.openapi.yaml).

For a GitHub-friendly rendered version, see [docs/positions-api.md](/workspaces/MQTT_CDK/docs/positions-api.md).

For an interactive Swagger UI, see [docs/swagger.html](/workspaces/MQTT_CDK/docs/swagger.html). If you want it shareable in a browser, serve the repo over HTTP or enable GitHub Pages from the `docs/` folder.

GitHub Pages deployment is configured in [.github/workflows/pages.yml](/workspaces/MQTT_CDK/.github/workflows/pages.yml). Once Pages is enabled for GitHub Actions in the repository settings, the published site will expose a landing page at `docs/index.html` and the Swagger UI at `docs/swagger.html`.

`GET /positions/latest` and `GET /positions/{senderId}` now share the same response shape, including `shortname` and `longname` fields.

### DNS Updates In VentraIP

Use VentraIP as the public DNS control plane for the consumer-facing hostnames.

For `mqtt.goneepic.com`:

1. Open the domain in VentraIP and go to DNS management.
2. Find or create the `mqtt` host record.
3. Set it as an `A` record pointing to the current `MqttPublicIp` output from `cdk deploy`.
4. Keep the port at `1883` in client configuration; DNS only maps the hostname.

For the API:

CDK can configure an API Gateway custom domain automatically when these are set in `config.json`:

- `api.customDomainName` (for example `api.goneepic.com`)
- `api.certificateArn` (ACM certificate ARN in the same region as the HTTP API)

Once the certificate is issued and validated, it normally remains stable and you can keep reusing the same ARN for future deploys.

After deploying with custom-domain config, use stack outputs:

- `PositionsApiCustomDomainTarget` as the VentraIP DNS target
- `PositionsApiCustomBaseUrl` as the preferred API URL
- `PositionsApiPreferredBaseUrl` as a safe fallback output (custom domain when present, otherwise execute-api)

In VentraIP, create/update the `api` host as `CNAME` (or `ALIAS` if preferred by your DNS policy) pointing to `PositionsApiCustomDomainTarget`.

After each deploy:

1. Check whether `MqttPublicIp` changed. If it did, update the VentraIP `A` record for `mqtt`.
2. If custom domain is enabled, confirm `api` points to `PositionsApiCustomDomainTarget`; otherwise use `PositionsApiBaseUrl` directly.
3. Verify resolution and connectivity before handing the endpoints to consumers.

Suggested verification:

```bash
dig +short mqtt.goneepic.com
dig +short api.goneepic.com
curl -H "x-api-key: <your-api-key>" "https://api.goneepic.com/testAuth"
mosquitto_sub -h mqtt.goneepic.com -t '#' -v -u meshdev -P large4cats
```

---

## Observability

On EC2 (ingest worker):

```bash
sudo journalctl -u mqtt-ingest -f --no-pager
```

You should see:

- startup/connect messages
- periodic stats snapshots (`received`, `stored`, `non_json`, etc.)
- one log line per successful stored position

If you are not seeing stored positions, look for:

- `non-json payload dropped` (binary/protobuf payloads)
- high `filtered_channel` counts (wrong channel)
- `missing_position` / `missing_sender`

For Lambda API logs (CloudWatch), use the stack output `PositionsApiTailCommand` or run:

```bash
aws logs tail /aws/lambda/mqtt-positions-api --follow
```

The API now logs request path/method, unauthorized requests, and result counts.

---

## Connecting to the broker

After `cdk deploy` completes, the stack prints the broker endpoint:

```
Outputs:
MqttCdkStack.MqttPublicIp      = 1.2.3.4
MqttCdkStack.MqttBrokerEndpoint = mqtt://1.2.3.4:1883
MqttCdkStack.PositionsApiBaseUrl = https://...
```

Treat the MQTT output as a deployment target behind `mqtt.goneepic.com`. The API should be consumed using the latest `PositionsApiBaseUrl` output unless you add a separate custom domain in front of it.

Use any MQTT client to connect with credentials from `config.json`, for example with `mosquitto_pub`:

```bash
# Send a message
mosquitto_pub -h mqtt.goneepic.com -t test/hello -m "Hello MQTT" -u meshdev -P large4cats

# Subscribe to all topics
mosquitto_sub -h mqtt.goneepic.com -t '#' -v -u meshdev -P large4cats
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
