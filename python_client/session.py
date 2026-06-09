"""
TeleopSession — codec/transport-agnostic message handling
=========================================================

Encapsulates the *logic* of being the robot-side teleop peer, independent of
which transport delivered the bytes (WebRTC DataChannel or a WebSocket relay
leg) and which codec is in use (binary or JSON).

A transport driver feeds raw frames in via :meth:`handle_frame` and supplies an
async ``send`` coroutine that puts a frame back on the wire.  The session takes
care of:

  * decoding incoming Twist commands and timestamping them
  * invoking the optional user callback + ROS 2 publish
  * building and sending a TwistAck with the full per-stage timing chain
  * answering ClockSync requests (NTP four-timestamp handshake)
  * stats + optional CSV timestamp logging

The ``send`` coroutine receives a :data:`codec.Frame` (``bytes`` for binary,
``str`` for JSON); the driver decides how to put that on its transport.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional

from twist_protocol import (
    TwistWithLatency,
    TwistAck,
    LatencyTimestamps,
    ClockSyncResponse,
    MessageType,
    current_time_ms,
    perf_counter_us,
)
from codec import Frame, peek_type

logger = logging.getLogger("TeleopSession")

SendFn = Callable[[Frame], Awaitable[None]]


class TeleopSession:
    def __init__(
        self,
        codec,
        send: SendFn,
        *,
        on_twist: Optional[Callable] = None,
        ros2=None,
        ts_log=None,
        stats=None,
        log: Optional[logging.Logger] = None,
    ):
        self._codec = codec
        self._send = send
        self.on_twist = on_twist
        self._ros2 = ros2
        self._ts_log = ts_log
        self.stats = stats
        self._log = log or logger

    # ── Entry point ────────────────────────────────────────────────────────
    async def handle_frame(self, data: Frame) -> None:
        """Dispatch a raw incoming frame (bytes or str) by message type."""
        rx_time = current_time_ms()
        try:
            mtype = peek_type(data)
        except Exception as e:
            self._log.error(f"frame classify error: {e}")
            return

        if mtype == MessageType.TWIST:
            await self._handle_twist(data, rx_time)
        elif mtype == MessageType.CLOCK_SYNC_REQUEST:
            await self._handle_clock_sync(data)
        else:
            self._log.debug(f"unknown msg type: {mtype}")

    # ── Twist ────────────────────────────────────────────────────────────────
    async def _handle_twist(self, data: Frame, rx_time: int) -> None:
        decode_start = perf_counter_us()
        try:
            twist = self._codec.decode_twist(data)
        except Exception as e:
            self._log.error(f"twist decode error: {e} (len={_len(data)})")
            return
        decode_us = perf_counter_us() - decode_start

        twist.timestamps.t3_python_rx = rx_time
        twist.timestamps.python_decode_us = decode_us

        process_start = perf_counter_us()
        if self.on_twist:
            try:
                self.on_twist(twist)
            except Exception as e:
                self._log.error(f"twist callback error: {e}")
        if self._ros2:
            self._ros2.publish(twist)
        twist.timestamps.python_process_us = perf_counter_us() - process_start

        await self._send_ack(twist)

        ts = twist.timestamps
        approx = rx_time - ts.t1_browser_send
        total_us = ts.python_decode_us + ts.python_process_us + ts.python_encode_us
        self._log.info(
            f"Twist #{twist.message_id:>6}  t1={ts.t1_browser_send}ms  "
            f"t3={ts.t3_python_rx}ms  t4={ts.t4_python_ack}ms  approx_lat={approx:+.0f}ms  "
            f"[dec={ts.python_decode_us}us proc={ts.python_process_us}us "
            f"enc={ts.python_encode_us}us total={total_us}us]"
        )
        if self._ts_log:
            self._ts_log.log_twist(twist)
        if self.stats:
            self.stats.record(approx, ts.python_decode_us,
                              ts.python_process_us, ts.python_encode_us)

    async def _send_ack(self, twist: TwistWithLatency) -> None:
        encode_start = perf_counter_us()
        ack_time = current_time_ms()
        ts = LatencyTimestamps(
            t1_browser_send=twist.timestamps.t1_browser_send,
            t3_python_rx=twist.timestamps.t3_python_rx,
            t4_python_ack=ack_time,
            python_decode_us=twist.timestamps.python_decode_us,
            python_process_us=twist.timestamps.python_process_us,
            python_encode_us=0,  # filled after first encode pass
        )
        ack = TwistAck(message_id=twist.message_id, timestamps=ts)
        _ = self._codec.encode_ack(ack)            # dry run to measure encode cost
        encode_us = perf_counter_us() - encode_start

        ts.python_encode_us = encode_us
        twist.timestamps.python_encode_us = encode_us
        ack = TwistAck(message_id=twist.message_id, timestamps=ts)
        payload = self._codec.encode_ack(ack)

        try:
            await self._send(payload)
            if self.stats:
                self.stats.ack_count += 1
            self._log.debug(f"ack #{twist.message_id} sent ({_len(payload)})")
        except Exception as e:
            self._log.error(f"ack send error: {e}")

    # ── Clock sync ─────────────────────────────────────────────────────────
    async def _handle_clock_sync(self, data: Frame) -> None:
        t2 = current_time_ms()    # receive time — captured before decode
        try:
            req = self._codec.decode_clock_request(data)
        except Exception as e:
            self._log.error(f"clock-sync decode error: {e}")
            return
        t3 = current_time_ms()    # transmit time — as late as possible
        resp = ClockSyncResponse(t1=req.t1, t2=t2, t3=t3)
        try:
            await self._send(self._codec.encode_clock_response(resp))
        except Exception as e:
            self._log.error(f"clock-sync send error: {e}")
            return
        self._log.info(
            f"ClockSync  t1={req.t1}ms  t2(py_rx)={t2}ms  t3(py_tx)={t3}ms"
        )
        if self._ts_log:
            self._ts_log.log_sync(req.t1, t2, t3)


def _len(data: Frame) -> str:
    try:
        return f"{len(data)}{'C' if isinstance(data, str) else 'B'}"
    except Exception:
        return "?"