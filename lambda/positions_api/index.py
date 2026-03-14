import json
import logging
import os
from decimal import Decimal

import boto3

TABLE_NAME = os.environ.get("POSITIONS_TABLE_NAME", "")
API_KEY = os.environ.get("POSITIONS_API_KEY", "")

ddb = boto3.resource("dynamodb")
logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _decimal_to_number(value):
    if isinstance(value, list):
        return [_decimal_to_number(v) for v in value]
    if isinstance(value, dict):
        return {k: _decimal_to_number(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    return value


def _json(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(body),
    }


def _normalize_path(event):
    path = event.get("rawPath") or event.get("path") or "/"
    trimmed = path.rstrip("/")
    return trimmed if trimmed else "/"


def _authorized(event):
    if not API_KEY:
        return False

    headers = event.get("headers") or {}
    provided = headers.get("x-api-key") or headers.get("X-Api-Key")
    return provided == API_KEY


def _scan_all_items(table):
    items = []
    start_key = None

    while True:
        kwargs = {
            "ProjectionExpression": "senderId, #channel, #topic, updatedAt, #position",
            "ExpressionAttributeNames": {
                "#channel": "channel",
                "#topic": "topic",
                "#position": "position",
            },
        }
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key

        res = table.scan(**kwargs)
        items.extend(res.get("Items", []))
        start_key = res.get("LastEvaluatedKey")
        if not start_key:
            break

    return items


def handler(event, _context):
    path = _normalize_path(event)
    method = ((event.get("requestContext") or {}).get("http") or {}).get("method")

    logger.info("request method=%s path=%s", method, path)

    if method != "GET":
        logger.info("method not allowed method=%s path=%s", method, path)
        return _json(405, {"error": "Method not allowed"})

    # ── Open endpoints (no auth) ────────────────────────────────────────────
    if path == "/test":
        return _json(200, {"status": "ok", "message": "API is reachable"})

    # ── Auth-required endpoints ─────────────────────────────────────────────
    if not TABLE_NAME:
        logger.error("missing environment variable POSITIONS_TABLE_NAME")
        return _json(500, {"error": "Missing POSITIONS_TABLE_NAME"})

    if not _authorized(event):
        logger.warning("unauthorized request path=%s", path)
        return _json(401, {"error": "Unauthorized"})

    if path == "/testAuth":
        return _json(200, {"status": "ok", "message": "Authentication successful"})

    table = ddb.Table(TABLE_NAME)

    if path == "/positions/keys":
        items = _scan_all_items(table)
        keys = sorted([item.get("senderId") for item in items if item.get("senderId")])
        logger.info("served keys count=%s", len(keys))
        return _json(200, {"keys": keys})

    if path == "/positions/latest":
        items = _scan_all_items(table)
        sorted_items = sorted(items, key=lambda i: i.get("updatedAt", 0), reverse=True)
        logger.info("served latest count=%s", len(sorted_items))
        return _json(200, {"positions": _decimal_to_number(sorted_items)})

    if path.startswith("/positions/") and path.count("/") == 2:
        sender_id = path.split("/", 2)[2]
        if not sender_id:
            return _json(400, {"error": "Missing senderId"})

        res = table.get_item(Key={"senderId": sender_id})
        item = res.get("Item")
        if not item:
            logger.info("sender not found senderId=%s", sender_id)
            return _json(404, {"error": "senderId not found", "senderId": sender_id})

        logger.info("served sender senderId=%s", sender_id)
        return _json(200, _decimal_to_number(item))

    logger.info("route not found path=%s", path)
    return _json(
        404,
        {
            "error": "Not found",
            "routes": [
                "GET /test           (no auth)",
                "GET /testAuth       (requires x-api-key)",
                "GET /positions/keys",
                "GET /positions/latest",
                "GET /positions/{senderId}",
            ],
        },
    )
