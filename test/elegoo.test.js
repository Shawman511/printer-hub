// Elegoo Centauri Carbon 2 driver against a fake printer: node --test
// The fake stands in for the MQTT client (the printer is the broker) and serves
// the printer's HTTP endpoints (/system/info, /upload).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ElegooDriver, mapStatus, deepMerge } = require('../drivers/elegoo');
const { planFilamentUse } = require('../lib/jobs');

const SN = 'CC2SN0001';

function idleStatus() {
  return {
    extruder: { target: 0, temperature: 33 },
    heater_bed: { target: 0, temperature: 30 },
    fans: { fan: { speed: 127.5 }, aux_fan: { speed: 0 }, box_fan: { speed: 255 } },
    gcode_move: { speed_mode: 1 },
    led: { status: 1 },
    machine_status: { exception_status: [], progress: 0, status: 1, sub_status: 0 },
    print_status: { current_layer: 0, filename: '', print_duration: 0, remaining_time_sec: 0, state: '' },
    ztemperature_sensor: { temperature: 27 },
  };
}

// `silent`: methods the printer never answers (and that change nothing).
async function fakeCentauri({ code = '123456', clientLimit = false, silent = [] } = {}) {
  const p = { status: idleStatus(), requests: [], uploads: [], seq: 100, clients: [], silent: new Set(silent) };
  // As a real CC2 lists them: color_map by G-code tool number, grams in total_filament_used.
  const files = p.files = [
    { filename: 'old.gcode', size: 10, create_time: 1, layer: 50, type: 'file', color_map: [{ color: '#36A8E1', name: 'PETG', t: 0 }, { color: '#FFFFFF', name: 'PLA', t: 1 }], total_filament_used: 30 },
    { filename: 'cube.gcode', size: 20, create_time: 2, layer: 120, type: 'file', color_map: [{ color: '#FF1010', name: 'PLA', t: 0 }], total_filament_used: 12.5 },
  ];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/system/info') {
      if (url.searchParams.get('X-Token') !== code) { res.writeHead(401); return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error_code: 0, system_info: { sn: SN } }));
    }
    if (url.pathname === '/upload' && req.method === 'PUT') {
      if (req.headers['x-token'] !== code) { req.resume(); res.writeHead(401); return res.end('<html>401 Unauthorized</html>'); }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        p.uploads.push({ range: req.headers['content-range'], name: req.headers['x-file-name'], md5: req.headers['x-file-md5'], token: req.headers['x-token'], size: Buffer.concat(chunks).length });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error_code: 0 }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // Pushes a status delta to every registered client.
  p.push = (delta) => {
    for (const c of p.clients) c.deliver(`elegoo/${SN}/api_status`, { id: p.seq++, method: 6000, result: delta });
  };

  const results = {
    // Shape as reported by a real CC2 on firmware 02.01.01.07.
    1001: () => ({ error_code: 0, machine_model: 'Centauri Carbon 2', software_version: { mcu_version: '00.00.00.00', ota_version: '02.01.01.07', soc_version: '' }, sn: SN }),
    1002: () => ({ error_code: 0, ...JSON.parse(JSON.stringify(p.status)) }),
    1020: (params) => {
      Object.assign(p.status.machine_status, { status: 2, sub_status: 2075, progress: 10 });
      Object.assign(p.status.print_status, { filename: params.filename, current_layer: 12, print_duration: 600, remaining_time_sec: 3000, state: 'printing' });
      return { error_code: 0 };
    },
    1021: () => { p.status.machine_status.sub_status = 2502; return { error_code: 0 }; },
    1023: () => { p.status.machine_status.sub_status = 2075; return { error_code: 0 }; },
    1022: () => { Object.assign(p.status.machine_status, { status: 1, sub_status: 0 }); p.status.print_status.filename = ''; return { error_code: 0 }; },
    1026: () => ({ error_code: 0 }),
    1027: () => ({ error_code: 0 }),
    1028: () => ({ error_code: 0 }),
    1029: (params) => { p.status.led.status = params.power; return { error_code: 0 }; },
    1030: () => ({ error_code: 0 }),
    1031: () => (p.status.machine_status.status === 2 ? { error_code: 0 } : { error_code: 1010 }),
    1044: (params) => ({ error_code: 0, file_list: files.slice(params.offset, params.offset + params.limit), offset: params.offset, total: files.length }),
    1046: (params) => {
      const f = files.find((x) => x.filename === params.filename);
      return f ? { error_code: 0, filename: params.filename, total_layer: f.layer } : { error_code: 1021 };
    },
    // Tray status: 0 empty, 1 loaded, 2 loaded and in use.
    2005: () => ({ error_code: 0, canvas_info: { active_canvas_id: 0, active_tray_id: 2, canvas_list: [{ canvas_id: 0, tray_list: [
      { tray_id: 0, filament_color: '#FF0000', filament_type: 'PLA', status: 1 },
      { tray_id: 1, filament_color: '#00FF00', filament_type: 'PETG', status: 0 },
      { tray_id: 2, filament_color: '#FFFFFF', filament_type: 'PLA', status: 2 },
    ] }] } }),
  };

  function connect(opts) {
    const client = new EventEmitter();
    client.connected = false;
    client.opts = opts;
    client.subs = [];
    client.deliver = (topic, body) => {
      const match = client.subs.some((s) => new RegExp(`^${s.replace(/\+/g, '[^/]+').replace(/#$/, '.*')}$`).test(topic));
      if (match && client.connected) setImmediate(() => client.emit('message', topic, Buffer.from(JSON.stringify(body))));
    };
    client.subscribe = (t) => { client.subs.push(...[].concat(t)); };
    client.unsubscribe = (t) => { client.subs = client.subs.filter((s) => s !== t); };
    client.end = () => { client.connected = false; p.clients = p.clients.filter((c) => c !== client); };
    client.publish = (topic, payload, opts = {}) => {
      const msg = JSON.parse(payload);
      if (topic === `elegoo/${SN}/api_register`) {
        const full = clientLimit && p.clients.length >= 2;
        if (!full) p.clients.push(client);
        client.registerTopic = `elegoo/${SN}/${msg.request_id}/register_response`;
        return client.deliver(client.registerTopic, full ? { client_id: msg.client_id, error: 'too many clients', code: 3 } : { client_id: msg.client_id, error: 'ok' });
      }
      const m = /^elegoo\/[^/]+\/([^/]+)\/api_request$/.exec(topic);
      if (!m) return;
      if (msg.type === 'PING') return client.deliver(`elegoo/${SN}/${m[1]}/api_response`, { type: 'PONG' });
      p.requests.push({ method: msg.method, params: msg.params, qos: opts.qos || 0 });
      if (p.silent.has(msg.method)) return;
      const result = results[msg.method] ? results[msg.method](msg.params || {}) : { error_code: 1001 };
      client.deliver(`elegoo/${SN}/${m[1]}/api_response`, { id: msg.id, method: msg.method, result });
    };
    setImmediate(() => {
      if (opts.username !== 'elegoo' || opts.password !== code) return client.emit('error', new Error('Connection refused: Not authorized'));
      client.connected = true;
      client.emit('connect');
    });
    return client;
  }

  return { p, connect, host: `127.0.0.1:${server.address().port}`, server };
}

