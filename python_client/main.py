#!/usr/bin/env python3
"""
WebRTC Twist Client (P2P)
=========================

Connects to the Go signaling server via WebSocket, negotiates a WebRTC
DataChannel with the browser, then handles binary robot-control messages
(Twist commands, acknowledgments, clock sync) peer-to-peer.

The Go server is ONLY used for the initial WebRTC handshake (SDP + ICE).
Once the RTCDataChannel opens, all data flows directly to the browser.

Architecture:
  Python ←──WS(signaling)──→ Go ←──WS(signaling)──→ Browser
  Python ←──────────── RTCDataChannel (P2P) ────────────────→ Browser

Binary Protocol (over DataChannel, all messages include trailing CRC-8/SMBUS byte):
  0x01  Twist          Browser → Python (19 + 8×N bytes)
  0x02  P2P Ack        Python → Browser (46 bytes)
  0x03  ClockSyncReq   Browser → Python (10 bytes)
  0x04  ClockSyncResp  Python → Browser (26 bytes)

Usage:
    python main.py [--signal ws://localhost:8080/ws/signal] [--topic /cmd_vel]

Dependencies:
    pip install aiortc aiohttp
"""

import asyncio
import argparse
import csv
import json
import logging
import os
import signal
import ssl
import sys
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Callable

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate
from aiortc.contrib.signaling import object_from_string

from twist_protocol import (
    TwistWithLatency, TwistAck, LatencyTimestamps,
    ClockSyncRequest, ClockSyncResponse,
    MessageType, current_time_ms, perf_counter_us,
    P2P_TWIST_ACK_SIZE,
)
from codec import make_codec
from session import TeleopSession

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("WebRTC-TwistClient")


# ─── Optional ROS2 ────────────────────────────────────────────────────────────

ROS2_AVAILABLE = False
try:
    import rclpy
    from rclpy.node import Node
    from geometry_msgs.msg import Twist
    ROS2_AVAILABLE = True
    logger.info("ROS2 available")
except ImportError:
    logger.info("ROS2 not available (running without robot)")


class ROS2Publisher:
    """Publishes Twist to a ROS2 topic."""

    def __init__(self, topic: str):
        self.topic = topic
        self._node = None
        self._pub = None
        self._ok = False

    def init(self) -> bool:
        if not ROS2_AVAILABLE:
            return False
        try:
            if not rclpy.ok():
                rclpy.init()
            self._node = rclpy.create_node('twist_bridge')
            self._pub = self._node.create_publisher(Twist, self.topic, 10)
            self._ok = True
            logger.info(f"ROS2 publisher: {self.topic}")
            return True
        except Exception as e:
            logger.error(f"ROS2 init failed: {e}")
            return False

    def publish(self, twist: TwistWithLatency):
        if not self._ok:
            return
        msg = Twist()
        msg.linear.x = twist.linear_x
        msg.linear.y = twist.linear_y
        msg.linear.z = twist.linear_z
        msg.angular.x = twist.angular_x
        msg.angular.y = twist.angular_y
        msg.angular.z = twist.angular_z
        self._pub.publish(msg)

    def shutdown(self):
        if self._node:
            self._node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


# ─── Stats ────────────────────────────────────────────────────────────────────

@dataclass
class Stats:
    def __init__(self, window: int = 100):
        self._latencies = deque(maxlen=window)
        self._decode_us = deque(maxlen=window)
        self._process_us = deque(maxlen=window)
        self._encode_us = deque(maxlen=window)
        self.rx_count = 0
        self.ack_count = 0

    def record(self, latency_ms: float, decode_us: int, process_us: int, encode_us: int):
        if latency_ms >= 0:
            self._latencies.append(latency_ms)
        self._decode_us.append(decode_us)
        self._process_us.append(process_us)
        self._encode_us.append(encode_us)
        self.rx_count += 1

    def avg(self, d: deque) -> float:
        return sum(d) / len(d) if d else 0.0

    def __str__(self) -> str:
        return (
            f"rx={self.rx_count} acks={self.ack_count} "
            f"lat={self.avg(self._latencies):.1f}ms "
            f"dec={self.avg(self._decode_us):.0f}μs "
            f"proc={self.avg(self._process_us):.0f}μs "
            f"enc={self.avg(self._encode_us):.0f}μs"
        )


