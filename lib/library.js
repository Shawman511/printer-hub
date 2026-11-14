// File library: print files kept on the hub (data/library/<id>/<name>) so they
// can be sent to any printer later, even after a printer has deleted them.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');
const { Worker } = require('node:worker_threads');

const PRINT_EXT = /\.(gcode|gx|bgcode)$/i;
const MODEL_EXT = /\.(stl|obj|step|stp|amf)$/i;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_DRAWN_BYTES = 150 * 1024 * 1024; // larger G-code isn't drawn: too much to hold in memory
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const isPng = (buf) => buf.subarray(0, 4).equals(PNG_MAGIC);
// A .3mf is a zip, and slicers keep a picture of the plate inside.
// Settings files and pictures inside a .3mf are well under this. A tiny file can
// claim to unpack to gigabytes, which would exhaust the hub's memory.
const MAX_UNPACKED = 50 * 1024 * 1024;
const ZIP_PREVIEWS = ['Metadata/plate_1.png', 'Metadata/thumbnail.png', 'Thumbnails/thumbnail.png', 'Metadata/top_1.png'];

// The first of these files found in a zip, unpacked, or null.
function zipEntry(filePath, names) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
    const tailLen = Math.min(size, 66 * 1024);
    const tail = read(size - tailLen, tailLen);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) return null;
    const dir = read(tail.readUInt32LE(end + 16), tail.readUInt32LE(end + 12));
    const found = new Map();
    for (let p = 0; p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50;) {
      const nameLen = dir.readUInt16LE(p + 28);
      found.set(dir.toString('utf8', p + 46, p + 46 + nameLen), { method: dir.readUInt16LE(p + 10), packed: dir.readUInt32LE(p + 20), size: dir.readUInt32LE(p + 24), offset: dir.readUInt32LE(p + 42) });
      p += 46 + nameLen + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    const entry = names.map((n) => found.get(n)).find(Boolean);
    if (!entry || entry.packed > MAX_UNPACKED || entry.size > MAX_UNPACKED) return null;
    const local = read(entry.offset, 30);
    const data = read(entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), entry.packed);
    // The stated size can lie, so the unpacking itself is capped too.
    return entry.method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_UNPACKED }) : data;
  } finally {
    fs.closeSync(fd);
  }
}

function zipPreview(filePath) {
  const png = zipEntry(filePath, ZIP_PREVIEWS);
  return png && isPng(png) ? png : null;
}

// The filaments saved in a slicer project .3mf: [{ index, color, type, preset }].
// Empty for anything else, including a plain mesh .3mf.
function projectFilaments(filePath) {
  try {
    const raw = zipEntry(filePath, ['Metadata/project_settings.config']);
    if (!raw) return [];
    const p = JSON.parse(raw.toString('utf8'));
    return (Array.isArray(p.filament_colour) ? p.filament_colour : []).map((color, index) => ({
      index,
      color,
      type: p.filament_type?.[index] || null,
      preset: p.filament_settings_id?.[index] || null,
    }));
  } catch {
    return [];
  }
}

function drawThumb(file, out) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'thumb-worker.js'), { workerData: { file, out } });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

function safeName(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/[\x00-\x1f<>:"|?*]/g, '_').trim();
  if (!base || base.startsWith('.')) throw new Error('Invalid file name');
  if (!PRINT_EXT.test(base) && !MODEL_EXT.test(base) && !/\.3mf$/i.test(base)) {
    throw new Error('Supported files: .gcode, .gx, .bgcode, .3mf, .stl, .obj, .step, .stp, .amf');
  }
  return base.slice(0, 200);
}

// A .3mf is either a sliced plate (contains Metadata/plate_N.gcode, which the
// AD5M prints directly) or a model/project that still needs slicing.
function classify(name, filePath) {
  if (PRINT_EXT.test(name)) return 'print';
  if (MODEL_EXT.test(name)) return 'model';
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); // zip central directory is at the end
    return /Metadata\/plate_\d+\.gcode/.test(buf.toString('latin1')) ? 'print' : 'model';
  } finally {
    fs.closeSync(fd);
  }
}

// "Magnets / Oval" -> "Magnets/Oval". Folders are labels in the index, never
// paths on disk; '' means no folder.
function folderPath(value) {
  const parts = String(value ?? '').split('/').map((p) => p.replace(/[\x00-\x1f\\]/g, '').trim()).filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) throw new Error('Invalid folder name');
  if (parts.length > 5) throw new Error('Folders can go 5 levels deep');
  if (parts.some((p) => p.length > 60)) throw new Error('Folder names can be up to 60 characters');
  return parts.join('/');
}

