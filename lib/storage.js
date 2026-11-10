// What the hub's data takes up on disk, for Settings → Storage.
const fs = require('node:fs');
const path = require('node:path');

// Bytes under a path. Files that go away while it's counting (a timelapse
// frame, a deleted library file) count as nothing.
async function dirBytes(p) {
  let st;
  try { st = await fs.promises.lstat(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let names;
  try { names = await fs.promises.readdir(p); } catch { return 0; }
  let total = 0;
  for (const name of names) total += await dirBytes(path.join(p, name));
  return total;
}

// Every folder is walked once: the library per file, then the rest of the data folder.
async function storageReport(dataDir, library, timelapses) {
  const sums = { print: { count: 0, bytes: 0 }, model: { count: 0, bytes: 0 } };
  for (const i of library.list()) {
    const s = sums[i.kind === 'model' ? 'model' : 'print'];
    s.count += 1;
    s.bytes += await dirBytes(path.join(library.dir, i.id));
  }
  const tl = { count: timelapses.list().length, bytes: await dirBytes(timelapses.dir) };
  const ids = new Set(library.list().map((i) => i.id));
  const rest = async (dir, skip) => {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return 0; }
    let total = 0;
    for (const name of names) if (!skip(path.join(dir, name), name)) total += await dirBytes(path.join(dir, name));
    return total;
  };
  const same = (a, b) => path.resolve(a) === path.resolve(b);
  const other = await rest(dataDir, (p) => same(p, library.dir) || same(p, timelapses.dir))
    + await rest(library.dir, (_p, name) => ids.has(name));
  let disk = null;
  try {
    const s = await fs.promises.statfs(dataDir);
    disk = { free: s.bavail * s.bsize, size: s.blocks * s.bsize };
  } catch { /* not available on this system */ }
  const total = sums.print.bytes + sums.model.bytes + tl.bytes + other;
  return { printFiles: sums.print, models: sums.model, timelapses: tl, other: { bytes: other }, total, disk };
}

module.exports = { storageReport, dirBytes };
