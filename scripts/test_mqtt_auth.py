#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path


def run_cmd(cmd, timeout=8):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def load_creds(config_path: Path):
    data = json.loads(config_path.read_text(encoding="utf-8"))
    mqtt = data.get("mqtt", {})
    required = {
        "meshadmin": "meshadmin",
        "uploader": "uploader",
        "squigglyConsumer": "squigglyConsumer",
        "squigglyUploader": "squigglyUploader",
    }
    creds = {}
    missing = []
    for key, label in required.items():
        entry = mqtt.get(key, {})
        username = entry.get("username")
        password = entry.get("password")
        if not username or not password:
            missing.append(label)
        else:
            creds[label] = (username, password)

    if missing:
        raise ValueError(f"Missing mqtt credentials in config for: {', '.join(missing)}")
    return creds


def publish(host, port, username, password, topic, payload):
    cmd = [
        "mosquitto_pub",
        "-h",
        host,
        "-p",
        str(port),
        "-t",
        topic,
        "-m",
        payload,
        "-u",
        username,
        "-P",
        password,
    ]
    return run_cmd(cmd)


def read_test(host, port, test_user, test_pass, admin_user, admin_pass, topic):
    payload = f"auth-read-{int(time.time() * 1000)}"
    sub_cmd = [
        "mosquitto_sub",
        "-h",
        host,
        "-p",
        str(port),
        "-t",
        topic,
        "-C",
        "1",
        "-W",
        "4",
        "-u",
        test_user,
        "-P",
        test_pass,
    ]
    sub_proc = subprocess.Popen(sub_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(0.5)
    pub_res = publish(host, port, admin_user, admin_pass, topic, payload)
    stdout, stderr = sub_proc.communicate(timeout=6)

    got_message = payload in (stdout or "")
    details = {
        "sub_rc": sub_proc.returncode,
        "sub_stdout": (stdout or "").strip(),
        "sub_stderr": (stderr or "").strip(),
        "pub_rc": pub_res.returncode,
        "pub_stderr": (pub_res.stderr or "").strip(),
    }
    return got_message, details


def write_test(host, port, test_user, test_pass, admin_user, admin_pass, topic):
    payload = f"auth-write-{int(time.time() * 1000)}"
    sub_cmd = [
        "mosquitto_sub",
        "-h",
        host,
        "-p",
        str(port),
        "-t",
        topic,
        "-C",
        "1",
        "-W",
        "4",
        "-u",
        admin_user,
        "-P",
        admin_pass,
    ]
    sub_proc = subprocess.Popen(sub_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(0.5)
    pub_res = publish(host, port, test_user, test_pass, topic, payload)
    stdout, stderr = sub_proc.communicate(timeout=6)

    got_message = payload in (stdout or "")
    details = {
        "sub_rc": sub_proc.returncode,
        "sub_stdout": (stdout or "").strip(),
        "sub_stderr": (stderr or "").strip(),
        "pub_rc": pub_res.returncode,
        "pub_stderr": (pub_res.stderr or "").strip(),
    }
    return got_message, details


def print_result(ok, name, expected, details):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} (expected: {expected})")
    if not ok:
        print(f"      details: sub_rc={details.get('sub_rc')} pub_rc={details.get('pub_rc')}")
        if details.get("sub_stderr"):
            print(f"      sub_err: {details['sub_stderr']}")
        if details.get("pub_stderr"):
            print(f"      pub_err: {details['pub_stderr']}")


def main():
    parser = argparse.ArgumentParser(description="Test MQTT pub/sub auth rules for configured users")
    parser.add_argument("--host", required=True, help="MQTT host to test (for example 54.66.41.137)")
    parser.add_argument("--port", type=int, default=1883, help="MQTT port for public listener (default: 1883)")
    parser.add_argument(
        "--config",
        default="config.json",
        help="Path to config file containing mqtt credentials (default: config.json)",
    )
    parser.add_argument(
        "--internal-host",
        default=None,
        help="Optional host for internal listener checks of squigglyUploader",
    )
    parser.add_argument(
        "--internal-port",
        type=int,
        default=1884,
        help="Internal listener port (default: 1884)",
    )
    args = parser.parse_args()

    for binary in ["mosquitto_pub", "mosquitto_sub"]:
        if run_cmd(["bash", "-lc", f"command -v {binary}"]).returncode != 0:
            print(f"Missing required binary: {binary}")
            return 2

    try:
        creds = load_creds(Path(args.config))
    except Exception as exc:
        print(f"Failed to load config: {exc}")
        return 2

    admin_user, admin_pass = creds["meshadmin"]
    uploader_user, uploader_pass = creds["uploader"]
    consumer_user, consumer_pass = creds["squigglyConsumer"]
    squiggly_uploader_user, squiggly_uploader_pass = creds["squigglyUploader"]

    total = 0
    failures = 0

    checks = [
        ("meshadmin can write any topic", "allow", "write", admin_user, admin_pass, "meshadmin/authz/write"),
        ("meshadmin can read any topic", "allow", "read", admin_user, admin_pass, "meshadmin/authz/read"),
        ("uploader can write non-squiggly", "allow", "write", uploader_user, uploader_pass, "test/uploader/write"),
        ("uploader cannot write squiggly/#", "deny", "write", uploader_user, uploader_pass, "squiggly/blocked/write"),
        ("uploader cannot read squiggly/#", "deny", "read", uploader_user, uploader_pass, "squiggly/blocked/read"),
        ("squigglyConsumer can read squiggly/#", "allow", "read", consumer_user, consumer_pass, "squiggly/consumer/read"),
        ("squigglyConsumer cannot write squiggly/#", "deny", "write", consumer_user, consumer_pass, "squiggly/consumer/write"),
        (
            "squigglyUploader cannot use public listener",
            "deny",
            "write",
            squiggly_uploader_user,
            squiggly_uploader_pass,
            "test/public/squigglyUploader",
        ),
    ]

    print(f"Testing MQTT auth on {args.host}:{args.port} using {args.config}")
    for name, expected, mode, user, pwd, topic in checks:
        total += 1
        if mode == "read":
            got, details = read_test(args.host, args.port, user, pwd, admin_user, admin_pass, topic)
        else:
            got, details = write_test(args.host, args.port, user, pwd, admin_user, admin_pass, topic)

        ok = got if expected == "allow" else not got
        if not ok:
            failures += 1
        print_result(ok, name, expected, details)

    if args.internal_host:
        print(f"\nRunning optional internal-listener checks on {args.internal_host}:{args.internal_port}")
        total += 1
        got, details = read_test(
            args.internal_host,
            args.internal_port,
            squiggly_uploader_user,
            squiggly_uploader_pass,
            admin_user,
            admin_pass,
            "msh/internal/read",
        )
        ok = got
        if not ok:
            failures += 1
        print_result(ok, "squigglyUploader can read msh/# on internal listener", "allow", details)

        total += 1
        got, details = write_test(
            args.internal_host,
            args.internal_port,
            squiggly_uploader_user,
            squiggly_uploader_pass,
            admin_user,
            admin_pass,
            "squiggly/internal/write",
        )
        ok = got
        if not ok:
            failures += 1
        print_result(ok, "squigglyUploader can write squiggly/# on internal listener", "allow", details)

    print(f"\nSummary: {total - failures}/{total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