// Trimmed and without repeats; "PLA" and "pla" count as the same tag.
function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Map();
  for (const t of list) {
    const tag = String(t).replace(/[\x00-\x1f]/g, '').trim().slice(0, 30);
    if (tag && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  }
  if (seen.size > 20) throw new Error('A file can have up to 20 tags');
  return [...seen.values()];
}

// Slicer metadata lives at the start (Anycubic Slicer Next, FlashPrint) or in
// the config block at the end (Orca/Bambu-style), so read both ends.
function readEnds(filePath, bytes = 128 * 1024) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (size <= bytes) return head;
    const tail = Buffer.alloc(Math.min(bytes, size - head.length));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return Buffer.concat([head, Buffer.from('\n'), tail]);
  } finally {
    fs.closeSync(fd);
  }
}

// Reads slicer metadata from G-code comments.
function sniff(head) {
  const text = head.toString('latin1');
  const pick = (re) => (text.match(re) || [])[1]?.trim() || null;
  return {
    printerModel: pick(/;\s*printer_model\s*=\s*(.+)/i) || pick(/;\s*machine_type\s*[:=]\s*(.+)/i),
    slicer: pick(/generated by\s+([^\r\n]+?)(?:\s+on\s|\r|\n)/i),
    material: pick(/;\s*filament_type\s*=\s*(.+)/i),
    estimate: pick(/;\s*estimated printing time[^=:]*[=:]\s*(.+)/i),
    bedTemp: Number(pick(/;\s*first_layer_bed_temperature\s*=\s*(\d+)/i) ?? NaN) || null,
    bedType: pick(/;\s*curr_bed_type\s*=\s*(.+)/i),
  };
}

