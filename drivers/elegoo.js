// Elegoo Centauri Carbon 2 in LAN Only mode.
//
// The printer runs its own MQTT 3.1.1 broker on port 1883 (user "elegoo",
// password = the access code on its screen). A client registers on
// elegoo/<sn>/api_register, then sends {id, method, params} requests to
// elegoo/<sn>/<client>/api_request and reads replies on .../api_response.
// Status arrives as partial deltas on elegoo/<sn>/api_status, merged into the
// last full snapshot (method 1002). Uploads are chunked HTTP PUTs on port 80.
// Protocol references: https://github.com/bjan/pycentauri (docs/PROTOCOL.md),
// https://github.com/dnviti/ha-generic-3dprinter-controller
// (docs/protocol-elegoo-cc2.md), https://github.com/runnane/elegoo-web.
const crypto = require('node:crypto');
const mqtt = require('mqtt');
const { PrinterDriver, baseUrl, HOST_FIELD, CAMERA_FIELD } = require('./base');

const METHOD = {
  ATTRIBUTES: 1001,
  STATUS: 1002,
  START: 1020,
  PAUSE: 1021,
  STOP: 1022,
  RESUME: 1023,
  HOME: 1026,
  MOVE: 1027,
  TEMP: 1028,
  LIGHT: 1029,
  FAN: 1030,
  SPEED: 1031,
  FILES: 1044,
  FILE_DETAIL: 1046,
  CANVAS: 2005,
  PUSH_STATUS: 6000,
  PUSH_ATTRIBUTES: 6008,
};

// machine_status.status (from the official app's names, via elegoo-web).
const BUSY = {
  0: 'Initializing', 3: 'Loading filament', 4: 'Unloading filament', 5: 'Auto-leveling',
  6: 'PID calibrating', 7: 'Resonance testing', 8: 'Self check', 9: 'Updating firmware',
  10: 'Homing', 11: 'Transferring file', 12: 'Creating timelapse', 13: 'Extruder operating',
  15: 'Power loss recovery',
};
// machine_status.sub_status while status is 2 (printing).
const SUB = {
  1045: 'heating', 1405: 'heating', 1133: 'heating',
  2401: 'printing', 2501: 'pausing', 2502: 'paused', 2503: 'cancelling', 2504: 'idle', 2505: 'paused',
  2077: 'completed',
};
// Exceptions that stop the printer (machine_status.exception_status entries).
const EXCEPTIONS = {
  101: 'Bed heating failed', 103: 'Nozzle heating failed', 107: 'Toolhead overheating protection',
  108: 'Bed overheating protection', 109: 'Filament runout', 304: 'Z homing failed', 704: 'Leveling failed',
  801: 'Mainboard–extruder communication error', 803: 'Critical system error', 1210: 'CANVAS communication error',
  1211: 'CANVAS filament runout', 1301: 'Spaghetti detected', 1302: 'Print defect detected',
};
const CRITICAL = new Set([101, 102, 103, 104, 105, 106, 107, 108, 801, 803, 902, 903, 1103, 1104, 1105, 1106, 1210]);
// Command error_code values.
const ERRORS = {
  1000: 'access code refused', 1001: 'unknown command', 1003: 'invalid parameter', 1009: 'printer is busy',
  1010: 'not printing', 1012: 'task not found', 1014: 'invalid G-code file', 1021: 'file not found',
};

const SPEED_MODES = [{ value: 0, label: 'Silent' }, { value: 1, label: 'Balanced' }, { value: 2, label: 'Sport' }, { value: 3, label: 'Ludicrous' }];
const PING_MS = 30000; // the printer drops quiet registrations after ~6 minutes
const GAP_MS = 2000; // 3+ requests in quick succession trigger a cooldown that drops replies
const CHUNK = 1024 * 1024;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// JSON.parse gives "__proto__" an own key; merging it would reach Object.prototype.
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
function deepMerge(into, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (UNSAFE.has(k)) continue;
    if (isObj(v) && isObj(into[k])) deepMerge(into[k], v);
    else into[k] = v;
  }
  return into;
}

// "#FF8800" / "FF8800" -> [255, 136, 0]
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex || ''));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

