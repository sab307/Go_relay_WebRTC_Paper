/**
 * modules/logger.js
 * -----------------
 * Console logging helpers and in-memory CSV log buffer with download support.
 */

import { CONFIG } from './config.js';
import { state } from './state.js';

// ── CSV column definitions ────────────────────────────────────────────────────
const LOG_TWIST_COLS = [
    'wall_iso', 'type', 'seq', 'msg_id',
    't1_browser_ms', 't6_browser_rx_ms', 'rtt_ms',
    't3_python_rx_ms', 't4_python_ack_ms', 'clock_offset_ms',
    'to_python_ms', 'python_proc_ms', 'from_python_ms',
    'decode_us', 'process_us', 'encode_us',
];
const LOG_SYNC_COLS = [
    'wall_iso', 'type', 'seq',
    't1_browser_ms', 't2_python_rx_ms', 't3_python_tx_ms', 't4_browser_rx_ms',
    'sync_rtt_ms', 'raw_offset_ms', 'smooth_offset_ms',
];
const LOG_SEND_COLS = [
    'wall_iso', 'type', 'seq', 'msg_id',
    't1_browser_ms', 'format', 'size_bytes', 'mask', 'payload',
];
export const LOG_ALL_COLS = [...new Set([
    ...LOG_TWIST_COLS, ...LOG_SYNC_COLS, ...LOG_SEND_COLS,
])];

// ── Buffer helpers ────────────────────────────────────────────────────────────

export function pushLog(row) {
    if (state.logBuffer.length >= CONFIG.logMaxRows) state.logBuffer.shift();
    state.logBuffer.push(row);
    const el = document.getElementById('logRowCount');
    if (el) el.textContent = state.logBuffer.length.toLocaleString();
}

export function downloadLog() {
    if (state.logBuffer.length === 0) { logWarn('log', 'Log buffer empty — nothing to download'); return; }
    const escape = v => {
        if (v === undefined || v === null || v === '') return '';
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
            ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [LOG_ALL_COLS.join(',')];
    for (const row of state.logBuffer)
        lines.push(LOG_ALL_COLS.map(k => escape(row[k])).join(','));
    const csv  = lines.join('\r\n');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `teleop_log_${ts}.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logInfo('log', `Downloaded ${state.logBuffer.length} rows → ${name}`);
}

export function clearLog() {
    state.logBuffer = []; state.logSeq = 0;
    const el = document.getElementById('logRowCount');
    if (el) el.textContent = '0';
    logInfo('log', 'Log buffer cleared');
}

// ── Console helpers ───────────────────────────────────────────────────────────

export function logDebug(cat, msg, data) {
    if (!CONFIG.debugLog) return;
    data !== undefined ? console.debug(`[${cat}] ${msg}`, data) : console.debug(`[${cat}] ${msg}`);
}
export function logInfo(cat, msg, data) {
    data !== undefined ? console.log(`[${cat}] ${msg}`, data) : console.log(`[${cat}] ${msg}`);
}
export function logWarn(cat, msg, data) {
    data !== undefined ? console.warn(`[${cat}] ${msg}`, data) : console.warn(`[${cat}] ${msg}`);
}
export function logError(cat, msg, data) {
    data !== undefined ? console.error(`[${cat}] ${msg}`, data) : console.error(`[${cat}] ${msg}`);
}

// ── Send-side logging ─────────────────────────────────────────────────────────
// Prints every outgoing Twist to the browser console with format/size/preview,
// and stores a SEND row in the CSV buffer.  For JSON frames the on-the-wire
// text is logged verbatim; for binary frames a hex preview of the first bytes
// is logged alongside the decoded velocity object so the operator can see what
// would have been sent in either format.

const HEX_PREVIEW_BYTES = 32;

function _hexPreview(buf, n = HEX_PREVIEW_BYTES) {
    const view  = buf instanceof ArrayBuffer ? new Uint8Array(buf)
                : ArrayBuffer.isView(buf)    ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
                : new Uint8Array(0);
    const slice = view.subarray(0, Math.min(n, view.length));
    let s = '';
    for (let i = 0; i < slice.length; i++) s += slice[i].toString(16).padStart(2, '0') + ' ';
    return s.trim() + (view.length > n ? ` … (+${view.length - n}B)` : '');
}

function _frameSize(frame) {
    if (typeof frame === 'string')      return new TextEncoder().encode(frame).length;
    if (frame instanceof ArrayBuffer)   return frame.byteLength;
    if (ArrayBuffer.isView(frame))      return frame.byteLength;
    return 0;
}

/**
 * Log an outgoing teleop frame and persist a SEND row to the CSV buffer.
 *
 * @param {'binary'|'json'} format    wire format actually sent
 * @param {ArrayBuffer|string} frame  the bytes/text handed to the transport
 * @param {object} meta               { id, t1, v, mask, tag? }
 */
export function logSend(format, frame, meta = {}) {
    const size  = _frameSize(frame);
    const tag   = meta.tag ? ` ${meta.tag}` : '';
    const head  = `[send${tag}] ${format} id=${meta.id} size=${size}B mask=0x${(meta.mask ?? 0).toString(16).padStart(2,'0')}`;

    if (format === 'json' && typeof frame === 'string') {
        console.log(`%c${head} %c${frame}`, 'color:#00f5d4;font-weight:600', 'color:#8a8a9a');
    } else {
        console.log(`%c${head}`, 'color:#00f5d4;font-weight:600', { v: meta.v, hex: _hexPreview(frame) });
    }

    pushLog({
        wall_iso:      new Date().toISOString(),
        type:          'SEND',
        seq:           ++state.logSeq,
        msg_id:        meta.id,
        t1_browser_ms: (meta.t1 ?? 0).toString(),
        format,
        size_bytes:    size,
        mask:          `0x${(meta.mask ?? 0).toString(16).padStart(2,'0')}`,
        payload:       (typeof frame === 'string') ? frame : _hexPreview(frame),
    });
}