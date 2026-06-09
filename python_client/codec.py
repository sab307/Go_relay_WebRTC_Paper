"""
Codec abstraction — binary (CRC-8) and JSON wire formats
========================================================

The teleop protocol has four logical messages (Twist, TwistAck, ClockSyncReq,
ClockSyncResp).  Each can be carried in two interchangeable wire formats:

  * ``binary``  — the compact variable-size layout with a trailing CRC-8/SMBUS
                  byte, defined in ``twist_protocol.py``.  Output type: ``bytes``.
  * ``json``    — a self-describing text envelope (no CRC; the underlying
                  transport already guarantees integrity).  Output type: ``str``.

Both ends of a connection MUST use the same codec.  The browser chooses the
codec at runtime; the Python side is told which to use via ``--format``.

JSON envelopes (keys kept short to keep messages small for fair size/latency
comparison against the binary format — they must match the JS codec exactly):

  Twist     {"t":1,"id":<int>,"t1":<ms>,"mask":<int>,"v":{"linear_y":...}}
  TwistAck  {"t":2,"id":<int>,"t1":<ms>,"t3":<ms>,"t4":<ms>,
             "dec":<us>,"proc":<us>,"enc":<us>}
  SyncReq   {"t":3,"t1":<ms>}
  SyncResp  {"t":4,"t1":<ms>,"t2":<ms>,"t3":<ms>}

``v`` carries only the fields whose bit is set in ``mask`` (mirrors the binary
field-mask semantics); the decoder zero-fills the rest.
"""

from __future__ import annotations

import json
from typing import Union

from twist_protocol import (
    TwistWithLatency,
    TwistAck,
    LatencyTimestamps,
    ClockSyncRequest,
    ClockSyncResponse,
    MessageType,
    FIELD_ORDER,
    _popcount,
)

# A frame on the wire is either bytes (binary codec) or str (JSON codec).
Frame = Union[bytes, str]


# =============================================================================
# Type peeking — figure out the message type without a full decode
# =============================================================================

def peek_type(data: Frame) -> int:
    """Return the MessageType byte/field of an incoming frame.

    Works for both formats so a dispatcher can route before decoding:
      * binary: the first byte is the message type.
      * json:   the ``"t"`` field holds the message type.
    Raises ValueError if the frame can't be classified.
    """
    if isinstance(data, (bytes, bytearray)):
        if len(data) < 1:
            raise ValueError("empty binary frame")
        return data[0]
    # str / JSON — may also arrive as bytes that are really UTF-8 JSON, but the
    # caller decides the codec, so a str here is always JSON.
    obj = json.loads(data)
    return int(obj.get("t", -1))


# =============================================================================
# Binary codec — thin delegation to twist_protocol's CRC-8 layout
# =============================================================================

class BinaryCodec:
    name = "binary"
    is_text = False

    def decode_twist(self, data: Frame) -> TwistWithLatency:
        return TwistWithLatency.decode(_as_bytes(data), check_crc=True)

    def encode_ack(self, ack: TwistAck) -> bytes:
        return ack.encode_p2p()

    def decode_clock_request(self, data: Frame) -> ClockSyncRequest:
        return ClockSyncRequest.decode(_as_bytes(data))

    def encode_clock_response(self, resp: ClockSyncResponse) -> bytes:
        return resp.encode()


# =============================================================================
# JSON codec
# =============================================================================

class JsonCodec:
    name = "json"
    is_text = True

    # ---- Twist (browser -> python) --------------------------------------
    def decode_twist(self, data: Frame) -> TwistWithLatency:
        obj = json.loads(_as_text(data))
        if int(obj.get("t", -1)) != MessageType.TWIST:
            raise ValueError(f"expected TWIST, got t={obj.get('t')}")
        mask = int(obj.get("mask", 0))
        v = obj.get("v", {}) or {}
        fields = {name: float(v.get(name, 0.0)) for name in FIELD_ORDER}
        ts = LatencyTimestamps(t1_browser_send=int(obj.get("t1", 0)))
        return TwistWithLatency(
            message_id=int(obj.get("id", 0)),
            field_mask=mask,
            timestamps=ts,
            **fields,
        )

    # ---- TwistAck (python -> browser) -----------------------------------
    def encode_ack(self, ack: TwistAck) -> str:
        ts = ack.timestamps
        return json.dumps({
            "t": int(MessageType.TWIST_ACK),
            "id": ack.message_id,
            "t1": ts.t1_browser_send,
            "t3": ts.t3_python_rx,
            "t4": ts.t4_python_ack,
            "dec": ts.python_decode_us,
            "proc": ts.python_process_us,
            "enc": ts.python_encode_us,
        }, separators=(",", ":"))

    # ---- ClockSync ------------------------------------------------------
    def decode_clock_request(self, data: Frame) -> ClockSyncRequest:
        obj = json.loads(_as_text(data))
        if int(obj.get("t", -1)) != MessageType.CLOCK_SYNC_REQUEST:
            raise ValueError(f"expected SYNC_REQ, got t={obj.get('t')}")
        return ClockSyncRequest(t1=int(obj.get("t1", 0)))

    def encode_clock_response(self, resp: ClockSyncResponse) -> str:
        return json.dumps({
            "t": int(MessageType.CLOCK_SYNC_RESPONSE),
            "t1": resp.t1,
            "t2": resp.t2,
            "t3": resp.t3,
        }, separators=(",", ":"))


# =============================================================================
# Helpers / factory
# =============================================================================

def _as_bytes(data: Frame) -> bytes:
    if isinstance(data, str):
        return data.encode("utf-8")
    return bytes(data)


def _as_text(data: Frame) -> str:
    if isinstance(data, (bytes, bytearray)):
        return bytes(data).decode("utf-8")
    return data


def make_codec(name: str):
    """Return a codec instance for ``name`` ('binary' or 'json')."""
    name = (name or "binary").lower()
    if name == "binary":
        return BinaryCodec()
    if name == "json":
        return JsonCodec()
    raise ValueError(f"unknown codec {name!r} (expected 'binary' or 'json')")