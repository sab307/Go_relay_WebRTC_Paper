package main

/*
WebRTC Signaling Relay (transport-specific build)
=================================================

This binary only does the WebRTC handshake (SDP + ICE exchange) over
WebSocket between a browser and a Python peer. Once the RTCPeerConnection
is up and the DataChannel opens, all teleop traffic flows DIRECTLY between
the two peers; this server is no longer in the data path.

It serves:
  WS /ws/signal?role=python    Python peer  (WebRTC signaling)
  WS /ws/signal?role=browser   Browser peer (WebRTC signaling)
  GET /health, /status         Diagnostics
  GET /                        Static web root (serves web-client_webrtc/)

It deliberately does NOT serve /ws/data or /wt. If you need those, use
the sibling go_relay_websocket/ or go_relay_webtransport/ binary.

Run:
  go run . --port 8443 --tls-cert ../certs/cert.pem --tls-key ../certs/key.pem
  # or plaintext for dev:
  go run . --port 8080 --web-root ../web-client_webrtc
*/

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Signal message ───────────────────────────────────────────────────────────

type SignalMsg struct {
	Type          string `json:"type"`
	SDP           string `json:"sdp,omitempty"`
	Candidate     string `json:"candidate,omitempty"`
	SdpMid        string `json:"sdpMid,omitempty"`
	SdpMLineIndex *int   `json:"sdpMLineIndex,omitempty"`
	Role          string `json:"role,omitempty"`
	PeerID        string `json:"peer_id,omitempty"`
	FromPeer      string `json:"from_peer,omitempty"`
	ToPeer        string `json:"to_peer,omitempty"`
}

// ─── Peer ─────────────────────────────────────────────────────────────────────

type Peer struct {
	id   string
	role string
	conn *websocket.Conn
	send chan []byte
	mu   sync.Mutex
	hub  *Hub
}

func newPeerID(role string) string {
	return fmt.Sprintf("%s_%d", role, time.Now().UnixNano())
}

func (p *Peer) sendMsg(msg SignalMsg) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[signal] marshal error: %v", err)
		return
	}
	select {
	case p.send <- data:
	default:
		log.Printf("[signal] %s send buffer full — dropping", p.id)
	}
}

