package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v3"
)

func fixture(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s, err := newServer(t.TempDir(), "test-admin-secret", mediaAPI(webrtc.SettingEngine{}))
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(s.handler())
	t.Cleanup(func() {
		s.mu.Lock()
		for _, p := range s.peers {
			p.conn.Close()
		}
		s.mu.Unlock()
		httpServer.Close()
		s.db.Close()
	})
	return s, httpServer
}
func apiCall(t *testing.T, base, method, path, token string, body interface{}, status int) json.RawMessage {
	t.Helper()
	data, _ := json.Marshal(body)
	request, _ := http.NewRequest(method, base+path, bytes.NewReader(data))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	result, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		t.Fatalf("%s %s: got %d want %d: %s", method, path, response.StatusCode, status, result)
	}
	return result
}
func sessionToken(t *testing.T, base, name string, admin bool) (string, string) {
	secret := ""
	if admin {
		secret = "test-admin-secret"
	}
	raw := apiCall(t, base, "POST", "/api/v1/sessions", "", map[string]string{"name": name, "hostSecret": secret}, 201)
	var out struct {
		Token         string
		ParticipantID string
	}
	json.Unmarshal(raw, &out)
	return out.Token, out.ParticipantID
}
func createRoom(t *testing.T, base, token, password string, capacity int) Room {
	raw := apiCall(t, base, "POST", "/api/v1/rooms", token, map[string]interface{}{"title": "Test room", "password": password, "capacity": capacity}, 201)
	var room Room
	json.Unmarshal(raw, &room)
	return room
}
func wsClient(t *testing.T, base, token string) *websocket.Conn {
	t.Helper()
	header := http.Header{"Authorization": []string{"Bearer " + token}}
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(base, "http")+"/ws/v1", header)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	return ws
}
func sendRequest(t *testing.T, ws *websocket.Conn, event, room string, payload interface{}) string {
	t.Helper()
	id := randomID()
	if err := ws.WriteJSON(map[string]interface{}{"v": 1, "event": event, "roomId": room, "requestId": id, "payload": payload}); err != nil {
		t.Fatal(err)
	}
	return id
}

type reply struct {
	Event     string          `json:"event"`
	RequestID string          `json:"requestId"`
	Error     string          `json:"error"`
	Payload   json.RawMessage `json:"payload"`
}

func readUntil(t *testing.T, ws *websocket.Conn, match func(reply) bool) reply {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	for {
		var message reply
		if err := ws.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if match(message) {
			return message
		}
	}
}
func call(t *testing.T, ws *websocket.Conn, event, room string, payload interface{}, wantError string) json.RawMessage {
	t.Helper()
	id := sendRequest(t, ws, event, room, payload)
	response := readUntil(t, ws, func(m reply) bool { return m.RequestID == id })
	if response.Error != wantError {
		t.Fatalf("%s: got error %q want %q", event, response.Error, wantError)
	}
	return response.Payload
}
func join(t *testing.T, ws *websocket.Conn, room, password string) {
	call(t, ws, "room.join", room, map[string]string{"password": password}, "")
}