# ─── Timestamp File Logger ────────────────────────────────────────────────────

class TimestampFileLogger:
    """Writes every Twist and ClockSync event to a CSV log file.

    Twist rows (type="TWIST"):
        time_iso          UTC wall-clock when the ack was sent (ISO-8601)
        seq               Running counter shared across TWIST + SYNC rows
        msg_id            Browser message ID
        t1_browser_ms     Browser send timestamp  (ms, browser epoch)
        t3_python_rx_ms   Python receive timestamp (ms, Python epoch)
        t4_python_ack_ms  Python ack timestamp     (ms, Python epoch)
        approx_lat_ms     t3 - t1  (raw, no clock correction — trend indicator)
        decode_us / process_us / encode_us   Per-stage Python durations (μs)
        total_python_us   decode + process + encode
        linear_x/y/z      Velocity fields
        angular_x/y/z     Velocity fields

    ClockSync rows (type="SYNC"):
        time_iso
        seq
        t1_browser_ms     Browser send time (echoed back)
        t2_python_rx_ms   Python receive time
        t3_python_tx_ms   Python transmit time
        sync_proc_us      (t3 - t2) in μs
    """

    ALL_FIELDS = [
        'time_iso', 'type', 'seq', 'msg_id',
        't1_browser_ms', 't3_python_rx_ms', 't4_python_ack_ms',
        'approx_lat_ms',
        'decode_us', 'process_us', 'encode_us', 'total_python_us',
        'linear_x', 'linear_y', 'linear_z',
        'angular_x', 'angular_y', 'angular_z',
        # SYNC-only columns (empty for TWIST rows)
        't2_python_rx_ms', 't3_python_tx_ms', 'sync_proc_us',
    ]

    def __init__(self, path: str):
        self._path   = path
        self._seq    = 0
        self._fh     = None
        self._writer = None

    def open(self):
        """Open (or append to) the CSV file; write column header if new."""
        new_file = not os.path.exists(self._path) or os.path.getsize(self._path) == 0
        self._fh = open(self._path, 'a', newline='', encoding='utf-8')
        self._writer = csv.DictWriter(
            self._fh, fieldnames=self.ALL_FIELDS, extrasaction='ignore',
        )
        if new_file:
            self._writer.writeheader()
            self._fh.flush()
        logger.info(f"Timestamp log → {os.path.abspath(self._path)}")

    def close(self):
        if self._fh:
            self._fh.flush()
            self._fh.close()
            self._fh = None

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat(timespec='milliseconds')

    def log_twist(self, twist) -> None:
        """Append one TWIST row (called after encode_us is populated)."""
        if self._writer is None:
            return
        self._seq += 1
        ts       = twist.timestamps
        total_us = ts.python_decode_us + ts.python_process_us + ts.python_encode_us
        self._writer.writerow({
            'time_iso':         self._now_iso(),
            'type':             'TWIST',
            'seq':              self._seq,
            'msg_id':           twist.message_id,
            't1_browser_ms':    ts.t1_browser_send,
            't3_python_rx_ms':  ts.t3_python_rx,
            't4_python_ack_ms': ts.t4_python_ack,
            'approx_lat_ms':    ts.t3_python_rx - ts.t1_browser_send,
            'decode_us':        ts.python_decode_us,
            'process_us':       ts.python_process_us,
            'encode_us':        ts.python_encode_us,
            'total_python_us':  total_us,
            'linear_x':         round(twist.linear_x,  6),
            'linear_y':         round(twist.linear_y,  6),
            'linear_z':         round(twist.linear_z,  6),
            'angular_x':        round(twist.angular_x, 6),
            'angular_y':        round(twist.angular_y, 6),
            'angular_z':        round(twist.angular_z, 6),
        })
        self._fh.flush()

    def log_sync(self, t1: int, t2: int, t3: int) -> None:
        """Append one SYNC row."""
        if self._writer is None:
            return
        self._seq += 1
        self._writer.writerow({
            'time_iso':         self._now_iso(),
            'type':             'SYNC',
            'seq':              self._seq,
            't1_browser_ms':    t1,
            't2_python_rx_ms':  t2,
            't3_python_tx_ms':  t3,
            'sync_proc_us':     (t3 - t2) * 1000,   # ms → μs
        })
        self._fh.flush()


