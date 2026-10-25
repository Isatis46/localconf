package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/mattn/go-sqlite3"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v3"
	"golang.org/x/crypto/argon2"
)

const version = "0.1.0"

type Room struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Capacity  int    `json:"capacity"`
	Locked    bool   `json:"locked"`
	Protected bool   `json:"protected"`
	Password  string `json:"-"`
}
type Participant struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role"`
	Muted     bool   `json:"muted"`
	CanShare  bool   `json:"canShare"`
	CanRecord bool   `json:"canRecord"`
	Recording bool   `json:"recording"`
}
type Publication struct {
	ID        string `json:"id"`
	Owner     string `json:"owner"`
	Kind      string `json:"kind"`
	TrackID   string `json:"trackId"`
	local     *webrtc.TrackLocalStaticRTP
	remote    *webrtc.TrackRemote
	publisher *webrtc.PeerConnection
}
type Session struct {
	ID, Name string
	Admin    bool
	Expires  time.Time
}
type Peer struct {
	Participant
	room     string
	session  *Session
	conn     *websocket.Conn
	out      chan interface{}
	done     chan struct{}
	pub, sub *webrtc.PeerConnection
	kinds    map[string]string
	updates  chan []string
	answers  chan webrtc.SessionDescription
}
type Message struct {
	V         int             `json:"v"`
	Event     string          `json:"event"`
	RequestID string          `json:"requestId"`
	RoomID    string          `json:"roomId"`
	Payload   json.RawMessage `json:"payload"`
}
type Server struct {
	mu              sync.Mutex
	db              *sql.DB
	api             *webrtc.API
	rooms           map[string]*Room
	sessions        map[string]*Session
	peers           map[string]*Peer
	pubs            map[string]*Publication
	adminSecret     string
	id, fingerprint string
	rates           map[string][]time.Time
}

func randomID() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func passwordHash(password string) string {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		panic(err)
	}
	hash := argon2.IDKey([]byte(password), salt, 2, 32*1024, 2, 32)
	return base64.RawStdEncoding.EncodeToString(salt) + ":" + base64.RawStdEncoding.EncodeToString(hash)
}
func passwordMatches(encoded, password string) bool {
	parts := strings.Split(encoded, ":")
	if len(parts) != 2 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[0])
	if e != nil {
		return false
	}
	expected, e := base64.RawStdEncoding.DecodeString(parts[1])
	if e != nil {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, 2, 32*1024, 2, 32)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}
