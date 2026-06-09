/**
 * app.js — Teleop Latency Dashboard (WebRTC P2P + Steering Wheel)
 * ================================================================
 * Thin orchestrator.  All heavy logic lives in modules/:
 *
 *   config.js      – CONFIG constants
 *   state.js       – shared mutable state + message handlers registry
 *   protocol.js    – message types, field mask, CRC, encode/decode
 *   logger.js      – CSV log buffer, console helpers
 *   chart.js       – uPlot chart (latency history + idle/active bg)
 *   ui.js          – DOM update helpers, speed/field-selector setup
 *   controls.js    – keyboard + on-screen joystick
 *   steering.js    – visual steering wheel + Gamepad API
 *   connection.js  – WebRTC signaling + DataChannel lifecycle
 */

import { CONFIG } from './modules/config.js';
import { state, handlers } from './modules/state.js';
import {
    FIELD_LINEAR_X,  FIELD_LINEAR_Y,  FIELD_LINEAR_Z,
    FIELD_ANGULAR_X, FIELD_ANGULAR_Y, FIELD_ANGULAR_Z,
    now,
} from './modules/protocol.js';
import { encodeTwist, decodeAck, decodeSyncResp,
         frameSize } from './modules/codec.js';
import { pushLog, downloadLog, clearLog,
         logInfo, logWarn, logError, logSend } from './modules/logger.js';
import { initChart, updateChart, resetZoom,
         setChartActive }             from './modules/chart.js';
import { updateControlDisplay, updateCrcDisplay,
         updateMetrics, updateBreakdown, updateTimestamps,
         setupSpeedControl, setupFieldSelector,
         setupPrecisionToggle,
         setupInputModeSelector,
         setupRoutingSelectors,
         setupFormatSelector } from './modules/ui.js';
import { setupKeyboard, setupJoystick } from './modules/controls.js';
import { setupSteering, drawWheel }   from './modules/steering.js';
import { connect, disconnect,
         sendSyncReq, stopSending }   from './modules/connection.js';

// ── Twist send timer ──────────────────────────────────────────────────────────

/** Maximum age in ms of a pendingTwists entry before we consider its ack lost.
 *  At 20 Hz and a 3 s TTL, the map holds at most ~60 entries. */
const PENDING_TWIST_TTL_MS = 3000;

/** Evict stale pendingTwists entries so the map can't grow unbounded if acks
 *  are dropped or the Python peer stalls. Cheap — called every 64 sends. */
function sweepPendingTwists() {
    const cutoff = performance.now() - PENDING_TWIST_TTL_MS;
    for (const [id, entry] of state.pendingTwists) {
        if (entry.perfMs < cutoff) state.pendingTwists.delete(id);
    }
}

function startSending() {
    if (state.sendTimer) clearInterval(state.sendTimer);
    state.sendTimer = setInterval(sendTwist, 1000 / CONFIG.sendHz);
    logInfo('send', `Sending at ${CONFIG.sendHz} Hz`);
}

/**
 * sendTwist — called by the timer at CONFIG.sendHz.
 *
 * Priority: gamepad → keyboard/joystick.
 * Field routing: forward axis → first enabled linear field (x→y→z),
 *                turn   axis  → first enabled angular field (z→x→y, ROS2 convention).
 */
