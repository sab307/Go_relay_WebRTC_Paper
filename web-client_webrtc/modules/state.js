/**
 * modules/state.js
 * ----------------
 * Single shared mutable state object.  All modules import this and mutate
 * the same object, avoiding circular-import issues caused by passing
 * callbacks everywhere.
 *
 * handlers{}  – set by app.js after module load to break the
 *               connection.js → app.js circular dependency.
 */

export const state = {
    // ── Active transport ──────────────────────────────────────────────────────
    /** The current Transport instance (WebRTC | WebSocket | WebTransport). */
    link:         null,
    /** Selected transport kind: 'webrtc' | 'websocket' | 'webtransport'. */
    transport:    'webrtc',
    /** Selected wire codec: 'binary' | 'json'. Mirrored to the UI radio group
     *  via setupFormatSelector(); both ends of the link MUST agree (Python
     *  side is told via --format). Default overridden at init from CONFIG. */
    format:       'binary',

    /** Pending Twist sends awaiting their ACK, keyed by msgId. */
    pendingTwists: new Map(),
    /** Currently selected input source: 'keyboard' | 'gamepad' | 'steering'. */
    inputMode:    'keyboard',
    /** When true, Twist values are packed as float32 instead of float64. */
    halfPrecision: false,

    // ── WebRTC connection ─────────────────────────────────────────────────────
    sigWs:        null,
    pc:           null,
    dc:           null,
    myPeerId:     '',
    connected:    false,
    syncInterval: null,

    // ── Clock sync ────────────────────────────────────────────────────────────
    clockOffset: 0,
    clockRtt:    0,
    clockSynced: false,
    offsets:     [],

    // ── Message sending ───────────────────────────────────────────────────────
    msgId:          0,
    sendTimer:      null,
    twistActive:    false,
    lastIdlePingMs: 0,
    eStop:          false,  // when true, all twist output is zeroed and suppressed

    // ── Keyboard / joystick velocities ────────────────────────────────────────
    linY:         0,      // forward / backward [-currentSpeed, +currentSpeed]
    angZ:         0,      // turn left / right  [-currentSpeed, +currentSpeed]
    currentSpeed: 0.5,    // scale set by the speed slider
    keysPressed:  new Set(),
    keyTimer:     null,

    // ── Gamepad / steering-wheel ───────────────────────────────────────────────
    gpIndex:       null,  // index in navigator.getGamepads(), null = none
    gpSteerAxis:   0,     // fixed: axis 0 → angular.z
    gpFwdAxis:     2,     // trigger axis for forward  (positive values only) → +linear
    gpRevAxis:     5,     // trigger axis for reverse  (positive values only) → -linear
    gpDeadzone:    0.05,  // axis values below this are treated as 0
    gpSensitivity: 1.0,   // multiplier applied after deadzone removal
    gpInvertSteer: false, // flip sign of steer axis
    wheelRange:    1.0,   // max output for full-lock drag (±wheelRange)

    // Computed values written by the gamepad poll loop
    gpLinY:   0,
    gpAngZ:   0,
    gpActive: false,      // true while gamepad has non-zero output

    // ── Binary protocol ───────────────────────────────────────────────────────
    /** Bitmask of which Twist fields to include in each message (0x01–0x3F) */
    fieldMask: 0x22,      // FIELD_LINEAR_Y | FIELD_ANGULAR_Z

    // ── Statistics ────────────────────────────────────────────────────────────
    ackCount:  0,
    crcErrors: 0,

    // ── In-memory CSV log buffer ──────────────────────────────────────────────
    logBuffer: [],
    logSeq:    0,

    // ── Chart ─────────────────────────────────────────────────────────────────
    chartBgActive: false,  // false = white (idle), true = dark (active)
};

/**
 * handlers
 * Set by app.js before any connection is made so that connection.js can
 * dispatch incoming messages without importing app.js (which would be circular).
 */
export const handlers = {
    onAck:        null,   // (ArrayBuffer) → void
    onSyncResp:   null,   // (ArrayBuffer) → void
    onConnected:  null,   // () → void  (called when DataChannel opens)
    toggleEStop:  null,   // () → void  (space / stop button)
};