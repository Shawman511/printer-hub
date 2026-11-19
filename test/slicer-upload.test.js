// Files sent from a slicer the way OrcaSlicer sends them to OctoPrint.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { readUploadForm } = require('../lib/upload-form');
const { JobLog } = require('../lib/jobs');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upload-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ pollIntervalMs: 200, printers: [
    { id: 'sim', name: 'Sim', type: 'mock' },
    { id: 'multi', name: 'Multi', type: 'mock', multiColor: true },
  ] }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--config', path.join(dir, 'config.json')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'data'), SLICER_URL: '' },
  });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hub didn't start:\n${log}`)), 10000);
    child.stdout.on('data', (d) => { log += d; const m = /setup code (\S+)/.exec(log); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, { method, body, cookie = '' } = {}) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    return { status: res.status, data: await res.json().catch(() => ({})), cookie: set ? set.split(';')[0] : null };
  };
  const admin = (await call('/api/auth/setup', { body: { code, username: 'admin', password: 'admin-password-1' } })).cookie;
  // As OrcaSlicer does: X-Api-Key, a multipart form with print, path and file.
  const send = async (printer, key, name, content, print) => {
    const form = new FormData();
    form.append('print', print ? 'true' : 'false');
    form.append('path', '');
    form.append('file', new Blob([content]), name);
    const res = await fetch(`${base}/octoprint/${printer}/api/files/local`, { method: 'POST', headers: key ? { 'X-Api-Key': key } : {}, body: form });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { base, call, send, admin, stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const printerState = async (hub, id) => (await hub.call('/api/printers', { cookie: hub.admin })).data.find((p) => p.id === id);
async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; }
  throw new Error('timed out');
}

