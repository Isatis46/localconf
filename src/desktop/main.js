'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, session } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { fileURLToPath } = require('url');
const WebSocket = require('ws');
const network = require('./network');

const root = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '../..');
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', path.join(dataDir, 'chromium'));
app.setPath('sessionData', path.join(dataDir, 'chromium'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-features', 'MediaRouter');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let window, hostProcess, hostSecret, hostInfo, remote, auth, socket, preview, recording;
let roomID = '';
const pending = new Map();
const trustFile = path.join(dataDir, 'trusted-hosts.json');
function trusts() { try { return JSON.parse(fs.readFileSync(trustFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('The host trust file is damaged. Restore it before connecting.'); } }
function emit(event, payload) { if (window && !window.isDestroyed()) window.webContents.send('conference:event', { event, payload }); }
function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Invalid caller.');
  const url = event.senderFrame.url;
  if (!url.startsWith('file:') || fileURLToPath(url) !== path.join(__dirname, 'index.html')) throw new Error('Invalid application page.');
}
function handle(name, fn) { ipcMain.handle(name, async (event, ...args) => { assertSender(event); return fn(...args); }); }
function rpc(event, payload, requestedRoom = roomID) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected.'));
  const requestId = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Server response timed out.')); }, 25000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ v: 1, event, requestId, roomId: requestedRoom, payload }));
  });
}
async function connect(name, secret) {
  if (!remote) throw new Error('Confirm the host fingerprint first.');
  if (socket) { socket.removeAllListeners(); socket.close(); socket = null; }
  auth = await network.request(remote, 'POST', '/api/v1/sessions', { name, hostSecret: secret || '' });
  auth.displayName = name;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${remote.key}/ws/v1`, { ...network.tlsOptions(remote), headers: { Authorization: `Bearer ${auth.token}` }, maxPayload: 256 * 1024, handshakeTimeout: 10000, perMessageDeflate: false });
    socket = ws;
    ws.once('open', resolve); ws.once('error', reject);
    ws.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.event === 'response') {
          const entry = pending.get(message.requestId);
          if (entry) { clearTimeout(entry.timer); pending.delete(message.requestId); if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.payload); }
        } else emit(message.event, message.payload);
      } catch { ws.close(); }
    });
    ws.on('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Connection closed.')); } pending.clear(); roomID = ''; emit('disconnected', {}); });
    ws.on('error', () => emit('network.error', { message: 'Connection failed. Check the host and LAN connection.' }));
  });
  return { participantId: auth.participantId, admin: auth.admin, address: remote.key, fingerprint: remote.fingerprint };
}
function interfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => addresses.filter(a => a.family === 'IPv4' && !a.internal).flatMap(a => { try { network.endpoint(a.address); return [{ name, address: a.address }]; } catch { return []; } }));
}
function secureDataDirectory() {
  if (process.platform !== 'win32') return;
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.stdout && identity.stdout.match(/S-1-5-[\d-]+/);
  if (identity.status !== 0 || !sid) throw new Error('Cannot determine the Windows account for data protection.');
  const result = spawnSync('icacls.exe', [dataDir, '/inheritance:r', '/grant:r', `*${sid[0]}:(OI)(CI)F`], { windowsHide: true });
  if (result.status !== 0) throw new Error('Cannot protect the data folder. Extract the app to a writable NTFS folder.');
}
async function startHost({ address, name }) {
  if (hostProcess) throw new Error('Host is already running.');
  if (!interfaces().some(i => i.address === address)) throw new Error('Select a local LAN interface.');
  secureDataDirectory();
  const exe = path.join(root, 'ConferenceServer.exe');
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const hash = crypto.createHash('sha256').update(await fsp.readFile(exe)).digest('hex');
  if (hash !== manifest.files['ConferenceServer.exe']) throw new Error('The server file does not match the release manifest. Re-extract a trusted package.');
  hostSecret = crypto.randomBytes(32).toString('hex');
  const child = spawn(exe, ['--listen', address, '--data', path.join(dataDir, 'host')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  hostProcess = child;
  child.on('exit', () => { hostProcess = null; hostSecret = null; hostInfo = null; emit('host.stopped', {}); });
  try {
    const info = await new Promise((resolve, reject) => {
      let stdout = '', errors = '';
      const timer = setTimeout(() => reject(new Error('Host startup timed out.')), 20000);
      child.stdout.on('data', bytes => { stdout += bytes.toString(); if (stdout.includes('\n')) { try { const value = JSON.parse(stdout.split('\n')[0]); clearTimeout(timer); resolve(value); } catch { clearTimeout(timer); reject(new Error('Invalid server readiness response.')); } } });
      child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-2000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(errors || 'Host stopped during startup.')); });
      child.stdin.write(`${hostSecret}\n`);
    });
    preview = await network.inspectCertificate(info.address);
    if (preview.fingerprint !== info.fingerprint) throw new Error('The host certificate does not match the child process.');
    remote = preview; hostInfo = info;
    const connection = await connect(name, hostSecret);
    await network.request(remote, 'GET', '/api/v1/health', undefined, auth.token);
    return { ...connection, hosting: true };
  } catch (error) { child.stdin.end(); throw error; }
}
async function closeRecording(options = {}) {
  const current = recording;
  if (!current) return null;
  recording = null;
  if (options.failed) current.failed = true;
  try { await current.queue; await current.file.sync(); } catch { current.failed = true; }
  finally { await current.file.close(); }
  if (current.failed) throw new Error('Recording is incomplete. Keep the .partial.webm file for recovery.');
  await fsp.link(current.partial, current.destination);
  await fsp.unlink(current.partial);
  const metadata = { schemaVersion: 1, startedAt: current.startedAt, endedAt: new Date().toISOString(), roomId: current.roomId, bytes: current.bytes, sha256: current.hash.digest('hex'), format: 'webm', recordingAnnouncement: true };
  await fsp.writeFile(`${current.destination}.json.tmp`, JSON.stringify(metadata, null, 2));
  await fsp.rename(`${current.destination}.json.tmp`, `${current.destination}.json`);
  return { path: current.destination, bytes: current.bytes };
}
handle('interfaces', interfaces);
handle('host.start', startHost);
handle('host.stop', async () => { if (hostProcess) hostProcess.stdin.end(); return true; });
handle('host.inspect', async address => {
  preview = await network.inspectCertificate(address);
  const saved = trusts()[preview.key];
  return { address: preview.key, fingerprint: preview.fingerprint, trusted: !!saved && saved.fingerprint === preview.fingerprint, changed: !!saved && saved.fingerprint !== preview.fingerprint };
});
handle('host.confirm', async ({ fingerprint, name }) => {
  if (!preview || preview.fingerprint !== fingerprint) throw new Error('Inspect the host again.');
  remote = preview;
  const saved = trusts(); saved[remote.key] = { fingerprint: remote.fingerprint, pem: remote.pem };
  await fsp.writeFile(`${trustFile}.tmp`, JSON.stringify(saved, null, 2), { mode: 0o600 }); await fsp.rename(`${trustFile}.tmp`, trustFile);
  return connect(name);
});
handle('rooms.list', () => network.request(remote, 'GET', '/api/v1/rooms', undefined, auth.token));
handle('rooms.create', room => network.request(remote, 'POST', '/api/v1/rooms', room, auth.token));
handle('room.join', async ({ id, password }) => { roomID = id; try { return await rpc('room.join', { password }, id); } catch (error) { roomID = ''; throw error; } });
handle('room.leave', async () => { roomID = ''; const name = auth && auth.displayName; const info = await connect(name || 'Participant', hostInfo ? hostSecret : ''); return { ...info, hosting: !!hostInfo }; });
handle('signal', (event, payload) => {
  if (!['publish.offer', 'publish.reset', 'subscriptions.set', 'subscribe.answer', 'participant.update', 'room.lock', 'room.close', 'recording.start', 'recording.stop'].includes(event)) throw new Error('Unsupported action.');
  return rpc(event, payload);
});
handle('disconnect', async () => { if (socket) socket.close(); roomID = ''; });
handle('capture.sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
  return sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
});
handle('recording.open', async () => {
  if (recording) throw new Error('A recording is already open.');
  if (!roomID) throw new Error('Join a room first.');
  const result = await dialog.showSaveDialog(window, { title: 'Save local recording', defaultPath: path.join(root, 'recordings', `Conference-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`), filters: [{ name: 'WebM video', extensions: ['webm'] }] });
  if (result.canceled) return null;
  const destination = result.filePath.toLowerCase().endsWith('.webm') ? result.filePath : `${result.filePath}.webm`;
  // Never replace an existing recording, even if a dialog allows overwrite.
  try { await fsp.access(destination); throw new Error('Choose a new filename to preserve the existing recording.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const partial = `${destination}.partial.webm`;
  const file = await fsp.open(partial, 'wx', 0o600);
  recording = { file, partial, destination, roomId: roomID, bytes: 0, hash: crypto.createHash('sha256'), startedAt: new Date().toISOString(), queue: Promise.resolve(), failed: false };
  return { path: destination };
});
handle('recording.chunk', async bytes => {
  const current = recording;
  if (!current || !(bytes instanceof Uint8Array) || bytes.byteLength > 16 * 1024 * 1024) throw new Error('Invalid recording data.');
  const data = Buffer.from(bytes);
  current.queue = current.queue.then(async () => {
    let offset = 0;
    while (offset < data.length) { const { bytesWritten } = await current.file.write(data, offset, data.length - offset); if (!bytesWritten) throw new Error('Recording storage stopped responding.'); offset += bytesWritten; }
    current.hash.update(data); current.bytes += data.length; await current.file.sync();
  }).catch(error => { current.failed = true; throw error; });
  return current.queue;
});
handle('recording.close', closeRecording);

app.whenReady().then(() => {
  secureDataDirectory();
  fs.mkdirSync(path.join(root, 'recordings'), { recursive: true });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window?.webContents && permission === 'media' && contents.getURL().startsWith('file:')));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === window?.webContents && permission === 'media');
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  window = new BrowserWindow({ width: 1320, height: 860, minWidth: 1000, minHeight: 700, backgroundColor: '#101827', title: 'LocalConf', webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'index.html'));
  window.on('close', event => {
    if (recording) { event.preventDefault(); emit('app.closeRequested', {}); }
  });
}).catch(error => { dialog.showErrorBox('LocalConf cannot start', `${error.message}\nExtract the entire ZIP to a writable NTFS folder.`); app.quit(); });
handle('app.exit', async () => { await closeRecording(); app.quit(); });
app.on('before-quit', () => { if (socket) socket.close(); if (hostProcess) hostProcess.stdin.end(); });
app.on('window-all-closed', () => app.quit());
