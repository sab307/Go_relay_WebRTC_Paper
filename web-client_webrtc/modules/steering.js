/**
 * modules/steering.js
 * --------------------
 * Visual on-screen steering wheel + Gamepad API integration.
 *
 * Visual wheel
 * ─────────────
 *   • Drawn on <canvas id="wheelCanvas"> using 2D context.
 *   • Click / touch-drag to rotate; value mapped to angZ in [-1, 1].
 *   • Rotation angle = angZ × 135° (full-lock feel).
 *   • Reflects gamepad input when a controller is connected.
 *
 * Gamepad API
 * ────────────
 *   • Two operating modes selected by state.inputMode:
 *       - 'steering' : axis 0 bidirectional steer + axes 2/5 as pedal triggers
 *       - 'gamepad'  : dual-stick (Logitech F310/F710) with configurable axes
 *                      and an E-stop button (rising-edge → handlers.toggleEStop).
 *   • Polls only while a mode needs it (maybeStartGpPoll / stopGpPoll).
 *   • User-configurable: axis mapping, deadzone, sensitivity, per-axis invert,
 *     and E-stop button index.
 *   • When state.inputMode !== 'keyboard', writes to state.gpLinY / state.gpAngZ
 *     are the source-of-truth for sendTwist() in app.js.
 *
 * Velocity mapping
 * ─────────────────
 *   state.gpAngZ ← steer axis value × sensitivity, clamped to [-1, 1]
 *   state.gpLinY ← fwd   axis value × sensitivity, clamped to [-1, 1]
 *   These are read by sendTwist() in app.js.
 */

import { state, handlers }      from './state.js';
import { updateControlDisplay } from './ui.js';
import { logInfo, logWarn }     from './logger.js';

// Physical degrees of pointer travel that equal full-lock (±wheelRange output).
// Changing this constant changes the drag "weight" of the wheel.
const LOCK_RAD = 90 * Math.PI / 180;  // 90 

// ── Internal canvas refs ──────────────────────────────────────────────────────
let wheelCanvas = null;
let wheelCtx    = null;

// Drag state for the visual wheel
let dragging              = false;
let dragStartAngle        = 0;    // mouse angle at drag start (radians)
let dragStartAngZ         = 0;    // state.angZ at drag start

// rAF handle for the gamepad poll loop
let gpRAF = null;

// ── Math helpers ──────────────────────────────────────────────────────────────