// Saves the largest PNG preview embedded in a G-code file ("; thumbnail begin
// WxH LEN" blocks, written by Orca, PrusaSlicer, Cura plugins and the hub's
// slicer) as thumb.png next to it. Returns true if there was one.
function extractThumb(filePath) {
  const fd = fs.openSync(filePath, 'r');
  let head;
  try {
    head = Buffer.alloc(Math.min(2 * 1024 * 1024, fs.fstatSync(fd).size));
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  let best = null;
  for (const m of head.toString('latin1').matchAll(/^; thumbnail begin (\d+)x(\d+) \d+\r?\n([\s\S]*?)^; thumbnail end/gm)) {
    const area = Number(m[1]) * Number(m[2]);
    if (!best || area > best.area) best = { area, b64: m[3] };
  }
  if (!best) return false;
  const png = Buffer.from(best.b64.replace(/^;\s?/gm, '').replace(/\s+/g, ''), 'base64');
  if (png.subarray(1, 4).toString() !== 'PNG') return false;
  fs.writeFileSync(path.join(path.dirname(filePath), 'thumb.png'), png);
  return true;
}

class Library extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dir = path.join(dataDir, 'library');
    this.indexFile = path.join(this.dir, 'index.json');
    this.foldersFile = path.join(this.dir, 'folders.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.items = fs.existsSync(this.indexFile) ? JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) : [];
    this.emptyFolders = fs.existsSync(this.foldersFile) ? JSON.parse(fs.readFileSync(this.foldersFile, 'utf8')) : [];
    // Entries from older versions: no kind, or metadata read from the head only.
    let changed = false;
    for (const i of this.items) {
      if (!i.kind) { i.kind = 'print'; changed = true; }
      // thumb === undefined: added before previews were extracted.
      if (i.kind === 'print' && i.thumb === undefined && !/\.3mf$/i.test(i.name)) {
        try { i.thumb = extractThumb(this.filePath(i)); } catch { i.thumb = false; }
        changed = true;
      }
      // metaChecked = 2: target printer and bed temperature read from both file ends.
      if (i.kind === 'print' && i.metaChecked !== 2 && !/\.3mf$/i.test(i.name)) {
        try {
          const meta = sniff(readEnds(this.filePath(i)));
          for (const [k, v] of Object.entries(meta)) if (v != null && i[k] == null) i[k] = v;
        } catch { /* file gone */ }
        i.metaChecked = 2;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  save() {
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1));
    fs.renameSync(tmp, this.indexFile);
    this.emit('change', this.list());
  }

  list() {
    return [...this.items].sort((a, b) => b.addedAt - a.addedAt);
  }

  get(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error('Unknown library file');
    return item;
  }

  filePath(item) {
    return path.join(this.dir, item.id, item.name);
  }

  // Gives a picture to files that came without one, one at a time in the
  // background. Each file is only tried once. Models other than .3mf can't be
  // drawn here: the browser sends those (see setThumb).
  async fillThumbs() {
    if (this.filling) return;
    this.filling = true;
    try {
      for (;;) {
        const item = this.items.find((i) => !i.thumb && !i.thumbTried && (i.kind === 'print' || /\.3mf$/i.test(i.name)));
        if (!item) return;
        const file = this.filePath(item);
        const out = path.join(this.dir, item.id, 'thumb.png');
        let made = false;
        try {
          if (/\.3mf$/i.test(item.name)) {
            const png = zipPreview(file);
            if (png) { fs.writeFileSync(out, png); made = true; }
          } else if (item.size <= MAX_DRAWN_BYTES) {
            made = await drawThumb(file, out);
          }
        } catch (err) {
          console.warn(`No preview for ${item.name}: ${err.message}`);
        }
        if (!this.items.includes(item)) continue; // deleted meanwhile
        item.thumbTried = true;
        if (made) item.thumb = true;
        this.save();
      }
    } finally {
      this.filling = false;
    }
  }

  // Starts filling in pictures now and whenever a file is added.
  startThumbs() {
    this.autoThumbs = true;
    this.fillThumbs();
  }

  // A picture of a model, drawn in a browser with the 3D preview.
  setThumb(id, png) {
    const item = this.get(id);
    if (!isPng(png)) throw new Error('A preview must be a PNG');
    fs.writeFileSync(path.join(this.dir, item.id, 'thumb.png'), png);
    item.thumb = true;
    this.save();
  }

  // The file's preview image, or null.
  thumbPath(item) {
    return item?.thumb ? path.join(this.dir, item.id, 'thumb.png') : null;
  }

  read(id) {
    return fs.readFileSync(this.filePath(this.get(id)));
  }

  // A renamed file also answers to its old names: running prints and copies on
  // printers still use them.
  findByName(name) {
    const all = this.list();
    return all.find((i) => i.name === name) || all.find((i) => i.previousNames?.includes(name)) || null;
  }

  // Every folder, with its parents: the ones made by hand and the ones in use.
  folders() {
    const all = new Set();
    for (const f of [...this.emptyFolders, ...this.items.map((i) => i.folder)]) {
      const parts = (f || '').split('/').filter(Boolean);
      parts.forEach((_, n) => all.add(parts.slice(0, n + 1).join('/')));
    }
    return [...all].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  }

  saveFolders() {
    // Only folders with no files need remembering; the rest come from the index.
    const tmp = this.foldersFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.emptyFolders, null, 1));
    fs.renameSync(tmp, this.foldersFile);
    this.save();
  }

  addFolder(value) {
    const folder = folderPath(value);
    if (!folder) throw new Error('Folder name is required');
    if (!this.folders().includes(folder)) {
      this.emptyFolders.push(folder);
      this.saveFolders();
    }
    return folder;
  }

  // Applies a change to a folder path to every file and folder inside it too.
  #movePaths(from, to) {
    const moved = (f) => (f === from ? to : f?.startsWith(`${from}/`) ? (to ? `${to}/` : '') + f.slice(from.length + 1) : f);
    for (const i of this.items) {
      if (!i.folder) continue;
      i.folder = moved(i.folder) || undefined;
    }
    this.emptyFolders = [...new Set(this.emptyFolders.map(moved).filter(Boolean))];
    this.saveFolders();
  }

  // Also moves a folder: "Magnets/Oval" to "Oval".
  renameFolder(fromValue, toValue) {
    const from = folderPath(fromValue);
    const to = folderPath(toValue);
    if (!from || !this.folders().includes(from)) throw new Error('Unknown folder');
    if (!to) throw new Error('Folder name is required');
    if (to.startsWith(`${from}/`)) throw new Error("A folder can't go inside itself");
    if (to.split('/').length + Math.max(...this.folders().filter((f) => f === from || f.startsWith(`${from}/`)).map((f) => f.split('/').length - from.split('/').length)) > 5) {
      throw new Error('Folders can go 5 levels deep');
    }
    if (to !== from) this.#movePaths(from, to);
    return to;
  }

  // Removes the folder but not what's in it: that moves up a level.
  removeFolder(value) {
    const folder = folderPath(value);
    if (!folder || !this.folders().includes(folder)) throw new Error('Unknown folder');
    this.#movePaths(folder, folder.split('/').slice(0, -1).join('/'));
  }

  // Edits from the Library page: any of name, folder and tags.
  update(id, { name, folder, tags }) {
    const item = this.get(id);
    // Check everything first, so a refused edit changes nothing.
    const f = folder != null ? folderPath(folder) : null;
    const t = tags != null ? cleanTags(tags) : null;
    if (name != null) this.#rename(item, name);
    if (f != null) { if (f) item.folder = f; else delete item.folder; }
    if (t) { if (t.length) item.tags = t; else delete item.tags; }
    this.save();
    return item;
  }

  // The extension stays, as it decides how the file is handled. Printers keep
  // any copy under its old name, so the next send uploads the new one.
  #rename(item, value) {
    const ext = path.extname(item.name);
    const typed = String(value).replace(/^.*[\\/]/, '').trim();
    const stem = typed.toLowerCase().endsWith(ext.toLowerCase()) ? typed.slice(0, -ext.length) : typed;
    const fileName = safeName(stem.slice(0, 200 - ext.length) + ext);
    if (fileName === item.name) return;
    if (this.items.some((i) => i !== item && i.name.toLowerCase() === fileName.toLowerCase())) {
      throw new Error(`The library already has a file named ${fileName}`);
    }
    const old = item.name;
    fs.renameSync(this.filePath(item), path.join(this.dir, item.id, fileName));
    item.name = fileName;
    item.previousNames = [...new Set([...(item.previousNames || []), old])].filter((n) => n !== fileName).slice(-10);
    item.sentTo = [];
    delete item.lastSentAt;
  }

  // "part.gcode" if it's free, otherwise "part_v2.gcode" and so on. Old names of
  // renamed files stay reserved: printers may still have those copies.
  freeName(fileName) {
    const taken = new Set(this.items.flatMap((i) => [i.name, ...(i.previousNames || [])]).map((n) => n.toLowerCase()));
    if (!taken.has(fileName.toLowerCase())) return fileName;
    const ext = path.extname(fileName);
    for (let n = 2; ; n += 1) {
      const tail = `_v${n}${ext}`;
      const next = fileName.slice(0, Math.min(fileName.length - ext.length, 200 - tail.length)) + tail;
      if (!taken.has(next.toLowerCase())) return next;
    }
  }

  // Streams an HTTP request body to disk. Re-adding identical content
  // returns the existing entry instead of storing a duplicate. With newVersion,
  // different content under a name in use gets its own name (see freeName).
  async addFromStream(name, stream, extra = {}, { newVersion = false } = {}) {
    const fileName = safeName(name);
    const id = crypto.randomUUID();
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, fileName);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    let out;
    try {
      await new Promise((resolve, reject) => {
        out = fs.createWriteStream(dest);
        stream.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) { stream.destroy(); out.destroy(); reject(new Error('File is larger than 512 MB')); return; }
          hash.update(chunk);
          if (head.length < 64 * 1024) head = Buffer.concat([head, chunk.subarray(0, 64 * 1024 - head.length)]);
        });
        stream.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        stream.pipe(out);
      });
      if (!size) throw new Error('File is empty');
    } catch (err) {
      out?.destroy(); // an upload that broke off leaves the file open otherwise
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const sha256 = hash.digest('hex');
    const unversioned = (n) => n.replace(/_v\d+(\.[^.]+)$/, '$1');
    const dupe = this.items.find((i) => i.sha256 === sha256 && (i.name === fileName || (newVersion && unversioned(i.name) === fileName)));
    if (dupe) {
      fs.rmSync(dir, { recursive: true, force: true });
      return dupe;
    }
    const finalName = newVersion ? this.freeName(fileName) : fileName;
    if (finalName !== fileName) {
      const renamed = path.join(dir, finalName);
      fs.renameSync(dest, renamed);
      dest = renamed;
    }
    const kind = classify(finalName, dest);
    const item = {
      id, name: finalName, kind, size, sha256, addedAt: Date.now(), sentTo: [],
      ...(kind === 'print' && !/\.3mf$/i.test(finalName) ? { ...sniff(readEnds(dest)), thumb: extractThumb(dest) } : {}),
      ...extra,
    };
    this.items.push(item);
    this.save();
    if (this.autoThumbs) this.fillThumbs();
    return item;
  }

  markSent(id, printerId) {
    const item = this.get(id);
    item.sentTo = [...new Set([...(item.sentTo || []), printerId])];
    item.lastSentAt = Date.now();
    this.save();
  }

  remove(id) {
    const item = this.get(id);
    fs.rmSync(path.join(this.dir, item.id), { recursive: true, force: true });
    this.items = this.items.filter((i) => i.id !== id);
    // Its folder stays until someone removes it.
    if (item.folder && !this.folders().includes(item.folder)) this.emptyFolders.push(item.folder);
    this.saveFolders();
  }
}

module.exports = { Library, safeName, sniff, classify, folderPath, cleanTags, projectFilaments };