function sendTwist() {
    if (!state.link || !state.link.isOpen) return;

    // E-Stop: suppress all twist messages — only idle keep-alive pings
    if (state.eStop) {
        const perfNow = performance.now();
        if (perfNow - state.lastIdlePingMs >= CONFIG.idlePingIntervalMs) {
            sendSyncReq();
            state.lastIdlePingMs = perfNow;
        }
        if (state.twistActive) { state.twistActive = false; setChartActive(false); }
        return;
    }

    // Source-of-truth per input mode. The keyboard mode uses state.linY/angZ
    // written by controls.js; gamepad and steering modes use state.gpLinY/gpAngZ
    // written by the poll loop in steering.js.
    const useGp   = state.inputMode !== 'keyboard';
    const effLinY = useGp ? state.gpLinY : state.linY;
    const effAngZ = useGp ? state.gpAngZ : state.angZ;
    const moving  = effLinY !== 0 || effAngZ !== 0;

    if (moving) {
        state.msgId++;
        const t1  = now();

        // Build velocity object — only the first enabled field of each group
        // receives the joystick/gamepad value; all others stay 0.
        const v = { lx: 0, ly: 0, lz: 0, ax: 0, ay: 0, az: 0 };
        if      (state.fieldMask & FIELD_LINEAR_X) v.lx = effLinY;
        else if (state.fieldMask & FIELD_LINEAR_Y) v.ly = effLinY;
        else if (state.fieldMask & FIELD_LINEAR_Z) v.lz = effLinY;

        if      (state.fieldMask & FIELD_ANGULAR_Z) v.az = effAngZ;
        else if (state.fieldMask & FIELD_ANGULAR_X) v.ax = effAngZ;
        else if (state.fieldMask & FIELD_ANGULAR_Y) v.ay = effAngZ;

        const frame = encodeTwist(state.msgId, t1, v);
        try { state.link.send(frame); }
        catch (e) { logError('send', `${state.link.label} send error: ${e.message}`); }

        // Remember t1 locally so we can match it to the eventual ack by msgId.
        // Previously t1 was echoed back on the ack wire (8 B wasted); now the
        // browser owns it. Entries are cleared on ack receipt, on disconnect,
        // and swept every ~3 s to cap map growth if acks are lost.
        state.pendingTwists.set(state.msgId, { t1, perfMs: performance.now() });
        if ((state.msgId & 0x3F) === 0) sweepPendingTwists();

        const size   = frameSize(frame);
        const sizeEl = document.getElementById('msgSize');
        if (sizeEl) sizeEl.textContent = `${size}B`;

        logSend(state.format, frame, {
            id: state.msgId, t1: Math.floor(t1), v, mask: state.fieldMask,
        });

        if (!state.twistActive) { state.twistActive = true; setChartActive(true); }

    } else {
        // Idle: send a ClockSyncReq keep-alive at 1 Hz
        const perfNow = performance.now();
        if (perfNow - state.lastIdlePingMs >= CONFIG.idlePingIntervalMs) {
            sendSyncReq();
            state.lastIdlePingMs = perfNow;
        }
        if (state.twistActive) { state.twistActive = false; setChartActive(false); }
    }
}

// ── Stop helper ───────────────────────────────────────────────────────────────

/**
 * Engage e-stop: zero all axes, send one zero twist, block further sending.
 * Press Space again (or any movement key) to disengage.
 */
function engageEStop() {
    state.eStop   = true;
    state.linY    = 0; state.angZ  = 0;
    state.gpLinY  = 0; state.gpAngZ = 0; state.gpActive = false;
    updateControlDisplay();
    drawWheel();
    updateEStopUI();
    // Send one explicit zero twist so the robot halts immediately
    if (state.link && state.link.isOpen) {
        state.msgId++;
        const z     = { lx:0, ly:0, lz:0, ax:0, ay:0, az:0 };
        const frame = encodeTwist(state.msgId, now(), z);
        try { state.link.send(frame); } catch (_) {}
        logSend(state.format, frame, { id: state.msgId, t1: Math.floor(now()), v: z, mask: state.fieldMask, tag: 'E-STOP' });
    }
    logInfo('ctrl', 'E-STOP engaged — all twist output suppressed');
}

function disengageEStop() {
    state.eStop = false;
    updateEStopUI();
    logInfo('ctrl', 'E-STOP disengaged — twist output resumed');
}