func (p *Peer) writeLoop() {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case msg, ok := <-p.send:
			if !ok {
				p.mu.Lock()
				_ = p.conn.WriteMessage(websocket.CloseMessage, nil)
				p.mu.Unlock()
				return
			}
			p.mu.Lock()
			err := p.conn.WriteMessage(websocket.TextMessage, msg)
			p.mu.Unlock()
			if err != nil {
				return
			}
		case <-ticker.C:
			p.mu.Lock()
			err := p.conn.WriteMessage(websocket.PingMessage, nil)
			p.mu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

func (p *Peer) readLoop() {
	p.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	p.conn.SetPongHandler(func(string) error {
		p.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	for {
		_, data, err := p.conn.ReadMessage()
		if err != nil {
			return
		}
		p.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		var msg SignalMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("[signal] %s bad JSON: %v", p.id, err)
			continue
		}
		p.hub.dispatch(p, msg)
	}
}

// ─── Hub ──────────────────────────────────────────────────────────────────────

type Hub struct {
	mu       sync.RWMutex
	python   *Peer
	browsers map[string]*Peer
}

var hub = &Hub{browsers: make(map[string]*Peer)}

func (h *Hub) add(p *Peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.role == "python" {
		if h.python != nil {
			log.Printf("[signal] Python reconnect — closing old %s", h.python.id)
			close(h.python.send)
		}
		h.python = p
		log.Printf("[signal] + python  %s  (browsers: %d)", p.id, len(h.browsers))
		for _, b := range h.browsers {
			b.sendMsg(SignalMsg{Type: "peer_ready", Role: "python"})
		}
	} else {
		h.browsers[p.id] = p
		log.Printf("[signal] + browser %s  (total: %d)", p.id, len(h.browsers))
		if h.python != nil {
			p.sendMsg(SignalMsg{Type: "peer_ready", Role: "python"})
			h.python.sendMsg(SignalMsg{Type: "peer_ready", Role: "browser", FromPeer: p.id})
		}
	}
}

func (h *Hub) remove(p *Peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.role == "python" {
		if h.python != nil && h.python.id == p.id {
			h.python = nil
		}
		log.Printf("[signal] - python  %s", p.id)
		for _, b := range h.browsers {
			b.sendMsg(SignalMsg{Type: "peer_disconnected", Role: "python"})
		}
	} else {
		delete(h.browsers, p.id)
		log.Printf("[signal] - browser %s  (remaining: %d)", p.id, len(h.browsers))
		if h.python != nil {
			h.python.sendMsg(SignalMsg{Type: "peer_disconnected", Role: "browser", FromPeer: p.id})
		}
	}
}

func (h *Hub) dispatch(src *Peer, msg SignalMsg) {
	h.mu.RLock()
	py := h.python
	h.mu.RUnlock()
	switch msg.Type {
	case "offer":
		if py == nil {
			log.Printf("[signal] offer from %s — no Python connected", src.id)
			return
		}
		msg.FromPeer = src.id
		py.sendMsg(msg)
		log.Printf("[signal] offer %s → python", src.id)
	case "answer":
		h.mu.RLock()
		browser := h.browsers[msg.ToPeer]
		h.mu.RUnlock()
		if browser == nil {
			log.Printf("[signal] answer — browser %q not found", msg.ToPeer)
			return
		}
		targetID := msg.ToPeer
		msg.ToPeer = ""
		browser.sendMsg(msg)
		log.Printf("[signal] answer python → %s", targetID)
	case "ice_candidate":
		if src.role == "browser" {
			if py == nil {
				return
			}
			msg.FromPeer = src.id
			py.sendMsg(msg)
		} else {
			h.mu.RLock()
			browser := h.browsers[msg.ToPeer]
			h.mu.RUnlock()
			if browser == nil {
				return
			}
			msg.ToPeer = ""
			browser.sendMsg(msg)
		}
	default:
		log.Printf("[signal] unknown type %q from %s", msg.Type, src.id)
	}
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

func handleSignal(w http.ResponseWriter, r *http.Request) {
	role := r.URL.Query().Get("role")
	if role != "python" {
		role = "browser"
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[signal] upgrade error: %v", err)
		return
	}
	peer := &Peer{
		id:   newPeerID(role),
		role: role,
		conn: conn,
		send: make(chan []byte, 64),
		hub:  hub,
	}
	hub.add(peer)
	defer func() {
		hub.remove(peer)
		conn.Close()
	}()
	peer.sendMsg(SignalMsg{Type: "welcome", PeerID: peer.id, Role: role})
	go peer.writeLoop()
	peer.readLoop()
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	hub.mu.RLock()
	pythonOK := hub.python != nil
	browsers := len(hub.browsers)
	hub.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "ok",
		"time_ms":          time.Now().UnixMilli(),
		"python_connected": pythonOK,
		"browser_count":    browsers,
	})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"type":             "webrtc",
		"mode":             "webrtc",
		"python_connected": hub.python != nil,
		"browser_count":    len(hub.browsers),
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ─── Main ────────────────────────────────────────────────────────────────────

func main() {
	fPort := flag.String("port", envOr("PORT", "8443"), "HTTPS/WSS listen port (env: PORT)")
	fHTTPPort := flag.String("http-port", envOr("HTTP_PORT", "8080"), "HTTP→HTTPS redirect port (TLS only)")
	fCert := flag.String("tls-cert", envOr("TLS_CERT", ""), "TLS certificate PEM (env: TLS_CERT)")
	fKey := flag.String("tls-key", envOr("TLS_KEY", ""), "TLS private key PEM (env: TLS_KEY)")
	fWebRoot := flag.String("web-root", "../web-client_webrtc", "Directory to serve as the web root")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/signal", handleSignal)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/status", handleStatus)
	mux.Handle("/", http.FileServer(http.Dir(*fWebRoot)))
	handler := corsMiddleware(mux)

	secure := *fCert != "" && *fKey != ""
	ws := "WS "
	scheme := "http"
	if secure {
		ws = "WSS"
		scheme = "https"
	}

	fmt.Println()
	fmt.Printf("  Transport : WEBRTC (signaling-only)%s\n", tlsBanner(secure))
	fmt.Printf("  %-9s : %s://localhost:%s\n", schemeLabel(secure), scheme, *fPort)
	if secure {
		fmt.Printf("  Cert      : %s\n", *fCert)
		fmt.Printf("  Key       : %s\n", *fKey)
	}
	fmt.Printf("  Web root  : %s\n", *fWebRoot)
	fmt.Println()
	fmt.Printf("  %s  /ws/signal?role=python   Python peer (WebRTC signaling)\n", ws)
	fmt.Printf("  %s  /ws/signal?role=browser  Browser peer (WebRTC signaling)\n", ws)
	fmt.Println("  GET  /health                  Health check")
	fmt.Println("  GET  /status                  Status JSON")
	fmt.Println()
	if !secure {
		fmt.Println("  Tip: add --tls-cert and --tls-key to enable HTTPS/WSS")
		fmt.Println()
	}

	if secure {
		go startHTTPRedirect(*fHTTPPort, *fPort)
		log.Fatal(http.ListenAndServeTLS(":"+*fPort, *fCert, *fKey, handler))
	} else {
		log.Fatal(http.ListenAndServe(":"+*fPort, handler))
	}
}

func startHTTPRedirect(httpPort, httpsPort string) {
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		target := "https://" + host
		if httpsPort != "443" {
			target += ":" + httpsPort
		}
		target += r.URL.RequestURI()
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	})
	fmt.Printf("  HTTP redirect  :%s → HTTPS :%s\n\n", httpPort, httpsPort)
	if err := http.ListenAndServe(":"+httpPort, redirect); err != nil {
		log.Printf("HTTP redirect listener error: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func tlsBanner(secure bool) string {
	if secure {
		return "   (TLS: HTTPS / WSS)"
	}
	return "   (no TLS — development only)"
}

func schemeLabel(secure bool) string {
	if secure {
		return "HTTPS"
	}
	return "HTTP"
}
