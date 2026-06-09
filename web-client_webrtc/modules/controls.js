/**
 * modules/controls.js
 * --------------------
 * Keyboard and joystick input handlers.
 * Both write directly to state.linY / state.angZ.
 * Gamepad / steering-wheel is handled separately in steering.js.
 */

import { state, handlers }      from './state.js';
import { updateControlDisplay } from './ui.js';

/** Movement key set (everything except space) */
const MOVE_KEYS = new Set(['w','s','a','d','arrowup','arrowdown','arrowleft','arrowright']);
const ALL_KEYS  = new Set([...MOVE_KEYS, ' ']);

// ── Keyboard ──────────────────────────────────────────────────────────────────

export function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        // Ignore if focus is on a text input or select
        if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
        const key = e.key.toLowerCase();
        if (!ALL_KEYS.has(key)) return;
        e.preventDefault();

        // Space toggles e-stop
        if (key === ' ') {
            handlers.toggleEStop();
            return;
        }

        state.keysPressed.add(key);
        updateFromKeys();
    });
    document.addEventListener('keyup', (e) => {
        state.keysPressed.delete(e.key.toLowerCase());
        updateFromKeys();
    });
    // Key-repeat while held
    state.keyTimer = setInterval(() => {
        if (state.keysPressed.size > 0) updateFromKeys();
    }, 50);
}

export function updateFromKeys() {
    // Only keyboard mode routes WASD → state.linY/angZ
    if (state.inputMode !== 'keyboard') return;
    // E-stop blocks all movement output
    if (state.eStop) return;

    let newLinY = 0, newAngZ = 0;
    if (state.keysPressed.has('w') || state.keysPressed.has('arrowup'))    newLinY =  state.currentSpeed;
    if (state.keysPressed.has('s') || state.keysPressed.has('arrowdown'))  newLinY = -state.currentSpeed;
    if (state.keysPressed.has('a') || state.keysPressed.has('arrowleft'))  newAngZ =  state.currentSpeed;
    if (state.keysPressed.has('d') || state.keysPressed.has('arrowright')) newAngZ = -state.currentSpeed;

    state.linY = newLinY;
    state.angZ = newAngZ;
    updateControlDisplay();
}

// ── Joystick (on-screen analogue stick) ──────────────────────────────────────

export function setupJoystick() {
    const container = document.getElementById('joystick');
    const knob      = document.getElementById('knob');
    if (!container || !knob) return;

    let dragging = false;

    const update = (x, y) => {
        if (state.inputMode !== 'keyboard') return;
        const rect = container.getBoundingClientRect();
        const cx   = rect.width  / 2;
        const cy   = rect.height / 2;
        const maxR = (rect.width - knob.offsetWidth) / 2;
        let dx = x - cx, dy = y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxR) { dx = dx / dist * maxR; dy = dy / dist * maxR; }
        knob.style.left = `${cx + dx}px`;
        knob.style.top  = `${cy + dy}px`;
        state.linY = -(dy / maxR) * state.currentSpeed;
        state.angZ = -(dx / maxR) * state.currentSpeed;
        updateControlDisplay();
    };

    const getXY = (e) => {
        const rect = container.getBoundingClientRect();
        return [
            (e.clientX ?? e.touches?.[0]?.clientX ?? rect.width  / 2) - rect.left,
            (e.clientY ?? e.touches?.[0]?.clientY ?? rect.height / 2) - rect.top,
        ];
    };

    const onMove = (e) => { if (!dragging) return; e.preventDefault(); update(...getXY(e)); };
    const onEnd  = () => {
        if (!dragging) return;
        dragging = false;
        knob.style.left = '50%';
        knob.style.top  = '50%';
        if (state.inputMode === 'keyboard') { state.linY = 0; state.angZ = 0; updateControlDisplay(); }
    };

    knob.addEventListener('mousedown',  () => dragging = true);
    knob.addEventListener('touchstart', () => dragging = true, { passive: true });
    document.addEventListener('mousemove',  onMove);
    document.addEventListener('touchmove',  onMove, { passive: false });
    document.addEventListener('mouseup',    onEnd);
    document.addEventListener('touchend',   onEnd);
}