# ─── P2P Twist Client ─────────────────────────────────────────────────────────

class P2PTwistClient:
    """
    Manages the full lifecycle:
      1. WebSocket signaling with Go
      2. WebRTC handshake (receive offer, send answer, ICE)
      3. DataChannel operation (Twist, Ack, ClockSync)
    """

    def __init__(
        self,
        signal_url: str,
        on_twist: Optional[Callable] = None,
        ros2_topic: Optional[str] = None,
        ts_logger: Optional['TimestampFileLogger'] = None,
        codec_name: str = "binary",
    ):
        # Ensure URL has ?role=python
        if "?" in signal_url:
            self._signal_url = f"{signal_url}&role=python"
        else:
            self._signal_url = f"{signal_url}?role=python"

        self.on_twist  = on_twist
        self.stats     = Stats()
        self._ts_log   = ts_logger   # TimestampFileLogger (may be None)
        self._codec    = make_codec(codec_name)
        self._session: Optional[TeleopSession] = None

        # WebSocket signaling state
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None

        # WebRTC state (one RTCPeerConnection per browser session)
        # We support one active peer at a time for simplicity
        self._pc: Optional[RTCPeerConnection] = None
        self._dc = None           # RTCDataChannel (set by browser)
        self._browser_id: str = ""  # ID of the browser we are paired with

        # ROS2
        self._ros2 = ROS2Publisher(ros2_topic) if ros2_topic else None

        # Shutdown event
        self._shutdown = asyncio.Event()

    # ── Connection ───────────────────────────────────────────────────────────

    async def run(self):
        """Connect to signaling server and wait for WebRTC sessions."""
        logger.info(f"Connecting to signaling: {self._signal_url}")

        if self._ros2:
            self._ros2.init()

        while not self._shutdown.is_set():
            try:
                await self._signaling_loop()
            except Exception as e:
                logger.error(f"Signaling error: {e}")
                await asyncio.sleep(3)
                logger.info("Reconnecting to signaling server...")

        await self._cleanup()

    async def _signaling_loop(self):
        """Connect to Go signaling WS and process messages until disconnect."""
        self._session = aiohttp.ClientSession()
        try:
            # Build SSL context for wss:// URLs.
            # Use ssl=False only when the server uses a self-signed cert and
            # you have not installed it in the system trust store; pass an
            # ssl.SSLContext with cafile set for proper certificate validation.
            ssl_ctx: ssl.SSLContext | bool | None = None
            if self._signal_url.startswith("wss://"):
                cafile = os.environ.get("TLS_CA")   # e.g. certs/cert.pem
                if cafile:
                    ssl_ctx = ssl.create_default_context(cafile=cafile)
                else:
                    # No CA provided — accept self-signed certs (dev only)
                    ssl_ctx = ssl.create_default_context()
                    ssl_ctx.check_hostname = False
                    ssl_ctx.verify_mode = ssl.CERT_NONE
            self._ws = await self._session.ws_connect(
                self._signal_url, heartbeat=25.0, ssl=ssl_ctx
            )
            logger.info("Signaling connected. Waiting for browser...")

            async for msg in self._ws:
                if self._shutdown.is_set():
                    break
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handle_signal(json.loads(msg.data))
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED):
                    logger.info("Signaling disconnected")
                    break
        finally:
            if self._ws and not self._ws.closed:
                await self._ws.close()
            await self._session.close()
            self._session = None
            self._ws = None

    # ── Signaling ────────────────────────────────────────────────────────────

    async def _handle_signal(self, msg: dict):
        msg_type = msg.get("type")

        if msg_type == "welcome":
            logger.info(f"Signaling welcome: my_id={msg.get('peer_id')}")

        elif msg_type == "peer_ready":
            role = msg.get("role")
            browser_id = msg.get("from_peer", "")
            logger.info(f"Peer ready: role={role} browser={browser_id}")
            # A new browser has connected and is ready to start P2P.
            # We close any existing PC before creating a new one.
            if self._pc is not None:
                await self._close_pc()
            self._browser_id = browser_id
            self._pc = RTCPeerConnection()
            self._setup_pc_callbacks(browser_id)

        elif msg_type == "offer":
            browser_id = msg.get("from_peer", "")
            sdp_str = msg.get("sdp", "")
            logger.info(f"Received offer from browser {browser_id}")

            if self._pc is None:
                # Peer-ready might not have arrived first; create PC now
                self._browser_id = browser_id
                self._pc = RTCPeerConnection()
                self._setup_pc_callbacks(browser_id)

            offer = RTCSessionDescription(sdp=sdp_str, type="offer")
            await self._pc.setRemoteDescription(offer)

            answer = await self._pc.createAnswer()
            await self._pc.setLocalDescription(answer)

            # Send answer back via signaling (include to_peer so Go can route it)
            await self._send_signal({
                "type": "answer",
                "sdp": self._pc.localDescription.sdp,
                "to_peer": browser_id,
            })
            logger.info(f"Sent answer to browser {browser_id}")

        elif msg_type == "ice_candidate":
            if self._pc is None:
                return
            candidate_str = msg.get("candidate", "")
            sdp_mid = msg.get("sdpMid", "")
            sdp_mline = msg.get("sdpMLineIndex", 0)
            if candidate_str:
                try:
                    candidate = RTCIceCandidate(
                        component=1,
                        foundation="",
                        ip="",
                        port=0,
                        priority=0,
                        protocol="",
                        type="",
                        sdpMid=sdp_mid,
                        sdpMLineIndex=sdp_mline,
                    )
                    # aiortc parses the candidate string from sdp attr format
                    # We reconstruct via the raw string approach
                    from aiortc.sdp import candidate_from_sdp
                    candidate = candidate_from_sdp(candidate_str.replace("candidate:", ""))
                    candidate.sdpMid = sdp_mid
                    candidate.sdpMLineIndex = sdp_mline
                    await self._pc.addIceCandidate(candidate)
                except Exception as e:
                    logger.debug(f"ICE candidate parse error (may be ok): {e}")

        elif msg_type == "peer_disconnected":
            logger.info(f"Browser disconnected: {msg.get('from_peer', '')}")
            if self._pc is not None:
                await self._close_pc()

    def _setup_pc_callbacks(self, browser_id: str):
        """Attach event handlers to a freshly created RTCPeerConnection."""
        pc = self._pc

        @pc.on("icecandidate")
        async def on_icecandidate(candidate):
            if candidate is None:
                return
            try:
                from aiortc.sdp import candidate_to_sdp
                cand_str = candidate_to_sdp(candidate)
                await self._send_signal({
                    "type": "ice_candidate",
                    "candidate": f"candidate:{cand_str}",
                    "sdpMid": candidate.sdpMid or "0",
                    "sdpMLineIndex": candidate.sdpMLineIndex or 0,
                    "to_peer": browser_id,
                })
            except Exception as e:
                logger.debug(f"ICE send error: {e}")

        @pc.on("datachannel")
        def on_datachannel(channel):
            logger.info(f"DataChannel opened: label={channel.label!r} — P2P active")
            self._dc = channel
            self._setup_dc_callbacks(channel)

        @pc.on("connectionstatechange")
        async def on_state():
            state = pc.connectionState
            logger.info(f"WebRTC state: {state}")
            if state in ("failed", "closed", "disconnected"):
                await self._close_pc()

    def _setup_dc_callbacks(self, channel):
        """Attach DataChannel handlers and build a codec-aware session.

        aiortc delivers ``bytes`` for binary frames and ``str`` for text
        frames, which lines up exactly with the binary/JSON codecs.  The
        send closure mirrors that: ``channel.send`` accepts either type.
        """
        async def _send(payload):
            # channel.send is synchronous in aiortc; wrap to satisfy the
            # async SendFn contract used by TeleopSession.
            channel.send(payload)

        self._session = TeleopSession(
            codec=self._codec,
            send=_send,
            on_twist=self.on_twist,
            ros2=self._ros2,
            ts_log=self._ts_log,
            stats=self.stats,
            log=logger,
        )

        @channel.on("message")
        async def on_message(data):
            # data is bytes (binary codec) or str (JSON codec)
            await self._session.handle_frame(data)

        @channel.on("close")
        def on_close():
            logger.info("DataChannel closed")
            self._dc = None
            self._session = None

    # ── Helpers ──────────────────────────────────────────────────────────────

    async def _send_signal(self, msg: dict):
        if self._ws and not self._ws.closed:
            try:
                await self._ws.send_str(json.dumps(msg))
            except Exception as e:
                logger.error(f"Signaling send error: {e}")

    async def _close_pc(self):
        if self._pc is not None:
            try:
                await self._pc.close()
            except Exception:
                pass
            self._pc = None
        self._dc = None
        self._browser_id = ""

    async def _cleanup(self):
        await self._close_pc()
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session:
            await self._session.close()
        if self._ros2:
            self._ros2.shutdown()

    def stop(self):
        self._shutdown.set()


