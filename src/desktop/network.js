'use strict';
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const net = require('net');

function endpoint(address) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(address.trim());
  if (!match || net.isIP(match[1]) !== 4) throw new Error('Enter a LAN IPv4 address, optionally followed by :8443.');
  const octets = match[1].split('.').map(Number);
  if (!(octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31))) throw new Error('Only private LAN and loopback addresses are supported.');
  const port = Number(match[2] || 8443);
  if (port < 1 || port > 65535) throw new Error('Invalid port.');
  return { host: match[1], port, key: `${match[1]}:${port}` };
}
function fingerprint(raw) { return crypto.createHash('sha256').update(raw).digest('hex').toUpperCase(); }
function inspectCertificate(address) {
  const target = endpoint(address);
  return new Promise((resolve, reject) => {
    // Unauthenticated inspection ONLY: no application bytes or credentials are sent.
    const socket = tls.connect({ host: target.host, port: target.port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    socket.setTimeout(7000, () => socket.destroy(new Error('Host did not respond. Check its IP and firewall.')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert.raw) { socket.destroy(); reject(new Error('Host has no certificate.')); return; }
      const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
      resolve({ ...target, fingerprint: fingerprint(cert.raw), pem }); socket.end();
    });
  });
}
function tlsOptions(host) {
  return {
    ca: host.pem, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    checkServerIdentity: (_name, cert) => {
      if (!cert.raw || fingerprint(cert.raw) !== host.fingerprint) return new Error('Host identity changed. Re-pair using a trusted channel.');
      // Exact certificate pin replaces DNS/IP name matching for a portable LAN host.
    }
  };
}
function request(host, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = data.length;
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.request({ hostname: host.host, port: host.port, method, path, headers, ...tlsOptions(host), agent: false }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) res.destroy(new Error('Response too large.')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (res.statusCode >= 400) reject(new Error(value.error || `HTTP ${res.statusCode}`)); else resolve(value); } catch (error) { reject(error); } });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out.'))); req.on('error', reject); req.end(data);
  });
}
module.exports = { endpoint, fingerprint, inspectCertificate, tlsOptions, request };
