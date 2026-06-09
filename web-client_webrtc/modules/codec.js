/**
 * modules/codec.js
 * ----------------
 * Format-agnostic encode/decode entry points.  Every call dispatches on
 * `state.format` ('binary' | 'json') so the rest of the app never branches on
 * wire format.
 *
 *   binary  → delegates to the CRC-8 codec in protocol.js. Wire type: ArrayBuffer.
 *   json    → self-describing text envelope (no CRC; transport guarantees
 *             integrity). Wire type: string.
 *
 * JSON envelopes — keys MUST stay identical to python-client/codec.py:
 *   Twist     {"t":1,"id","t1","mask","v":{"linear_y":...}}
 *   TwistAck  {"t":2,"id","t1","t3","t4","dec","proc","enc"}
 *   SyncReq   {"t":3,"t1"}
 *   SyncResp  {"t":4,"t1","t2","t3"}
 *
 * Incoming frames may be ArrayBuffer (binary frame, or a WebTransport datagram)
 * or string (WS/DataChannel text frame).  The JSON decoders accept either, so
 * the WebTransport leg — which is always typeless bytes — round-trips cleanly.
 */

import { state } from './state.js';
import {
    MSG_TWIST, MSG_ACK, MSG_SYNC_REQ, MSG_SYNC_RESP,
    FIELD_ORDER,
    encodeTwist as binEncodeTwist,
    encodeSyncReq as binEncodeSyncReq,
    decodeAck as binDecodeAck,
    decodeSyncResp as binDecodeSyncResp,
} from './protocol.js';

const _decoder = new TextDecoder();

/** Normalise an incoming frame to a string (for JSON parsing). */
function toText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return _decoder.decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data))    return _decoder.decode(data);
    return String(data);
}

/**
 * Peek the message type of an incoming frame without a full decode, so the
 * dispatcher can route ACK vs SYNC_RESP regardless of format/transport.
 * @returns {number} message type byte, or -1 if unknown
 */
export function peekType(data) {
    if (typeof data !== 'string') {
        if (data instanceof ArrayBuffer) return new Uint8Array(data)[0];
        if (ArrayBuffer.isView(data))    return new Uint8Array(data.buffer, data.byteOffset, 1)[0];
    }
    try { return Number(JSON.parse(toText(data)).t); } catch { return -1; }
}

// ── Encoders (browser → python) ───────────────────────────────────────────────

/**
 * @param {number} id   sequence number
 * @param {number} t1   browser send timestamp (ms)
 * @param {{lx,ly,lz,ax,ay,az}} v
 * @returns {ArrayBuffer|string}
 */
export function encodeTwist(id, t1, v) {
    if (state.format === 'json') {
        const mask = state.fieldMask;
        const all  = [v.lx, v.ly, v.lz, v.ax, v.ay, v.az];
        const out  = {};
        FIELD_ORDER.forEach((f, i) => { if (mask & f.bit) out[f.name] = all[i]; });
        return JSON.stringify({
            t: MSG_TWIST, id: Math.floor(id), t1: Math.floor(t1), mask, v: out,
        });
    }
    return binEncodeTwist(id, t1, v);
}

/** @returns {ArrayBuffer|string} */
export function encodeSyncReq(t1) {
    if (state.format === 'json') {
        return JSON.stringify({ t: MSG_SYNC_REQ, t1: Math.floor(t1) });
    }
    return binEncodeSyncReq(t1);
}

// ── Decoders (python → browser) ───────────────────────────────────────────────

/** @returns {object|null} normalised ack, or null on a bad frame */
export function decodeAck(data) {
    if (state.format === 'json') {
        let o; try { o = JSON.parse(toText(data)); } catch { return null; }
        if (Number(o.t) !== MSG_ACK) return null;
        return {
            msgId:         Number(o.id),
            t1_browser:    Number(o.t1),
            t3_python_rx:  Number(o.t3),
            t4_python_ack: Number(o.t4),
            decode_us:     Number(o.dec),
            process_us:    Number(o.proc),
            encode_us:     Number(o.enc),
        };
    }
    return binDecodeAck(data);   // ArrayBuffer + CRC check
}

/** @returns {object|null} {t1,t2,t3} or null on a bad frame */
export function decodeSyncResp(data) {
    if (state.format === 'json') {
        let o; try { o = JSON.parse(toText(data)); } catch { return null; }
        if (Number(o.t) !== MSG_SYNC_RESP) return null;
        return { t1: Number(o.t1), t2: Number(o.t2), t3: Number(o.t3) };
    }
    return binDecodeSyncResp(data);
}

/** Wire size of an encoded frame, in bytes (string → UTF-8 byte length). */
export function frameSize(frame) {
    if (typeof frame === 'string') return new TextEncoder().encode(frame).length;
    if (frame instanceof ArrayBuffer) return frame.byteLength;
    if (ArrayBuffer.isView(frame)) return frame.byteLength;
    return 0;
}