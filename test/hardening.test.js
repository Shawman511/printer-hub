// Requests that used to stop the hub or slip past a check.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { AuthStore, allowed } = require('../lib/auth');
const { Library } = require('../lib/library');
const { AnycubicDriver } = require('../drivers/anycubic');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function startHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hard-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ pollIntervalMs: 200, printers: [{ id: 'sim', name: 'Sim', type: 'mock' }] }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--config', path.join(dir, 'config.json')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'data'), SLICER_URL: '' },
  });
  let log = '';
  let exited = false;
  child.on('exit', () => { exited = true; });
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
  // fetch tidies paths, so "//" has to go out by hand.
  const raw = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  const admin = (await call('/api/auth/setup', { body: { code, username: 'admin', password: 'admin-password-1' } })).cookie;
  return { dir, base, call, raw, admin, alive: () => !exited, stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('bad requests get an error reply and the hub keeps running', async () => {
  const hub = await startHub();
  try {
    assert.equal(await hub.raw('/api/printers', { Cookie: 'hub_session=%E0%A4%A' }), 401, 'a cookie that can not be decoded');
    assert.equal(await hub.raw('//'), 400, 'a path that is not a URL');
    assert.equal((await hub.call('/api/health')).status, 200);
    assert.ok(hub.alive());
  } finally { hub.stop(); }
});

test('a file missing from disk is a 404, not a crash', async () => {
  const hub = await startHub();
  try {
    const up = await fetch(`${hub.base}/api/library?name=part.gcode`, { method: 'POST', headers: { Origin: hub.base, Cookie: hub.admin }, body: 'G1 X1\n' });
    const item = await up.json();
    assert.equal(await hub.raw(`/api/library/${item.id}/download`, { Cookie: hub.admin }), 200);
    fs.rmSync(path.join(hub.dir, 'data', 'library', item.id, 'part.gcode'));
    assert.equal(await hub.raw(`/api/library/${item.id}/download`, { Cookie: hub.admin }), 404);
    assert.equal((await hub.call('/api/storage', { cookie: hub.admin })).status, 200);
    assert.equal((await hub.call('/api/health')).status, 200);
    assert.ok(hub.alive());
  } finally { hub.stop(); }
});

test('printer settings stay admin-only however the path is written', async () => {
  const hub = await startHub();
  try {
    await hub.call('/api/users', { body: { username: 'oper', password: 'operator-pass-1', role: 'operator' }, cookie: hub.admin });
    const op = (await hub.call('/api/auth/login', { body: { username: 'oper', password: 'operator-pass-1' } })).cookie;
    assert.equal(await hub.raw('/api/printer-setup', { Cookie: op }), 403);
    assert.equal(await hub.raw('/api//printer-setup', { Cookie: op }), 403);
    assert.equal(await hub.raw('//api/printer-setup', { Cookie: op }), 404, 'read as another host: not a hub path at all');
    assert.equal(await hub.raw('/api/printer-setup/', { Cookie: op }), 403);
    assert.equal(await hub.raw('/api//printer-setup', { Cookie: hub.admin }), 200, 'admins still get in');
    assert.equal(await hub.raw('/api/printers', { Cookie: op }), 200);
  } finally { hub.stop(); }
});

test('allowed() treats doubled slashes as one', () => {
  assert.equal(allowed('viewer', 'GET', '/api//printer-setup'), false);
  assert.equal(allowed('operator', 'POST', '/api///users'), false);
  assert.equal(allowed('operator', 'POST', '/api/printers/x/pause'), true);
  assert.equal(allowed('viewer', 'POST', '/api/printers/x/pause'), false);
});

test('wrong passwords lock the address, not the account, and old entries go', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  try {
    const auth = new AuthStore(dir);
    await auth.createUser({ username: 'admin', password: 'right-password', role: 'admin' });
    for (let i = 0; i < 8; i++) await assert.rejects(auth.login({ username: 'admin', password: 'nope' }, { ip: '10.0.0.66' }), /Wrong/);
    await assert.rejects(auth.login({ username: 'admin', password: 'right-password' }, { ip: '10.0.0.66' }), /Too many/);
    const ok = await auth.login({ username: 'admin', password: 'right-password' }, { ip: '10.0.0.5' });
    assert.ok(ok.token, 'the owner still gets in from their own device');
    assert.ok([...auth.failures.keys()].every((k) => !k.startsWith('user:')));
    for (const f of auth.failures.values()) { f.at -= 16 * 60 * 1000; f.until = 0; }
    await assert.rejects(auth.login({ username: 'x', password: 'y' }, { ip: '10.0.0.7' }));
    assert.deepEqual([...auth.failures.keys()], ['ip:10.0.0.7']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an upload that breaks off closes its file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  try {
    const lib = new Library(dir);
    const opened = [];
    const create = fs.createWriteStream;
    fs.createWriteStream = (...a) => { const s = create(...a); opened.push(s); return s; };
    try {
      const broken = new Readable({ read() { this.push(Buffer.from('G1 X1\n')); this.destroy(new Error('connection lost')); } });
      await assert.rejects(lib.addFromStream('part.gcode', broken), /connection lost/);
    } finally { fs.createWriteStream = create; }
    assert.equal(opened.length, 1);
    assert.equal(opened[0].destroyed, true);
    assert.equal(lib.list().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A Kobra X driver with a stand-in for its MQTT connection.
function kobra(opts = {}) {
  const d = new AnycubicDriver({ id: 'k', name: 'Kobra X', type: 'anycubic', host: '127.0.0.1' }, { confirmMs: 150, ...opts });
  d.hs = { modelId: 'm', deviceId: 'dev' };
  d.sent = [];
  d.client = { connected: true, publish: (topic, payload) => d.sent.push(JSON.parse(payload)) };
  d.reply = (type, action, data) => d.onMessage(`x/printer/public/m/dev/${type}/report`, Buffer.from(JSON.stringify({ type, action, code: 200, data })));
  return d;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('Kobra X: two requests of one kind each get their own answer', async () => {
  const d = kobra();
  const a = d.request('file', 'fileDetails', { filename: 'a.gcode' });
  const b = d.request('file', 'fileDetails', { filename: 'b.gcode' });
  await tick();
  assert.deepEqual(d.sent.map((m) => m.data.filename), ['a.gcode'], 'the second waits for the first');
  d.reply('file', 'fileDetails', { name: 'a' });
  assert.equal((await a).data.name, 'a');
  await tick();
  assert.deepEqual(d.sent.map((m) => m.data.filename), ['a.gcode', 'b.gcode']);
  d.reply('file', 'fileDetails', { name: 'b' });
  assert.equal((await b).data.name, 'b');
});

test('Kobra X: a request that fails does not hold up the next', async () => {
  const d = kobra();
  d.client.connected = false;
  await assert.rejects(d.request('light', 'control', {}), /not connected/);
  d.client.connected = true;
  const next = d.request('light', 'control', {});
  await tick();
  d.reply('light', 'control', {});
  await next;
});

test('Kobra X: cancel and pause succeed only when the status shows it', async () => {
  const d = kobra();
  d.update({ online: true, status: 'printing' });
  await assert.rejects(d.cancel(), /didn’t confirm the cancel/);
  assert.equal(d.sent.at(-1).action, 'stop');
  const cancel = d.cancel();
  d.update({ status: 'cancelling' });
  await cancel;
  d.update({ status: 'printing' });
  const pause = d.pause();
  d.update({ status: 'printing' });
  d.update({ status: 'pausing' });
  await pause;
  await assert.rejects(d.pause(), /didn’t confirm the pause/, 'still printing is not a pause');
  d.client.connected = false;
  await assert.rejects(d.cancel(), /not connected/);
  assert.equal(d.listenerCount('update'), 0, 'no listeners left behind');
});

test('Kobra X: a driver stopped while connecting stays stopped', async () => {
  // Port 9 refuses at once, so the handshake fails; stop() lands before it does.
  const d = new AnycubicDriver({ id: 'k', name: 'Kobra X', type: 'anycubic', host: '127.0.0.1:9' }, {});
  d.start();
  await d.stop();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(d.retryTimer, undefined, 'no reconnect is scheduled');
  assert.equal(d.client, undefined);
});

test('a .3mf that unpacks to too much is refused, not unpacked', () => {
  const zlib = require('node:zlib');
  const { projectFilaments } = require('../lib/library');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  try {
    // 0.1 MB packed, 100 MB unpacked, both as stated and as it really is.
    const make = (statedSize) => {
      const packed = zlib.deflateRawSync(Buffer.alloc(100 * 1024 * 1024, 32));
      const name = Buffer.from('Metadata/project_settings.config');
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(statedSize, 22); local.writeUInt16LE(name.length, 26);
      const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(statedSize, 24); cd.writeUInt16LE(name.length, 28);
      const central = Buffer.concat([cd, name]);
      const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(30 + name.length + packed.length, 16);
      return Buffer.concat([local, name, packed, central, end]);
    };
    for (const [label, stated] of [['honest size', 100 * 1024 * 1024], ['size that lies', 100]]) {
      const file = path.join(dir, 'big.3mf');
      fs.writeFileSync(file, make(stated));
      const before = process.memoryUsage().rss;
      assert.deepEqual(projectFilaments(file), [], label);
      assert.ok(process.memoryUsage().rss - before < 80 * 1024 * 1024, `${label}: memory stayed bounded`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CSV export keeps spreadsheets from running cell text as formulas', () => {
  const { JobLog } = require('../lib/jobs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-'));
  try {
    const log = new JobLog(dir);
    log.addManual({ file: '=1+1.gcode', printerName: '+Printer', plates: 1, quantity: 1 });
    log.edit(log.list()[0].id, { notes: '@SUM(1+1) "quoted"' });
    const row = log.csv().split('\r\n')[1];
    assert.match(row, /"'=1\+1"/);
    assert.match(row, /"'=1\+1\.gcode"/);
    assert.match(row, /"'\+Printer"/);
    assert.match(row, /"'@SUM\(1\+1\) ""quoted"""/);
    assert.match(row, /"0\.00"/, 'numbers are left alone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the printer settings file is readable by the hub only', { skip: process.platform === 'win32' && 'no Unix file modes on Windows' }, () => {
  const { PrinterStore } = require('../lib/printers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prn-'));
  try {
    const file = path.join(dir, 'printers.json');
    fs.writeFileSync(file, '[]', { mode: 0o644 }); // as older versions left it
    const store = new PrinterStore(dir, { mock: { meta: { fields: [] } } });
    store.add({ type: 'mock', name: 'Sim' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
