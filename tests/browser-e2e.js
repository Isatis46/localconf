'use strict';
// Linux integration harness: real renderer and server, synthetic browser devices.
// Electron IPC is replaced by a test bridge; Windows/Electron execution is separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const WebSocket = require('ws');
const network = require('../src/desktop/network');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'artifacts/browser-test');
fs.mkdirSync(output,{recursive:true});
const data = fs.mkdtempSync(path.join(output,'host-'));
const secret = crypto.randomBytes(32).toString('hex');
let server, browser;
const clients = [];
async function bridge(page, admin) {
  const host = await network.inspectCertificate('127.0.0.1:18443');
  const auth = await network.request(host,'POST','/api/v1/sessions',{name:admin?'Test Host':'Test Guest',hostSecret:admin?secret:''});
  const ws = new WebSocket(`wss://${host.key}/ws/v1`,{...network.tlsOptions(host),headers:{Authorization:`Bearer ${auth.token}`}});
  clients.push(ws); await new Promise((resolve,reject) => {ws.once('open',resolve);ws.once('error',reject);});
  let room = '', chunks = [], finalFile;
  const waiting = new Map();
  function rpc(event,payload,roomID=room) {const id=crypto.randomBytes(8).toString('hex');return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`Timeout: ${event}`));},20000);waiting.set(id,{resolve,reject,timer});ws.send(JSON.stringify({v:1,event,requestId:id,roomId:roomID,payload}));});}
  ws.on('message',async bytes=>{const message=JSON.parse(bytes);if(message.event==='response'){const entry=waiting.get(message.requestId);if(entry){waiting.delete(message.requestId);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error)):entry.resolve(message.payload);}}else{await page.evaluate(message=>window.__event?.(message),message).catch(()=>{});}});
  await page.exposeFunction('__invoke',async(name,...args)=>{
    switch(name){
      case 'interfaces':return [{name:'Test LAN',address:'127.0.0.1'}];
      case 'host.start':case 'host.confirm':return {participantId:auth.participantId,admin,address:host.key,fingerprint:host.fingerprint,hosting:admin};
      case 'host.inspect':return {address:host.key,fingerprint:host.fingerprint,trusted:false,changed:false};
      case 'rooms.list':return network.request(host,'GET','/api/v1/rooms',undefined,auth.token);
      case 'rooms.create':return network.request(host,'POST','/api/v1/rooms',args[0],auth.token);
      case 'room.join':room=args[0].id;return rpc('room.join',{password:args[0].password});
      case 'signal':return rpc(args[0],args[1]);
      case 'recording.open':chunks=[];finalFile=path.join(output,`${admin?'host':'guest'}.webm`);return {path:finalFile};
      case 'recording.chunk':chunks.push(Buffer.from(Object.values(args[0])));return true;
      case 'recording.close':fs.writeFileSync(finalFile,Buffer.concat(chunks));return {path:finalFile,bytes:Buffer.concat(chunks).length};
      case 'disconnect':ws.close();return;
      default:throw new Error(`Harness operation not implemented: ${name}`);
    }
  });
  await page.evaluateOnNewDocument(()=>{window.conference={invoke:(...args)=>window.__invoke(...args),onEvent:callback=>{window.__event=callback;}};});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`file://${path.join(root,'src/desktop/index.html')}`);
  await page.type('#display-name',admin?'Test Host':'Test Guest');
  if(admin)await page.click('#start-host');
  else{await page.type('#host-address','127.0.0.1:18443');await page.click('#inspect-host');await page.waitForSelector('#pair-dialog[open]');await page.click('#pair-verified');await page.click('#pair-connect');}
  await page.waitForSelector('#lobby:not([hidden])');
  return {page,errors,auth};
}
async function main(){
  server=spawn(path.join(root,'artifacts/conference-server-linux'),['--listen','127.0.0.1','--port','18443','--media-port','40001','--data',data],{stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server readiness timeout')),15000);server.once('error',reject);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.stderr.on('data',b=>process.stderr.write(b));server.once('exit',code=>reject(new Error(`Server exit ${code}`)));server.stdin.write(secret+'\n');});
  browser=await puppeteer.launch({executablePath:await chromium.executablePath(),headless:true,args:[...chromium.args.filter(arg=>arg!=='--disable-web-security'),'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'],defaultViewport:{width:1360,height:920}});
  console.log('Browser started');
  const first=await bridge(await browser.newPage(),true);
  console.log('Host lobby ready');
  await first.page.type('#room-title','Engineering sync');await first.page.click('#create-room button');await first.page.waitForSelector('.room-card button');await first.page.click('.room-card button');await first.page.waitForSelector('#meeting:not([hidden])');
  console.log('Host joined room');
  const second=await bridge(await browser.newPage(),false);await second.page.click('.room-card button');await second.page.waitForSelector('#meeting:not([hidden])');
  console.log('Guest joined room');
  await first.page.click('#camera');await first.page.waitForFunction(()=>document.querySelector('#camera').textContent==='Camera on');await first.page.click('#microphone');console.log('Capture enabled');
  await second.page.waitForFunction(()=>[...document.querySelectorAll('#videos video')].some(v=>v.videoWidth>0),{timeout:30000});
  await second.page.waitForFunction(()=>document.querySelector('#audio-streams audio')?.srcObject?.getAudioTracks().length===1,{timeout:30000});
  assert.equal(await second.page.$eval('#record',el=>el.disabled),true);
  await first.page.click('#record');await second.page.waitForSelector('#recording-indicator:not([hidden])');
  await first.page.waitForFunction(()=>document.querySelector('#record').textContent==='Stop recording');
  await new Promise(resolve=>setTimeout(resolve,3500));await first.page.click('#record');await first.page.waitForFunction(()=>document.querySelector('#record').textContent==='Record locally');
  const recorded=fs.readFileSync(path.join(output,'host.webm'));assert.ok(recorded.length>10000,'recording contains media');assert.equal(recorded.subarray(0,4).toString('hex'),'1a45dfa3','Matroska/WebM EBML header');
  await first.page.screenshot({path:path.join(output,'meeting.png'),fullPage:true});
  await second.page.waitForSelector('#recording-indicator[hidden]');
  // Repeated publication changes exercise dynamic SFU add/remove/renegotiation.
  await first.page.click('#camera');await second.page.waitForFunction(()=>document.querySelectorAll('#videos video').length===0);
  await first.page.click('#camera');await second.page.waitForFunction(()=>[...document.querySelectorAll('#videos video')].some(v=>v.videoWidth>0),{timeout:30000});
  await first.page.evaluate(async id => window.conference.invoke('signal','participant.update',{id,canRecord:true}),second.auth.participantId);
  await second.page.waitForFunction(()=>!document.querySelector('#record').disabled);
  await second.page.click('#record');await second.page.waitForFunction(()=>document.querySelector('#record').textContent==='Stop recording');
  await new Promise(resolve=>setTimeout(resolve,1200));
  await first.page.evaluate(async id => window.conference.invoke('signal','participant.update',{id,canRecord:false}),second.auth.participantId);
  await second.page.waitForFunction(()=>document.querySelector('#record').disabled && document.querySelector('#record').textContent==='Record locally');
  assert.ok(fs.statSync(path.join(output,'guest.webm')).size>1000,'revocation finalized guest recording');
  assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
  console.log(JSON.stringify({result:'passed',checks:['host + guest join','synthetic camera received','microphone received','guest recording denied in UI','public recording indicator','local WebM output','stop notification','camera stop/start renegotiation','recording revoke stops guest recorder','renderer has no page errors'],recordingBytes:recorded.length}));
}
main().catch(async error=>{console.error(error);if(browser)for(const [i,page] of (await browser.pages()).entries()){await page.screenshot({path:path.join(output,`failure-${i}.png`)}).catch(()=>{});console.error(await page.evaluate(()=>({notice:document.querySelector('#notification')?.textContent,status:document.querySelector('#footer-status')?.textContent,publications:typeof snapshot==='undefined'?null:snapshot?.publications,remote:typeof remoteTracks==='undefined'?null:[...remoteTracks.keys()],transceivers:typeof receiving==='undefined'?null:receiving?.getTransceivers().map(t=>({mid:t.mid,id:t.receiver.track.id,state:t.receiver.track.readyState}))})).catch(()=>({})));}process.exitCode=1;}).finally(async()=>{for(const ws of clients)ws.close();if(browser)await browser.close();if(server){server.stdin.end();setTimeout(()=>server.kill(),3000).unref();}});