function applyDeadzone(val, dz) {
    if (Math.abs(val) < dz) return 0;
    return (val - Math.sign(val) * dz) / (1 - dz);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Gamepad polling ───────────────────────────────────────────────────────────

/** Reads wheel + pedal trigger inputs (mode='steering'). */
function readWheelInputs(gp) {
    // Steer: axis 0 fixed, full bidirectional range
    const rawSteer = gp.axes[0] ?? 0;
    const steer = clamp(
        applyDeadzone(rawSteer, state.gpDeadzone) * state.gpSensitivity * (state.gpInvertSteer ? -1 : 1),
        -1, 1);

    // Fwd trigger: clamp to [0,1] — only positive portion drives forward
    const rawFwd = Math.max(0, gp.axes[state.gpFwdAxis] ?? 0);
    const fwd    = clamp(applyDeadzone(rawFwd, state.gpDeadzone) * state.gpSensitivity, 0, 1);

    // Rev trigger: clamp to [0,1] — only positive portion drives reverse (negated)
    const rawRev = Math.max(0, gp.axes[state.gpRevAxis] ?? 0);
    const rev    = clamp(applyDeadzone(rawRev, state.gpDeadzone) * state.gpSensitivity, 0, 1);

    state.gpAngZ   = steer;
    state.gpLinY   = fwd - rev;   // net linear: +1 full fwd, -1 full rev
    state.gpActive = Math.abs(rawSteer) > state.gpDeadzone
                  || rawFwd > state.gpDeadzone
                  || rawRev > state.gpDeadzone;

    // Live value display in the steering panel
    const steerEl = document.getElementById('gpSteerVal');
    const fwdEl   = document.getElementById('gpFwdVal');
    const revEl   = document.getElementById('gpRevVal');
    if (steerEl) steerEl.textContent = steer.toFixed(3);
    if (fwdEl)   fwdEl.textContent   = fwd.toFixed(3);
    if (revEl)   revEl.textContent   = rev.toFixed(3);
}

/** Reads dual-stick inputs + E-stop button (mode='gamepad').
 *  Defaults: left-stick Y → linear_x, right-stick X → angular_z, button B → E-stop. */
function readGamepadInputs(gp) {
    const rawLin = gp.axes[state.gpLinAxis] ?? 0;
    const rawAng = gp.axes[state.gpAngAxis] ?? 0;

    const linSign = state.gpInvertLinAxis ? -1 : 1;
    const angSign = state.gpInvertAngAxis ? -1 : 1;

    const lin = clamp(applyDeadzone(rawLin, state.gpDeadzone) * state.gpSensitivity * linSign, -1, 1);
    const ang = clamp(applyDeadzone(rawAng, state.gpDeadzone) * state.gpSensitivity * angSign, -1, 1);

    state.gpLinY   = lin;
    state.gpAngZ   = ang;
    state.gpActive = Math.abs(rawLin) > state.gpDeadzone
                  || Math.abs(rawAng) > state.gpDeadzone;

    // Live value display in the gamepad panel
    const linEl = document.getElementById('gpLinVal');
    const angEl = document.getElementById('gpAngVal');
    if (linEl) linEl.textContent = lin.toFixed(3);
    if (angEl) angEl.textContent = ang.toFixed(3);

    // E-stop button rising-edge: fires once per press, ignores hold
    const btn       = gp.buttons[state.gpEStopButton];
    const pressed   = btn?.pressed ?? false;
    const btnEl     = document.getElementById('gpEStopVal');
    if (btnEl) btnEl.textContent = pressed ? 'PRESSED' : 'released';
    if (pressed && !state.gpEStopPrev && handlers.toggleEStop) {
        handlers.toggleEStop();
    }
    state.gpEStopPrev = pressed;
}

function pollGamepad() {
    if (state.gpIndex === null) return;
    const gp = navigator.getGamepads()[state.gpIndex];
    if (!gp) { gpRAF = requestAnimationFrame(pollGamepad); return; }

    if      (state.inputMode === 'steering') readWheelInputs(gp);
    else if (state.inputMode === 'gamepad')  readGamepadInputs(gp);

    drawWheel();
    updateControlDisplay();
    gpRAF = requestAnimationFrame(pollGamepad);
}

/** Start the poll loop if a gamepad is connected AND the current input mode
 *  needs it. Exported so ui.js can call it on mode change. */
export function maybeStartGpPoll() {
    const needed = state.gpIndex !== null
                && (state.inputMode === 'gamepad' || state.inputMode === 'steering');
    if (!needed) return;
    if (gpRAF) cancelAnimationFrame(gpRAF);
    gpRAF = requestAnimationFrame(pollGamepad);
}

/** Stop the poll loop and zero out gamepad-derived state. */
export function stopGpPoll() {
    if (gpRAF) { cancelAnimationFrame(gpRAF); gpRAF = null; }
    state.gpActive    = false;
    state.gpAngZ      = 0;
    state.gpLinY      = 0;
    state.gpEStopPrev = false;
}

function updateGpStatusDisplay() {
    const el = document.getElementById('gpStatus');
    if (!el) return;
    if (state.gpIndex === null) {
        el.textContent = 'Not connected';
        el.style.color = 'var(--text2)';
    } else {
        const gp = navigator.getGamepads()[state.gpIndex];
        const id = gp?.id ?? '';
        el.textContent = id.length > 26 ? id.slice(0, 26) + '…' : (id || 'Connected');
        el.style.color = 'var(--cyan)';
    }
}

// Fwd and Rev selectors are restricted to Axis 2 and Axis 5 (trigger axes).
const TRIGGER_AXES = [2, 5];

function buildTriggerOptions(selectedIdx) {
    return TRIGGER_AXES.map(i =>
        `<option value="${i}"${i === selectedIdx ? ' selected' : ''}>Axis ${i}</option>`
    ).join('');
}

function refreshAxisDropdowns() {
    const fwdSel = document.getElementById('gpFwdAxisSel');
    const revSel = document.getElementById('gpRevAxisSel');
    if (fwdSel) fwdSel.innerHTML = buildTriggerOptions(state.gpFwdAxis);
    if (revSel) revSel.innerHTML = buildTriggerOptions(state.gpRevAxis);
}

// ── Visual wheel drawing ──────────────────────────────────────────────────────

/**
 * Draw the steering wheel on the canvas.
 * Called by the gamepad poll loop and by updateControlDisplay() hooks.
 * angZ range [-1, 1] maps to ±135° rotation.
 */
export function drawWheel() {
    if (!wheelCtx) return;
    const ctx    = wheelCtx;
    const W      = wheelCanvas.width;
    const H      = wheelCanvas.height;
    const cx     = W / 2;
    const cy     = H / 2;
    const outerR = W * 0.42;
    const innerR = W * 0.27;
    const hubR   = W * 0.09;
    const CYAN   = '#00f5d4';
    const BLUE   = '#4361ee';
    const PINK   = '#f72585';

    const angZVal = state.inputMode === 'keyboard' ? state.angZ : state.gpAngZ;
    // Normalize by wheelRange so full-lock value → ±LOCK_RAD rotation
    const normalized = clamp(angZVal / Math.max(state.wheelRange, 0.01), -1, 1);
    const angle      = normalized * LOCK_RAD;

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Outer rim
    ctx.beginPath();
    ctx.arc(0, 0, outerR, 0, Math.PI * 2);
    ctx.strokeStyle = CYAN;
    ctx.lineWidth   = W * 0.075;
    ctx.stroke();

    // Three spokes at 0°, 120°, 240°
    for (let i = 0; i < 3; i++) {
        const a = (i * 120 * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * (hubR * 1.15), Math.sin(a) * (hubR * 1.15));
        ctx.lineTo(Math.cos(a) * innerR,         Math.sin(a) * innerR);
        ctx.strokeStyle = BLUE;
        ctx.lineWidth   = W * 0.045;
        ctx.stroke();
    }

    // Center hub
    ctx.beginPath();
    ctx.arc(0, 0, hubR, 0, Math.PI * 2);
    ctx.fillStyle   = '#1a1a25';
    ctx.fill();
    ctx.strokeStyle = CYAN;
    ctx.lineWidth   = W * 0.025;
    ctx.stroke();

    // Top orientation dot
    ctx.beginPath();
    ctx.arc(0, -(outerR - W * 0.04), W * 0.038, 0, Math.PI * 2);
    ctx.fillStyle = PINK;
    ctx.fill();

    ctx.restore();

    // Value label below the wheel
    const label      = angZVal.toFixed(3);
    const labelColor = Math.abs(angZVal) > 0.01 ? CYAN : '#8a8a9a';
    ctx.fillStyle    = labelColor;
    ctx.font         = `bold ${Math.round(W * 0.09)}px 'JetBrains Mono', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, cx, H - 2);
}

// ── Visual wheel drag interaction ─────────────────────────────────────────────

/** Angle (radians) from canvas centre to a pointer event */
function pointerAngle(e) {
    const rect = wheelCanvas.getBoundingClientRect();
    const cx   = rect.left + rect.width  / 2;
    const cy   = rect.top  + rect.height / 2;
    const px   = e.clientX ?? e.touches?.[0]?.clientX ?? cx;
    const py   = e.clientY ?? e.touches?.[0]?.clientY ?? cy;
    return Math.atan2(py - cy, px - cx);
}

function onDragMove(e) {
    if (!dragging) return;
    const currentAngle = pointerAngle(e);
    let delta = currentAngle - dragStartAngle;
    // Wrap delta to (-π, π] to avoid discontinuity at ±180°
    while (delta >  Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // LOCK_RAD of pointer travel = wheelRange output units
    const newVal = clamp(dragStartAngZ + (delta / LOCK_RAD) * state.wheelRange,
                         -state.wheelRange, state.wheelRange);
    // Visual drag overrides both keyboard and gamepad
    state.gpActive = false;
    state.angZ     = newVal;
    drawWheel();
    updateControlDisplay();
    e.preventDefault?.();
}

function setupWheelDrag() {
    if (!wheelCanvas) return;

    wheelCanvas.style.cursor = 'grab';

    wheelCanvas.addEventListener('mousedown', (e) => {
        dragging       = true;
        dragStartAngle = pointerAngle(e);
        dragStartAngZ  = state.inputMode === 'keyboard' ? state.angZ : state.gpAngZ;
        wheelCanvas.style.cursor = 'grabbing';
        e.preventDefault();
    });

    wheelCanvas.addEventListener('touchstart', (e) => {
        dragging       = true;
        dragStartAngle = pointerAngle(e);
        dragStartAngZ  = state.inputMode === 'keyboard' ? state.angZ : state.gpAngZ;
        e.preventDefault();
    }, { passive: false });

    document.addEventListener('mousemove',  onDragMove);
    document.addEventListener('touchmove',  onDragMove, { passive: false });

    document.addEventListener('mouseup', () => {
        dragging = false;
        if (wheelCanvas) wheelCanvas.style.cursor = 'grab';
    });
    document.addEventListener('touchend', () => { dragging = false; });
}

// ── Public initialisation ─────────────────────────────────────────────────────

export function setupSteering() {
    // Canvas
    wheelCanvas = document.getElementById('wheelCanvas');
    if (wheelCanvas) {
        wheelCtx = wheelCanvas.getContext('2d');
        setupWheelDrag();
        drawWheel();
    }

    // ── Gamepad API events ────────────────────────────────────────────────────
    window.addEventListener('gamepadconnected', (e) => {
        state.gpIndex = e.gamepad.index;
        logInfo('gamepad',
            `Connected: ${e.gamepad.id} (${e.gamepad.axes.length} axes, ` +
            `${e.gamepad.buttons.length} buttons, mapping='${e.gamepad.mapping}')`);
        if (e.gamepad.mapping !== 'standard') {
            logWarn('gamepad',
                `Non-standard gamepad mapping — axis/button indices may not match ` +
                `expected layout. Check device settings (X-input vs D-input).`);
        }
        updateGpStatusDisplay();
        refreshAxisDropdowns();
        maybeStartGpPoll();
    });

    window.addEventListener('gamepaddisconnected', (e) => {
        if (e.gamepad.index === state.gpIndex) {
            logWarn('gamepad', `Disconnected: ${e.gamepad.id}`);
            stopGpPoll();
            state.gpIndex = null;
            updateGpStatusDisplay();
            drawWheel();
            updateControlDisplay();
        }
    });

    // Check for already-connected gamepads (e.g. after page reload)
    for (const gp of navigator.getGamepads()) {
        if (gp) {
            state.gpIndex = gp.index;
            logInfo('gamepad', `Pre-connected: ${gp.id} (mapping='${gp.mapping}')`);
            updateGpStatusDisplay();
            refreshAxisDropdowns();
            maybeStartGpPoll();
            break;
        }
    }

    // ── Options panel wiring ──────────────────────────────────────────────────

    // Steer axis is fixed to 0 — no selector wiring needed.

    // Forward trigger axis selector (Axis 2 / Axis 5)
    const fwdAxisSel = document.getElementById('gpFwdAxisSel');
    if (fwdAxisSel) {
        fwdAxisSel.addEventListener('change', (e) => {
            state.gpFwdAxis = parseInt(e.target.value, 10);
        });
    }

    // Reverse trigger axis selector (Axis 2 / Axis 5)
    const revAxisSel = document.getElementById('gpRevAxisSel');
    if (revAxisSel) {
        revAxisSel.addEventListener('change', (e) => {
            state.gpRevAxis = parseInt(e.target.value, 10);
        });
    }

    // Deadzone slider
    const dzSlider = document.getElementById('gpDzSlider');
    const dzVal    = document.getElementById('gpDzVal');
    if (dzSlider) {
        dzSlider.value = state.gpDeadzone;
        dzSlider.addEventListener('input', (e) => {
            state.gpDeadzone = parseFloat(e.target.value);
            if (dzVal) dzVal.textContent = state.gpDeadzone.toFixed(2);
        });
    }

    // Sensitivity slider
    const sensSlider = document.getElementById('gpSensSlider');
    const sensVal    = document.getElementById('gpSensVal');
    if (sensSlider) {
        sensSlider.value = state.gpSensitivity;
        sensSlider.addEventListener('input', (e) => {
            state.gpSensitivity = parseFloat(e.target.value);
            if (sensVal) sensVal.textContent = state.gpSensitivity.toFixed(1);
        });
    }

    // Invert steer toggle
    const invSteer = document.getElementById('gpInvertSteer');
    if (invSteer) {
        invSteer.checked = state.gpInvertSteer;
        invSteer.addEventListener('change', (e) => { state.gpInvertSteer = e.target.checked; });
    }

    // Steer range slider
    const rangeSlider = document.getElementById('wheelRangeSlider');
    const rangeVal    = document.getElementById('wheelRangeVal');
    if (rangeSlider) {
        rangeSlider.value = state.wheelRange;
        rangeSlider.addEventListener('input', (e) => {
            state.wheelRange = parseFloat(e.target.value);
            if (rangeVal) rangeVal.textContent = `±${state.wheelRange.toFixed(1)}`;
            drawWheel();
        });
    }

    // Return-to-centre button
    const centreBtn = document.getElementById('wheelCentreBtn');
    if (centreBtn) {
        centreBtn.addEventListener('click', () => {
            state.angZ   = 0;
            state.gpAngZ = 0;
            state.gpActive = false;
            drawWheel();
            updateControlDisplay();
        });
    }

    // ── Dual-stick (Logitech) mode wiring ─────────────────────────────────────

    // Linear axis selector (stick Y axes)
    const linAxisSel = document.getElementById('gpLinAxisSel');
    if (linAxisSel) {
        linAxisSel.value = String(state.gpLinAxis);
        linAxisSel.addEventListener('change', (e) => {
            state.gpLinAxis = parseInt(e.target.value, 10);
        });
    }

    // Angular axis selector (stick X axes)
    const angAxisSel = document.getElementById('gpAngAxisSel');
    if (angAxisSel) {
        angAxisSel.value = String(state.gpAngAxis);
        angAxisSel.addEventListener('change', (e) => {
            state.gpAngAxis = parseInt(e.target.value, 10);
        });
    }

    // Invert linear axis
    const invLin = document.getElementById('gpInvertLinAxis');
    if (invLin) {
        invLin.checked = state.gpInvertLinAxis;
        invLin.addEventListener('change', (e) => { state.gpInvertLinAxis = e.target.checked; });
    }

    // Invert angular axis
    const invAng = document.getElementById('gpInvertAngAxis');
    if (invAng) {
        invAng.checked = state.gpInvertAngAxis;
        invAng.addEventListener('change', (e) => { state.gpInvertAngAxis = e.target.checked; });
    }

    // E-stop button picker (index 0..15)
    const estopSel = document.getElementById('gpEStopButtonSel');
    if (estopSel) {
        // Populate with standard Xbox-layout labels
        const labels = ['A (0)','B (1)','X (2)','Y (3)','LB (4)','RB (5)','LT (6)','RT (7)',
                        'Back (8)','Start (9)','L3 (10)','R3 (11)','Up (12)','Down (13)','Left (14)','Right (15)'];
        estopSel.innerHTML = labels.map((l, i) =>
            `<option value="${i}"${i === state.gpEStopButton ? ' selected' : ''}>${l}</option>`).join('');
        estopSel.addEventListener('change', (e) => {
            state.gpEStopButton = parseInt(e.target.value, 10);
            state.gpEStopPrev   = false;  // reset latch so new button starts clean
        });
    }

    // Redraw wheel at ~10 Hz even when gamepad is not polling
    // (keeps it in sync with keyboard / joystick angZ changes)
    setInterval(() => { if (!gpRAF) drawWheel(); }, 100);

    refreshAxisDropdowns();
}