// Settings → Printers API on a real hub process: node --test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fakeMoonraker } = require('./fake-printers');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts a hub with its own data dir and config; resolves once it prints its setup code.
async function startHub(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ pollIntervalMs: 200, ...config }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--config', configPath], {
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'data'), SLICER_URL: '' },
  });
  let log = '';
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hub didn't start:\n${log}`)), 10000);
    child.stdout.on('data', (d) => {
      log += d;
      const m = /setup code (\S+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.stderr.on('data', (d) => { log += d; });
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (p, { method, body, as } = {}) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: as ?? cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, cookie: set ? set.split(';')[0] : null };
  };
  const r = await call('/api/auth/setup', { body: { code, username: 'admin', password: 'admin-password-1' } });
  cookie = r.cookie;
  return { dir, call, stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('existing config printers are imported once, keeping their ids', async () => {
  const hub = await startHub({ printers: [
    { id: 'ad5m', name: 'Adventurer 5M', type: 'mock' },
    { id: 'gone', name: 'Unset', type: 'moonraker', host: '' }, // address from an unset env var
  ] });
  try {
    const { data } = await hub.call('/api/printer-setup');
    assert.deepEqual(data.map((p) => p.id), ['ad5m']);
    assert.ok(fs.existsSync(path.join(hub.dir, 'data', 'printers.json')));
  } finally { hub.stop(); }
});

test('add, test, mask secrets, edit and remove a printer', async () => {
  const fake = await fakeMoonraker({ apiKey: 'sekrit' });
  const hub = await startHub({ printers: [] });
  try {
    let r = await hub.call('/api/printers');
    assert.deepEqual(r.data, []);

    r = await hub.call('/api/printer-setup/types');
    assert.deepEqual(r.data.map((t) => t.type), ['moonraker', 'octoprint', 'prusalink', 'flashforge', 'anycubic', 'elegoo', 'mock']);
    assert.ok(r.data.find((t) => t.type === 'moonraker').fields.some((f) => f.key === 'apiKey' && f.type === 'password'));

    // Test before saving: a good printer, a wrong key, and a dead address.
    r = await hub.call('/api/printer-setup/test', { body: { type: 'moonraker', name: 'Voron', host: fake.host, apiKey: 'sekrit' } });
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    assert.equal(r.data.firmware, 'v0.12.0');
    r = await hub.call('/api/printer-setup/test', { body: { type: 'moonraker', name: 'Voron', host: fake.host, apiKey: 'nope' } });
    assert.equal(r.data.ok, false);
    r = await hub.call('/api/printer-setup/test', { body: { type: 'moonraker', name: 'Voron', host: '127.0.0.1:1' } });
    assert.equal(r.data.ok, false);
    assert.ok(r.data.error);

    // Validation.
    r = await hub.call('/api/printer-setup', { body: { type: 'moonraker', name: 'Voron' } });
    assert.match(r.data.error, /Address is required/);
    r = await hub.call('/api/printer-setup', { body: { type: 'nope', name: 'X', host: 'x' } });
    assert.match(r.data.error, /Pick a printer type/);
    r = await hub.call('/api/printer-setup', { body: { type: 'moonraker', name: 'X', host: 'bad host!' } });
    assert.match(r.data.error, /Address should be/);

    // Add: secret masked in replies, printer goes live.
    r = await hub.call('/api/printer-setup', { body: { type: 'moonraker', name: 'Voron 2.4', host: fake.host, apiKey: 'sekrit', slicer: { vendor: 'Voron', machine: 'Voron 2.4 350 0.4 nozzle' } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.id, 'voron-2-4');
    assert.equal(r.data.apiKey, undefined);
    assert.equal(r.data.apiKeySet, true);
    let state;
    for (let i = 0; i < 30 && !state?.online; i++) { await sleep(100); state = (await hub.call('/api/printers')).data[0]; }
    assert.equal(state.online, true);
    assert.equal(state.status, 'idle');

    // A second printer with the same name gets its own id.
    r = await hub.call('/api/printer-setup', { body: { type: 'mock', name: 'Voron 2.4' } });
    assert.equal(r.data.id, 'voron-2-4-2');

    // Edit with the key left blank keeps it (the printer stays online).
    r = await hub.call('/api/printer-setup/voron-2-4', { method: 'PATCH', body: { name: 'Big Voron', host: fake.host, apiKey: '' } });
    assert.equal(r.data.name, 'Big Voron');
    assert.equal(r.data.apiKeySet, true);
    assert.deepEqual(r.data.slicer, { vendor: 'Voron', machine: 'Voron 2.4 350 0.4 nozzle' });
    for (let i = 0; i < 30; i++) { await sleep(100); state = (await hub.call('/api/printers')).data.find((p) => p.id === 'voron-2-4'); if (state?.online && state.name === 'Big Voron') break; }
    assert.equal(state.name, 'Big Voron');
    assert.equal(state.online, true);
    const stored = JSON.parse(fs.readFileSync(path.join(hub.dir, 'data', 'printers.json'), 'utf8'));
    assert.equal(stored.find((p) => p.id === 'voron-2-4').apiKey, 'sekrit');

    // Only admins.
    await hub.call('/api/users', { body: { username: 'oper', password: 'operator-pass', role: 'operator' } });
    const op = (await hub.call('/api/auth/login', { body: { username: 'oper', password: 'operator-pass' }, as: '' })).cookie;
    r = await hub.call('/api/printer-setup', { as: op });
    assert.equal(r.status, 403);
    r = await hub.call('/api/printer-setup', { as: op, body: { type: 'mock', name: 'Sneaky' } });
    assert.equal(r.status, 403);

    // Remove.
    r = await hub.call('/api/printer-setup/voron-2-4', { method: 'DELETE' });
    assert.equal(r.data.ok, true);
    r = await hub.call('/api/printers');
    assert.deepEqual(r.data.map((p) => p.id), ['voron-2-4-2']);
  } finally {
    hub.stop();
    fake.server.close();
  }
});

test('Clear: a finished print is cleared on the printer and shown as ready', async () => {
  const fake = await fakeMoonraker();
  Object.assign(fake.p, { state: 'complete', filename: 'cube.gcode', progress: 1, duration: 600 });
  const hub = await startHub({ printers: [{ id: 'voron', name: 'Voron', type: 'moonraker', host: fake.host }] });
  const state = async () => (await hub.call('/api/printers')).data[0];
  try {
    let s;
    for (let i = 0; i < 30 && s?.status !== 'completed'; i++) { await sleep(100); s = await state(); }
    assert.equal(s.status, 'completed');
    assert.equal(s.job.file, 'cube.gcode');

    let r = await hub.call('/api/printers/voron/clear', { body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(fake.p.gcode.includes('SDCARD_RESET_FILE'), 'the printer was told');
    // This fake doesn't reset itself, so this is the hub's own "cleared" view.
    s = await state();
    assert.equal(s.status, 'idle');
    assert.equal(s.job, null);
    await sleep(500); // still cleared after more polls of the unchanged printer
    assert.equal((await state()).status, 'idle');

    r = await hub.call('/api/printers/voron/clear', { body: {} });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /no finished print/);

    // A new print ends the cleared view.
    Object.assign(fake.p, { state: 'printing', filename: 'next.gcode', progress: 0.3 });
    for (let i = 0; i < 30 && s?.status !== 'printing'; i++) { await sleep(100); s = await state(); }
    assert.equal(s.status, 'printing');
    assert.equal(s.job.file, 'next.gcode');
  } finally {
    hub.stop();
    fake.server.close();
  }
});

test('Camera crop: saved alone, shown in live state, admins only', async () => {
  const fake = await fakeMoonraker({ apiKey: 'k' });
  const hub = await startHub({ printers: [{ id: 'voron', name: 'Voron', type: 'moonraker', host: fake.host, apiKey: 'k' }] });
  const state = async () => (await hub.call('/api/printers')).data[0];
  try {
    for (let i = 0; i < 30 && !(await state())?.online; i++) await sleep(100);
    let r = await hub.call('/api/printer-setup/voron', { method: 'PATCH', body: { cameraCrop: { x: 0.2, y: 0.3, w: 0.5, h: 0.4 } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.cameraCrop, { x: 0.2, y: 0.3, w: 0.5, h: 0.4 });
    assert.equal(r.data.host, fake.host, 'other settings kept');
    assert.equal(r.data.apiKeySet, true);
    const s = await state();
    assert.deepEqual(s.cameraCrop, { x: 0.2, y: 0.3, w: 0.5, h: 0.4 });
    assert.equal(s.online, true, 'still connected (no restart for a crop)');

    r = await hub.call('/api/printer-setup/voron', { method: 'PATCH', body: { cameraCrop: null } });
    assert.equal(r.data.cameraCrop, undefined);
    assert.equal((await state()).cameraCrop, null);

    await hub.call('/api/users', { body: { username: 'oper', password: 'operator-pass', role: 'operator' } });
    const op = (await hub.call('/api/auth/login', { body: { username: 'oper', password: 'operator-pass' }, as: '' })).cookie;
    r = await hub.call('/api/printer-setup/voron', { method: 'PATCH', body: { cameraCrop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, as: op });
    assert.equal(r.status, 403);
  } finally {
    hub.stop();
    fake.server.close();
  }
});
