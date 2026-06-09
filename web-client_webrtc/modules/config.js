/**
 * modules/config.js
 * -----------------
 * Global configuration constants.  Change values here to tune behaviour
 * without touching application logic.
 */

export const CONFIG = {
    /** WebSocket URL of the Go signaling server.
     *  Automatically uses wss:// when the page is served over HTTPS,
     *  so no manual change is needed when TLS is enabled on the server. */
    signalUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:${location.port || (location.protocol === 'https:' ? '443' : '80')}/ws/signal?role=browser`,

    /** WebSocket data-hub URL (browser leg of the WebSocket transport). */
    dataWsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:${location.port || (location.protocol === 'https:' ? '443' : '80')}/ws/data?role=browser`,

    /** UDP port the Go relay's WebTransport (HTTP/3) listener uses.
     *  Defaults to the page's port because --wt-port defaults to --port on the
     *  relay (QUIC/UDP can share the number with HTTPS/TCP). Override if you ran
     *  the relay with a distinct --wt-port. */
    wtPort: Number(location.port) || 443,

    /** WebTransport URL — HTTP/3 is TLS-only, so this is always https://. */
    wtUrl: `https://${location.hostname || 'localhost'}:${location.port || 443}/wt?role=browser`,

    /** Default command transport: 'webrtc' | 'websocket' | 'webtransport'.
     *  Overridden on load by the relay's /status (--type) when available. */
    transport: 'webrtc',

    /** Default wire codec: 'binary' | 'json'. */
    format: 'binary',

    /** Default Twist send rate in Hz (overridden at runtime by the Hz selector) */
    sendHz: 20,

    /** Seconds of history shown on the latency chart */
    chartWindowSec: 20,

    /** How often (ms) to fire a background clock-sync req while connected */
    syncIntervalMs: 10000,

    /** How often (ms) to send an idle ClockSyncReq keep-alive when not moving */
    idlePingIntervalMs: 1000,

    /** Speed slider bounds and default (velocity is in the range ±maxSpeed) */
    minSpeed: 0.05,
    maxSpeed: 1.0,
    defaultSpeed: 0.5,

    /** Key-repeat interval while a key is held (ms) */
    keyRepeatMs: 50,

    /** ICE servers for WebRTC NAT traversal */
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],

    /** Set true to enable verbose console.debug output */
    debugLog: false,

    /** Log full timestamp table every N acks */
    tsLogEvery: 20,

    /** Max rows kept in the in-memory CSV log buffer */
    logMaxRows: 100000,
};