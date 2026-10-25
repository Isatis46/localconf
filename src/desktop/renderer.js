'use strict';
const $ = id => document.getElementById(id);
const invoke = (name, ...args) => window.conference.invoke(name, ...args);
const signal = (event, payload) => invoke('signal', event, payload);
let identity, pairing, room, self, snapshot, pendingJoin;
let publishing, receiving, publishQueue = Promise.resolve(), subscriptionKey = '';
let active = false, recorder, recordingQueue = Promise.resolve(), recordingFailure = false, recordingContext, recordingTimer, recordCanvas;
let local = { audio: null, camera: null, screen: null };
const remoteTracks = new Map();
const tiles = new Map();
const recordingSources = new Map();
function notify(error) { $('notification').textContent = error.message || String(error); $('notification').hidden = false; }
function clearNotice() { $('notification').hidden = true; }
function status(text) { $('footer-status').textContent = text; }
function on(id, event, fn) { $(id).addEventListener(event, async e => { try { clearNotice(); await fn(e); } catch (error) { notify(error); } }); }
function button(text, callback, className) { const el = document.createElement('button'); el.textContent = text; if (className) el.className = className; el.onclick = () => Promise.resolve().then(callback).catch(notify); return el; }
function displayName() { const name = $('display-name').value.trim(); if (!name) throw new Error('Enter your display name first.'); return name; }
function show(section) { for (const name of ['welcome', 'lobby', 'meeting']) $(name).hidden = name !== section; }
async function connected(info) {
  identity = info;
  $('connection').textContent = '● Connected'; $('host-location').textContent = info.address;
  $('host-fingerprint').textContent = info.fingerprint.match(/.{1,4}/g).join(' ');
  $('create-room').hidden = !info.admin; $('stop-host').hidden = !info.hosting;
  show('lobby'); await refreshRooms(); status(info.hosting ? 'Host is running. Keep this app open.' : 'Connected to a verified host.');
}
async function refreshRooms() {
  const rooms = await invoke('rooms.list'); $('room-list').replaceChildren();
  if (!rooms.length) { const p = document.createElement('p'); p.textContent = identity.admin ? 'Create your first room above.' : 'No rooms yet. Ask the host to create one, then refresh.'; $('room-list').append(p); }
  for (const item of rooms) {
    const card = document.createElement('article'); card.className = 'room-card';
    const title = document.createElement('h3'); title.textContent = item.title;
    const description = document.createElement('p'); description.textContent = `Up to ${item.capacity} people · ${item.locked ? 'Locked' : item.protected ? 'Password protected' : 'Open room'}`;
    const join = button('Join room →', async () => { if (item.protected && !identity.admin) { pendingJoin = item; $('join-password').value = ''; $('password-dialog').showModal(); $('join-password').focus(); } else await joinRoom(item, ''); }, 'primary');
    join.disabled = item.locked && !identity.admin; card.append(title, description, join); $('room-list').append(card);
  }
}
async function joinRoom(item, password) {
  room = item; active = true;
  try { self = await invoke('room.join', { id: item.id, password }); } catch (error) { room = null; active = false; throw error; }
  $('meeting-title').textContent = item.title; $('lock-room').hidden = !identity.admin; show('meeting'); updateControls(); status('Connected. Choose what to share.');
}
function updateControls() {
  for (const [kind, id, off, enabled] of [['audio','microphone','Mic off','Mic on'],['camera','camera','Camera off','Camera on'],['screen','screen','Share screen','Stop sharing']]) { $(id).textContent = local[kind] ? enabled : off; $(id).classList.toggle('active', !!local[kind]); }
  $('record').disabled = !self?.canRecord && !recorder;
  $('record').textContent = recorder ? 'Stop recording' : 'Record locally';
  $('screen').disabled = self && !self.canShare;
  $('microphone').disabled = self && self.muted;
}
function stopLocal(kind) { if (local[kind]) for (const track of local[kind].getTracks()) track.stop(); local[kind] = null; removeTile(`local-${kind}`); updateControls(); }
function addTile(id, stream, label, kind, muted) {
  if (tiles.has(id)) return;
  const tile = document.createElement('div'); tile.className = `tile ${kind}`;
  const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = muted; video.srcObject = stream;
  const name = document.createElement('span'); name.textContent = label; tile.append(video, name); $('videos').append(tile); tiles.set(id, { tile, video, label, kind }); video.play().catch(() => {}); $('empty-stage').hidden = true;
}
function removeTile(id) { const entry = tiles.get(id); if (entry) { entry.video.srcObject = null; entry.tile.remove(); tiles.delete(id); } $('empty-stage').hidden = tiles.size > 0; }
function selectedDevice(id) { const value = $(id).value; return value ? { exact: value } : undefined; }
async function toggleDevice(kind) {
  if (local[kind]) stopLocal(kind);
  else {
    if (kind === 'audio') local.audio = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: selectedDevice('audio-input'), echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    else { local.camera = await navigator.mediaDevices.getUserMedia({ video: { deviceId: selectedDevice('video-input'), width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 30 } }, audio: false }); addTile('local-camera', local.camera, 'You · Camera', 'camera', true); }
    for (const track of local[kind].getTracks()) track.onended = () => { stopLocal(kind); queuePublish(); notify(new Error('A media device was disconnected. Choose a device and turn it on again.')); };
  }
  updateControls(); syncRecordingAudio(); await queuePublish();
}
async function gather(pc) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', change); reject(new Error('Local ICE gathering timed out.')); }, 10000);
    function change() { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', change); resolve(); } }
    pc.addEventListener('icegatheringstatechange', change);
  });
}
function queuePublish() {
  publishQueue = publishQueue.catch(() => {}).then(async () => {
    if (!active) return;
    if (publishing) { publishing.close(); publishing = null; await signal('publish.reset', {}); }
    const streams = Object.entries(local).filter(([_kind, stream]) => stream);
    if (!streams.length) return;
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }); publishing = pc;
    const kinds = {};
    for (const [kind, stream] of streams) for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream); kinds[track.id] = kind;
      const parameters = sender.getParameters(); if (!parameters.encodings) parameters.encodings = [{}]; parameters.encodings[0].maxBitrate = kind === 'audio' ? 64000 : kind === 'camera' ? 500000 : 4000000;
      try { await sender.setParameters(parameters); } catch { /* Some legacy drivers do not expose sender parameters before negotiation. */ }
      if (kind === 'screen') track.contentHint = 'detail';
    }
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') notify(new Error('Media connection failed. Check UDP 40000, client isolation, and rejoin the room.')); };
    await pc.setLocalDescription(await pc.createOffer()); await gather(pc);
    const answer = await signal('publish.offer', { sdp: pc.localDescription.sdp, tracks: kinds });
    if (active && publishing === pc) await pc.setRemoteDescription(answer);
    status('Media is being sent over encrypted WebRTC.');
  });
  return publishQueue;
}
async function receiveOffer(offer) {
  if (!active) return;
  if (!receiving) {
    receiving = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    receiving.ontrack = event => {
      const track = event.track; const stream = new MediaStream([track]);
      // The SFU's stream ID is the publication ID. Browsers may retain a receiver
      // track ID when a transceiver is reused after camera stop/start.
      const id = event.streams[0]?.id || track.id;
      remoteTracks.set(id, { track, stream });
      track.onended = () => removeRemote(id);
      renderRemote(); syncRecordingAudio();
    };
  }
  await receiving.setRemoteDescription(offer); await receiving.setLocalDescription(await receiving.createAnswer()); await gather(receiving);
  await signal('subscribe.answer', { type: receiving.localDescription.type, sdp: receiving.localDescription.sdp });
}
function removeRemote(id) {
  const entry = remoteTracks.get(id); if (!entry) return;
  if (entry.audio) { entry.audio.srcObject = null; entry.audio.remove(); }
  removeTile(id); remoteTracks.delete(id); syncRecordingAudio();
}
function renderRemote() {
  if (!snapshot) return;
  for (const [id, entry] of remoteTracks) {
    const pub = snapshot.publications.find(p => p.trackId === id); if (!pub) continue;
    const owner = snapshot.participants.find(p => p.id === pub.owner); const label = `${owner?.name || 'Participant'} · ${pub.kind === 'screen' ? 'Screen' : 'Camera'}`;
    if (pub.kind === 'audio') {
      if (!entry.audio) { const audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = entry.stream; $('audio-streams').append(audio); entry.audio = audio; const sink = $('audio-output').value; if (sink && audio.setSinkId) audio.setSinkId(sink).catch(notify); audio.play().catch(notify); }
    } else addTile(id, entry.stream, label, pub.kind, false);
  }
}
async function applySnapshot(value) {
  if (!active || value.room?.id !== room?.id) return;
  snapshot = value; room = value.room; self = value.participants.find(p => p.id === identity.participantId) || self;
  $('meeting-title').textContent = room.title; $('lock-room').textContent = room.locked ? 'Unlock' : 'Lock';
  $('member-count').textContent = `${value.participants.length} people`;
  const recorders = value.participants.filter(p => p.recording);
  $('recording-indicator').hidden = !recorders.length; $('recording-indicator').textContent = `● Recording: ${recorders.map(p => p.name).join(', ')}`;
  $('participants').replaceChildren();
  for (const person of value.participants) {
    const el = document.createElement('div'); el.className = 'person'; const name = document.createElement('strong'); name.textContent = person.name + (person.id === identity.participantId ? ' (you)' : '');
    const detail = document.createElement('small'); detail.textContent = `${person.role}${person.muted ? ' · Muted by host' : ''}${person.recording ? ' · Recording' : ''}`; el.append(name, detail);
    if (identity.admin && person.id !== identity.participantId) {
      const actions = document.createElement('div'); actions.className = 'person-actions';
      actions.append(button(person.muted ? 'Unmute permission' : 'Mute', () => signal('participant.update', { id: person.id, muted: !person.muted })), button(person.canRecord ? 'Revoke recording' : 'Allow recording', () => signal('participant.update', { id: person.id, canRecord: !person.canRecord })), button(person.canShare ? 'Block sharing' : 'Allow sharing', () => signal('participant.update', { id: person.id, canShare: !person.canShare })), button('Remove', () => signal('participant.update', { id: person.id, kick: true }))); el.append(actions);
    }
    $('participants').append(el);
  }
  if (self?.muted && local.audio) { stopLocal('audio'); queuePublish().catch(notify); }
  if (!self?.canShare && local.screen) { stopLocal('screen'); queuePublish().catch(notify); }
  if (!self?.canRecord && recorder) await stopRecording();
  updateControls();
  let cameras = 0, screens = 0;
  const ids = value.publications.filter(pub => pub.owner !== identity.participantId && (pub.kind === 'audio' || (pub.kind === 'camera' && cameras++ < 4) || (pub.kind === 'screen' && screens++ < 1))).map(p => p.id).sort();
  const key = JSON.stringify(ids);
  for (const id of remoteTracks.keys()) if (!ids.includes(id)) removeRemote(id);
  renderRemote();
  if (key !== subscriptionKey) { subscriptionKey = key; try { await signal('subscriptions.set', ids); } catch (error) { subscriptionKey = ''; if (active) notify(error); } }
}
async function selectScreen() {
  if (local.screen) { stopLocal('screen'); await queuePublish(); return; }
  if (snapshot?.publications.some(p => p.kind === 'screen' && p.owner !== identity.participantId)) throw new Error('Another participant is sharing. Wait until they stop.');
  const sources = await invoke('capture.sources'); $('capture-sources').replaceChildren();
  for (const source of sources) {
    const choice = button('', async () => {
      $('capture-dialog').close();
      local.screen = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } } });
      local.screen.getVideoTracks()[0].onended = () => { stopLocal('screen'); queuePublish().catch(notify); };
      addTile('local-screen', local.screen, `You · ${source.name}`, 'screen', true); updateControls(); await queuePublish();
    }); const image = document.createElement('img'); image.src = source.thumbnail; image.alt = ''; const title = document.createElement('span'); title.textContent = source.name; choice.append(image, title); $('capture-sources').append(choice);
  }
  $('capture-dialog').showModal();
}
function syncRecordingAudio() {
  if (!recordingContext) return;
  const wanted = new Map(); if (local.audio) wanted.set('local', local.audio);
  for (const [id, entry] of remoteTracks) if (entry.track.kind === 'audio') wanted.set(id, entry.stream);
  for (const [id, entry] of recordingSources) if (!wanted.has(id) || wanted.get(id) !== entry.stream) { entry.source.disconnect(); recordingSources.delete(id); }
  for (const [id, stream] of wanted) if (!recordingSources.has(id)) { const source = recordingContext.context.createMediaStreamSource(stream); source.connect(recordingContext.destination); recordingSources.set(id, { source, stream }); }
}
function paintRecording() {
  const ctx = recordCanvas.getContext('2d'); const width = recordCanvas.width, height = recordCanvas.height;
  ctx.fillStyle = '#101827'; ctx.fillRect(0, 0, width, height);
  const entries = [...tiles.values()].sort((a, b) => Number(b.kind === 'screen') - Number(a.kind === 'screen'));
  const screen = entries.find(e => e.kind === 'screen'); const cameras = entries.filter(e => e !== screen).slice(0, 5);
  function draw(entry, x, y, w, h) {
    const video = entry.video; if (video.readyState >= 2 && video.videoWidth) { const scale = Math.min(w / video.videoWidth, h / video.videoHeight); const dw = video.videoWidth * scale, dh = video.videoHeight * scale; ctx.drawImage(video, x + (w-dw)/2, y + (h-dh)/2, dw, dh); }
    ctx.fillStyle = '#101827dd'; ctx.fillRect(x, y+h-30, w, 30); ctx.fillStyle = '#edf3ff'; ctx.font = '16px sans-serif'; ctx.fillText(entry.label.slice(0, 65), x+8, y+h-10, w-16);
  }
  if (screen) { draw(screen, 0, 40, width, cameras.length ? 510 : 680); cameras.forEach((e,i) => draw(e, i*(width/Math.max(cameras.length,1)), 555, width/cameras.length, 165)); }
  else { const cols = cameras.length > 1 ? 2 : 1; const rows = Math.ceil(cameras.length/cols) || 1; cameras.forEach((e,i) => draw(e, (i%cols)*width/cols, 40+Math.floor(i/cols)*680/rows, width/cols, 680/rows)); }
  ctx.fillStyle = '#91e4bd'; ctx.font = '18px sans-serif'; ctx.fillText(`${room?.title || 'Conference'} · ${new Date().toLocaleTimeString()}`, 18, 27);
}
async function startRecording() {
  if (!self?.canRecord) throw new Error('Ask the host for recording permission.');
  const mime = 'video/webm;codecs=vp8,opus'; if (!MediaRecorder.isTypeSupported(mime)) throw new Error('The bundled recorder codec is unavailable on this device.');
  const file = await invoke('recording.open'); if (!file) return;
  try {
    await signal('recording.start', {});
    recordCanvas = document.createElement('canvas'); recordCanvas.width = 1280; recordCanvas.height = 720;
    const context = new AudioContext(); await context.resume(); const destination = context.createMediaStreamDestination();
    // A silent source keeps the audio timeline valid in a room without microphones.
    const oscillator = context.createOscillator(); const gain = context.createGain(); gain.gain.value = 0; oscillator.connect(gain).connect(destination); oscillator.start();
    recordingContext = { context, destination, oscillator }; syncRecordingAudio(); paintRecording();
    const stream = recordCanvas.captureStream(25); for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3000000, audioBitsPerSecond: 96000 });
    recordingFailure = false; recordingQueue = Promise.resolve();
    let queuedChunks = 0;
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      queuedChunks++;
      if (queuedChunks > 10) { recordingFailure = true; notify(new Error('Recording storage is too slow. Recording has stopped; keep the partial file.')); if (recorder?.state === 'recording') recorder.stop(); }
      recordingQueue = recordingQueue.then(async () => { const bytes = new Uint8Array(await event.data.arrayBuffer()); await invoke('recording.chunk', bytes); queuedChunks--; }).catch(error => { recordingFailure = true; notify(error); if (recorder?.state === 'recording') recorder.stop(); });
    };
    recorder.onerror = event => { recordingFailure = true; notify(event.error || new Error('Recording encoder failed.')); };
    recorder.onstop = async () => {
      clearInterval(recordingTimer); for (const track of stream.getTracks()) track.stop();
      try { await recordingQueue; const result = await invoke('recording.close', { failed: recordingFailure }); status(recordingFailure ? 'Recording failed; check the partial file.' : `Recording saved: ${result?.path}`); } catch (error) { notify(error); }
      try { if (active) await signal('recording.stop', {}); } catch { /* Disconnect already clears the public recording indicator. */ }
      if (recordingContext) await recordingContext.context.close(); recordingContext = null; recordingSources.clear(); recorder = null; updateControls();
    };
    recordingTimer = setInterval(paintRecording, 40); recorder.start(1000); updateControls(); status(`Recording locally: ${file.path}`);
  } catch (error) { await invoke('recording.close', { failed: true }).catch(() => {}); await signal('recording.stop', {}).catch(() => {}); throw error; }
}
async function stopRecording() {
  if (!recorder) return;
  const current = recorder;
  await new Promise(resolve => { const existing = current.onstop; current.onstop = async event => { await existing(event); resolve(); }; if (current.state !== 'inactive') current.stop(); else resolve(); });
}
async function cleanup() {
  active = false; await stopRecording();
  for (const kind of Object.keys(local)) stopLocal(kind);
  if (publishing) publishing.close(); if (receiving) receiving.close(); publishing = receiving = null;
  for (const id of remoteTracks.keys()) removeRemote(id); snapshot = null; subscriptionKey = ''; room = null; self = null;
}
on('start-host','click',async () => { const name = displayName(); $('start-host').disabled = true; status('Starting host…'); try { await connected(await invoke('host.start', { address: $('interfaces').value, name })); } finally { $('start-host').disabled = false; } });
on('inspect-host','click',async () => { displayName(); pairing = await invoke('host.inspect', $('host-address').value); $('pair-fingerprint').textContent = pairing.fingerprint.match(/.{1,4}/g).join(' '); $('pair-warning').textContent = pairing.changed ? 'WARNING: This address has a different identity from your saved host. Do not continue unless you independently verified the replacement.' : pairing.trusted ? 'This certificate matches your previously trusted host.' : 'First connection: a host name or a PIN alone does not prove identity.'; $('pair-verified').checked = pairing.trusted; $('pair-connect').disabled = !pairing.trusted; $('pair-dialog').showModal(); });
on('pair-verified','change',() => { $('pair-connect').disabled = !$('pair-verified').checked; });
on('pair-cancel','click',() => $('pair-dialog').close());
on('pair-connect','click',async () => { $('pair-dialog').close(); await connected(await invoke('host.confirm', { fingerprint: pairing.fingerprint, name: displayName() })); });
on('refresh-rooms','click',refreshRooms);
on('create-room','submit',async e => { e.preventDefault(); await invoke('rooms.create', { title: $('room-title').value.trim(), password: $('room-password').value, capacity: Number($('room-capacity').value) }); $('room-title').value = ''; $('room-password').value = ''; await refreshRooms(); });
on('join-form','submit',async e => { e.preventDefault(); const password = $('join-password').value; $('join-password').value = ''; $('password-dialog').close(); await joinRoom(pendingJoin,password); });
on('join-cancel','click',() => $('password-dialog').close());
on('disconnect','click',() => invoke('disconnect'));
on('stop-host','click',async () => { if (confirm('Stop the host and disconnect everyone?')) await invoke('host.stop'); });
on('leave','click',async () => { await cleanup(); await connected(await invoke('room.leave')); });
on('microphone','click',() => toggleDevice('audio'));
on('camera','click',() => toggleDevice('camera'));
on('screen','click',selectScreen);
on('capture-cancel','click',() => $('capture-dialog').close());
on('record','click',() => recorder ? stopRecording() : startRecording());
on('lock-room','click',() => signal('room.lock', !room.locked));
on('devices','click',async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [id,kind] of [['audio-input','audioinput'],['video-input','videoinput'],['audio-output','audiooutput']]) {
    const previous = $(id).value; $(id).replaceChildren(); const standard = document.createElement('option'); standard.value = ''; standard.textContent = 'System default'; $(id).append(standard);
    devices.filter(d => d.kind === kind).forEach((d,i) => { const option = document.createElement('option'); option.value = d.deviceId; option.textContent = d.label || `${kind} ${i+1}`; $(id).append(option); }); $(id).value = previous;
  }
  $('devices-dialog').showModal();
});
on('devices-close','click',async () => { $('devices-dialog').close(); for (const entry of remoteTracks.values()) if (entry.audio?.setSinkId) await entry.audio.setSinkId($('audio-output').value); });
let offerQueue = Promise.resolve();
window.conference.onEvent(({event,payload}) => {
  if (event === 'room.snapshot') applySnapshot(payload).catch(notify);
  else if (event === 'subscribe.offer') { offerQueue = offerQueue.then(() => receiveOffer(payload)).catch(notify); }
  else if (event === 'disconnected') { cleanup().then(() => { show('welcome'); $('connection').textContent = '● Offline'; status('Disconnected. Verify the host and reconnect to rejoin.'); }).catch(notify); }
  else if (event === 'host.stopped') notify(new Error('The host has stopped. Meetings have ended.'));
  else if (event === 'error' || event === 'network.error') notify(new Error(payload.message));
  else if (event === 'app.closeRequested') stopRecording().then(() => invoke('app.exit')).catch(notify);
});
invoke('interfaces').then(list => { $('interfaces').replaceChildren(); for (const item of list) { const option = document.createElement('option'); option.value = item.address; option.textContent = `${item.name} · ${item.address}`; $('interfaces').append(option); } if (!list.length) { $('start-host').disabled = true; status('Connect to a private LAN to start a host.'); } }).catch(notify);
setInterval(async () => { if (!receiving || !active) return; try { const stats = await receiving.getStats(); let bytes = 0, lost = 0; stats.forEach(report => { if (report.type === 'inbound-rtp') { bytes += report.bytesReceived || 0; lost += report.packetsLost || 0; } }); $('quality').textContent = `Received ${(bytes/1048576).toFixed(1)} MB · ${lost} packets lost`; } catch {} }, 3000);