func mediaAPI(settings webrtc.SettingEngine) *webrtc.API {
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		panic(err)
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		panic(err)
	}
	return webrtc.NewAPI(webrtc.WithSettingEngine(settings), webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry))
}
func newServer(dir, secret string, api *webrtc.API) (*Server, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3", filepath.Join(dir, "server.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,title TEXT NOT NULL,capacity INTEGER NOT NULL,locked INTEGER NOT NULL,password TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY, action TEXT, room_id TEXT, participant_id TEXT, timestamp INTEGER);
 PRAGMA user_version=1;`)
	if err != nil {
		db.Close()
		return nil, err
	}
	s := &Server{db: db, api: api, adminSecret: secret, id: randomID(), rooms: map[string]*Room{}, sessions: map[string]*Session{}, peers: map[string]*Peer{}, pubs: map[string]*Publication{}, rates: map[string][]time.Time{}}
	rows, err := db.Query("SELECT id,title,capacity,locked,password FROM rooms")
	if err != nil {
		db.Close()
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		r := &Room{}
		if err := rows.Scan(&r.ID, &r.Title, &r.Capacity, &r.Locked, &r.Password); err != nil {
			return nil, err
		}
		r.Protected = r.Password != ""
		s.rooms[r.ID] = r
	}
	return s, rows.Err()
}
func (s *Server) audit(action, room, actor string) {
	_, err := s.db.Exec("INSERT INTO audit_events VALUES(?,?,?,?,?)", randomID(), action, room, actor, time.Now().Unix())
	if err != nil {
		log.Print("audit write failed")
	}
}
func (s *Server) saveRoom(r *Room) error {
	_, err := s.db.Exec("INSERT OR REPLACE INTO rooms VALUES(?,?,?,?,?)", r.ID, r.Title, r.Capacity, r.Locked, r.Password)
	return err
}
func jsonOut(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func apiError(w http.ResponseWriter, status int, code string) {
	jsonOut(w, status, map[string]string{"error": code})
}
func decode(w http.ResponseWriter, r *http.Request, value interface{}) error {
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return errors.New("trailing data")
	}
	return nil
}
func (s *Server) auth(r *http.Request) *Session {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	session := s.sessions[token]
	if session == nil || time.Now().After(session.Expires) {
		return nil
	}
	return session
}
func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/server/info", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 200, map[string]interface{}{"version": version, "protocol": 1, "serverId": s.id, "fingerprint": s.fingerprint})
	})
	mux.HandleFunc("/api/v1/sessions", s.createSession)
	mux.HandleFunc("/api/v1/rooms", s.roomAPI)
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.auth(r) == nil {
			apiError(w, 401, "unauthorized")
			return
		}
		jsonOut(w, 200, map[string]interface{}{"ready": true, "peers": len(s.peers), "rooms": len(s.rooms), "publications": len(s.pubs)})
	})
	mux.HandleFunc("/ws/v1", s.websocket)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Header.Get("Origin") != "" {
			apiError(w, 403, "browser_origin_denied")
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		apiError(w, 405, "method_not_allowed")
		return
	}
	var in struct {
		Name       string `json:"name"`
		HostSecret string `json:"hostSecret"`
	}
	if decode(w, r, &in) != nil || len(strings.TrimSpace(in.Name)) == 0 || len(in.Name) > 80 {
		apiError(w, 400, "invalid_name")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	now := time.Now()
	var recent []time.Time
	for _, t := range s.rates[ip] {
		if now.Sub(t) < time.Minute {
			recent = append(recent, t)
		}
	}
	if len(recent) >= 20 {
		apiError(w, 429, "rate_limited")
		return
	}
	s.rates[ip] = append(recent, now)
	for token, session := range s.sessions {
		if now.After(session.Expires) {
			delete(s.sessions, token)
		}
	}
	if len(s.sessions) >= 300 {
		apiError(w, 503, "session_limit")
		return
	}
	admin := in.HostSecret != "" && subtle.ConstantTimeCompare([]byte(in.HostSecret), []byte(s.adminSecret)) == 1
	if in.HostSecret != "" && !admin {
		apiError(w, 401, "invalid_host_credentials")
		return
	}
	session := &Session{ID: randomID(), Name: strings.TrimSpace(in.Name), Admin: admin, Expires: now.Add(8 * time.Hour)}
	token := randomID()
	s.sessions[token] = session
	jsonOut(w, 201, map[string]interface{}{"token": token, "participantId": session.ID, "admin": admin, "expiresAt": session.Expires})
}
func (s *Server) roomAPI(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.auth(r)
	if session == nil {
		apiError(w, 401, "unauthorized")
		return
	}
	if r.Method == "GET" {
		rooms := []*Room{}
		for _, room := range s.rooms {
			rooms = append(rooms, room)
		}
		jsonOut(w, 200, rooms)
		return
	}
	if r.Method != "POST" {
		apiError(w, 405, "method_not_allowed")
		return
	}
	if !session.Admin {
		apiError(w, 403, "host_required")
		return
	}
	var in struct {
		Title    string `json:"title"`
		Capacity int    `json:"capacity"`
		Password string `json:"password"`
	}
	if decode(w, r, &in) != nil || len(strings.TrimSpace(in.Title)) == 0 || len(in.Title) > 100 || in.Capacity < 2 || in.Capacity > 50 || len(in.Password) > 128 {
		apiError(w, 400, "invalid_room")
		return
	}
	if len(s.rooms) >= 10 {
		apiError(w, 409, "room_limit")
		return
	}
	room := &Room{ID: randomID(), Title: strings.TrimSpace(in.Title), Capacity: in.Capacity, Protected: in.Password != ""}
	if room.Protected {
		room.Password = passwordHash(in.Password)
	}
	if s.saveRoom(room) != nil {
		apiError(w, 500, "storage_error")
		return
	}
	s.rooms[room.ID] = room
	s.audit("room.created", room.ID, session.ID)
	jsonOut(w, 201, room)
}
func (p *Peer) send(event string, payload interface{}) {
	select {
	case p.out <- map[string]interface{}{"v": 1, "event": event, "roomId": p.room, "payload": payload}:
	default:
		p.conn.Close()
	}
}
func (p *Peer) reply(request string, payload interface{}, err error) {
	out := map[string]interface{}{"v": 1, "event": "response", "requestId": request, "payload": payload}
	if err != nil {
		out["error"] = err.Error()
	}
	select {
	case p.out <- out:
	default:
		p.conn.Close()
	}
}
func (s *Server) snapshot(room string) {
	participants := []Participant{}
	publications := []*Publication{}
	for _, p := range s.peers {
		if p.room == room {
			participants = append(participants, p.Participant)
		}
	}
	for _, pub := range s.pubs {
		if owner := s.peers[pub.Owner]; owner != nil && owner.room == room {
			publications = append(publications, pub)
		}
	}
	for _, p := range s.peers {
		if p.room == room {
			p.send("room.snapshot", map[string]interface{}{"room": s.rooms[room], "participants": participants, "publications": publications})
		}
	}
}
func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	session := s.auth(r)
	if session == nil {
		s.mu.Unlock()
		apiError(w, 401, "unauthorized")
		return
	}
	if len(s.peers) >= 100 || s.peers[session.ID] != nil {
		s.mu.Unlock()
		apiError(w, 409, "peer_limit_or_duplicate")
		return
	}
	up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }, HandshakeTimeout: 10 * time.Second}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		s.mu.Unlock()
		return
	}
	role := "participant"
	if session.Admin {
		role = "owner"
	}
	p := &Peer{Participant: Participant{ID: session.ID, Name: session.Name, Role: role, CanShare: true, CanRecord: session.Admin}, session: session, conn: conn, out: make(chan interface{}, 128), done: make(chan struct{}), kinds: map[string]string{}, updates: make(chan []string, 1), answers: make(chan webrtc.SessionDescription, 1)}
	s.peers[p.ID] = p
	s.mu.Unlock()
	defer s.removePeer(p)
	conn.SetReadLimit(256 * 1024)
	conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case value := <-p.out:
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if conn.WriteJSON(value) != nil {
					conn.Close()
					return
				}
			case <-ticker.C:
				if time.Now().After(session.Expires) {
					conn.Close()
					return
				}
				if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
					conn.Close()
					return
				}
			case <-p.done:
				return
			}
		}
	}()
	go s.subscriptions(p)
	for {
		var msg Message
		if conn.ReadJSON(&msg) != nil {
			return
		}
		if msg.V != 1 || msg.RequestID == "" || len(msg.RequestID) > 100 {
			p.reply(msg.RequestID, nil, errors.New("invalid_envelope"))
			continue
		}
		payload, err := s.message(p, msg)
		p.reply(msg.RequestID, payload, err)
	}
}
func (s *Server) removePeer(p *Peer) {
	s.mu.Lock()
	if s.peers[p.ID] != p {
		s.mu.Unlock()
		return
	}
	room := p.room
	delete(s.peers, p.ID)
	close(p.done)
	for id, pub := range s.pubs {
		if pub.Owner == p.ID {
			delete(s.pubs, id)
		}
	}
	if p.Recording {
		s.audit("recording.stopped", room, p.ID)
	}
	s.snapshot(room)
	pub, sub := p.pub, p.sub
	s.mu.Unlock()
	p.conn.Close()
	if pub != nil {
		pub.Close()
	}
	if sub != nil {
		sub.Close()
	}
}
func (s *Server) message(p *Peer, msg Message) (interface{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.peers[p.ID] != p {
		return nil, errors.New("disconnected")
	}
	if msg.Event == "room.join" {
		if p.room != "" {
			return nil, errors.New("already_joined")
		}
		var in struct {
			Password string `json:"password"`
		}
		if json.Unmarshal(msg.Payload, &in) != nil || len(in.Password) > 128 {
			return nil, errors.New("invalid_password")
		}
		room := s.rooms[msg.RoomID]
		if room == nil {
			return nil, errors.New("room_not_found")
		}
		if room.Locked && !p.session.Admin {
			return nil, errors.New("room_locked")
		}
		count := 0
		for _, peer := range s.peers {
			if peer.room == room.ID {
				count++
			}
		}
		if count >= room.Capacity {
			return nil, errors.New("room_full")
		}
		if room.Protected && !p.session.Admin && !passwordMatches(room.Password, in.Password) {
			return nil, errors.New("incorrect_password")
		}
		p.room = room.ID
		s.snapshot(room.ID)
		s.audit("participant.joined", p.room, p.ID)
		return p.Participant, nil
	}
	if p.room == "" || msg.RoomID != p.room {
		return nil, errors.New("room_scope_denied")
	}
	switch msg.Event {
	case "room.leave":
		go p.conn.Close()
		return true, nil
	case "publish.offer":
		var in struct {
			SDP    string            `json:"sdp"`
			Tracks map[string]string `json:"tracks"`
		}
		if json.Unmarshal(msg.Payload, &in) != nil || len(in.Tracks) > 3 || p.pub != nil {
			return nil, errors.New("invalid_offer")
		}
		counts := map[string]int{}
		for _, kind := range in.Tracks {
			counts[kind]++
			if (kind != "audio" && kind != "camera" && kind != "screen") || counts[kind] > 1 {
				return nil, errors.New("invalid_tracks")
			}
			if kind == "screen" && !p.CanShare {
				return nil, errors.New("share_denied")
			}
		}
		pc, err := s.api.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			return nil, err
		}
		p.pub = pc
		p.kinds = in.Tracks
		pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) { s.forward(p, pc, track) })
		pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
			if state == webrtc.PeerConnectionStateFailed {
				p.conn.Close()
			}
		})
		if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: in.SDP}); err != nil {
			pc.Close()
			p.pub = nil
			return nil, errors.New("invalid_sdp")
		}
		answer, err := pc.CreateAnswer(nil)
		if err != nil {
			return nil, err
		}
		gather := webrtc.GatheringCompletePromise(pc)
		if err = pc.SetLocalDescription(answer); err != nil {
			return nil, err
		}
		select {
		case <-gather:
		case <-time.After(10 * time.Second):
			return nil, errors.New("ice_timeout")
		}
		return pc.LocalDescription(), nil
	case "publish.reset":
		pc := p.pub
		p.pub = nil
		for id, pub := range s.pubs {
			if pub.Owner == p.ID {
				delete(s.pubs, id)
			}
		}
		s.snapshot(p.room)
		if pc != nil {
			go pc.Close()
		}
		return true, nil
	case "subscriptions.set":
		var ids []string
		if json.Unmarshal(msg.Payload, &ids) != nil || len(ids) > 55 {
			return nil, errors.New("invalid_subscriptions")
		}
		camera, screen := 0, 0
		seen := map[string]bool{}
		for _, id := range ids {
			pub := s.pubs[id]
			if pub == nil || seen[id] {
				return nil, errors.New("unknown_publication")
			}
			seen[id] = true
			owner := s.peers[pub.Owner]
			if owner == nil || owner.room != p.room || owner.ID == p.ID {
				return nil, errors.New("subscription_denied")
			}
			if pub.Kind == "camera" {
				camera++
			}
			if pub.Kind == "screen" {
				screen++
			}
		}
		if camera > 4 || screen > 1 {
			return nil, errors.New("subscription_limit")
		}
		select {
		case <-p.updates:
		default:
		}
		p.updates <- ids
		return true, nil
	case "subscribe.answer":
		var answer webrtc.SessionDescription
		if json.Unmarshal(msg.Payload, &answer) != nil || answer.Type != webrtc.SDPTypeAnswer {
			return nil, errors.New("invalid_answer")
		}
		select {
		case p.answers <- answer:
		default:
			return nil, errors.New("unexpected_answer")
		}
		return true, nil
	case "recording.start":
		if !p.CanRecord {
			return nil, errors.New("record_denied")
		}
		p.Recording = true
		s.audit("recording.started", p.room, p.ID)
		s.snapshot(p.room)
		return true, nil
	case "recording.stop":
		p.Recording = false
		s.audit("recording.stopped", p.room, p.ID)
		s.snapshot(p.room)
		return true, nil
	case "participant.update":
		if !p.session.Admin {
			return nil, errors.New("host_required")
		}
		var in struct {
			ID        string `json:"id"`
			Muted     *bool  `json:"muted"`
			CanRecord *bool  `json:"canRecord"`
			CanShare  *bool  `json:"canShare"`
			Kick      bool   `json:"kick"`
		}
		if json.Unmarshal(msg.Payload, &in) != nil {
			return nil, errors.New("invalid_policy")
		}
		target := s.peers[in.ID]
		if target == nil || target.room != p.room || target.session.Admin {
			return nil, errors.New("invalid_target")
		}
		if in.Muted != nil {
			target.Muted = *in.Muted
		}
		if in.CanRecord != nil {
			target.CanRecord = *in.CanRecord
			if !target.CanRecord && target.Recording {
				target.Recording = false
				s.audit("recording.revoked", p.room, p.ID)
			}
		}
		if in.CanShare != nil {
			target.CanShare = *in.CanShare
			if !target.CanShare {
				for id, publication := range s.pubs {
					if publication.Owner == target.ID && publication.Kind == "screen" {
						delete(s.pubs, id)
					}
				}
			}
		}
		if in.Kick {
			for token, session := range s.sessions {
				if session.ID == target.ID {
					delete(s.sessions, token)
				}
			}
			go target.conn.Close()
		}
		s.audit("participant.policy", p.room, p.ID)
		s.snapshot(p.room)
		return true, nil
	case "room.lock":
		if !p.session.Admin {
			return nil, errors.New("host_required")
		}
		var locked bool
		if json.Unmarshal(msg.Payload, &locked) != nil {
			return nil, errors.New("invalid_policy")
		}
		room := s.rooms[p.room]
		if room == nil {
			return nil, errors.New("room_closed")
		}
		previous := room.Locked
		room.Locked = locked
		if err := s.saveRoom(room); err != nil {
			room.Locked = previous
			return nil, errors.New("storage_error")
		}
		s.snapshot(p.room)
		return true, nil
	case "room.close":
		if !p.session.Admin {
			return nil, errors.New("host_required")
		}
		if _, err := s.db.Exec("DELETE FROM rooms WHERE id=?", p.room); err != nil {
			return nil, errors.New("storage_error")
		}
		delete(s.rooms, p.room)
		for _, peer := range s.peers {
			if peer.room == p.room {
				go peer.conn.Close()
			}
		}
		return true, nil
	}
	return nil, errors.New("unknown_event")
}
func (s *Server) forward(p *Peer, pc *webrtc.PeerConnection, track *webrtc.TrackRemote) {
	s.mu.Lock()
	kind := p.kinds[track.ID()]
	if s.peers[p.ID] != p || p.pub != pc || p.room == "" || kind == "" {
		s.mu.Unlock()
		return
	}
	if (kind == "audio") != (track.Kind() == webrtc.RTPCodecTypeAudio) {
		s.mu.Unlock()
		return
	}
	for _, pub := range s.pubs {
		if pub.Owner == p.ID && pub.Kind == kind {
			s.mu.Unlock()
			return
		}
		owner := s.peers[pub.Owner]
		if owner != nil && owner.room == p.room && pub.Kind == "screen" && kind == "screen" {
			p.send("error", map[string]string{"message": "Another participant is already sharing."})
			s.mu.Unlock()
			return
		}
	}
	id := randomID()
	local, err := webrtc.NewTrackLocalStaticRTP(track.Codec().RTPCodecCapability, id, id)
	if err != nil {
		s.mu.Unlock()
		return
	}
	s.pubs[id] = &Publication{ID: id, Owner: p.ID, Kind: kind, TrackID: id, local: local, remote: track, publisher: pc}
	s.snapshot(p.room)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.pubs, id); s.snapshot(p.room); s.mu.Unlock() }()
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		s.mu.Lock()
		allowed := s.peers[p.ID] == p && p.pub == pc && s.pubs[id] != nil && (kind != "audio" || !p.Muted) && (kind != "screen" || p.CanShare)
		s.mu.Unlock()
		if allowed {
			_ = local.WriteRTP(packet)
		}
	}
}
func (s *Server) subscriptions(p *Peer) {
	senders := map[string]*webrtc.RTPSender{}
	for {
		select {
		case ids := <-p.updates:
			s.mu.Lock()
			if s.peers[p.ID] != p {
				s.mu.Unlock()
				return
			}
			if p.sub == nil {
				pc, err := s.api.NewPeerConnection(webrtc.Configuration{})
				if err != nil {
					s.mu.Unlock()
					p.conn.Close()
					return
				}
				p.sub = pc
			}
			pc := p.sub
			desired := map[string]bool{}
			changed := false
			for _, id := range ids {
				pub := s.pubs[id]
				if pub == nil {
					continue
				}
				owner := s.peers[pub.Owner]
				if owner == nil || owner.room != p.room || owner.ID == p.ID {
					continue
				}
				desired[id] = true
				if senders[id] != nil {
					continue
				}
				sender, err := pc.AddTrack(pub.local)
				if err != nil {
					continue
				}
				senders[id] = sender
				changed = true
				go func(sender *webrtc.RTPSender, pub *Publication) {
					buf := make([]byte, 1500)
					for {
						n, _, err := sender.Read(buf)
						if err != nil {
							return
						}
						packets, err := rtcp.Unmarshal(buf[:n])
						if err != nil {
							continue
						}
						for _, packet := range packets {
							switch packet.(type) {
							case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
								_ = pub.publisher.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(pub.remote.SSRC())}})
							}
						}
					}
				}(sender, pub)
			}
			for id, sender := range senders {
				if !desired[id] {
					_ = pc.RemoveTrack(sender)
					delete(senders, id)
					changed = true
				}
			}
			s.mu.Unlock()
			if !changed {
				continue
			}
			offer, err := pc.CreateOffer(nil)
			if err != nil {
				p.conn.Close()
				return
			}
			gather := webrtc.GatheringCompletePromise(pc)
			if pc.SetLocalDescription(offer) != nil {
				p.conn.Close()
				return
			}
			select {
			case <-gather:
			case <-p.done:
				return
			case <-time.After(10 * time.Second):
				p.conn.Close()
				return
			}
			p.send("subscribe.offer", pc.LocalDescription())
			select {
			case answer := <-p.answers:
				if pc.SetRemoteDescription(answer) != nil {
					p.conn.Close()
					return
				}
			case <-p.done:
				return
			case <-time.After(20 * time.Second):
				p.conn.Close()
				return
			}
		case <-p.done:
			return
		}
	}
}
func certificate(dir, ip string) (tls.Certificate, string, error) {
	certPath, keyPath := filepath.Join(dir, "host.crt"), filepath.Join(dir, "host.key")
	if _, err := os.Stat(certPath); os.IsNotExist(err) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "LocalConf host"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP(ip)}, BasicConstraintsValid: true}
		der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		keyDER, err := x509.MarshalECPrivateKey(key)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		if err = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
			return tls.Certificate{}, "", err
		}
		if err = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
			return tls.Certificate{}, "", err
		}
	}
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return cert, "", err
	}
	hash := sha256.Sum256(cert.Certificate[0])
	return cert, strings.ToUpper(hex.EncodeToString(hash[:])), nil
}
func main() {
	listen := flag.String("listen", "", "LAN IPv4 interface to bind (required)")
	httpsPort := flag.Int("port", 8443, "HTTPS port")
	mediaPort := flag.Int("media-port", 40000, "UDP port")
	data := flag.String("data", "data/host", "private data directory")
	flag.Parse()
	ip := net.ParseIP(*listen)
	if ip == nil || (!ip.IsPrivate() && !ip.IsLoopback()) {
		log.Fatal("Select a private LAN IPv4 address with --listen")
	}
	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() || len(scanner.Text()) < 32 {
		log.Fatal("bootstrap secret must arrive over parent stdin")
	}
	secret := scanner.Text()
	if err := os.MkdirAll(*data, 0700); err != nil {
		log.Fatal(err)
	}
	cert, fingerprint, err := certificate(*data, *listen)
	if err != nil {
		log.Fatal("TLS identity initialization failed: ", err)
	}
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip, Port: *mediaPort})
	if err != nil {
		log.Fatal(err)
	}
	defer udp.Close()
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIPFilter(func(candidate net.IP) bool { return candidate.Equal(ip) })
	settings.SetIncludeLoopbackCandidate(ip.IsLoopback())
	settings.SetICEUDPMux(webrtc.NewICEUDPMux(nil, udp))
	api := mediaAPI(settings)
	s, err := newServer(*data, secret, api)
	if err != nil {
		log.Fatal(err)
	}
	s.fingerprint = fingerprint
	s.id = fingerprint[:24]
	defer s.db.Close()
	server := &http.Server{Addr: net.JoinHostPort(*listen, fmt.Sprint(*httpsPort)), Handler: s.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384, TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}}
	listener, err := net.Listen("tcp4", server.Addr)
	if err != nil {
		log.Fatal(err)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"ready": true, "fingerprint": fingerprint, "address": server.Addr, "version": version})
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	go func() {
		for scanner.Scan() {
		}
		stop <- os.Interrupt
	}()
	go func() {
		<-stop
		s.mu.Lock()
		for _, peer := range s.peers {
			peer.conn.Close()
		}
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	if err = server.Serve(tls.NewListener(listener, server.TLSConfig)); err != nil && err != http.ErrServerClosed {
		log.Print("server stopped: ", err)
	}
	_, _ = s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
}
