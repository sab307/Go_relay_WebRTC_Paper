/**
 * modules/ui.js
 * -------------
 * All DOM read/write helpers: metric cards, breakdown, timestamps, clock-sync
 * display, speed slider, Hz selector wiring, and field-mask selector.
 *
 * Note: setupHzSelector is intentionally kept in app.js because it restarts
 * the send timer — a concern owned by the orchestrator.
 */

import { CONFIG }       from './config.js';
import { state }        from './state.js';
import { FIELD_ORDER, popcount,
         FIELD_LINEAR_X,  FIELD_LINEAR_Y,  FIELD_LINEAR_Z,
         FIELD_ANGULAR_X, FIELD_ANGULAR_Y, FIELD_ANGULAR_Z } from './protocol.js';
import { maybeStartGpPoll, stopGpPoll, drawWheel } from './steering.js';
import { logInfo }      from './logger.js';

// ── Connection badge ──────────────────────────────────────────────────────────

export function setConnected(v) {
    state.connected = v;
    const dot  = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const btn  = document.getElementById('connectBtn');
    if (dot)  dot.classList.toggle('on', v);
    if (text) text.textContent = v ? 'Connected (P2P)' : 'Disconnected';
    if (btn)  btn.textContent  = v ? 'Disconnect'      : 'Connect';
}

// ── Velocity display ──────────────────────────────────────────────────────────

export function updateControlDisplay() {
    const useGp   = state.inputMode !== 'keyboard';
    const effLinY = useGp ? state.gpLinY : state.linY;
    const effAngZ = useGp ? state.gpAngZ : state.angZ;
    const linEl   = document.getElementById('linY');
    const angEl   = document.getElementById('angZ');
    if (linEl) linEl.textContent = effLinY.toFixed(2);
    if (angEl) angEl.textContent = effAngZ.toFixed(2);
    updateKeyIndicators();
}

export function updateKeyIndicators() {
    ['w','a','s','d'].forEach(k => {
        const el  = document.getElementById(`key-${k}`);
        const alt = k==='w'?'arrowup' : k==='s'?'arrowdown' : k==='a'?'arrowleft' : 'arrowright';
        if (el) el.classList.toggle('active', state.keysPressed.has(k) || state.keysPressed.has(alt));
    });
}

// ── CRC error counter ────────────────────────────────────────────────────────

export function updateCrcDisplay() {
    const el = document.getElementById('crcErrors');
    if (el) {
        el.textContent = state.crcErrors;
        el.style.color = state.crcErrors > 0 ? 'var(--magenta)' : 'var(--cyan)';
    }
}

// ── Latency metrics ───────────────────────────────────────────────────────────

export function updateMetrics(lat) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined && !isNaN(val))
            el.innerHTML = val.toFixed(1) + '<span class="metric-unit">ms</span>';
    };
    set('mRtt', lat.rtt);
    set('mBR',  lat.toPython);
    set('mPy',  lat.pythonMs);
    set('mPR',  lat.fromPython);
}

export function updateBreakdown(lat) {
    const el = document.getElementById('breakdown');
    if (!el) return;
    const items = [
        { label: 'Browser → Python', color: '#f72585', val: lat.toPython,   unit: 'ms' },
        { label: 'Python Decode',    color: '#4361ee', val: lat.decode_us,  unit: 'μs' },
        { label: 'Python Process',   color: '#4361ee', val: lat.process_us, unit: 'μs' },
        { label: 'Python Encode',    color: '#4361ee', val: lat.encode_us,  unit: 'μs' },
        { label: 'Python → Browser', color: '#ff6b35', val: lat.fromPython, unit: 'ms' },
        { label: 'Total RTT',        color: '#00f5d4', val: lat.rtt,        unit: 'ms' },
    ];
    el.innerHTML = items.map(i => `
        <div class="breakdown-item">
            <div class="breakdown-label">
                <div class="breakdown-dot" style="background:${i.color}"></div>
                ${i.label}
            </div>
            <div class="breakdown-val" style="color:${i.color}">
                ${(i.val !== undefined && !isNaN(i.val))
                    ? i.val.toFixed(i.unit === 'μs' ? 0 : 2)
                    : '--'} ${i.unit}
            </div>
        </div>`).join('');
}

