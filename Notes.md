Current state : works

Configure:

- Setup API key (config.json)
- the mqtt username and password.
- ensure that SSH is blocked (prod) or open for dev

```
cdk deploy
```

- Take note of the public IP,
- and the PositionsApiBaseUrl

Setup meshtastic node:

- Set a node up on a network with internet.
- Turn MQTT on
- set server, username & pwd
- TLS off, encryption off, json on.
- ensure that channel > ok to mqtt is set for all nodes you'd like to track

testing that it's transmitting:
On the EC2 (if you left the SSH open (not for deployment))

```bash
sudo journalctl -u mqtt-ingest -f --no-pager
```

To get data out of the other end via api

```
GET PositionsApiBaseUrl xxx
most endpoints need Header x-api-key, and the key from the config above.

```

Supported endpoints are
/test (no auth)

```
{
	"status": "ok",
	"message": "API is reachable"
}
```

/testAuth

```
{
	"status": "ok",
	"message": "Authentication successful"
}
```

/positions/keys
/positions/latest
/positions/<senderId>

```

```
