const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['interfaces','host.start','host.stop','host.inspect','host.confirm','rooms.list','rooms.create','room.join','room.leave','signal','disconnect','capture.sources','recording.open','recording.chunk','recording.close','app.exit']);
contextBridge.exposeInMainWorld('conference', {
  invoke: (name, ...args) => { if (!allowed.has(name)) return Promise.reject(new Error('Unsupported operation.')); return ipcRenderer.invoke(name, ...args); },
  onEvent: callback => { const listener = (_event, message) => callback(message); ipcRenderer.on('conference:event', listener); return () => ipcRenderer.removeListener('conference:event', listener); }
});