function updateEStopUI() {
    const btn = document.getElementById('stopBtn');
    if (btn) {
        btn.textContent = state.eStop ? '⛔ E-STOP (Space to resume)' : 'Stop';
        btn.classList.toggle('estop-active', state.eStop);
    }
}

// ── Incoming message handlers ─────────────────────────────────────────────────

function handleAck(buf) {
    const t6  = now();
    const ack = decodeAck(buf);
    if (!ack) { updateCrcDisplay(); return; }

    // t1 is no longer on the wire — look it up from our local pending map.
    // If the entry was swept (stale) or never existed (spurious ack), drop
    // the sample: we can't compute RTT or →Python without the matching t1.
    const pending = state.pendingTwists.get(ack.msgId);
    if (!pending) {
        logWarn('ack', `no pending t1 for msg=${ack.msgId} (stale or swept)`);
        return;
    }
    state.pendingTwists.delete(ack.msgId);
    const t1 = pending.t1;
    state.ackCount++;

    const t3b = ack.t3_python_rx  - state.clockOffset;
    const t4b = ack.t4_python_ack - state.clockOffset;
    const rtt              = t6 - t1;
    const toPython         = t3b - t1;
    const pythonMs         = (ack.decode_us + ack.process_us + ack.encode_us) / 1000;
    const fromPython       = t6 - t4b;

    const lat = {
        rtt, toPython, pythonMs, fromPython,
        decode_us: ack.decode_us, process_us: ack.process_us, encode_us: ack.encode_us,
        t1, t3py: ack.t3_python_rx, t4py: ack.t4_python_ack, t6,
    };

    if (rtt < 0) logError('ack', `Negative RTT=${rtt.toFixed(2)}ms`);
    if (state.ackCount <= 5)
        logInfo('ack', `msg=${ack.msgId} RTT=${rtt.toFixed(2)}ms →Py=${toPython.toFixed(2)}ms proc=${pythonMs.toFixed(3)}ms`);

    if (state.ackCount % CONFIG.tsLogEvery === 0) {
        console.groupCollapsed(`%c[ts] msg=${ack.msgId}  RTT=${rtt.toFixed(2)}ms`, 'color:#00f5d4');
        console.table({
            't1 browser_send':  { ms: t1.toFixed(3) },
            't3 browser_equiv': { ms: t3b.toFixed(3) },
            't4 browser_equiv': { ms: t4b.toFixed(3) },
            't6 browser_rx':    { ms: t6.toFixed(3) },
        });
        console.groupEnd();
    }

    pushLog({
        wall_iso: new Date().toISOString(), type: 'TWIST', seq: ++state.logSeq,
        msg_id: ack.msgId,
        t1_browser_ms:    t1.toFixed(3),
        t6_browser_rx_ms: t6.toFixed(3),
        rtt_ms:           rtt.toFixed(3),
        t3_python_rx_ms:  ack.t3_python_rx,
        t4_python_ack_ms: ack.t4_python_ack,
        clock_offset_ms:  state.clockOffset.toFixed(3),
        to_python_ms:     toPython.toFixed(3),
        python_proc_ms:   pythonMs.toFixed(4),
        from_python_ms:   fromPython.toFixed(3),
        decode_us: ack.decode_us, process_us: ack.process_us, encode_us: ack.encode_us,
    });

    updateMetrics(lat);
    updateChart(lat, t6);
    updateBreakdown(lat);
    updateTimestamps(lat);
}