test('the upload form is read from disk, with fields and the file\'s exact bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-'));
  try {
    const body = Buffer.concat([
      Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="print"\r\n\r\ntrue\r\n'),
      Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="file"; filename="part.gcode"\r\nContent-Type: application/octet-stream\r\n\r\n'),
      Buffer.from('G1 X1\r\n--XyZnot-a-boundary\r\nG1 X2'),
      Buffer.from('\r\n--XyZ--\r\n'),
    ]);
    const req = Readable.from([body.subarray(0, 50), body.subarray(50)]);
    req.headers = { 'content-type': 'multipart/form-data; boundary=XyZ' };
    const form = await readUploadForm(req, dir);
    assert.deepEqual(form.fields, { print: 'true' });
    assert.equal(form.file.name, 'part.gcode');
    const bytes = fs.readFileSync(form.file.path).subarray(form.file.start, form.file.end).toString();
    assert.equal(bytes, 'G1 X1\r\n--XyZnot-a-boundary\r\nG1 X2');
    fs.rmSync(form.file.path);
    const plain = Readable.from([Buffer.from('x')]);
    plain.headers = { 'content-type': 'application/json' };
    await assert.rejects(readUploadForm(plain, dir), /multipart/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a slicer needs the printer\'s key, which only an admin can make', async () => {
  const hub = await startHub();
  try {
    const version = (key) => fetch(`${hub.base}/octoprint/sim/api/version`, { headers: key ? { 'X-Api-Key': key } : {} });
    assert.equal((await version()).status, 403, 'no key made yet');
    await hub.call('/api/users', { body: { username: 'oper', password: 'operator-pass-1', role: 'operator' }, cookie: hub.admin });
    const op = (await hub.call('/api/auth/login', { body: { username: 'oper', password: 'operator-pass-1' } })).cookie;
    assert.equal((await hub.call('/api/printer-setup/sim/upload-key', { body: {}, cookie: op })).status, 403);
    const { key } = (await hub.call('/api/printer-setup/sim/upload-key', { body: {}, cookie: hub.admin })).data;
    assert.ok(key.length >= 32);
    const v = await (await version(key)).json();
    assert.match(v.text, /^OctoPrint/, 'what OrcaSlicer checks for');
    assert.ok(v.api);
    assert.equal((await version('wrong')).status, 403);
    assert.equal((await fetch(`${hub.base}/octoprint/multi/api/version`, { headers: { 'X-Api-Key': key } })).status, 403, 'one printer\'s key is not another\'s');
    assert.equal((await fetch(`${hub.base}/octoprint/nope/api/version`, { headers: { 'X-Api-Key': key } })).status, 403);
    const { key: second } = (await hub.call('/api/printer-setup/sim/upload-key', { body: {}, cookie: hub.admin })).data;
    assert.equal((await version(key)).status, 403, 'a replaced key stops working');
    assert.equal((await version(second)).status, 200);
    assert.equal((await hub.send('sim', 'wrong', 'x.gcode', 'G1', false)).status, 403);
    assert.equal((await printerState(hub, 'sim')).status !== 'offline', true, 'making a key does not reconnect the printer');
  } finally { hub.stop(); }
});

test('upload keeps the file in the library and puts it on the printer; print starts it', async () => {
  const hub = await startHub();
  try {
    const { key } = (await hub.call('/api/printer-setup/sim/upload-key', { body: {}, cookie: hub.admin })).data;
    await until(async () => (await printerState(hub, 'sim'))?.online);
    const up = await hub.send('sim', key, 'oval rim.gcode', 'G1 X1\n', false);
    assert.equal(up.status, 201);
    assert.equal(up.data.done, true);
    const lib = (await hub.call('/api/library', { cookie: hub.admin })).data;
    assert.ok(lib.some((i) => i.name === 'oval rim.gcode' && i.sentTo.includes('sim')));
    const files = (await hub.call('/api/printers/sim/files', { cookie: hub.admin })).data;
    assert.ok(files.some((f) => f.name === 'oval rim.gcode'));
    assert.equal((await printerState(hub, 'sim')).status, 'idle', 'just sent, not started');

    const go = await hub.send('sim', key, 'bracket.gcode', 'G1 X2\n', true);
    assert.equal(go.status, 201);
    await until(async () => ['preparing', 'printing'].includes((await printerState(hub, 'sim')).status));
    const busy = await hub.send('sim', key, 'later.gcode', 'G1 X3\n', true);
    assert.equal(busy.status, 409, 'a busy printer is reported to the slicer');
    assert.match(busy.data.error, /Saved in Printer Hub's library/);
    assert.ok((await hub.call('/api/library', { cookie: hub.admin })).data.some((i) => i.name === 'later.gcode'), 'and the file is still kept');
  } finally { hub.stop(); }
});

test('a multicolor print waits on the card for its colors to be checked', async () => {
  const hub = await startHub();
  try {
    const { key } = (await hub.call('/api/printer-setup/multi/upload-key', { body: {}, cookie: hub.admin })).data;
    await until(async () => (await printerState(hub, 'multi'))?.online);
    const go = await hub.send('multi', key, 'benchy.gcode', 'G1 X1\n', true); // the simulator gives benchy two colors
    assert.equal(go.status, 201);
    const s = await printerState(hub, 'multi');
    assert.equal(s.status, 'idle', 'not started');
    assert.equal(s.pendingStart.file, 'benchy.gcode');
    await hub.call('/api/printers/multi/dismiss', { body: {}, cookie: hub.admin });
    assert.equal((await printerState(hub, 'multi')).pendingStart, undefined);
  } finally { hub.stop(); }
});

test('a printer naming a file with and without its folder is one job', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  try {
    const log = new JobLog(dir);
    const see = (file, progress) => log.observe({ id: 'k', name: 'Kobra X', online: true, status: 'printing', job: { file, progress, elapsed: progress * 60 } });
    see('3Dbenchy_PLA_0.2_14m.gcode', 1);
    see('/test_model/3Dbenchy_PLA_0.2_14m.gcode', 5);
    see('3Dbenchy_PLA_0.2_14m.gcode', 38);
    assert.equal(log.list().length, 1);
    assert.equal(log.list()[0].outcome, 'printing');
    see('other.gcode', 1);
    assert.equal(log.list().length, 2, 'a different file is still a new job');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
