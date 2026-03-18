#!/usr/bin/env python3
import json
import logging
import os
import time
from decimal import Decimal

import boto3
import paho.mqtt.client as mqtt

MQTT_HOST = os.environ.get('MQTT_HOST', '127.0.0.1')
MQTT_PORT = int(os.environ.get('MQTT_PORT', '1883'))
MQTT_USERNAME = os.environ.get('MQTT_USERNAME')
MQTT_PASSWORD = os.environ.get('MQTT_PASSWORD')
TABLE_NAME = os.environ['TABLE_NAME']
ALLOWED_CHANNEL = os.environ.get('ALLOWED_CHANNEL', '').strip()
PUBLISH_TOPIC = os.environ.get('PUBLISH_TOPIC', 'squiggly').strip() or 'squiggly'
AWS_REGION = os.environ.get('AWS_REGION', 'ap-southeast-2')
LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO').upper()
STATS_LOG_EVERY = int(os.environ.get('STATS_LOG_EVERY', '100'))

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format='%(asctime)s %(levelname)s mqtt-ingest %(message)s',
)
logger = logging.getLogger('mqtt-ingest')

stats = {
    'received': 0,
    'stored': 0,
    'filtered_channel': 0,
    'non_json': 0,
    'non_position': 0,
    'missing_sender': 0,
    'missing_position': 0,
    'nodeinfo': 0,
    'published': 0,
    'publish_skipped_empty': 0,
    'publish_failed': 0,
}

ddb = boto3.resource('dynamodb', region_name=AWS_REGION)
table = ddb.Table(TABLE_NAME)


def _log_stats_if_needed(reason):
    total = stats['received']
    if total % STATS_LOG_EVERY == 0:
        logger.info('stats reason=%s %s', reason, json.dumps(stats, sort_keys=True))


def _node_id(from_int):
    """Convert integer node id to '!xxxxxxxx' hex string."""
    return '!' + format(int(from_int) & 0xFFFFFFFF, '08x')


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


def _to_publish_record(item):
    return _decimal_to_number({
        'senderId': item.get('senderId'),
        'channel': item.get('channel'),
        'topic': item.get('topic'),
        'updatedAt': item.get('updatedAt'),
        'updatedNodeinfoAt': item.get('updatedNodeinfoAt'),
        'shortname': item.get('shortname', ''),
        'longname': item.get('longname', ''),
        'position': item.get('position'),
    })


def _publish_position(client, item):
    position = item.get('position') or {}
    lat = position.get('lat')
    lon = position.get('lon')
    if lat == 0 and lon == 0:
        stats['publish_skipped_empty'] += 1
        logger.info('publish skipped empty position senderId=%s topic=%s', item.get('senderId'), PUBLISH_TOPIC)
        return

    payload = _to_publish_record(item)
    try:
        result = client.publish(PUBLISH_TOPIC, json.dumps(payload), qos=0, retain=False)
        if result.rc == mqtt.MQTT_ERR_SUCCESS:
            stats['published'] += 1
            logger.info('published topic=%s senderId=%s updatedAt=%s', PUBLISH_TOPIC, payload.get('senderId'), payload.get('updatedAt'))
        else:
            stats['publish_failed'] += 1
            logger.warning('publish failed topic=%s senderId=%s rc=%s', PUBLISH_TOPIC, payload.get('senderId'), result.rc)
    except Exception:
        stats['publish_failed'] += 1
        logger.exception('publish exception topic=%s senderId=%s', PUBLISH_TOPIC, payload.get('senderId'))


def _extract_sender(topic_parts, payload_obj):
    # Use 'from' integer field as the canonical node id (hex with ! prefix)
    if isinstance(payload_obj, dict) and payload_obj.get('from') is not None:
        return _node_id(payload_obj['from'])
    # Fallback: explicit sender field or last topic segment
    if isinstance(payload_obj, dict):
        sender = payload_obj.get('sender') or payload_obj.get('senderId')
        if sender:
            return str(sender)
    if topic_parts:
        return topic_parts[-1]
    return None


def _is_position_packet(topic, payload_obj):
    topic_l = topic.lower()
    if '/position/' in topic_l:
        return True
    if not isinstance(payload_obj, dict):
        return False
    packet_type = str(payload_obj.get('type', '')).lower()
    port_num = str(payload_obj.get('portnum', '')).lower()
    if packet_type == 'position' or port_num == 'position_app':
        return True
    pos = payload_obj.get('position')
    if isinstance(pos, dict):
        return True
    keys = {'lat', 'lon', 'latitude', 'longitude', 'latitudeI', 'longitudeI'}
    return any(k in payload_obj for k in keys)