export function updateTimestamps(lat) {
    const el = document.getElementById('timestamps');
    if (!el) return;
    const fmt = ts => ts ? new Date(ts).toISOString().substr(11, 12) : '--';
    el.innerHTML = `
        <div class="ts-row"><span class="ts-label">t1 Browser Send</span><span class="ts-val">${fmt(lat.t1)}</span></div>
        <div class="ts-row"><span class="ts-label">t3 Python Rx</span><span class="ts-val">${fmt(lat.t3py)}</span></div>
        <div class="ts-row"><span class="ts-label">t4 Python Ack</span><span class="ts-val">${fmt(lat.t4py)}</span></div>
        <div class="ts-row"><span class="ts-label">t6 Browser Rx</span><span class="ts-val">${fmt(lat.t6)}</span></div>
        <div class="ts-row"><span class="ts-label">Clock Offset</span><span class="ts-val">${state.clockOffset.toFixed(1)} ms</span></div>`;
}

// ── Field mask info ───────────────────────────────────────────────────────────

/** Bit masks of the two field groups for convenience. */
const LINEAR_MASK  = FIELD_LINEAR_X  | FIELD_LINEAR_Y  | FIELD_LINEAR_Z;
const ANGULAR_MASK = FIELD_ANGULAR_X | FIELD_ANGULAR_Y | FIELD_ANGULAR_Z;

/** Returns which field the sendTwist first-match routing currently targets.
 *  Must stay in sync with the priority ordering in app.js:sendTwist():
 *    linear:  X → Y → Z
 *    angular: Z → X → Y
 *  Returns '' if no field in the group is enabled. */
function currentRoutedField(group) {
    if (group === 'linear') {
        if (state.fieldMask & FIELD_LINEAR_X) return 'linear_x';
        if (state.fieldMask & FIELD_LINEAR_Y) return 'linear_y';
        if (state.fieldMask & FIELD_LINEAR_Z) return 'linear_z';
        return '';
    }
    if (state.fieldMask & FIELD_ANGULAR_Z) return 'angular_z';
    if (state.fieldMask & FIELD_ANGULAR_X) return 'angular_x';
    if (state.fieldMask & FIELD_ANGULAR_Y) return 'angular_y';
    return '';
}

/** Populate the field-mask checkboxes from state.fieldMask.
 *  Re-rendered whenever the mask changes so the UI stays consistent. */
function renderFieldCheckboxes() {
    const container = document.getElementById('fieldSelector');
    if (!container) return;
    container.innerHTML = FIELD_ORDER.map(f => {
        const checked = (state.fieldMask & f.bit) ? 'checked' : '';
        return `<label class="field-toggle">
                    <input type="checkbox" data-bit="${f.bit}" ${checked}>
                    <span class="field-name">${f.label}</span>
                    <span class="field-bit">0x${f.bit.toString(16).padStart(2,'0')}</span>
                </label>`;
    }).join('');
}

/** Reflect the current mask in the routing dropdowns (if present). */
function syncRoutingDropdowns() {
    const linSel = document.getElementById('linearRouteSel');
    const angSel = document.getElementById('angularRouteSel');
    if (linSel) linSel.value = currentRoutedField('linear');
    if (angSel) angSel.value = currentRoutedField('angular');
}

export function updateFieldInfo() {
    const n        = popcount(state.fieldMask);
    const perField = state.halfPrecision ? 4 : 8;
    const size     = 18 + n * perField + 1;   // header(18) + N×(4|8) + CRC(1)
    const maskEl  = document.getElementById('fieldMask');
    const sizeEl  = document.getElementById('msgSize');
    const countEl = document.getElementById('fieldCount');
    if (maskEl)  maskEl.textContent  = `0x${state.fieldMask.toString(16).padStart(2,'0')}`;
    if (sizeEl)  sizeEl.textContent  = `${size}B`;
    if (countEl) countEl.textContent = `${n}/6`;
    syncRoutingDropdowns();
}

// ── Wire-format selector (binary ↔ json) ─────────────────────────────────────
// Both ends of the link must agree on the codec.  Switching while connected is
// safe on the browser side (next encodeTwist() picks up state.format) but the
// Python peer was started with one --format, so changing this here without
// restarting Python will cause decode errors at the other end.  We log a warn
// when the operator flips it mid-session so the mismatch is obvious.

export function setupFormatSelector() {
    const radios = document.querySelectorAll('input[name="wireFormat"]');
    if (radios.length === 0) return;

    state.format = (CONFIG.format === 'json') ? 'json' : 'binary';
    radios.forEach(r => { r.checked = (r.value === state.format); });
    updateFieldInfo();

    radios.forEach(r => r.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        const next = e.target.value === 'json' ? 'json' : 'binary';
        if (next === state.format) return;
        state.format = next;
        logInfo('format', `Wire codec → ${state.format}`);
        if (state.link && state.link.isOpen) {
            logInfo('format',
                'Live switch — make sure the Python peer was started with the same --format');
        }
        updateFieldInfo();
    }));
}