function waitFor(driver, pred, ms = 3000) {
  if (pred(driver.state)) return Promise.resolve(driver.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { driver.off('update', on); reject(new Error(`timed out; last state ${driver.state.status} ${driver.state.error || ''}`)); }, ms);
    const on = (s) => { if (pred(s)) { clearTimeout(timer); driver.off('update', on); resolve(s); } };
    driver.on('update', on);
  });
}

async function withDriver(fake, cfg, fn, opts = {}) {
  const d = new ElegooDriver({ id: 'cc2', name: 'CC2', type: 'elegoo', host: fake.host, ...cfg }, { connect: fake.connect, gapMs: 0, pingMs: 60000, ...opts });
  try {
    await d.start();
    await fn(d);
  } finally {
    await d.stop();
    fake.server.close();
  }
}

test('Elegoo CC2: connects, reports status, files, prints, controls, uploads', async () => {
  const fake = await fakeCentauri({ code: 'ABC123' });
  await withDriver(fake, { accessCode: 'ABC123' }, async (d) => {
    let s = await waitFor(d, (x) => x.online && x.firmware);
    assert.equal(s.status, 'idle');
    assert.equal(s.model, 'Centauri Carbon 2');
    assert.equal(s.firmware, '02.01.01.07');
    assert.deepEqual(s.temps.nozzle, { cur: 33, target: 0 });
    assert.deepEqual(s.temps.chamber, { cur: 27, target: 0 });
    assert.equal(s.fans.part, 50);
    assert.equal(s.fans.chamber, 100);
    assert.equal(s.light, true);
    assert.equal(s.camera, 'mjpeg');
    assert.equal(d.cameraSource().url, 'http://127.0.0.1:8080/?action=stream');
    s = await waitFor(d, (x) => x.slots);
    assert.deepEqual(s.slots, [
      { index: 0, color: [255, 0, 0], type: 'PLA', ready: true },
      { index: 1, color: [0, 255, 0], type: 'PETG', ready: false },
      { index: 2, color: [255, 255, 255], type: 'PLA', ready: true }, // status 2: the tray in use
    ]);

    // Deltas merge into the snapshot.
    fake.p.push({ extruder: { target: 220, temperature: 150 } });
    s = await waitFor(d, (x) => x.temps.nozzle.target === 220);
    assert.equal(s.temps.bed.cur, 30); // untouched by the delta

    assert.deepEqual((await d.listFiles()).map((f) => f.name), ['cube.gcode', 'old.gcode']);

    await d.startPrint('cube.gcode');
    // Red PLA goes to the red PLA tray, and the printer is told so.
    assert.deepEqual(fake.p.requests.find((r) => r.method === 1020).params, { storage_media: 'local', filename: 'cube.gcode', config: { printer_check: true, slot_map: [{ t: 0, canvas_id: 0, tray_id: 0 }] } });
    fake.p.push(JSON.parse(JSON.stringify({ machine_status: fake.p.status.machine_status, print_status: fake.p.status.print_status })));
    s = await waitFor(d, (x) => x.status === 'printing');
    assert.equal(s.job.file, 'cube.gcode');
    assert.equal(s.job.progress, 10);
    assert.equal(s.job.layer, 12);
    assert.equal(s.job.totalLayers, 120); // from the file list
    assert.equal(s.job.remaining, 3000);
    assert.equal(s.speed.kind, 'mode');

    await d.control({ action: 'speed', value: 2 });
    assert.equal(d.state.speed.value, 2);
    await assert.rejects(d.control({ action: 'jog', axis: 'x', distance: 10 }), /during a print/);

    await d.pause();
    fake.p.push({ machine_status: { sub_status: 2502 } });
    await waitFor(d, (x) => x.status === 'paused');
    await d.resume();
    fake.p.push({ machine_status: { sub_status: 2075 } });
    await waitFor(d, (x) => x.status === 'printing');
    await d.cancel();
    fake.p.push({ machine_status: { status: 1, sub_status: 0 }, print_status: { filename: '' } });
    s = await waitFor(d, (x) => x.status === 'idle' && !x.job);
    assert.equal(s.speed, null);

    await d.control({ action: 'jog', axis: 'z', distance: -1 });
    await d.control({ action: 'home', axes: 'xyz' });
    await d.control({ action: 'temp', heater: 'bed', target: 60 });
    await d.control({ action: 'fan', pct: 100 });
    await d.setLight(false);
    assert.equal(d.state.light, false);
    const sent = (m) => fake.p.requests.filter((r) => r.method === m).map((r) => r.params);
    assert.deepEqual(sent(1027), [{ axes: 'z', distance: -1 }]);
    assert.deepEqual(sent(1026), [{ homed_axes: 'xyz' }]);
    assert.deepEqual(sent(1028), [{ heater_bed: 60 }]);
    assert.deepEqual(sent(1030), [{ fan: 255 }]);
    assert.deepEqual(sent(1029), [{ power: 0 }]);

    // 2.5 MiB goes up in three ranged chunks, each with the whole-file MD5.
    const data = crypto.randomBytes(2.5 * 1024 * 1024);
    await d.upload('part.gcode', data);
    const md5 = crypto.createHash('md5').update(data).digest('hex');
    assert.deepEqual(fake.p.uploads.map((u) => u.range), ['bytes 0-1048575/2621440', 'bytes 1048576-2097151/2621440', 'bytes 2097152-2621439/2621440']);
    assert.ok(fake.p.uploads.every((u) => u.md5 === md5 && u.name === 'part.gcode' && u.token === 'ABC123'));
    await assert.rejects(d.upload('model.3mf', data), /\.gcode/);
  });
});

