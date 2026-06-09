#!/usr/bin/env python3
"""
Headless browser — teleop sender/tester for the WebSocket (and WebTransport)
data hub. Acts as the ?role=browser peer so you can exercise the full
relay → robot → relay path WITHOUT a browser, in either codec.

Useful for: debugging the relay/robot pipeline in isolation from the web UI,
and as a deterministic load generator for latency measurements.

Examples:
    # talk to a relay running `--type websocket --port 8443`
    python3 headless_browser.py --url ws://localhost:8443/ws/data \
            --format json --count 20 --hz 20

    # binary over wss (skip cert verification for self-signed dev certs)
    python3 headless_browser.py --url wss://localhost:8443/ws/data \
            --format binary --insecure

Pair it with the robot side, e.g.:
    python3 main.py --transport relay --data ws://localhost:8443/ws/data --format json
"""

import argparse
import asyncio
import json
import ssl
import statistics
import struct
import time

import aiohttp

from twist_protocol import (
    TwistWithLatency, LatencyTimestamps, ClockSyncRequest,
    TwistAck, ClockSyncResponse, MessageType, crc8,
)

MSG_TWIST, MSG_ACK = 0x01, 0x02
MSG_SYNC_REQ, MSG_SYNC_RESP = 0x03, 0x04


def now_ms() -> int:
    return int(time.time() * 1000)


# ── Browser-side encode/decode (mirrors web-client/modules/codec.js) ──────────

def encode_twist(fmt, msg_id, t1, mask, lx, ly, lz, ax, ay, az):
    if fmt == "json":
        names = ["linear_x", "linear_y", "linear_z", "angular_x", "angular_y", "angular_z"]
        vals = [lx, ly, lz, ax, ay, az]
        v = {names[i]: vals[i] for i in range(6) if mask & (1 << i)}
        return json.dumps({"t": MSG_TWIST, "id": msg_id, "t1": t1, "mask": mask, "v": v},
                          separators=(",", ":"))
    # binary: reuse the protocol's CRC-8 layout
    return TwistWithLatency(
        message_id=msg_id, field_mask=mask,
        linear_x=lx, linear_y=ly, linear_z=lz,
        angular_x=ax, angular_y=ay, angular_z=az,
        timestamps=LatencyTimestamps(t1_browser_send=t1),
    ).encode()


def encode_sync_req(fmt, t1):
    if fmt == "json":
        return json.dumps({"t": MSG_SYNC_REQ, "t1": t1}, separators=(",", ":"))
    return ClockSyncRequest(t1=t1).encode()


def peek_type(data):
    if isinstance(data, (bytes, bytearray)):
        return data[0]
    return int(json.loads(data).get("t", -1))


def decode_ack(fmt, data):
    if fmt == "json":
        o = json.loads(data)
        return dict(msg_id=o["id"], t1=o["t1"], t3=o["t3"], t4=o["t4"],
                    dec=o["dec"], proc=o["proc"], enc=o["enc"])
    a = TwistAck.decode_p2p(data)
    ts = a.timestamps
    return dict(msg_id=a.message_id, t1=ts.t1_browser_send, t3=ts.t3_python_rx,
                t4=ts.t4_python_ack, dec=ts.python_decode_us,
                proc=ts.python_process_us, enc=ts.python_encode_us)


def decode_sync_resp(fmt, data):
    if fmt == "json":
        o = json.loads(data)
        return o["t1"], o["t2"], o["t3"]
    r = ClockSyncResponse.decode(data)
    return r.t1, r.t2, r.t3


# ── Main ──────────────────────────────────────────────────────────────────────

async def run(args):
    ssl_ctx = None
    if args.url.startswith("wss://"):
        ssl_ctx = ssl.create_default_context()
        if args.insecure:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

    url = args.url + ("&" if "?" in args.url else "?") + "role=browser"
    print(f"  URL    : {url}")
    print(f"  Format : {args.format}")
    print(f"  Send   : {args.count} twists @ {args.hz} Hz\n")

    rtts, acks = [], 0
    async with aiohttp.ClientSession() as sess:
        async with sess.ws_connect(url, heartbeat=25.0, ssl=ssl_ctx) as ws:
            print("Connected to data hub as browser.\n")

            async def reader():
                nonlocal acks
                async for msg in ws:
                    if msg.type in (aiohttp.WSMsgType.BINARY, aiohttp.WSMsgType.TEXT):
                        data = msg.data
                        try:
                            t = peek_type(data)
                        except Exception:
                            continue
                        if t == MSG_ACK:
                            t6 = now_ms()
                            a = decode_ack(args.format, data)
                            rtt = t6 - a["t1"]
                            rtts.append(rtt)
                            acks += 1
                            if acks <= 10:
                                print(f"  ack #{a['msg_id']:>4}  RTT={rtt:>4}ms  "
                                      f"py[dec={a['dec']}us proc={a['proc']}us enc={a['enc']}us]")
                        elif t == MSG_SYNC_RESP:
                            _t1, _t2, _t3 = decode_sync_resp(args.format, data)
                    elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED,
                                      aiohttp.WSMsgType.ERROR):
                        break

            async def send_bytes_or_text(payload):
                if isinstance(payload, str):
                    await ws.send_str(payload)
                else:
                    await ws.send_bytes(payload)

            rtask = asyncio.create_task(reader())

            # warm up clock sync
            for _ in range(3):
                await send_bytes_or_text(encode_sync_req(args.format, now_ms()))
                await asyncio.sleep(0.1)

            # send twists
            period = 1.0 / args.hz
            for i in range(1, args.count + 1):
                payload = encode_twist(args.format, i, now_ms(), 0x22,
                                       0.0, 0.5, 0.0, 0.0, 0.0, -0.25)
                await send_bytes_or_text(payload)
                await asyncio.sleep(period)

            # drain acks
            await asyncio.sleep(0.5)
            rtask.cancel()

    print()
    if rtts:
        print(f"RESULT: {acks}/{args.count} acks  "
              f"RTT min/median/max = {min(rtts)}/{int(statistics.median(rtts))}/{max(rtts)} ms")
    else:
        print("RESULT: 0 acks received — is the robot (role=python) connected to the SAME "
              "data hub with a matching --format?")


def main():
    p = argparse.ArgumentParser(description="Headless browser teleop sender")
    p.add_argument("--url", default="ws://localhost:8443/ws/data",
                   help="data-hub URL (ws:// or wss://), without role")
    p.add_argument("--format", choices=["binary", "json"], default="binary")
    p.add_argument("--count", type=int, default=20)
    p.add_argument("--hz", type=float, default=20.0)
    p.add_argument("--insecure", action="store_true",
                   help="skip TLS verification for self-signed certs (wss only)")
    asyncio.run(run(p.parse_args()))


if __name__ == "__main__":
    main()