# ─── Relay Twist Client (WebSocket data hub) ──────────────────────────────────

class RelayTwistClient:
    """Robot-side peer for the WebSocket / WebTransport browser legs.

    When the operator selects the WebSocket or WebTransport transport, the Go
    relay bridges the browser to this client over a plain WebSocket data hub
    (``/ws/data?role=python``).  From Python's point of view both browser legs
    look identical — a stream of frames arriving over one WebSocket — so a
    single relay client serves both.  The relay never inspects or rewrites the
    payload, so the protocol (and the end-to-end browser↔Python clock sync) is
    exactly the same as in the WebRTC P2P path; only the number of network hops
    differs.

    The active codec (binary or JSON) must match the operator's selection.
    """

    def __init__(
        self,
        data_url: str,
        on_twist: Optional[Callable] = None,
        ros2_topic: Optional[str] = None,
        ts_logger: Optional['TimestampFileLogger'] = None,
        codec_name: str = "binary",
    ):
        if "?" in data_url:
            self._data_url = f"{data_url}&role=python"
        else:
            self._data_url = f"{data_url}?role=python"

        self.on_twist = on_twist
        self.stats    = Stats()
        self._ts_log  = ts_logger
        self._codec   = make_codec(codec_name)

        self._session: Optional[TeleopSession] = None
        self._session_ros2 = ROS2Publisher(ros2_topic) if ros2_topic else None

        self._session_aiohttp = None
        self._ws = None
        self._shutdown = asyncio.Event()

    async def run(self):
        logger.info(f"Connecting to data hub: {self._data_url}")
        if self._session_ros2:
            self._session_ros2.init()
        while not self._shutdown.is_set():
            try:
                await self._relay_loop()
            except Exception as e:
                logger.error(f"Relay error: {e}")
                await asyncio.sleep(3)
                logger.info("Reconnecting to data hub...")
        await self._cleanup()

    async def _relay_loop(self):
        self._session_aiohttp = aiohttp.ClientSession()
        try:
            ssl_ctx = None
            if self._data_url.startswith("wss://"):
                cafile = os.environ.get("TLS_CA")
                if cafile:
                    ssl_ctx = ssl.create_default_context(cafile=cafile)
                else:
                    ssl_ctx = ssl.create_default_context()
                    ssl_ctx.check_hostname = False
                    ssl_ctx.verify_mode = ssl.CERT_NONE
            self._ws = await self._session_aiohttp.ws_connect(
                self._data_url, heartbeat=25.0, ssl=ssl_ctx
            )
            logger.info("Data hub connected. Waiting for browser frames...")

            async def _send(payload):
                # aiohttp distinguishes text/binary explicitly
                if isinstance(payload, str):
                    await self._ws.send_str(payload)
                else:
                    await self._ws.send_bytes(payload)

            self._session = TeleopSession(
                codec=self._codec,
                send=_send,
                on_twist=self.on_twist,
                ros2=self._session_ros2,
                ts_log=self._ts_log,
                stats=self.stats,
                log=logger,
            )

            async for msg in self._ws:
                if self._shutdown.is_set():
                    break
                if msg.type == aiohttp.WSMsgType.BINARY:
                    await self._session.handle_frame(msg.data)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    await self._session.handle_frame(msg.data)
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED,
                                  aiohttp.WSMsgType.ERROR):
                    logger.info("Data hub disconnected")
                    break
        finally:
            if self._ws and not self._ws.closed:
                await self._ws.close()
            if self._session_aiohttp:
                await self._session_aiohttp.close()
            self._ws = None
            self._session_aiohttp = None
            self._session = None

    async def _cleanup(self):
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session_aiohttp:
            await self._session_aiohttp.close()
        if self._session_ros2:
            self._session_ros2.shutdown()

    def stop(self):
        self._shutdown.set()