test('Elegoo CC2: a wrong access code is reported', async () => {
  const fake = await fakeCentauri({ code: 'right' });
  await withDriver(fake, { accessCode: 'wrong' }, async (d) => {
    const s = await waitFor(d, (x) => !!x.error);
    assert.equal(s.online, false);
    assert.match(s.error, /access code/);
  });
});

test('Elegoo CC2: a full client list is explained', async () => {
  const fake = await fakeCentauri({ clientLimit: true });
  fake.p.clients.push({ deliver() {} }, { deliver() {} }); // the Elegoo app and slicer
  await withDriver(fake, {}, async (d) => {
    const s = await waitFor(d, (x) => !!x.error);
    assert.match(s.error, /two LAN connections/);
  });
});

test('Elegoo CC2: status codes map to hub statuses', () => {
  const st = (machine_status, print_status = {}) => mapStatus({ machine_status, print_status }).status;
  assert.equal(st({ status: 1 }), 'idle');
  assert.equal(st({ status: 2, sub_status: 2075 }), 'printing');
  assert.equal(st({ status: 2, sub_status: 1045 }), 'heating');
  assert.equal(st({ status: 2, sub_status: 2501 }), 'pausing');
  assert.equal(st({ status: 2, sub_status: 2505 }), 'paused'); // filament runout
  assert.equal(st({ status: 2, sub_status: 2503 }), 'cancelling');
  assert.equal(st({ status: 1, sub_status: 2077 }), 'completed');
  assert.equal(st({ status: 1 }, { state: 'complete' }), 'completed');
  // Seen on a real CC2 (02.01.01.07) while uploading, then cancelling a print.
  assert.deepEqual(mapStatus({ machine_status: { status: 11, sub_status: 3000 } }), { status: 'busy', stage: 'Transferring file' });
  assert.equal(st({ status: 2, sub_status: 1405 }, { state: 'printing' }), 'heating');
  assert.equal(st({ status: 2, sub_status: 2502 }, { state: 'printing' }), 'paused');
  assert.equal(st({ status: 2, sub_status: 2503 }, { state: 'cancelled' }), 'cancelling');
  assert.equal(st({ status: 2, sub_status: 2504 }, { state: 'cancelled' }), 'idle');
  assert.equal(st({ status: 1, sub_status: 0 }, { state: 'cancelled' }), 'idle');
  assert.equal(st({ status: 10 }), 'busy');
  assert.equal(st({ status: 14 }), 'error');
  assert.deepEqual(mapStatus({ machine_status: { status: 2, exception_status: [103] } }), { status: 'error', error: 'Nozzle heating failed' });
  assert.equal(st({ status: 2, exception_status: [1301] }), 'printing'); // warnings don't stop the print
});