// ── Precision toggle (float64 ↔ float32) ─────────────────────────────────────

export function setupPrecisionToggle() {
    const btn = document.getElementById('precisionBtn');
    if (!btn) return;
    const render = () => {
        const hp = state.halfPrecision;
        btn.textContent = `Precision: ${hp ? 'f32 (4 B/field)' : 'f64 (8 B/field)'}`;
        btn.classList.toggle('precision-half', hp);
    };
    btn.addEventListener('click', () => {
        state.halfPrecision = !state.halfPrecision;
        render();
        updateFieldInfo();
    });
    render();
}

// ── Setup functions ───────────────────────────────────────────────────────────

export function setupSpeedControl() {
    const slider  = document.getElementById('speedSlider');
    const display = document.getElementById('speedValue');
    if (!slider) return;
    slider.min   = CONFIG.minSpeed;
    slider.max   = CONFIG.maxSpeed;
    slider.step  = 0.05;
    slider.value = CONFIG.defaultSpeed;
    state.currentSpeed = CONFIG.defaultSpeed;
    if (display) display.textContent = CONFIG.defaultSpeed.toFixed(2);
    slider.addEventListener('input', (e) => {
        state.currentSpeed = parseFloat(e.target.value);
        if (display) display.textContent = state.currentSpeed.toFixed(2);
    });
}

export function setupFieldSelector() {
    const container = document.getElementById('fieldSelector');
    if (!container) return;
    renderFieldCheckboxes();
    container.addEventListener('change', (e) => {
        if (e.target.type !== 'checkbox') return;
        const bit = parseInt(e.target.dataset.bit);
        if (e.target.checked) state.fieldMask |=  bit;
        else                  state.fieldMask &= ~bit;
        updateFieldInfo();
    });
    updateFieldInfo();
}

/**
 * Wire the two routing dropdowns (linear and angular).
 * Changing a dropdown clears all bits in that group and sets only the chosen one
 * (or clears the group entirely for the blank '— off —' option). The checkbox
 * panel is re-rendered so it reflects the new mask.
 */
export function setupRoutingSelectors() {
    const linSel = document.getElementById('linearRouteSel');
    const angSel = document.getElementById('angularRouteSel');

    const bitOf = {
        linear_x:  FIELD_LINEAR_X,   linear_y:  FIELD_LINEAR_Y,   linear_z:  FIELD_LINEAR_Z,
        angular_x: FIELD_ANGULAR_X,  angular_y: FIELD_ANGULAR_Y,  angular_z: FIELD_ANGULAR_Z,
    };

    const wire = (sel, groupMask) => {
        if (!sel) return;
        sel.addEventListener('change', (e) => {
            state.fieldMask &= ~groupMask;              // clear all bits in group
            const chosen = bitOf[e.target.value];       // undefined if '— off —'
            if (chosen) state.fieldMask |= chosen;
            renderFieldCheckboxes();
            updateFieldInfo();                          // also syncs the dropdowns
        });
    };

    wire(linSel, LINEAR_MASK);
    wire(angSel, ANGULAR_MASK);

    syncRoutingDropdowns();
}

// ── Input source selector (keyboard / gamepad / steering) ─────────────────────

/** Panel data-attributes toggled by the selector.
 *  Each element with [data-input-mode="<mode>"] is shown only when selected. */
function setInputModePanels(mode) {
    document.querySelectorAll('[data-input-mode]').forEach(el => {
        const modes = el.dataset.inputMode.split(/\s+/);
        el.classList.toggle('hidden', !modes.includes(mode));
    });
}

/**
 * Wire the input-source radio group and switch cleanly between the three modes.
 * On each switch we:
 *   1. update state.inputMode
 *   2. zero out the inactive-source state (so no stale values get sent)
 *   3. start or stop the gamepad poll as needed
 *   4. toggle panel visibility and redraw the wheel
 */
export function setupInputModeSelector() {
    const radios = document.querySelectorAll('input[name="inputMode"]');
    if (radios.length === 0) return;

    // Reflect current state.inputMode in the DOM on load
    radios.forEach(r => { r.checked = (r.value === state.inputMode); });
    setInputModePanels(state.inputMode);

    radios.forEach(r => r.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        const mode = e.target.value;
        state.inputMode = mode;

        // Zero residual values so a recently-active source doesn't linger
        state.linY = 0;   state.angZ = 0;
        stopGpPoll();                 // clears gpLinY/gpAngZ, cancels rAF
        if (mode !== 'keyboard') maybeStartGpPoll();

        setInputModePanels(mode);
        updateControlDisplay();
        drawWheel();
        logInfo('input', `Mode → ${mode}`);
    }));
}