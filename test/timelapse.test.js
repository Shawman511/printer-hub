// Timelapses recorded by the hub (lib/timelapse.js). The MP4 checks need
// FFmpeg (installed in CI and in the Docker image); without it the recording
// must fail with a clear message instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Timelapses, videoTiming } = require('../lib/timelapse');
const { PrinterStore } = require('../lib/printers');
const { storageReport } = require('../lib/storage');
const { Library } = require('../lib/library');
const { MockDriver } = require('../drivers/mock');

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function videoSize(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  return String(r.stdout).trim(); // "320x180" style -> "320,180"
}

async function settle(tl, pred, ms = 30000) {
  for (let t = 0; t < ms; t += 100) { if (pred()) return; await sleep(100); }
  throw new Error(`timed out: ${JSON.stringify(tl.list())}`);
}

test('records a frame per layer plus a final one, cropped like the camera', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const tl = new Timelapses(dir);
    const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
    driver.cfg.cameraCrop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const state = (status, layer) => ({ id: 'm', name: 'Mock', camera: 'mjpeg', status, job: { file: 'part.gcode', layer, totalLayers: 12 } });
    for (let layer = 1; layer <= 12; layer++) {
      driver.sim.progress = (layer / 12) * 100;
      tl.observe(driver, state('printing', layer));
      tl.observe(driver, state('printing', layer)); // same layer again: no extra frame
      await sleep(5);
    }
    tl.observe(driver, state('completed', 12));
    await settle(tl, () => ['ready', 'failed'].includes(tl.list()[0]?.status));
    const item = tl.list()[0];
    assert.equal(item.frames, 13);
    assert.equal(item.outcome, 'completed');
    if (HAS_FFMPEG) {
      assert.equal(item.status, 'ready', item.error);
      assert.ok(fs.statSync(tl.videoPath(item)).size > 1000);
      assert.ok(fs.existsSync(tl.posterPath(item)), 'poster frame');
      assert.equal(videoSize(tl.videoPath(item)), '320,180', 'cropped to the middle quarter');
      assert.ok(!fs.existsSync(tl.framesDir(item)), 'frames cleaned up');
    } else {
      assert.equal(item.status, 'failed');
      assert.match(item.error, /FFmpeg isn.t installed/);
    }
    tl.remove(item.id);
    assert.equal(tl.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing is recorded without a camera, or with timelapses off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const tl = new Timelapses(dir);
    const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
    tl.observe(driver, { id: 'm', name: 'Mock', camera: null, status: 'printing', job: { file: 'a.gcode', layer: 1, totalLayers: 5 } });
    driver.cfg.timelapse = false;
    tl.observe(driver, { id: 'm', name: 'Mock', camera: 'mjpeg', status: 'printing', job: { file: 'a.gcode', layer: 1, totalLayers: 5 } });
    assert.equal(tl.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('printers that report no layers get a frame every interval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const tl = new Timelapses(dir, { intervalMs: 50, graceMs: 0 });
    const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
    const s = { id: 'm', name: 'Mock', camera: 'mjpeg', status: 'printing', job: { file: 'b.gcode', layer: 0, totalLayers: 0 } };
    for (let i = 0; i < 6; i++) { tl.observe(driver, s); await sleep(60); }
    tl.observe(driver, { ...s, status: 'idle', job: null }); // cancelled
    await settle(tl, () => ['ready', 'failed'].includes(tl.list()[0]?.status));
    assert.equal(tl.list()[0].frames, 6);
    assert.equal(tl.list()[0].outcome, 'stopped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the hub records a simulated print and serves the video with Range', { skip: !HAS_FFMPEG && 'needs FFmpeg' }, async () => {
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-hub-'));
  const configPath = path.join(dir, 'config.json');
  // A fast simulator: done in a few polls.
  fs.writeFileSync(configPath, JSON.stringify({ pollIntervalMs: 150, printers: [{ id: 'sim', name: 'Sim', type: 'mock', startPrinting: true, speed: 30 }] }));
  const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--config', configPath], {
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'data'), SLICER_URL: '' },
  });
  let log = '';
  try {
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(log)), 10000);
      child.stdout.on('data', (d) => { log += d; const m = /setup code (\S+)/.exec(log); if (m) { clearTimeout(t); resolve(m[1]); } });
    });
    const base = `http://127.0.0.1:${port}`;
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code, username: 'admin', password: 'admin-password-1' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const get = (p, h = {}) => fetch(base + p, { headers: { Cookie: cookie, ...h } });
    let item;
    for (let i = 0; i < 200 && item?.status !== 'ready'; i++) {
      await sleep(150);
      item = (await (await get('/api/timelapses')).json())[0];
      assert.notEqual(item?.status, 'failed', item?.error);
    }
    assert.equal(item.status, 'ready');
    assert.equal(item.outcome, 'completed');
    assert.ok(item.frames >= 3);
    const whole = await get(`/api/timelapses/${item.id}/video`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    const part = await get(`/api/timelapses/${item.id}/video`, { Range: 'bytes=0-99' });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.equal((await get(`/api/timelapses/${item.id}/poster`)).headers.get('content-type'), 'image/jpeg');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a blip mid-print does not end the recording', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const tl = new Timelapses(dir); // default one-minute grace
    const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
    const s = (status, layer) => ({ id: 'm', name: 'Mock', camera: 'mjpeg', status, job: status === 'printing' ? { file: 'c.gcode', layer, totalLayers: 9 } : null });
    tl.observe(driver, s('printing', 1));
    tl.observe(driver, s('error'));
    tl.observe(driver, s('printing', 2));
    assert.equal(tl.list().length, 1);
    assert.equal(tl.list()[0].status, 'recording');
    assert.equal(tl.active.get('m').stoppedAt, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const HOUR = 3600000;

test('longer prints get longer videos, unless a length is chosen', () => {
  assert.equal(videoTiming(900, 4 * HOUR).fps, 30, '30 seconds for 4 hours');
  assert.equal(videoTiming(900, 4 * HOUR).seconds, 31, 'plus the held last frame');
  assert.equal(videoTiming(100, 0).seconds, 11);
  assert.equal(videoTiming(6000, 40 * HOUR).seconds, 61, 'an automatic video stops at a minute');
  assert.equal(videoTiming(600, 4 * HOUR, 120).seconds, 121);
  assert.equal(videoTiming(16, 3 * HOUR).fps, 4, 'too few frames never becomes a slideshow');
  assert.equal(videoTiming(16, 3 * HOUR).seconds, 5);
});

async function record(cfg, layers, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const tl = new Timelapses(dir, { graceMs: 0, ...opts });
  const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
  Object.assign(driver.cfg, cfg);
  const state = (status, layer) => ({ id: 'm', name: 'Mock', camera: 'mjpeg', status, job: { file: 'part.gcode', layer, totalLayers: layers } });
  for (let layer = 1; layer <= layers; layer++) {
    tl.observe(driver, state('printing', layer));
    await sleep(5);
  }
  return { dir, tl, driver, state, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('takes a frame every N layers', async () => {
  const { tl, done } = await record({ timelapseEvery: { layers: 5 } }, 21);
  try {
    assert.equal(tl.list()[0].frames, 5, 'layers 1, 6, 11, 16 and 21');
  } finally { done(); }
});

test('a timer setting ignores layers', async () => {
  const { tl, done } = await record({ timelapseEvery: { seconds: 3600 } }, 20);
  try {
    assert.equal(tl.list()[0].frames, 1);
  } finally { done(); }
});

test('a size shows while recording', async () => {
  const { tl, done } = await record({}, 3);
  try {
    assert.ok(tl.list()[0].size > 0);
  } finally { done(); }
});

test('a very long recording thins out and still reaches the end', async () => {
  const { tl, done } = await record({}, 25, { maxFrames: 10 });
  try {
    const item = tl.list()[0];
    assert.ok(item.frames < 10, `${item.frames} frames`);
    assert.ok(item.stride >= 2, 'capturing slowed down');
    const files = fs.readdirSync(tl.framesDir(item)).sort();
    assert.equal(files.length, item.frames);
    assert.equal(files[files.length - 1], `${String(item.frames).padStart(5, '0')}.${item.ext}`, 'numbered without gaps, for FFmpeg');
    assert.equal(item.size, files.reduce((n, f) => n + fs.statSync(path.join(tl.framesDir(item), f)).size, 0));
  } finally { done(); }
});

test('the video length is the one chosen', { skip: !HAS_FFMPEG && 'needs FFmpeg' }, async () => {
  const { tl, driver, state, done } = await record({ timelapseLength: 5 }, 40);
  try {
    tl.observe(driver, state('completed', 40));
    await settle(tl, () => tl.list()[0]?.status === 'ready' || tl.list()[0]?.status === 'failed');
    const item = tl.list()[0];
    assert.equal(item.status, 'ready', item.error);
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tl.videoPath(item)]);
    assert.ok(Math.abs(Number(String(r.stdout).trim()) - 6) < 0.5, `${r.stdout} seconds`);
  } finally { done(); }
});

test('timelapse settings are checked and kept when a printer is edited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const store = new PrinterStore(dir, { mock: MockDriver }, []);
    const p = store.add({ type: 'mock', name: 'Sim', timelapseEvery: { layers: 5 }, timelapseLength: 30 });
    assert.deepEqual(p.timelapseEvery, { layers: 5 });
    assert.equal(p.timelapseLength, 30);
    assert.deepEqual(store.update(p.id, { name: 'Sim 2' }).timelapseEvery, { layers: 5 }, 'other edits leave them alone');
    assert.equal(store.update(p.id, { timelapseLength: 0 }).timelapseLength, undefined, 'back to automatic');
    assert.deepEqual(store.update(p.id, { timelapseEvery: { seconds: 60 } }).timelapseEvery, { seconds: 60 });
    assert.throws(() => store.update(p.id, { timelapseEvery: { seconds: 1 } }), /5–3600/);
    assert.throws(() => store.update(p.id, { timelapseEvery: { layers: 0 } }), /1–1000/);
    assert.throws(() => store.update(p.id, { timelapseLength: 9999 }), /5–600/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('storage adds up what is on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const { Readable } = require('node:stream');
    const lib = new Library(dir);
    const tl = new Timelapses(dir);
    await lib.addFromStream('a.gcode', Readable.from([Buffer.alloc(5000, 65)]));
    await lib.addFromStream('m.stl', Readable.from([Buffer.alloc(9000, 66)]));
    fs.writeFileSync(path.join(tl.dir, 'x.mp4'), Buffer.alloc(7000));
    const s = storageReport(dir, lib, tl);
    assert.equal(s.printFiles.count, 1);
    assert.ok(s.printFiles.bytes >= 5000);
    assert.equal(s.models.bytes, 9000);
    assert.equal(s.timelapses.bytes, 7000);
    assert.ok(s.total >= 21000);
    assert.equal(s.total, s.printFiles.bytes + s.models.bytes + s.timelapses.bytes + s.other.bytes);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
