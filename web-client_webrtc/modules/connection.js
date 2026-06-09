/**
 * modules/connection.js
 * ----------------------
 * Transport-agnostic connection coordinator.
 *
 * Owns the active transport (WebRTC / WebSocket / WebTransport, chosen by
 * state.transport), wires its lifecycle into shared `state`, runs the
 * browser↔Python clock-sync loop, and dispatches incoming ACK / SYNC_RESP
 * frames to `handlers` (registered by app.js).  The actual Twist send loop
 * lives in app.js; it calls state.link.send().
 */

import { CONFIG }              from './config.js';
import { state, handlers }     from './state.js';
import { now }                 from './protocol.js';
import { MSG_ACK, MSG_SYNC_RESP } from './protocol.js';
import { encodeSyncReq, peekType } from './codec.js';
import { createTransport }     from './transports.js';
import { logDebug, logInfo, logWarn, logError } from './logger.js';
import { setConnected }        from './ui.js';
import { setChartActive }      from './chart.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function sendSyncReq() {
    if (!state.link || !state.link.isOpen) return;
    try {
        state.link.send(encodeSyncReq(now()));
        logDebug('sync', 'sent ClockSyncReq');
    } catch (e) {
        logError('sync', `Send error: ${e.message}`);
    }
}

export function stopSending() {
    if (state.sendTimer) { clearInterval(state.sendTimer); state.sendTimer = null; }
}

// ── Connect / disconnect ───────────────────────────────────────────────────────

export async function connect() {
    if (state.link) disconnect();

    const link = createTransport(state.transport);
    logInfo('conn', `Transport=${link.label}  format=${state.format}`);

    link.onOpen = async () => {
        setConnected(true);

        logInfo('sync', 'Initial clock sync (5 samples)…');
        for (let i = 0; i < 5; i++) { sendSyncReq(); await sleep(200); }
        if (state.clockSynced)
            logInfo('sync', `Synced: offset=${state.clockOffset.toFixed(1)}ms rtt=${state.clockRtt.toFixed(1)}ms`);
        else
            logWarn('sync', `Sync incomplete (${state.offsets.length}/3 samples). Continuing.`);

        if (state.syncInterval) clearInterval(state.syncInterval);
        state.syncInterval = setInterval(sendSyncReq, CONFIG.syncIntervalMs);
        if (handlers.onConnected) handlers.onConnected();
    };

    link.onClose = () => {
        setConnected(false);
        stopSending();
        if (state.syncInterval) { clearInterval(state.syncInterval); state.syncInterval = null; }
        state.twistActive = false;
        setChartActive(false);
    };

    link.onMessage = (data) => {
        const type = peekType(data);
        if      (type === MSG_ACK       && handlers.onAck)      handlers.onAck(data);
        else if (type === MSG_SYNC_RESP && handlers.onSyncResp) handlers.onSyncResp(data);
        else logWarn('conn', `Unknown message type: ${type}`);
    };

    state.link = link;
    try {
        await link.connect();
    } catch (e) {
        logError('conn', `Connect failed: ${e.message || e}`);
        state.link = null;
        setConnected(false);
        throw e;
    }
}

export function disconnect() {
    stopSending();
    if (state.syncInterval) { clearInterval(state.syncInterval); state.syncInterval = null; }
    try { state.link?.close(); } catch (_) {}
    state.link = null;
    state.offsets = []; state.clockSynced = false;
    state.twistActive = false;
    setConnected(false);
    setChartActive(false);
    logInfo('conn', 'Disconnected');
}