// Review 1: the tray a print uses is charged, and is the tray the printer is told to use.
test('Elegoo CC2: CANVAS prints charge the tray they print from', async () => {
  const fake = await fakeCentauri();
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.slots);
    const one = await d.printOptions('cube.gcode');
    assert.deepEqual(one.colors, [{ index: 0, color: [255, 16, 16], material: 'PLA', grams: 12.5, slot: 0 }]);
    assert.deepEqual(planFilamentUse(one.colors, null, true), [{ slot: 0, grams: 12.5 }]); // what the job log charges

    // A multi-color file gets a tray per color, no per-color weights. PLA goes to
    // the closer PLA tray; with no PETG loaded, PETG goes to the closest color.
    const two = await d.printOptions('old.gcode');
    assert.deepEqual(two.colors.map((c) => [c.index, c.material, c.slot, c.grams]), [[0, 'PETG', 2, 0], [1, 'PLA', 2, 0]]);

    // The user's choice (the tray in use counts as loaded) goes to the printer.
    await d.startPrint('cube.gcode', { mapping: { 0: 2 } });
    assert.deepEqual(fake.p.requests.find((r) => r.method === 1020).params.config.slot_map, [{ t: 0, canvas_id: 0, tray_id: 2 }]);
    // An empty tray is refused rather than letting the printer fall back to tray 0.
    await assert.rejects(d.startPrint('cube.gcode', { mapping: { 0: 1 } }), /loaded CANVAS tray/);
  });
});