# ─── Main ─────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Multi-transport Twist Client")
    p.add_argument(
        "--transport", "-T",
        choices=["webrtc", "relay"],
        default="webrtc",
        help="Robot-side transport. 'webrtc' = P2P DataChannel via the Go "
             "signaling server (matches the browser's WebRTC option). 'relay' = "
             "WebSocket data hub on the Go relay (matches the browser's WebSocket "
             "AND WebTransport options — both browser legs reach Python the same "
             "way). Default: webrtc."
    )
    p.add_argument(
        "--format", "-f",
        choices=["binary", "json"],
        default="binary",
        help="Wire codec. Must match the operator's selection in the browser. "
             "Default: binary."
    )
    p.add_argument(
        "--signal", "-s",
        default="ws://localhost:8443/ws/signal",
        help="Go signaling server URL for --transport webrtc (ws:// or wss://)"
    )
    p.add_argument(
        "--data", "-d",
        default="ws://localhost:8443/ws/data",
        help="Go data-hub URL for --transport relay (ws:// or wss://)"
    )
    p.add_argument(
        "--ca-cert",
        default=None,
        metavar="PATH",
        help="CA certificate for verifying the TLS server cert (wss:// only). "
             "Use the same cert.pem generated by gen_certs.sh for self-signed setups. "
             "If omitted with wss://, certificate verification is skipped (dev only)."
    )
    p.add_argument("--topic", "-t", default=None, help="ROS2 topic name")
    p.add_argument("--verbose", "-v", action="store_true")
    p.add_argument(
        "--log-file", "-l",
        default="teleop_timestamps.csv",
        metavar="PATH",
        help="CSV file for per-message timestamp log (default: teleop_timestamps.csv)"
    )
    p.add_argument(
        "--no-log-file",
        action="store_true",
        help="Disable CSV timestamp logging entirely"
    )
    return p.parse_args()


