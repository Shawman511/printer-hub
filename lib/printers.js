// The printer list, edited in Settings → Printers and saved to
// data/printers.json. On first run it's seeded from the config file's
// "printers" (so installs from before the setup screen keep their printers
// and IDs, which the job log and filament rolls refer to).
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Camera crop: the part of the frame to show, as fractions { x, y, w, h }.
// Anything invalid (or the whole frame) means no crop.
function cropOf(c) {
  if (!c || typeof c !== 'object') return null;
  const n = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 10000) / 10000;
  const x = n(c.x), y = n(c.y), w = n(Math.min(n(c.w), 1 - x)), h = n(Math.min(n(c.h), 1 - y));
  if (w < 0.05 || h < 0.05 || (w > 0.999 && h > 0.999)) return null;
  return { x, y, w, h };
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'printer';

// How often a timelapse takes a frame: { layers: 5 } or { seconds: 60 }. Nothing means every layer.
function timelapseEveryOf(v) {
  if (!v) return null;
  const whole = (n, min, max) => (Number.isInteger(Number(n)) && Number(n) >= min && Number(n) <= max ? Number(n) : null);
  if (v.layers != null && whole(v.layers, 1, 1000)) return { layers: Number(v.layers) };
  if (v.seconds != null && whole(v.seconds, 5, 3600)) return { seconds: Number(v.seconds) };
  throw new Error('A timelapse frame can be every 1–1000 layers or every 5–3600 seconds');
}

// Seconds of video, or nothing for a length that follows the print's.
function timelapseLengthOf(v) {
  if (v == null || v === '' || Number(v) === 0) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 5 || n > 600) throw new Error('A timelapse can be 5–600 seconds long');
  return n;
}

class PrinterStore extends EventEmitter {
  // types: { [type]: DriverClass } (each with static meta.fields)
  constructor(dataDir, types, seed = []) {
    super();
    this.types = types;
    this.file = path.join(dataDir, 'printers.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.printers = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      // Entries whose address came from an unset environment variable are skipped.
      this.printers = seed.filter((p) => p && p.id && types[p.type] && (p.host || !this.fieldsOf(p.type).some((f) => f.key === 'host')));
      this.save();
      if (this.printers.length) console.log(`Printers: imported ${this.printers.map((p) => p.id).join(', ')} from the config file`);
    }
  }

  fieldsOf(type) { return this.types[type]?.meta?.fields || []; }
  secretKeys(type) { return this.fieldsOf(type).filter((f) => f.type === 'password').map((f) => f.key); }

  save() {
    const tmp = `${this.file}.tmp`;
    // Holds check codes, API keys and passwords: readable by the hub's user only.
    fs.writeFileSync(tmp, JSON.stringify(this.printers, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // the mode above only applies to a new file
    fs.renameSync(tmp, this.file);
  }

  all() { return this.printers; }
  get(id) { return this.printers.find((p) => p.id === id) || null; }

  // For the browser: secrets replaced by "<key>Set: true".
  view(p) {
    const out = { ...p };
    for (const k of this.secretKeys(p.type)) {
      out[`${k}Set`] = !!p[k];
      delete out[k];
    }
    return out;
  }

  list() { return this.printers.map((p) => this.view(p)); }

  // Builds a clean config from form input. `prev` keeps secrets left blank.
  clean(input, prev = null) {
    const type = prev ? prev.type : input.type;
    if (!this.types[type]) throw new Error('Pick a printer type');
    const name = String(input.name ?? prev?.name ?? '').trim();
    if (!name) throw new Error('Give the printer a name');
    if (name.length > 40) throw new Error('Name is too long (40 characters max)');
    const cfg = { id: prev?.id, name, type };
    for (const f of this.fieldsOf(type)) {
      let v = input[f.key];
      if (v === undefined && prev) v = prev[f.key]; // partial update (e.g. only the camera crop)
      if (f.type === 'password' && (v == null || v === '') && prev) v = prev[f.key];
      if (f.type === 'checkbox') v = v === true || v === 'on' || v === 'true';
      else v = v == null ? '' : String(v).trim();
      if (f.required && !v) throw new Error(`${f.label} is required`);
      if (v !== '' && v !== false) cfg[f.key] = v;
    }
    if (cfg.host && !/^(https?:\/\/)?[\w.-]+(:\d{1,5})?(\/[\w./~-]*)?$/i.test(cfg.host)) throw new Error('Address should be an IP or host name, e.g. 192.168.1.50 or voron.local:7125');
    const crop = cropOf(input.cameraCrop === undefined ? prev?.cameraCrop : input.cameraCrop);
    if (crop) cfg.cameraCrop = crop;
    // Timelapses are recorded unless turned off.
    const timelapse = input.timelapse === undefined ? prev?.timelapse : input.timelapse;
    if (timelapse === false || timelapse === 'false') cfg.timelapse = false;
    const every = timelapseEveryOf(input.timelapseEvery === undefined ? prev?.timelapseEvery : input.timelapseEvery);
    if (every) cfg.timelapseEvery = every;
    const length = timelapseLengthOf(input.timelapseLength === undefined ? prev?.timelapseLength : input.timelapseLength);
    if (length) cfg.timelapseLength = length;
    const slicer = input.slicer === undefined ? prev?.slicer : input.slicer;
    if (slicer?.vendor && slicer?.machine) cfg.slicer = { vendor: String(slicer.vendor), machine: String(slicer.machine) };
    const match = input.modelMatch === undefined ? prev?.modelMatch : input.modelMatch;
    if (match) {
      try { new RegExp(match); } catch { throw new Error('The sliced-file check isn’t a valid pattern'); }
      cfg.modelMatch = String(match);
    }
    // Settings only a config file can set (e.g. demo options) carry over.
    if (prev) for (const [k, v] of Object.entries(prev)) if (!(k in cfg) && !this.fieldsOf(type).some((f) => f.key === k) && !['slicer', 'modelMatch', 'cameraCrop', 'timelapse', 'timelapseEvery', 'timelapseLength'].includes(k)) cfg[k] = v;
    return cfg;
  }

  add(input) {
    const cfg = this.clean(input);
    let id = slug(cfg.name);
    for (let n = 2; this.get(id); n++) id = `${slug(cfg.name).slice(0, 28)}-${n}`;
    cfg.id = id;
    this.printers.push(cfg);
    this.save();
    this.emit('change', { added: cfg });
    return cfg;
  }

  update(id, input) {
    const i = this.printers.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('Printer not found');
    const cfg = this.clean(input, this.printers[i]);
    this.printersBefore = this.printers[i];
    this.printers[i] = cfg;
    this.save();
    this.emit('change', { updated: cfg, previous: this.printersBefore });
    return cfg;
  }

  remove(id) {
    const before = this.printers.length;
    this.printers = this.printers.filter((p) => p.id !== id);
    if (this.printers.length === before) throw new Error('Printer not found');
    this.save();
    this.emit('change', { removed: id });
  }
}

module.exports = { PrinterStore };
