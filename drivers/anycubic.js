// Anycubic Kobra X / Kobra 3 / S1 family in stock-firmware LAN Mode.
//
// Handshake: GET http://<host>:18910/info, then a signed POST to the returned
// ctrlInfoUrl; the AES-CBC encrypted reply holds MQTT credentials and a client
// certificate. Status and commands then go over MQTT/TLS (port 9883).
// Protocol reference: https://github.com/rvanderp3/kobra-connect
const crypto = require('node:crypto');
const mqtt = require('mqtt');
const { PrinterDriver, HOST_FIELD, CAMERA_FIELD } = require('./base');
const { postMultipart } = require('../lib/multipart');
const { matcherFor } = require('../lib/compat');

const PREFIX = 'anycubic/anycubicCloud/v1';
const PAUSE = { PRINTING: 0, PAUSED: 1, PAUSING: 2, RESUMING: 3, STOPPING: 4 };

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const randStr = (n, chars) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');

async function getJson(method, url) {
  const res = await fetch(url, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function handshake(host) {
  const info = await getJson('GET', `http://${host}:18910/info`);
  if (info.ctrlType === 'cloud') throw new Error('Printer is in cloud mode — enable LAN Mode on the printer');
  const { token, ctrlInfoUrl, modelId } = info;
  if (!token || !ctrlInfoUrl || !modelId) throw new Error('Printer does not support the LAN Mode handshake');

  const ts = Date.now();
  const nonce = randStr(6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  const did = randStr(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const sign = md5(md5(token.slice(0, 16)) + ts + nonce);
  const qs = new URLSearchParams({ ts, nonce, sign, did });
  const ctrl = await getJson('POST', `${ctrlInfoUrl}?${qs}`);
  if (ctrl.code !== 200) throw new Error(`LAN handshake failed: ${ctrl.message || ctrl.code}`);

  const iv = Buffer.alloc(16);
  Buffer.from(ctrl.data.token).copy(iv, 0, 0, 16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(token.slice(16, 32)), iv);
  const plain = Buffer.concat([decipher.update(Buffer.from(ctrl.data.info, 'base64')), decipher.final()]);
  const data = JSON.parse(plain.toString('utf8'));

  const m = /mqtts?:\/\/([^:]+):(\d+)/.exec(data.broker);
  if (!m) throw new Error(`Unexpected broker URL: ${data.broker}`);
  return {
    brokerHost: m[1],
    brokerPort: +m[2],
    username: data.username,
    password: data.password,
    deviceId: data.deviceId,
    modelId: String(modelId),
    cert: data.devicecrt,
    key: data.devicepk,
    modelName: info.modelName || null,
  };
}

const SPEED_MODES = [{ value: 1, label: 'Silent' }, { value: 2, label: 'Standard' }, { value: 3, label: 'Sport' }];

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));

function slotsFrom(boxes) {
  return boxes.flatMap((b, bi) => (b.slots || []).map((s) => ({
    index: bi * 4 + s.index,
    color: (s.color || [0, 0, 0]).slice(0, 3),
    type: s.type || '',
    ready: s.status === 5,
    percent: s.consumables_percent ?? null,
  })));
}

function mapStatus(infoState, project) {
  const ps = project?.state?.toLowerCase();
  if (ps === 'printing') {
    if (project.pause === PAUSE.PAUSED) return 'paused';
    if (project.pause === PAUSE.PAUSING) return 'pausing';
    if (project.pause === PAUSE.STOPPING) return 'cancelling';
    return 'printing';
  }
  if (ps === 'paused') return 'paused';
  if (ps === 'finish' || ps === 'finished' || ps === 'complete') return 'completed';
  if (ps === 'preheating' || ps === 'heating') return 'heating';
  const s = (infoState || '').toLowerCase();
  if (s === 'free' || s === 'idle' || s === 'ready') return 'idle';
  if (s === 'printing') return 'printing';
  if (s === 'error') return 'error';
  return s ? 'busy' : 'idle';
}

const ENDED = new Set(['finish', 'finished', 'complete', 'failed', 'stoped', 'stopped', 'canceled', 'cancelled']);
const STAGES = { downloading: 'Downloading file', checking: 'Checking file', auto_leveling: 'Auto-leveling', leveling: 'Auto-leveling' };

// What the printer says it's doing before the first layer, e.g. "auto_leveling"
// -> "Auto-leveling"; null for generic states.
function stageLabel(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s || ['busy', 'printing', 'free', 'idle', 'ready'].includes(s)) return null;
  if (STAGES[s]) return STAGES[s];
  const t = s.replace(/[_-]+/g, ' ');
  return t[0].toUpperCase() + t.slice(1);
}

class AnycubicDriver extends PrinterDriver {
  static meta = {
    label: 'Anycubic Kobra X / Kobra 3 / S1 (LAN mode)',
    help: 'Stock firmware with LAN Mode on (Settings → Network). No credentials needed; the hub gets them from the printer.',
    slicer: { vendor: 'Anycubic', machine: 'Anycubic Kobra X 0.4 nozzle' },
    fields: [{ ...HOST_FIELD, help: 'The printer’s IP address.' }, CAMERA_FIELD],
  };

  constructor(cfg, opts) {
    super(cfg, opts);
    this.state.capabilities = { pause: true, resume: true, cancel: true, light: true, files: true };
    this.info = {};
    this.project = null;
    this.light = null;
    this.slots = null;
    this.pollCount = 0;
    this.limits = { nozzle: 300, bed: 120, jog: 100 };
    this.state.capabilities.control = {
      jog: true, home: true, motorsOff: true, temps: ['nozzle', 'bed'], fans: ['part'],
      speed: 'mode', limits: this.limits,
    };
    // Replies carry their own msgid (after an empty ack echoing ours), so we
    // match pending requests by "type:action" instead.
    this.pending = new Map();
    this.lines = new Map(); // "type:action" -> the last request of that kind
    this.confirmMs = opts?.confirmMs ?? 20000;
  }

  async start() {
    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.retryTimer);
    this.client?.end(true);
  }

  async connect() {
    try {
      this.hs = await handshake(this.cfg.host);
    } catch (err) {
      if (this.stopped) return;
      this.setOffline(err);
      this.retryTimer = setTimeout(() => this.connect(), 15000);
      return;
    }
    if (this.stopped) return; // stopped while the handshake was under way
    const { brokerHost, brokerPort, username, password, cert, key, modelId, deviceId } = this.hs;
    this.client = mqtt.connect({
      protocol: 'mqtts',
      host: brokerHost,
      port: brokerPort,
      username,
      password,
      cert,
      key,
      rejectUnauthorized: false, // printer uses a self-signed broker cert
      clientId: `printer-hub-${crypto.randomBytes(4).toString('hex')}`,
      reconnectPeriod: 0, // reconnect via a fresh handshake instead; credentials may rotate
      connectTimeout: 10000,
    });
    this.client.on('connect', () => {
      this.client.subscribe(`${PREFIX}/printer/public/${modelId}/${deviceId}/#`);
      this.update({ online: true, error: null, model: this.hs.modelName });
      this.poll();
      this.pollTimer = setInterval(() => this.poll(), Math.max(this.pollIntervalMs, 2000));
    });
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    const client = this.client;
    const lost = (err) => {
      if (this.client !== client) return; // already handled (error + close both fire)
      clearInterval(this.pollTimer);
      client.removeAllListeners();
      client.on('error', () => {});
      client.end(true);
      this.client = null;
      this.setOffline(err || new Error('Connection lost'));
      if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), 10000);
    };
    this.client.on('error', lost);
    this.client.on('close', () => lost());
  }

  publish(channel, type, action, data) {
    if (!this.client?.connected) throw new Error('Printer not connected');
    const msgid = crypto.randomUUID();
    const topic = `${PREFIX}/${channel}/printer/${this.hs.modelId}/${this.hs.deviceId}/${type}`;
    this.client.publish(topic, JSON.stringify({ type, action, timestamp: Date.now(), msgid, data }));
    return msgid;
  }

  poll() {
    try {
      this.publish('web', 'info', 'query', null);
      this.publish('web', 'light', 'query', null);
      // Filament slots change rarely; refresh them about every 30 seconds.
      if (this.pollCount++ % Math.max(1, Math.round(30000 / Math.max(this.pollIntervalMs, 2000))) === 0) {
        this.publish('web', 'multiColorBox', 'getInfo', null);
      }
    } catch { /* reconnect handled elsewhere */ }
  }

  onMessage(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (!topic.endsWith('/report') || !msg.type) return; // skip empty acks
    const type = topic.split('/').slice(-2, -1)[0];
    const d = msg.data || {};

    const key = `${msg.type}:${msg.action}`;
    if (this.pending.has(key)) {
      this.pending.get(key)(msg);
      this.pending.delete(key);
    }

    if (type === 'light') {
      const l = (d.lights || [])[0];
      if (!l) return;
      this.light = !!l.status;
    } else if (type === 'info') {
      this.info = d;
      if ('project' in d) this.project = d.project || null;
    } else if (type === 'print' && d && (d.filename || d.progress != null)) {
      this.project = { ...(this.project || {}), ...d, state: d.state || msg.state || this.project?.state };
    } else if (type === 'tempature') {
      if (d.curr_nozzle_temp != null || d.curr_hotbed_temp != null) this.info = { ...this.info, temp: { ...(this.info.temp || {}), ...d } };
    } else if (type === 'fan') {
      this.info = { ...this.info, ...pick(d, ['fan_speed_pct', 'aux_fan_speed_pct', 'box_fan_level']) };
    } else if (type === 'multiColorBox' && Array.isArray(d.multi_color_box)) {
      this.slots = slotsFrom(d.multi_color_box);
    } else {
      return;
    }
    this.render();
  }

  render() {
    const t = this.info.temp || {};
    const p = this.project;
    let status = mapStatus(this.info.state, p);
    // Before the first layer (download, file check, leveling) the printer just
    // says "busy". If we know the file, call it preparing instead. A print the
    // hub started counts for a minute even before the printer reports anything.
    const ps = p?.state?.toLowerCase();
    const starting = this.starting && Date.now() - this.starting.at < 30 * 60 * 1000 ? this.starting : null;
    const prepFile = (p?.filename && !ENDED.has(ps) && p.filename) || starting?.file;
    if (prepFile && (status === 'busy' || (status === 'idle' && starting && Date.now() - starting.at < 60 * 1000))) {
      status = 'preparing';
    }
    if (status !== 'preparing' && status !== 'busy') this.starting = null;
    const active = ['printing', 'pausing', 'paused', 'cancelling', 'heating', 'completed'].includes(status);
    this.update({
      online: true,
      status,
      error: status === 'error' ? 'Printer reported an error' : null,
      model: this.info.model || this.hs?.modelName || 'Anycubic',
      firmware: this.info.version || null,
      camera: this.cameraUrl() ? 'flv' : null,
      light: this.light,
      fans: {
        part: this.info.fan_speed_pct ?? null,
        ...(this.info.aux_fan_speed_pct != null ? { aux: this.info.aux_fan_speed_pct } : {}),
      },
      speed: ['printing', 'pausing', 'paused'].includes(status)
        ? { kind: 'mode', value: p?.print_speed_mode ?? this.info.print_speed_mode ?? 2, options: SPEED_MODES }
        : null,
      slots: this.slots,
      temps: {
        nozzle: { cur: t.curr_nozzle_temp ?? 0, target: t.target_nozzle_temp ?? 0 },
        bed: { cur: t.curr_hotbed_temp ?? 0, target: t.target_hotbed_temp ?? 0 },
      },
      job: active && p ? {
        file: p.filename || '',
        progress: p.progress || 0,
        layer: p.curr_layer || 0,
        totalLayers: p.total_layers || 0,
        elapsed: p.print_time != null ? p.print_time * 60 : null, // printer reports minutes
        remaining: p.remain_time != null ? p.remain_time * 60 : null,
        thumb: false,
      } : status === 'preparing' ? {
        file: prepFile,
        progress: 0,
        layer: 0,
        totalLayers: p?.total_layers || 0,
        elapsed: null,
        remaining: p?.remain_time > 0 ? p.remain_time * 60 : null,
        stage: stageLabel(ps) || stageLabel(this.info.state),
        thumb: false,
      } : null,
    });
  }

  // Publishes a command and resolves with the printer's report for it; rejects
  // if the printer reports failure.
  request(type, action, data, timeoutMs = 10000, channel = 'web') {
    const key = `${type}:${action}`;
    // Replies are matched by kind alone, so requests of one kind go one at a
    // time: two in flight would take each other's answers.
    const run = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('Printer did not respond')); }, timeoutMs);
      this.pending.set(key, (msg) => {
        clearTimeout(timer);
        if (msg.state === 'failed' || (msg.code && msg.code !== 200)) reject(new Error(`Printer refused ${action} (code ${msg.code}${msg.msg ? `: ${msg.msg}` : ''})`));
        else resolve(msg);
      });
      try { this.publish(channel, type, action, data); } catch (err) { clearTimeout(timer); this.pending.delete(key); reject(err); }
    });
    const result = (this.lines.get(key) || Promise.resolve()).then(run, run);
    this.lines.set(key, result.catch(() => {}));
    return result;
  }

  // Sends a command the printer doesn't answer, then waits for its status to
  // show it. No change in time is an error, never a silent success.
  async command(action, done, what) {
    this.publish('web', 'print', action, { taskid: this.taskId() });
    await new Promise((resolve, reject) => {
      const onUpdate = (s) => { if (done(s.status)) { clearTimeout(timer); this.off('update', onUpdate); resolve(); } };
      const timer = setTimeout(() => {
        this.off('update', onUpdate);
        reject(new Error(`The printer didn’t confirm the ${what}. Check the printer.`));
      }, this.confirmMs);
      this.on('update', onUpdate);
    });
  }

  taskId() {
    return String(this.project?.taskid ?? this.project?.task_id ?? '-1');
  }

  async pause() { await this.command('pause', (s) => ['pausing', 'paused'].includes(s), 'pause'); }
  async resume() { await this.command('resume', (s) => !['pausing', 'paused'].includes(s), 'resume'); }
  async cancel() {
    this.starting = null; // a start being cancelled is no longer "preparing"
    await this.command('stop', (s) => !['preparing', 'heating', 'printing', 'pausing', 'paused'].includes(s), 'cancel');
  }

  // Commands per the Kobra X LAN protocol (see stribor/anycubic_kobrax):
  // axis/move {axis 1=X 2=Y 3=Z, move_type 1=+ 0=- 2=home (axis 4=XY 3=Z 5=XYZ), distance}.
  async control(raw) {
    const cmd = this.validateControl(raw);
    switch (cmd.action) {
      case 'jog':
        return this.publish('web', 'axis', 'move', {
          axis: { x: 1, y: 2, z: 3 }[cmd.axis],
          move_type: cmd.distance > 0 ? 1 : 0,
          distance: Math.abs(cmd.distance),
        });
      case 'home':
        return this.publish('web', 'axis', 'move', { axis: { xy: 4, z: 3, xyz: 5 }[cmd.axes], move_type: 2, distance: 0 });
      case 'motorsOff':
        return this.publish('web', 'axis', 'turnOff', null);
      case 'temp': {
        const t = this.info.temp || {};
        const nozzle = cmd.heater === 'nozzle' ? cmd.target : (t.target_nozzle_temp ?? 0);
        const bed = cmd.heater === 'bed' ? cmd.target : (t.target_hotbed_temp ?? 0);
        this.publish('web', 'tempature', 'set', { type: cmd.heater === 'nozzle' ? 0 : 1, target_hotbed_temp: bed, target_nozzle_temp: nozzle });
        this.info = { ...this.info, temp: { ...t, target_nozzle_temp: nozzle, target_hotbed_temp: bed } };
        return this.render();
      }
      case 'fan':
        this.publish('web', 'fan', 'setSpeed', { fan_speed_pct: cmd.pct });
        this.info = { ...this.info, fan_speed_pct: cmd.pct };
        return this.render();
      case 'speed': {
        const mode = Number(cmd.value);
        if (!SPEED_MODES.some((m) => m.value === mode)) throw new Error('Unknown speed mode');
        return this.publish('web', 'print', 'update', { taskid: this.taskId(), settings: { print_speed_mode: mode } });
      }
      default:
        throw new Error('Unsupported');
    }
  }

  async refreshSlots() {
    const msg = await this.request('multiColorBox', 'getInfo', null);
    this.slots = slotsFrom(msg.data?.multi_color_box || []);
    this.render();
    return this.slots;
  }

  async setLight(on) {
    await this.request('light', 'control', { type: 3, status: on ? 1 : 0, brightness: on ? 100 : 0 });
    this.light = on;
    this.render();
  }

  async listFiles() {
    // Paging params are required, but the Kobra X may ignore them and return
    // everything each time, so stop as soon as a page adds nothing new.
    const files = new Map();
    const pageSize = 50;
    for (let page = 1; page <= 20; page++) {
      const msg = await this.request('file', 'listLocal', { root: 'local', path: '/', page_num: page, page_size: pageSize });
      const records = (msg.data?.records || []).filter((f) => !f.is_dir);
      const before = files.size;
      for (const f of records) files.set(f.fileKey || f.filename, f);
      if (records.length < pageSize || files.size === before) break;
    }
    this.fileRecords = new Map([...files.values()].map((f) => [f.filename, f]));
    return [...files.values()]
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .map((f) => ({ name: f.filename, size: f.size || null }));
  }

  async fileRecord(filename) {
    if (!this.fileRecords?.has(filename)) await this.listFiles();
    const rec = this.fileRecords.get(filename);
    if (!rec) throw new Error(`${filename} is not on the printer`);
    return rec;
  }

  // Colors used by a file and the filament slots available to feed them,
  // with a suggested slot for each color (same material, closest color).
  async printOptions(filename) {
    const [details, box] = await Promise.all([
      this.request('file', 'fileDetails', { root: 'local', filename }),
      this.request('multiColorBox', 'getInfo', null),
    ]);
    // The printer reports which model each stored file was sliced for; refuse
    // files meant for another printer (also covers startPrint, which calls this).
    const model = details.data?.file_details?.printer_model;
    const re = matcherFor(this.cfg);
    if (model && re && !re.test(model)) {
      throw new Error(`${filename} was sliced for ${model}, not ${this.state.name}. Slice it for this printer instead.`);
    }
    const paints = details.data?.file_details?.paint_infos || [];
    const boxes = box.data?.multi_color_box || [];
    const slots = boxes.flatMap((b, bi) => (b.slots || []).map((s) => ({
      index: bi * 4 + s.index,
      color: (s.color || [0, 0, 0]).slice(0, 3),
      type: s.type || 'Unknown',
      ready: s.status === 5,
    })));
    const base = (t) => String(t || '').split(/\s+/)[0].toUpperCase();
    const dist = (a, b) => a.reduce((n, v, i) => n + (v - (b[i] ?? 0)) ** 2, 0);
    const colors = paints.map((p) => {
      const color = (p.paint_color || [0, 0, 0]).slice(0, 3);
      const candidates = slots.filter((s) => s.ready && base(s.type) === base(p.material_type));
      const pool = candidates.length ? candidates : slots.filter((s) => s.ready);
      const best = pool.sort((a, b) => dist(a.color, color) - dist(b.color, color))[0];
      return { index: p.paint_index, color, material: p.material_type, grams: p.filament_used || 0, slot: best ? best.index : null };
    });
    return {
      colors,
      slots,
      options: [{ key: 'autoLevel', label: 'Auto-level before printing', default: true }],
    };
  }

  // Payload validated on Kobra X FW 2.0.2.2 (see eduardobittencourt/kobra-lan-cli).
  async startPrint(filename, { mapping, autoLevel = true } = {}) {
    const rec = await this.fileRecord(filename);
    const opts = await this.printOptions(filename);
    const slotFor = (paint) => {
      const chosen = mapping && mapping[paint.index] != null ? Number(mapping[paint.index]) : paint.slot;
      const slot = opts.slots.find((s) => s.index === chosen);
      if (!slot) throw new Error(`Pick a filament slot for color ${paint.index + 1}`);
      return slot;
    };
    const ams = opts.colors.map((p) => {
      const slot = slotFor(p);
      return {
        paint_index: p.index,
        ams_index: slot.index,
        paint_color: [...p.color, 255],
        ams_color: [...slot.color, 255],
        material_type: slot.type,
      };
    });
    await this.request('print', 'start', {
      taskid: '-1',
      url: '',
      filename,
      md5: rec.fileKey || '',
      filepath: null,
      filetype: 1,
      project_type: 1,
      filesize: rec.size || 0,
      ams_settings: { use_ams: ams.length > 0, ams_box_mapping: ams },
      task_settings: {
        auto_leveling: autoLevel ? 1 : 0,
        vibration_compensation: 0,
        flow_calibration: 0,
        dry_mode: 0,
        ai_settings: { status: 0, count: 0, type: 0 },
        timelapse: { status: 0, count: 0, type: 0 },
        drying_settings: { status: 0, target_temp: 0, duration: 0, remain_time: 0 },
        model_objects_skip_parts: [],
      },
    }, 20000, 'slicer');
    this.starting = { file: filename, at: Date.now() };
    this.render();
  }

  async upload(filename, data) {
    if (!/\.gcode$/i.test(filename)) throw new Error('The Kobra X accepts .gcode files');
    if (!['idle', 'completed'].includes(this.state.status)) throw new Error('Printer must be idle to receive files');
    const url = this.info.urls?.fileUploadurl;
    if (!url) throw new Error('Printer has not reported an upload address yet');
    const res = await postMultipart(url, {
      fields: { filename },
      file: { field: 'gcode', name: filename, data },
      headers: { 'User-Agent': 'AnycubicSlicerNext/1.3.9.4', 'X-BBL-Client-Name': 'AnycubicSlicerNext', 'X-BBL-Client-Type': 'slicer', 'X-File-Length': String(data.length) },
    });
    if (res.code !== 200) throw new Error(`Printer rejected the upload (code ${res.code})`);
    this.fileRecords = null; // refresh listing on next use
  }

  cameraUrl() {
    if (this.cfg.cameraUrl === false) return null;
    return this.cfg.cameraUrl || this.info.urls?.rtspUrl || `http://${this.cfg.host}:18088/flv`;
  }

  cameraSource() {
    // Ask the printer to start its camera feed; harmless if it is already running.
    try { this.publish('web', 'video', 'startCapture', null); } catch { /* offline */ }
    const url = this.cameraUrl();
    return url ? { url } : null;
  }

  snapshotSource() {
    return { url: `http://${this.cfg.host}:18910/camera/snapshot` };
  }
}

module.exports = { AnycubicDriver, handshake };