async def main():
    args = parse_args()
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Expose --ca-cert via env var so the transport's TLS setup picks it up
    if args.ca_cert:
        os.environ["TLS_CA"] = args.ca_cert

    endpoint = args.signal if args.transport == "webrtc" else args.data
    tls_note = ""
    if endpoint.startswith("wss://"):
        tls_note = f"  TLS CA     : {args.ca_cert or 'skipping verification (dev)'}\n"

    print()
    print(f"  Transport  : {args.transport}")
    print(f"  Format     : {args.format}")
    print(f"  Endpoint   : {endpoint}")
    print(f"  ROS2 topic : {args.topic or 'disabled'}")
    print(f"  Timestamp log : {'disabled' if args.no_log_file else args.log_file}")
    if tls_note:
        print(tls_note, end="")
    print()

    ts_logger = None
    if not args.no_log_file:
        ts_logger = TimestampFileLogger(args.log_file)
        ts_logger.open()

    if args.transport == "webrtc":
        client = P2PTwistClient(
            signal_url=args.signal,
            ros2_topic=args.topic,
            ts_logger=ts_logger,
            codec_name=args.format,
        )
    else:
        client = RelayTwistClient(
            data_url=args.data,
            ros2_topic=args.topic,
            ts_logger=ts_logger,
            codec_name=args.format,
        )

    shutdown = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown.set)

    async def stats_loop():
        while not shutdown.is_set():
            await asyncio.sleep(5.0)
            logger.info(f"Stats: {client.stats}")

    stats_task = asyncio.create_task(stats_loop())
    client_task = asyncio.create_task(client.run())

    await shutdown.wait()
    client.stop()
    stats_task.cancel()
    client_task.cancel()
    try:
        await asyncio.gather(stats_task, client_task, return_exceptions=True)
    except Exception:
        pass

    if ts_logger:
        ts_logger.close()
        logger.info(f"Timestamp log closed: {args.log_file}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)