// Second review 1: with CANVAS attached, a file whose colors aren't known isn't
// started blind (an empty slot_map lets the printer pick any tray).
test('Elegoo CC2: with CANVAS, a file with no known colors is refused', async () => {
  const fake = await fakeCentauri();
  fake.p.files.push({ filename: 'nocolors.gcode', size: 5, create_time: 0, layer: 10, type: 'file', total_filament_used: 3 });
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.slots);
    assert.deepEqual((await d.printOptions('nocolors.gcode')).colors, []);
    await assert.rejects(d.startPrint('nocolors.gcode'), /doesn’t report which colors nocolors\.gcode uses/);
    await assert.rejects(d.startPrint('not-on-printer.gcode'), /doesn’t report which colors/);
    assert.equal(fake.p.requests.filter((r) => r.method === 1020).length, 0);
  });
});

// Second review 4: a color's index is its tool number t, which is also the
// filament number the hub's library uses for per-color grams.
test('Elegoo CC2: color index is the tool number t', async () => {
  const fake = await fakeCentauri();
  fake.p.files.push({ filename: 'second-filament.gcode', size: 5, create_time: 0, layer: 10, type: 'file', color_map: [{ color: '#FFFFFF', name: 'PLA', t: 1 }], total_filament_used: 4 });
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.slots);
    const { colors } = await d.printOptions('second-filament.gcode');
    assert.deepEqual(colors.map((c) => [c.index, c.slot]), [[1, 2]]);
    await d.startPrint('second-filament.gcode');
    assert.deepEqual(fake.p.requests.find((r) => r.method === 1020).params.config.slot_map, [{ t: 1, canvas_id: 0, tray_id: 2 }]);
  });
});

// Second review 2: tray deltas don't pile up tray reads in the queue.
test('Elegoo CC2: bursts of CANVAS deltas share one tray read', async () => {
  const fake = await fakeCentauri();
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.slots);
    await new Promise((r) => setTimeout(r, 30));
    d.gapMs = 50;
    const reads = () => fake.p.requests.filter((r) => r.method === 2005).length;
    const before = reads();
    for (let i = 0; i < 10; i++) fake.p.push({ canvas_info: { active_tray_id: i % 4 } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reads() - before, 1);
    assert.equal(d.slotsRead, null); // and a later delta can read again
  });
});

// Second review 3: the dashboard hides Pause while heating for this printer.
test('Elegoo CC2: says it can’t pause while heating', () => {
  const d = new ElegooDriver({ id: 'x', type: 'elegoo', host: '127.0.0.1' });
  assert.equal(d.state.capabilities.pauseWhileHeating, false);
});

test('Elegoo CC2: without a CANVAS unit nothing is mapped', async () => {
  const fake = await fakeCentauri();
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.online);
    d.slots = null;
    assert.deepEqual((await d.printOptions('cube.gcode')).colors, []);
    await d.startPrint('cube.gcode');
    assert.deepEqual(fake.p.requests.find((r) => r.method === 1020).params.config.slot_map, []);
  });
});

// Review 2: no throw from the ping timer, and one ping timer however often the printer answers.
test('Elegoo CC2: ping never throws, and a repeated register_response keeps one timer', async () => {
  const fake = await fakeCentauri();
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.online && x.firmware);
    const timer = d.pingTimer;
    const client = fake.p.clients[0];
    client.deliver(client.registerTopic, { client_id: d.clientId, error: 'ok' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(d.pingTimer, timer);
    assert.equal(fake.p.requests.filter((r) => r.method === 1001).length, 1);

    client.connected = false; // e.g. mid-reconnect
    assert.doesNotThrow(() => d.ping());
    d.client = null;
    assert.doesNotThrow(() => d.ping());
  });
});

// Review 3: a crafted status push can't reach Object.prototype.
test('Elegoo CC2: status merging ignores __proto__, constructor and prototype', async () => {
  const evil = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"led":{"status":0}}');
  const into = deepMerge({ led: { status: 1 } }, evil);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(into, { led: { status: 0 } });

  const fake = await fakeCentauri();
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.online);
    for (const c of fake.p.clients) c.deliver(`elegoo/${SN}/api_status`, JSON.parse(`{"id":900,"method":6000,"result":{"__proto__":{"polluted":2},"led":{"status":0}}}`));
    await waitFor(d, (x) => x.light === false);
    assert.equal({}.polluted, undefined);
  });
});