def _extract_position(payload_obj):
    if not isinstance(payload_obj, dict):
        return None

    # Meshtastic JSON format: position fields are nested under 'payload'
    # Older JSON may use a 'position' key; protobuf-decoded may be top-level
    if isinstance(payload_obj.get('payload'), dict):
        src = payload_obj['payload']
    elif isinstance(payload_obj.get('position'), dict):
        src = payload_obj['position']
    else:
        src = payload_obj

    # Support both snake_case (Meshtastic JSON) and camelCase variants
    lat_i = next((src[k] for k in ('latitude_i', 'latitudeI') if k in src), None)
    lon_i = next((src[k] for k in ('longitude_i', 'longitudeI') if k in src), None)

    lat = src.get('lat') or src.get('latitude')
    lon = src.get('lon') or src.get('longitude')

    if lat is None and isinstance(lat_i, (int, float)):
        lat = float(lat_i) / 1e7
    if lon is None and isinstance(lon_i, (int, float)):
        lon = float(lon_i) / 1e7

    if lat is None or lon is None:
        return None

    result = {
        'lat': Decimal(str(lat)),
        'lon': Decimal(str(lon)),
    }

    for camel, snake in [('altitude', 'altitude'), ('satsInView', 'sats_in_view'),
                          ('groundTrack', 'ground_track'), ('groundSpeed', 'ground_speed')]:
        value = next((src[k] for k in (camel, snake) if k in src), None)
        if isinstance(value, (int, float)):
            result[camel] = Decimal(str(value))

    return result


def _is_nodeinfo_packet(topic, payload_obj):
    if '/nodeinfo/' in topic.lower():
        return True
    return isinstance(payload_obj, dict) and payload_obj.get('type') == 'nodeinfo'


def _handle_nodeinfo(sender_id, channel, topic, payload_obj):
    payload = payload_obj.get('payload', {})
    longname = payload.get('longname')
    shortname = payload.get('shortname')
    if not longname and not shortname:
        return
    try:
        table.update_item(
            Key={'senderId': sender_id},
            UpdateExpression='SET longname = :l, shortname = :s, channel = if_not_exists(channel, :c), updatedNodeinfoAt = :t',
            ExpressionAttributeValues={
                ':l': longname or '',
                ':s': shortname or '',
                ':c': channel,
                ':t': int(time.time() * 1000),
            },
        )
        stats['nodeinfo'] += 1
        logger.info('nodeinfo stored senderId=%s longname=%s shortname=%s', sender_id, longname, shortname)
    except Exception:
        logger.exception('failed to store nodeinfo senderId=%s topic=%s', sender_id, topic)


def on_connect(client, _userdata, _flags, rc):
    if rc == 0:
        client.subscribe('msh/#')
        logger.info('connected to mqtt host=%s port=%s subscribed=msh/# channel_filter=%s table=%s', MQTT_HOST, MQTT_PORT, ALLOWED_CHANNEL or '*', TABLE_NAME)
    else:
        logger.error('mqtt connect failed rc=%s', rc)


def on_disconnect(_client, _userdata, rc):
    if rc != 0:
        logger.warning('unexpected mqtt disconnect rc=%s', rc)


def on_message(client, _userdata, msg):
    topic = msg.topic
    topic_parts = topic.split('/')
    channel = topic_parts[1] if len(topic_parts) > 1 else ''
    stats['received'] += 1

    if ALLOWED_CHANNEL and channel != ALLOWED_CHANNEL:
        stats['filtered_channel'] += 1
        _log_stats_if_needed('filtered_channel')
        return

    try:
        payload_obj = json.loads(msg.payload.decode('utf-8'))
    except Exception:
        stats['non_json'] += 1
        if stats['non_json'] <= 5 or stats['non_json'] % STATS_LOG_EVERY == 0:
            logger.info('non-json payload dropped topic=%s bytes=%s', topic, len(msg.payload or b''))
        _log_stats_if_needed('non_json')
        return

    sender_id = _extract_sender(topic_parts, payload_obj)
    if not sender_id:
        stats['missing_sender'] += 1
        _log_stats_if_needed('missing_sender')
        return

    if _is_nodeinfo_packet(topic, payload_obj):
        _handle_nodeinfo(sender_id, channel, topic, payload_obj)
        return

    if not _is_position_packet(topic, payload_obj):
        stats['non_position'] += 1
        _log_stats_if_needed('non_position')
        return

    position = _extract_position(payload_obj)
    if not position:
        stats['missing_position'] += 1
        _log_stats_if_needed('missing_position')
        return

    item = {
        'senderId': sender_id,
        'channel': channel,
        'topic': topic,
        'updatedAt': int(time.time() * 1000),
        'position': position,
    }

    try:
        res = table.update_item(
            Key={'senderId': sender_id},
            UpdateExpression='SET #channel = :c, #topic = :t, updatedAt = :u, #position = :p',
            ExpressionAttributeNames={
                '#channel': 'channel',
                '#topic': 'topic',
                '#position': 'position',
            },
            ExpressionAttributeValues={
                ':c': channel,
                ':t': topic,
                ':u': item['updatedAt'],
                ':p': position,
            },
            ReturnValues='ALL_NEW',
        )
        stored_item = res.get('Attributes', item)
        stats['stored'] += 1
        logger.info('stored senderId=%s channel=%s lat=%s lon=%s updatedAt=%s', sender_id, channel, position.get('lat'), position.get('lon'), item['updatedAt'])
        _publish_position(client, stored_item)
        _log_stats_if_needed('stored')
    except Exception:
        logger.exception('failed to store senderId=%s topic=%s', sender_id, topic)


def main():
    logger.info('starting mqtt ingest worker')
    client = mqtt.Client()
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_forever()


if __name__ == '__main__':
    main()
