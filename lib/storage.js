// What the hub's data takes up on disk, for Settings → Storage.
const fs = require('node:fs');
const path = require('node:path');

function dirBytes(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, name) => n + dirBytes(path.join(p, name)), 0);
}

function storageReport(dataDir, library, timelapses) {
  const items = library.list();
  const sum = (kind) => {
    const of = items.filter((i) => (i.kind === 'model') === (kind === 'model'));
    return { count: of.length, bytes: of.reduce((n, i) => n + dirBytes(path.join(library.dir, i.id)), 0) };
  };
  const printFiles = sum('print');
  const models = sum('model');
  const tl = { count: timelapses.list().length, bytes: dirBytes(timelapses.dir) };
  const total = dirBytes(dataDir);
  let disk = null;
  try {
    const s = fs.statfsSync(dataDir);
    disk = { free: s.bavail * s.bsize, size: s.blocks * s.bsize };
  } catch { /* not available on this system */ }
  return { printFiles, models, timelapses: tl, other: { bytes: Math.max(0, total - printFiles.bytes - models.bytes - tl.bytes) }, total, disk };
}

module.exports = { storageReport, dirBytes };