// Review 4: stop and pause jump the queue, go at QoS 1, and a silent printer is an error.
test('Elegoo CC2: cancel skips queued requests and is not confirmed when nothing happens', async () => {
  const fake = await fakeCentauri();
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.online && x.slots);
    d.gapMs = 150;
    const listed = () => fake.p.requests.filter((r) => r.method === 1044).length;
    const before = listed();
    const queued = [d.send(1044, { offset: 0, limit: 1 }), d.send(1044, { offset: 1, limit: 1 }), d.send(1044, { offset: 2, limit: 1 })];
    await d.cancel();
    assert.ok(listed() - before <= 1, 'cancel waited behind queued requests');
    assert.equal(fake.p.requests.find((r) => r.method === 1022).qos, 1);
    await Promise.all(queued);
  });

  const printing = (fakeP) => Object.assign(fakeP.status.machine_status, { status: 2, sub_status: 2075 });
  const mute = await fakeCentauri({ silent: [1021, 1022] });
  printing(mute.p);
  await withDriver(mute, {}, async (d) => {
    await waitFor(d, (x) => x.status === 'printing' && x.slots);
    await assert.rejects(d.cancel(), /didn’t confirm the cancel/);
    await assert.rejects(d.pause(), /didn’t confirm the pause/);
  }, { confirmMs: 100 });

  // A printer that doesn't answer but does change state has confirmed it.
  const late = await fakeCentauri({ silent: [1021] });
  printing(late.p);
  await withDriver(late, {}, async (d) => {
    await waitFor(d, (x) => x.status === 'printing' && x.slots);
    const p = d.pause();
    late.p.push({ machine_status: { status: 2, sub_status: 2502 }, print_status: { filename: 'cube.gcode' } });
    await p;
  }, { confirmMs: 1000 });
});

// Found on a real CC2 (02.01.01.07): a pause while preheating is held and
// carried out minutes later, so it's refused; uploads need the access code.
test('Elegoo CC2: no pause while heating, and an upload with a wrong code is explained', async () => {
  const fake = await fakeCentauri({ code: 'right' });
  Object.assign(fake.p.status.machine_status, { status: 2, sub_status: 1405 });
  fake.p.status.print_status.filename = 'cube.gcode';
  await withDriver(fake, { accessCode: 'right' }, async (d) => {
    await waitFor(d, (x) => x.status === 'heating');
    await assert.rejects(d.pause(), /heats up/);
    assert.equal(fake.p.requests.filter((r) => r.method === 1021).length, 0);
    await d.cancel(); // cancel still works while heating
  });

  const fake2 = await fakeCentauri({ code: 'right' });
  await withDriver(fake2, { accessCode: 'right' }, async (d) => {
    await waitFor(d, (x) => x.online);
    d.cfg.accessCode = 'changed-on-the-printer';
    await assert.rejects(d.upload('a.gcode', Buffer.from('G28\n')), /refused the access code/);
  });
});

// Review 5: slicing works without picking a profile first.
test('Elegoo CC2: has a default slicer profile', () => {
  assert.deepEqual(ElegooDriver.meta.slicer, { vendor: 'Elegoo', machine: 'Elegoo Centauri Carbon 2 0.4 nozzle' });
});

// Review (smaller): a failed layer lookup is asked once, not on every update.
test('Elegoo CC2: a failed total-layer lookup is not retried', async () => {
  const fake = await fakeCentauri();
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.online);
    for (let i = 0; i < 5; i++) fake.p.push({ machine_status: { status: 2, sub_status: 2075, progress: i }, print_status: { filename: 'gone.gcode', current_layer: i } });
    await waitFor(d, (x) => x.job?.layer === 4);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fake.p.requests.filter((r) => r.method === 1046).length, 1);
    assert.equal(d.state.job.totalLayers, 0);
  });
});

// Found while checking review 1: a tray delta re-reads the trays instead of shrinking the list.
test('Elegoo CC2: a CANVAS delta refreshes the whole tray list', async () => {
  const fake = await fakeCentauri();
  await withDriver(fake, {}, async (d) => {
    await waitFor(d, (x) => x.slots);
    const before = fake.p.requests.filter((r) => r.method === 2005).length;
    fake.p.push({ canvas_info: { canvas_list: [{ canvas_id: 0, tray_list: [{ tray_id: 1, status: 1 }] }] } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fake.p.requests.filter((r) => r.method === 2005).length, before + 1);
    assert.equal(d.state.slots.length, 3);
    assert.equal(d.status.canvas_info, undefined);
  });
});