function handleSyncResp(buf) {
    const t4 = now();
    const r  = decodeSyncResp(buf);
    if (!r) return;

    const syncRtt   = (t4 - r.t1) - (r.t3 - r.t2);
    const rawOffset = ((r.t2 - r.t1) + (r.t3 - t4)) / 2;

    // Reject outliers (>3× median RTT once we have 3+ samples)
    if (state.offsets.length >= 3) {
        const sorted = state.offsets.map(o => o._rtt).filter(Boolean).sort((a, b) => a - b);
        const medRtt = sorted[Math.floor(sorted.length / 2)];
        if (syncRtt > medRtt * 3) { logWarn('sync', `Outlier rejected syncRtt=${syncRtt.toFixed(2)}ms`); return; }
    }

    state.offsets.push({ value: rawOffset, _rtt: syncRtt });
    if (state.offsets.length > 10) state.offsets.shift();

    const sorted    = [...state.offsets].map(o => o.value).sort((a, b) => a - b);
    const newMedian = sorted[Math.floor(sorted.length / 2)];
    const delta     = newMedian - state.clockOffset;

    if (!state.clockSynced)         state.clockOffset = newMedian;
    else if (Math.abs(delta) > 50)  { logWarn('sync', `Large jump ${delta.toFixed(1)}ms — hard reset`); state.clockOffset = newMedian; }
    else                            state.clockOffset += delta * 0.2;

    state.clockRtt    = syncRtt;
    state.clockSynced = state.offsets.length >= 3;

    logInfo('sync', `rtt=${syncRtt.toFixed(3)}ms  raw=${rawOffset.toFixed(3)}ms  smooth=${state.clockOffset.toFixed(3)}ms`);

    pushLog({
        wall_iso: new Date().toISOString(), type: 'SYNC', seq: ++state.logSeq,
        t1_browser_ms:    r.t1.toFixed(3),
        t2_python_rx_ms:  r.t2,
        t3_python_tx_ms:  r.t3,
        t4_browser_rx_ms: t4.toFixed(3),
        sync_rtt_ms:      syncRtt.toFixed(3),
        raw_offset_ms:    rawOffset.toFixed(3),
        smooth_offset_ms: state.clockOffset.toFixed(3),
    });

    const el = (id) => document.getElementById(id);
    const eo = el('syncOffset'), er = el('syncRtt'), es = el('syncStatus');
    if (eo) eo.textContent = state.clockOffset.toFixed(2) + ' ms';
    if (er) er.textContent = state.clockRtt.toFixed(2)    + ' ms';
    if (es) es.textContent = state.clockSynced ? 'Synced ✓' : 'Syncing…';
}

// ── Hz selector ───────────────────────────────────────────────────────────────

function setupHzSelector() {
    const sel     = document.getElementById('hzSelector');
    const display = document.getElementById('hzValue');
    if (!sel) return;
    sel.addEventListener('change', (e) => {
        CONFIG.sendHz = parseInt(e.target.value, 10);
        if (display) display.textContent = `${CONFIG.sendHz} Hz`;
        logInfo('send', `Rate changed to ${CONFIG.sendHz} Hz`);
        if (state.sendTimer) { stopSending(); startSending(); }
    });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
    // Register message handlers before any connection attempt
    handlers.onAck        = handleAck;
    handlers.onSyncResp   = handleSyncResp;
    handlers.onConnected  = startSending;
    handlers.toggleEStop  = () => state.eStop ? disengageEStop() : engageEStop();

    initChart();
    setupKeyboard();
    setupJoystick();
    setupSpeedControl();
    setupHzSelector();
    setupFieldSelector();
    setupRoutingSelectors();
    setupPrecisionToggle();
    setupFormatSelector();
    setupSteering();
    setupInputModeSelector();

    // Button wiring
    const $ = (id) => document.getElementById(id);
    $('connectBtn')    ?.addEventListener('click', () => state.connected ? disconnect() : connect());
    $('stopBtn')       ?.addEventListener('click', () => state.eStop ? disengageEStop() : engageEStop());
    $('syncBtn')       ?.addEventListener('click', sendSyncReq);
    $('resetZoomBtn')  ?.addEventListener('click', resetZoom);
    $('downloadLogBtn')?.addEventListener('click', downloadLog);
    $('clearLogBtn')   ?.addEventListener('click', clearLog);

    updateBreakdown({});
    logInfo('init', 'Teleop Dashboard ready (WebRTC P2P + Steering Wheel)');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}