// The hub numbers slots canvas_id * 4 + tray_id (tray_id 0-3 per unit); the
// printer takes canvas_id and tray_id separately. Tray status: 0 empty,
// 1 loaded, 2 loaded and in use.
const TRAYS = 4;
function slotsFrom(canvas) {
  return (canvas?.canvas_list || []).flatMap((c) => (c.tray_list || []).map((t) => ({
    index: (c.canvas_id || 0) * TRAYS + (t.tray_id || 0),
    color: rgb(t.filament_color),
    type: t.filament_type || '',
    ready: t.status === 1 || t.status === 2,
  })));
}
const trayOf = (index) => ({ canvas_id: Math.floor(index / TRAYS), tray_id: index % TRAYS });

// A string on older firmware; on 02.01.01.07 an object such as
// { mcu_version: '00.00.00.00', ota_version: '02.01.01.07', soc_version: '' }.
function firmwareOf(v) {
  if (isObj(v)) return v.ota_version || v.soc_version || null;
  return v || null;
}

function mapStatus(s) {
  const ms = s.machine_status || {};
  const exc = (ms.exception_status || []).find((c) => CRITICAL.has(c));
  if (exc != null || ms.status === 14) return { status: 'error', error: EXCEPTIONS[exc] || (exc != null ? `Printer error ${exc}` : 'Emergency stop') };
  const ps = String(s.print_status?.state || '').toLowerCase();
  if (ms.status === 2) return { status: SUB[ms.sub_status] || 'printing' };
  if (ms.status === 1 || ms.status == null) {
    if (ms.sub_status === 2077 || ['complete', 'completed', 'finished'].includes(ps)) return { status: 'completed' };
    return { status: 'idle' };
  }
  return { status: 'busy', stage: BUSY[ms.status] || null };
}

class ElegooDriver extends PrinterDriver {
  static meta = {
    label: 'Elegoo Centauri Carbon 2 (LAN Only mode)',
    help: 'Stock firmware with LAN Only Mode on (Settings → Network). The printer allows two LAN connections at a time, so the hub uses one of them.',
    slicer: { vendor: 'Elegoo', machine: 'Elegoo Centauri Carbon 2 0.4 nozzle' },
    fields: [
      { ...HOST_FIELD, help: 'The printer’s IP address.' },
      { key: 'accessCode', label: 'Access code', type: 'password', help: 'Shown on the printer under Settings → Network. Leave empty if none is set; the hub then uses 123456, like Elegoo’s own software.' },
      { ...CAMERA_FIELD, help: 'Defaults to the printer’s camera on port 8080.' },
    ],
  };

  constructor(cfg, opts = {}) {
    super(cfg, opts);
    this.http = baseUrl(cfg.host, 80);
    this.mqttHost = new URL(this.http).hostname;
    this.mqttPort = Number(cfg.mqttPort) || 1883;
    this.connectMqtt = opts.connect || mqtt.connect; // tests pass a fake
    this.gapMs = opts.gapMs ?? GAP_MS;
    this.pingMs = opts.pingMs ?? PING_MS;
    this.confirmMs = opts.confirmMs ?? 15000;
    this.status = {};
    this.attrs = {};
    this.slots = null;
    this.totalLayers = new Map(); // file -> layer count
    this.pending = new Map(); // request id -> { resolve, reject, timer }
    this.queue = Promise.resolve();
    this.nextId = 1;
    this.limits = { nozzle: 300, bed: 110, jog: 100 };
    this.state.capabilities = {
      pause: true, resume: true, cancel: true, light: true, files: true,
      pauseWhileHeating: false, // see pause()
      control: { jog: true, home: true, motorsOff: false, temps: ['nozzle', 'bed'], fans: ['part'], speed: 'mode', limits: this.limits },
    };
  }

  // Elegoo's SDK and slicer use 123456 when the printer has no access code set.
  get password() { return this.cfg.accessCode || '123456'; }

  async start() {
    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.teardown();
  }