func TestAuthenticationAndInputValidation(t *testing.T) {
	_, httpServer := fixture(t)
	base := httpServer.URL
	apiCall(t, base, "GET", "/api/v1/rooms", "", nil, 401)
	apiCall(t, base, "POST", "/api/v1/sessions", "", map[string]string{"name": "", "hostSecret": ""}, 400)
	apiCall(t, base, "POST", "/api/v1/sessions", "", map[string]string{"name": "attacker", "hostSecret": "wrong"}, 401)
	guest, _ := sessionToken(t, base, "Guest", false)
	apiCall(t, base, "POST", "/api/v1/rooms", guest, map[string]interface{}{"title": "Room", "capacity": 25}, 403)
	admin, _ := sessionToken(t, base, "Host", true)
	apiCall(t, base, "POST", "/api/v1/rooms", admin, map[string]interface{}{"title": "Room", "capacity": 101}, 400)
	room := createRoom(t, base, admin, "private", 2)
	if !room.Protected {
		t.Fatal("password protection not advertised")
	}
	raw := apiCall(t, base, "GET", "/api/v1/rooms", guest, nil, 200)
	if bytes.Contains(raw, []byte("private")) {
		t.Fatal("password leaked")
	}
}
func TestRoomPasswordCapacityAndCrossRoomIsolation(t *testing.T) {
	_, httpServer := fixture(t)
	base := httpServer.URL
	admin, _ := sessionToken(t, base, "Host", true)
	room := createRoom(t, base, admin, "secret", 2)
	other := createRoom(t, base, admin, "", 2)
	host := wsClient(t, base, admin)
	join(t, host, room.ID, "")
	token, _ := sessionToken(t, base, "Guest", false)
	guest := wsClient(t, base, token)
	call(t, guest, "room.join", room.ID, map[string]string{"password": "bad"}, "incorrect_password")
	join(t, guest, room.ID, "secret")
	call(t, guest, "room.lock", other.ID, true, "room_scope_denied")
	call(t, guest, "room.lock", room.ID, true, "host_required")
	third, _ := sessionToken(t, base, "Third", false)
	thirdWS := wsClient(t, base, third)
	call(t, thirdWS, "room.join", room.ID, map[string]string{"password": "secret"}, "room_full")
	join(t, thirdWS, other.ID, "")
	call(t, host, "room.lock", room.ID, true, "")
}
func TestRecordingPermissionRevokeAndKick(t *testing.T) {
	s, httpServer := fixture(t)
	base := httpServer.URL
	admin, _ := sessionToken(t, base, "Host", true)
	room := createRoom(t, base, admin, "", 3)
	host := wsClient(t, base, admin)
	join(t, host, room.ID, "")
	token, id := sessionToken(t, base, "Guest", false)
	guest := wsClient(t, base, token)
	join(t, guest, room.ID, "")
	call(t, guest, "recording.start", room.ID, struct{}{}, "record_denied")
	call(t, host, "participant.update", room.ID, map[string]interface{}{"id": id, "canRecord": true}, "")
	call(t, guest, "recording.start", room.ID, struct{}{}, "")
	s.mu.Lock()
	started := s.peers[id].Recording
	s.mu.Unlock()
	if !started {
		t.Fatal("recording state missing")
	}
	call(t, host, "participant.update", room.ID, map[string]interface{}{"id": id, "canRecord": false}, "")
	s.mu.Lock()
	stopped := !s.peers[id].Recording
	s.mu.Unlock()
	if !stopped {
		t.Fatal("revocation did not stop recording state")
	}
	call(t, guest, "recording.start", room.ID, struct{}{}, "record_denied")
	call(t, host, "participant.update", room.ID, map[string]interface{}{"id": id, "kick": true}, "")
	apiCall(t, base, "GET", "/api/v1/rooms", token, nil, 401)
}
func TestRoomPersistence(t *testing.T) {
	dir := t.TempDir()
	s, err := newServer(dir, "secret", mediaAPI(webrtc.SettingEngine{}))
	if err != nil {
		t.Fatal(err)
	}
	room := &Room{ID: randomID(), Title: "Persisted", Capacity: 25, Password: passwordHash("password"), Locked: true}
	if err = s.saveRoom(room); err != nil {
		t.Fatal(err)
	}
	s.db.Close()
	s, err = newServer(dir, "secret", mediaAPI(webrtc.SettingEngine{}))
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	loaded := s.rooms[room.ID]
	if loaded == nil || !loaded.Locked || !loaded.Protected || !passwordMatches(loaded.Password, "password") || passwordMatches(loaded.Password, "wrong") {
		t.Fatal("room/password persistence failed")
	}
}
func TestCertificateIdentityPersists(t *testing.T) {
	dir := t.TempDir()
	_, first, err := certificate(dir, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	_, second, err := certificate(dir, "192.168.1.2")
	if err != nil || first != second || len(first) != 64 {
		t.Fatalf("identity changed: %v", err)
	}
}
func TestEncryptedMediaForwardingAndSubscriptionIsolation(t *testing.T) {
	s, httpServer := fixture(t)
	base := httpServer.URL
	admin, _ := sessionToken(t, base, "Host", true)
	room := createRoom(t, base, admin, "", 4)
	other := createRoom(t, base, admin, "", 4)
	publisherWS := wsClient(t, base, admin)
	join(t, publisherWS, room.ID, "")
	receiverToken, _ := sessionToken(t, base, "Receiver", false)
	receiverWS := wsClient(t, base, receiverToken)
	join(t, receiverWS, room.ID, "")
	outsiderToken, _ := sessionToken(t, base, "Other room", false)
	outsider := wsClient(t, base, outsiderToken)
	join(t, outsider, other.ID, "")
	publisher, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Close()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "camera-test", "camera-stream")
	if err != nil {
		t.Fatal(err)
	}
	sender, err := publisher.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buffer := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buffer); err != nil {
				return
			}
		}
	}()
	offer, err := publisher.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := webrtc.GatheringCompletePromise(publisher)
	publisher.SetLocalDescription(offer)
	<-gather
	raw := call(t, publisherWS, "publish.offer", room.ID, map[string]interface{}{"sdp": publisher.LocalDescription().SDP, "tracks": map[string]string{"camera-test": "camera"}}, "")
	var answer webrtc.SessionDescription
	json.Unmarshal(raw, &answer)
	if err = publisher.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-ticker.C:
				sequence++
				track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(sequence) * 1800, SSRC: 12345}, Payload: []byte{0x10, 0x00, 0x01, 0x02}})
			case <-stop:
				return
			}
		}
	}()
	var pubID string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		for id := range s.pubs {
			pubID = id
		}
		s.mu.Unlock()
		if pubID != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pubID == "" {
		t.Fatal("publisher media never arrived")
	}
	call(t, outsider, "subscriptions.set", other.ID, []string{pubID}, "subscription_denied")
	receiver, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	received := make(chan []byte, 1)
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		packet, _, err := track.ReadRTP()
		if err == nil {
			received <- packet.Payload
		}
	})
	sendRequest(t, receiverWS, "subscriptions.set", room.ID, []string{pubID})
	negotiation := readUntil(t, receiverWS, func(m reply) bool { return m.Event == "subscribe.offer" })
	var serverOffer webrtc.SessionDescription
	json.Unmarshal(negotiation.Payload, &serverOffer)
	if err = receiver.SetRemoteDescription(serverOffer); err != nil {
		t.Fatal(err)
	}
	receiverAnswer, err := receiver.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather = webrtc.GatheringCompletePromise(receiver)
	receiver.SetLocalDescription(receiverAnswer)
	<-gather
	call(t, receiverWS, "subscribe.answer", room.ID, receiver.LocalDescription(), "")
	select {
	case payload := <-received:
		if !bytes.Equal(payload, []byte{0x10, 0x00, 0x01, 0x02}) {
			t.Fatal("forwarded packet changed")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no encrypted media reached subscriber")
	}
	if receiver.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatal("receiver not connected")
	}
}
