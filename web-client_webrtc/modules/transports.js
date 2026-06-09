/**
 * modules/transports.js — WebRTC-only build
 * -----------------------------------------
 *
 * Single Transport driver: WebRTC RTCDataChannel, established P2P after
 * signaling via the Go relay's /ws/signal endpoint. Once the channel opens
 * the Go relay is no longer in the data path.
 *
 *   interface Transport {
 *     onOpen, onClose, onMessage callbacks
 *     connect(): Promise<void>
 *     send(data: ArrayBuffer | string): void
 *     close(): void
 *     get isOpen(): boolean
 *   }
 *
 * Frame typing: binary frames arrive as ArrayBuffer, text frames as string.
 */

import { CONFIG } from './config.js';
import { logDebug, logInfo, logWarn, logError } from './logger.js';

class Transport {
    constructor() {
        this.onOpen = null;
        this.onClose = null;
        this.onMessage = null;
    }
    async connect() { throw new Error('not implemented'); }
    send(_data) { throw new Error('not implemented'); }
    close() {}
    get isOpen() { return false; }
    get label() { return 'transport'; }
}

class WebRtcTransport extends Transport {
    constructor() {
        super();
        this._sigWs = null;
        this._pc = null;
        this._dc = null;
        this._myPeerId = '';
    }

    get label() { return 'webrtc'; }
    get isOpen() { return !!this._dc && this._dc.readyState === 'open'; }

    async connect() {
        const url = CONFIG.signalUrl;
        logInfo('webrtc', `Connecting to signaling: ${url}`);
        this._sigWs = new WebSocket(url);
        this._sigWs.onclose = () => logInfo('signal', 'Signaling WebSocket closed');
        this._sigWs.onerror = (e) => logError('signal', 'Signaling WS error', e);

        await new Promise((resolve, reject) => {
            this._sigWs.onopen = resolve;
            this._sigWs.onerror = reject;
        });
        logInfo('signal', 'Signaling connected — waiting for peer_ready…');

        this._pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
        this._dc = this._pc.createDataChannel('teleop', { ordered: false, maxRetransmits: 0 });
        this._dc.binaryType = 'arraybuffer';

        this._dc.onopen    = () => { logInfo('webrtc', 'DataChannel open — P2P established'); this.onOpen && this.onOpen(); };
        this._dc.onclose   = () => { logInfo('webrtc', 'DataChannel closed'); this.onClose && this.onClose(); };
        this._dc.onerror   = (e) => logError('webrtc', 'DataChannel error', e);
        this._dc.onmessage = (e) => this.onMessage && this.onMessage(e.data);

        this._pc.onicecandidate = (e) => {
            if (!e.candidate) return;
            const c = e.candidate;
            this._sendSignal({ type: 'ice_candidate', candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
            logDebug('ice', 'Sent local ICE candidate');
        };
        this._pc.onconnectionstatechange = () => {
            const st = this._pc.connectionState;
            logInfo('webrtc', `Connection state: ${st}`);
            if (st === 'failed') { logError('webrtc', 'WebRTC connection failed'); this.onClose && this.onClose(); }
        };

        this._sigWs.onmessage = (e) => this._onSignal(JSON.parse(e.data));
    }

    send(data) { this._dc.send(data); }

    close() {
        try { this._dc?.close(); } catch (_) {}
        try { this._pc?.close(); } catch (_) {}
        try { this._sigWs?.close(); } catch (_) {}
        this._dc = null; this._pc = null; this._sigWs = null;
    }

    _sendSignal(msg) {
        if (this._sigWs && this._sigWs.readyState === WebSocket.OPEN)
            this._sigWs.send(JSON.stringify(msg));
    }

    async _onSignal(msg) {
        switch (msg.type) {
            case 'welcome':
                this._myPeerId = msg.peer_id;
                logInfo('signal', `Peer ID: ${this._myPeerId}`);
                break;
            case 'peer_ready':
                if (msg.role === 'python') {
                    logInfo('signal', 'Python ready — sending SDP offer…');
                    const offer = await this._pc.createOffer();
                    await this._pc.setLocalDescription(offer);
                    this._sendSignal({ type: 'offer', sdp: this._pc.localDescription.sdp });
                    logInfo('signal', 'SDP offer sent');
                }
                break;
            case 'answer':
                logInfo('signal', 'Received SDP answer from Python');
                await this._pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
                break;
            case 'ice_candidate':
                if (msg.candidate && this._pc) {
                    try {
                        await this._pc.addIceCandidate(new RTCIceCandidate({
                            candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex,
                        }));
                        logDebug('ice', 'Added remote ICE candidate');
                    } catch (err) { logDebug('ice', `ICE add error (may be ok): ${err.message}`); }
                }
                break;
            case 'peer_disconnected':
                if (msg.role === 'python') { logWarn('signal', 'Python peer disconnected'); this.onClose && this.onClose(); }
                break;
            default:
                logDebug('signal', `Unknown signal message: ${msg.type}`);
        }
    }
}

export function createTransport(_kind) {
    return new WebRtcTransport();
}
