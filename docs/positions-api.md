# MQTT Positions API

Human-readable API reference for service teams consuming the positions API.

Machine-readable spec: [openapi/positions-api.openapi.yaml](/workspaces/MQTT_CDK/openapi/positions-api.openapi.yaml)

## Base URL

Use the deployed stack output `PositionsApiBaseUrl`.

Example:

```text
https://your-function-id.lambda-url.ap-southeast-2.on.aws/
```

## Authentication

- `GET /test` does not require authentication.
- All other endpoints require the `x-api-key` header.

Example:

```http
x-api-key: replace-with-your-api-key
```

## Conventions

- Only `GET` is supported.
- Trailing slashes are accepted and normalize to the same route.
- `senderId` is typically a Meshtastic node id in `!xxxxxxxx` format.
- `/positions/latest` and `/positions/{senderId}` return the same record shape.
- `shortname` and `longname` are always present and default to an empty string when node info has not been ingested yet.

## Endpoints

### `GET /test`

Reachability check.

Auth: none

Response `200`

```json
{
  "status": "ok",
  "message": "API is reachable"
}
```

### `GET /testAuth`

Authentication check.

Auth: required

Response `200`

```json
{
  "status": "ok",
  "message": "Authentication successful"
}
```

Response `401`

```json
{
  "error": "Unauthorized"
}
```

### `GET /positions/keys`

Returns all known sender ids, sorted ascending.

Auth: required

Response `200`

```json
{
  "keys": ["!a0cb10f8", "!f00dbabe"]
}
```

### `GET /positions/latest`

Returns the latest stored record for every sender.

Auth: required

Response `200`

```json
{
  "positions": [
    {
      "senderId": "!a0cb10f8",
      "channel": "ANZ",
      "topic": "msh/ANZ/2/json/!a0cb10f8",
      "updatedAt": 1710485699123,
      "updatedNodeinfoAt": 1710485600000,
      "shortname": "Alpha",
      "longname": "Field Node Alpha",
      "position": {
        "lat": -33.865143,
        "lon": 151.2099,
        "altitude": 42,
        "satsInView": 8,
        "groundTrack": 270,
        "groundSpeed": 1.5
      }
    }
  ]
}
```

### `GET /positions/{senderId}`

Returns the latest stored record for one sender.

Auth: required

Path parameter:

| Name       | Type   | Required | Description                                    |
| ---------- | ------ | -------- | ---------------------------------------------- |
| `senderId` | string | yes      | Sender identifier, usually in `!xxxxxxxx` form |

Response `200`

```json
{
  "senderId": "!a0cb10f8",
  "channel": "ANZ",
  "topic": "msh/ANZ/2/json/!a0cb10f8",
  "updatedAt": 1710485699123,
  "updatedNodeinfoAt": 1710485600000,
  "shortname": "Alpha",
  "longname": "Field Node Alpha",
  "position": {
    "lat": -33.865143,
    "lon": 151.2099,
    "altitude": 42,
    "satsInView": 8,
    "groundTrack": 270,
    "groundSpeed": 1.5
  }
}
```

Response `404`

```json
{
  "error": "senderId not found",
  "senderId": "!deadbeef"
}
```

## Shared Record Shape

Used by:

- `GET /positions/latest` items
- `GET /positions/{senderId}` response

| Field               | Type   | Nullable | Notes                                      |
| ------------------- | ------ | -------- | ------------------------------------------ |
| `senderId`          | string | no       | Sender identifier                          |
| `channel`           | string | yes      | MQTT channel                               |
| `topic`             | string | yes      | Source MQTT topic                          |
| `updatedAt`         | int64  | yes      | Position update timestamp in milliseconds  |
| `updatedNodeinfoAt` | int64  | yes      | Node info update timestamp in milliseconds |
| `shortname`         | string | no       | Empty string when unavailable              |
| `longname`          | string | no       | Empty string when unavailable              |
| `position`          | object | yes      | Latest position payload                    |

### `position` object

| Field         | Type   | Required |
| ------------- | ------ | -------- |
| `lat`         | number | no       |
| `lon`         | number | no       |
| `altitude`    | number | no       |
| `satsInView`  | number | no       |
| `groundTrack` | number | no       |
| `groundSpeed` | number | no       |

## Common Errors

### `401 Unauthorized`

```json
{
  "error": "Unauthorized"
}
```

### `405 Method not allowed`

```json
{
  "error": "Method not allowed"
}
```

### `500 Missing POSITIONS_TABLE_NAME`

```json
{
  "error": "Missing POSITIONS_TABLE_NAME"
}
```
