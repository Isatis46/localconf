'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { endpoint, fingerprint, inspectCertificate, request } = require('../src/desktop/network');
let server, target, directory, requestCount = 0;
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'localconf-tls-'));
  execFileSync('openssl', ['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem'),'-days','1','-subj','/CN=LocalConf test'], { stdio:'ignore' });
  server = https.createServer({ key:fs.readFileSync(path.join(directory,'key.pem')), cert:fs.readFileSync(path.join(directory,'cert.pem')) }, (req,res) => { requestCount++; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ authenticated:req.headers.authorization === 'Bearer test-token' })); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  target = `127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory,{recursive:true,force:true}); });
test('only explicit private IPv4 endpoints are accepted', () => {
  assert.deepEqual(endpoint('192.168.1.20'),{host:'192.168.1.20',port:8443,key:'192.168.1.20:8443'});
  for(const value of ['example.com','https://192.168.1.1','8.8.8.8','192.168.999.1','127.0.0.1:0','127.0.0.1:65536','192.168.1.1/path']) assert.throws(() => endpoint(value));
});
test('certificate preview sends no application request or credentials', async () => {
  const before = requestCount; const host = await inspectCertificate(target);
  assert.equal(host.fingerprint.length,64); assert.match(host.pem,/BEGIN CERTIFICATE/); assert.equal(requestCount,before);
});
test('verified pinned TLS transmits authenticated requests', async () => {
  const host = await inspectCertificate(target); const response = await request(host,'GET','/api/v1/health',undefined,'test-token'); assert.equal(response.authenticated,true);
});
test('mismatched fingerprint prevents application traffic', async () => {
  const host = await inspectCertificate(target); const before = requestCount;
  await assert.rejects(request({...host,fingerprint:'0'.repeat(64)},'GET','/api/v1/health',undefined,'test-token'),/identity changed/);
  assert.equal(requestCount,before);
});
test('fingerprints are deterministic SHA-256 values', () => { assert.equal(fingerprint(Buffer.from('abc')),'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'); });