  teardown() {
    this.registered = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.snTimer);
    clearTimeout(this.registerTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); }
    this.pending.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      client.on('error', () => {});
      client.end(true);
    }
  }

  retry(err, ms = 10000) {
    this.teardown();
    this.setOffline(err);
    if (!this.stopped) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), ms);
    }
  }

  // The serial number is in every topic. The printer reports it over HTTP;
  // older firmware without that endpoint is handled by learning it from the
  // first topic the broker shows us.
  async serial() {
    if (this.sn) return this.sn;
    try {
      const res = await fetch(`${this.http}/system/info?X-Token=${encodeURIComponent(this.password)}`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 401) throw new Error('The printer refused the access code');
      const body = await res.json();
      if (body.system_info?.sn) this.sn = body.system_info.sn;
    } catch (err) {
      if (/refused/.test(err.message)) throw err;
    }
    return this.sn || null;
  }

  async connect() {
    if (this.stopped) return;
    let sn;
    try {
      sn = await this.serial();
    } catch (err) {
      return this.retry(err, 30000);
    }
    if (this.stopped) return;
    this.clientId = `1_PC_${crypto.randomInt(1e9, 1e12)}`;
    this.requestId = crypto.randomBytes(8).toString('hex');
    const client = this.connectMqtt({
      host: this.mqttHost,
      port: this.mqttPort,
      protocol: 'mqtt',
      protocolVersion: 4,
      username: 'elegoo',
      password: this.password,
      clientId: this.clientId,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 0, // reconnect here instead, so we register again
      connectTimeout: 10000,
    });
    this.client = client;
    const lost = (err) => {
      if (this.client !== client) return; // error + close both fire
      const refused = err && /not authorized|bad user name or password/i.test(err.message);
      this.retry(refused ? new Error('The printer refused the access code') : err || new Error('Connection lost'));
    };
    client.on('error', lost);
    client.on('close', () => lost());
    client.on('message', (topic, payload) => this.onMessage(topic, payload));
    client.on('connect', () => {
      if (sn) return this.register();
      // No serial yet: watch the printer's topics until one shows it.
      client.subscribe('elegoo/+/api_status');
      this.snTimer = setTimeout(() => lost(new Error('The printer didn’t report its serial number. Is LAN Only mode on?')), 15000);
    });
  }

  register() {
    clearTimeout(this.snTimer);
    const sn = this.sn;
    const t = `elegoo/${sn}`;
    this.client.subscribe([`${t}/${this.requestId}/register_response`, `${t}/${this.clientId}/api_response`, `${t}/api_status`]);
    this.client.publish(`${t}/api_register`, JSON.stringify({ client_id: this.clientId, request_id: this.requestId }), { qos: 1 });
    this.registerTimer = setTimeout(() => {
      this.retry(new Error('The printer accepted the connection but didn’t answer. Turn on LAN Only mode on the printer.'));
    }, 10000);
  }

  async onRegistered() {
    clearTimeout(this.registerTimer);
    if (this.registered) return; // a repeated register_response
    this.registered = true;
    clearInterval(this.pingTimer);
    this.missed = 0;
    this.pingTimer = setInterval(() => this.ping(), this.pingMs);
    try {
      this.attrs = await this.send(METHOD.ATTRIBUTES);
      this.applyFull(await this.send(METHOD.STATUS));
      this.refreshSlots().catch(() => {});
    } catch (err) {
      this.retry(err);
    }
  }

  // Runs from a timer, so it must never throw: an uncaught error would stop the hub.
  ping() {
    if (this.missed >= 2) return this.retry(new Error('The printer stopped answering'));
    this.missed++;
    try { this.publishRequest({ type: 'PING' }); } catch { return; }
    // A full snapshot now and then guards against missed deltas; trays change
    // during multi-color prints.
    this.send(METHOD.STATUS).then((r) => this.applyFull(r)).catch(() => {});
    if (this.slots && ['printing', 'paused'].includes(this.state.status)) this.refreshSlots().catch(() => {});
  }

  publishRequest(body, qos = 0) {
    if (!this.client?.connected) throw new Error('Printer not connected');
    this.client.publish(`elegoo/${this.sn}/${this.clientId}/api_request`, JSON.stringify(body), { qos });
  }

  // Sends a request and resolves with its result. Requests are spaced out
  // (see GAP_MS); `urgent` ones (stop, pause...) skip the line and go at QoS 1.
  send(method, params = {}, { timeoutMs = 10000, urgent = false } = {}) {
    const run = () => new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Printer did not respond')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.publishRequest({ id, method, params }, urgent ? 1 : 0); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
    if (urgent) return run();
    const p = this.queue.then(run);
    // The next request waits for this one to be sent plus the gap, not for its answer.
    this.queue = this.queue.then(() => new Promise((r) => setTimeout(r, this.gapMs)));
    return p;
  }

  // A command that changes what the printer is doing. The printer only answers
  // pause/resume/stop once they've finished, so either its answer or a status
  // matching `done` counts as confirmation; neither within confirmMs is an error,
  // never a silent success. A refusal fails at once.
  command(method, params, done, what, { confirmMs = this.confirmMs } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('update', onUpdate);
        fn(v);
      };
      const onUpdate = (s) => { if (done(s)) finish(resolve); };
      const timer = setTimeout(() => finish(reject, new Error(`The printer didn’t confirm the ${what}. Check the printer.`)), confirmMs);
      this.on('update', onUpdate);
      this.send(method, params, { urgent: true, timeoutMs: confirmMs + 1000 })
        .then(() => finish(resolve), (err) => { if (!/did not respond/.test(err.message)) finish(reject, err); });
    });
  }

  onMessage(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (!this.sn) {
      const m = /^elegoo\/([^/]+)\/api_status$/.exec(topic);
      if (m) { this.sn = m[1]; this.client.unsubscribe('elegoo/+/api_status'); this.register(); }
      return;
    }
    if (topic.endsWith('/register_response')) {
      if (msg.error === 'ok' || msg.error === 'already registered') return this.onRegistered();
      clearTimeout(this.registerTimer);
      const full = msg.code === 3 || /too many/i.test(String(msg.error));
      return this.retry(new Error(full ? 'The printer already has two LAN connections (Elegoo app or slicer). Close one, and the hub reconnects.' : `Printer refused the connection: ${msg.error}`), 30000);
    }
    if (msg.type === 'PONG') { this.missed = 0; return; }
    if (msg.method === METHOD.PUSH_STATUS) return this.applyDelta(msg.result || msg.params || {}, msg.id);
    if (msg.method === METHOD.PUSH_ATTRIBUTES) { this.attrs = { ...this.attrs, ...(msg.result || {}) }; return this.render(); }
    const p = this.pending.get(msg.id);
    if (!p || p.method !== msg.method) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    const r = msg.result || {};
    if (r.error_code) p.reject(new Error(`Printer refused the command: ${ERRORS[r.error_code] || `error ${r.error_code}`}`));
    else p.resolve(r);
  }

  applyFull(result) {
    if (!result || !isObj(result)) return;
    const { error_code: _, ...status } = result;
    this.status = status;
    this.render();
  }

  applyDelta(delta, seq) {
    // A jump in the push sequence means we missed updates: fetch everything.
    if (seq != null && this.lastSeq != null && seq - this.lastSeq > 5) {
      this.send(METHOD.STATUS).then((r) => this.applyFull(r)).catch(() => {});
    }
    if (seq != null) this.lastSeq = seq;
    // A tray delta would replace the whole tray list with the one that changed,
    // so read the trays again instead of merging it.
    if (isObj(delta) && 'canvas_info' in delta) {
      const { canvas_info: _, ...rest } = delta;
      delta = rest;
      this.refreshSlots().catch(() => {});
    }
    deepMerge(this.status, delta); // arrays (exception_status) are replaced whole
    this.render();
  }

  // Total layers aren't in the status; the file detail has them. Asked once per
  // file: a failed lookup stays at 0 rather than retrying all print long.
  layersFor(file) {
    if (!file || this.totalLayers.has(file)) return this.totalLayers.get(file) || 0;
    this.totalLayers.set(file, 0);
    this.send(METHOD.FILE_DETAIL, { storage_media: 'local', filename: file })
      .then((r) => { this.totalLayers.set(file, r.total_layer || r.layer || 0); this.render(); })
      .catch(() => {});
    return 0;
  }

  render() {
    const s = this.status;
    const ps = s.print_status || {};
    const file = ps.filename || '';
    let { status, error, stage } = mapStatus(s);
    // Leveling, homing etc. with a file loaded is the start of a print.
    if (status === 'busy' && file && stage) status = 'preparing';
    const ext = s.extruder || {};
    const bed = s.heater_bed || {};
    const pct = (f) => (f?.speed != null ? Math.round((f.speed / 255) * 100) : null);
    const active = ['printing', 'pausing', 'paused', 'cancelling', 'heating', 'completed'].includes(status) && file;
    this.update({
      online: true,
      status,
      error: error || null,
      model: this.attrs.machine_model || 'Centauri Carbon 2',
      firmware: firmwareOf(this.attrs.software_version),
      camera: this.cameraUrl() ? 'mjpeg' : null,
      light: s.led ? s.led.status === 1 : null,
      temps: {
        nozzle: { cur: ext.temperature ?? 0, target: ext.target ?? 0 },
        bed: { cur: bed.temperature ?? 0, target: bed.target ?? 0 },
        ...(s.ztemperature_sensor ? { chamber: { cur: s.ztemperature_sensor.temperature ?? 0, target: 0 } } : {}),
      },
      fans: {
        part: pct(s.fans?.fan),
        ...(s.fans?.aux_fan ? { aux: pct(s.fans.aux_fan) } : {}),
        ...(s.fans?.box_fan ? { chamber: pct(s.fans.box_fan) } : {}),
      },
      // Pushes report the current move's speed factor, not the chosen mode, so
      // show the mode the hub last set when there is one.
      speed: ['printing', 'pausing', 'paused'].includes(status)
        ? { kind: 'mode', value: this.speedMode ?? s.gcode_move?.speed_mode ?? 1, options: SPEED_MODES }
        : null,
      slots: this.slots,
      job: active ? {
        file,
        progress: s.machine_status?.progress ?? 0,
        layer: ps.current_layer || 0,
        totalLayers: ps.total_layer || this.layersFor(file),
        elapsed: ps.print_duration ?? null,
        remaining: ps.remaining_time_sec ?? null,
        thumb: false,
      } : status === 'preparing' ? { file, progress: 0, layer: 0, totalLayers: 0, elapsed: null, remaining: null, stage, thumb: false } : null,
    });
    if (status !== 'printing' && status !== 'paused' && status !== 'pausing') this.speedMode = null;
  }

  // One tray read at a time: tray deltas can come often, and each queued read
  // would hold back other requests by GAP_MS.
  refreshSlots() {
    if (this.slotsRead) return this.slotsRead;
    this.slotsRead = (async () => {
      try {
        const r = await this.send(METHOD.CANVAS);
        const slots = slotsFrom(r.canvas_info);
        this.slots = slots.length ? slots : null;
        this.render();
        return this.slots;
      } finally {
        this.slotsRead = null;
      }
    })();
    return this.slotsRead;
  }

  async pause() {
    // Seen on 02.01.01.07: a pause sent while preheating isn't answered, and the
    // printer carries it out minutes later. Refuse it rather than leave one pending.
    if (this.state.status === 'heating') throw new Error('The printer can’t pause while it heats up for a print. Pause once it’s printing, or cancel.');
    await this.command(METHOD.PAUSE, {}, (s) => ['pausing', 'paused'].includes(s.status), 'pause');
  }
  async resume() { await this.command(METHOD.RESUME, {}, (s) => ['printing', 'heating'].includes(s.status), 'resume'); }
  async cancel() { await this.command(METHOD.STOP, {}, (s) => ['cancelling', 'idle'].includes(s.status), 'cancel'); }

  async setLight(on) {
    await this.send(METHOD.LIGHT, { power: on ? 1 : 0 });
    deepMerge(this.status, { led: { status: on ? 1 : 0 } });
    this.render();
  }

  async control(raw) {
    const cmd = this.validateControl(raw);
    switch (cmd.action) {
      case 'jog': return this.send(METHOD.MOVE, { axes: cmd.axis, distance: cmd.distance });
      case 'home': return this.command(METHOD.HOME, { homed_axes: cmd.axes }, (s) => s.status === 'busy', 'homing');
      case 'temp': return this.send(METHOD.TEMP, cmd.heater === 'nozzle' ? { extruder: cmd.target } : { heater_bed: cmd.target });
      case 'fan': return this.send(METHOD.FAN, { fan: Math.round((cmd.pct / 100) * 255) });
      case 'speed': {
        const mode = Number(cmd.value);
        if (!SPEED_MODES.some((m) => m.value === mode)) throw new Error('Unknown speed mode');
        await this.send(METHOD.SPEED, { mode });
        this.speedMode = mode;
        return this.render();
      }
      default: throw new Error('Unsupported');
    }
  }

  async listFiles() {
    const files = [];
    for (let offset = 0; offset < 2000;) {
      const r = await this.send(METHOD.FILES, { storage_media: 'local', offset, limit: 100 });
      const page = (r.file_list || []).filter((f) => f.type !== 'folder' && f.type !== 'dir');
      files.push(...page);
      for (const f of page) if (f.layer) this.totalLayers.set(f.filename, f.layer);
      offset += (r.file_list || []).length;
      if (!r.file_list?.length || offset >= (r.total ?? 0)) break;
    }
    this.fileRecords = new Map(files.map((f) => [f.filename, f]));
    return files
      .sort((a, b) => (b.create_time || 0) - (a.create_time || 0))
      .map((f) => ({ name: f.filename, size: f.size || null }));
  }

  async fileRecord(filename) {
    if (!this.fileRecords?.has(filename)) await this.listFiles();
    return this.fileRecords.get(filename) || null;
  }

  // Colors a file uses (its color_map, by G-code tool number "t") and the
  // CANVAS tray suggested for each: same material, closest color. Per-color
  // weights aren't reported, so a one-color file gets the file's total grams
  // and a multi-color one none (the job log then can't split the total).
  // Without a CANVAS unit there's nothing to map.
  async printOptions(filename) {
    const slots = this.slots || [];
    if (!slots.length) return { colors: [], slots: [], options: [] };
    const rec = await this.fileRecord(filename);
    const map = rec?.color_map || [];
    const ready = slots.filter((s) => s.ready);
    const base = (t) => String(t || '').split(/\s+/)[0].toUpperCase();
    const dist = (a, b) => a.reduce((n, v, i) => n + (v - (b[i] ?? 0)) ** 2, 0);
    const colors = map.map((c) => {
      const color = rgb(c.color);
      const same = ready.filter((s) => base(s.type) === base(c.name));
      const best = (same.length ? same : ready).slice().sort((a, b) => dist(a.color, color) - dist(b.color, color))[0];
      return { index: c.t ?? 0, color, material: c.name || '', grams: map.length === 1 ? rec.total_filament_used || 0 : 0, slot: best ? best.index : null };
    });
    return { colors, slots, options: [] };
  }

  // The hub sends its own tray choice as slot_map, so the roll it charges is
  // the one the printer feeds from. The printer prints from tray 0 when an
  // entry is missing or out of range, so every color must map to a loaded tray.
  async startPrint(filename, { mapping } = {}) {
    const opts = await this.printOptions(filename);
    // With CANVAS attached, an empty slot_map would print from whatever tray
    // the printer picks, possibly the wrong color, so don't start blind.
    if (opts.slots.length && !opts.colors.length) {
      throw new Error(`The printer doesn’t report which colors ${filename} uses, so the hub can’t choose a CANVAS tray for it. Start it on the printer’s screen instead.`);
    }
    const slotMap = opts.colors.map((c) => {
      const chosen = mapping && mapping[c.index] != null ? Number(mapping[c.index]) : c.slot;
      const slot = opts.slots.find((s) => s.index === chosen && s.ready);
      if (!slot) throw new Error(`Pick a loaded CANVAS tray for color ${c.index + 1}`);
      return { t: c.index, ...trayOf(slot.index) };
    });
    // printer_check persists to the next job that omits it, so always send it.
    await this.command(METHOD.START, {
      storage_media: 'local',
      filename,
      config: { printer_check: true, slot_map: slotMap },
    }, (s) => !['idle', 'completed', 'offline', 'error'].includes(s.status), 'print start', { confirmMs: Math.max(this.confirmMs, 20000) });
  }

  // Raw body in 1 MiB chunks over one kept-alive connection. Chunks aren't
  // retried: a resent chunk corrupts the file on the printer.
  async upload(filename, data) {
    if (!/\.gcode$/i.test(filename)) throw new Error('The Centauri Carbon 2 prints .gcode files');
    if (!['idle', 'completed'].includes(this.state.status)) throw new Error('Printer must be idle to receive files');
    const md5 = crypto.createHash('md5').update(data).digest('hex');
    for (let start = 0; start < data.length || start === 0; start += CHUNK) {
      const end = Math.min(start + CHUNK, data.length);
      const res = await fetch(`${this.http}/upload`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${Math.max(end - 1, 0)}/${data.length}`,
          'X-File-Name': filename,
          'X-File-MD5': md5,
          'X-Token': this.password,
        },
        body: data.subarray(start, end),
        signal: AbortSignal.timeout(60000),
      });
      // Uploads check the access code (a wrong or missing X-Token is HTTP 401).
      if (res.status === 401) throw new Error('The printer refused the access code for the upload');
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error_code) throw new Error(`Printer rejected the upload (${body.error_code ? `error ${body.error_code}` : `HTTP ${res.status}`})`);
      if (end >= data.length) break;
    }
    this.fileRecords = null; // list again on next use
  }

  cameraUrl() {
    if (this.cfg.cameraUrl === false) return null;
    return this.cfg.cameraUrl || `http://${this.mqttHost}:8080/?action=stream`;
  }

  cameraSource() {
    const url = this.cameraUrl();
    return url ? { url } : null;
  }
}

module.exports = { ElegooDriver, mapStatus, slotsFrom, deepMerge };
