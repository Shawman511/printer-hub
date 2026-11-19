// Reads a multipart/form-data upload (what slicers send to OctoPrint) without
// holding it in memory: the body goes to a temporary file, then each part is
// found in it. Resolves { fields, file: { name, start, end, path } } where the
// file's bytes are path[start, end); the caller removes path when done.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 520 * 1024 * 1024; // the library's 512 MB, plus the form around it
const CHUNK = 1024 * 1024;

function boundaryOf(contentType) {
  const m = /^multipart\/form-data;.*\bboundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(String(contentType || ''));
  return m ? m[1] || m[2] : null;
}

// Every offset of needle in the file, read a chunk at a time.
function findAll(fd, size, needle) {
  const hits = [];
  const buf = Buffer.alloc(CHUNK + needle.length);
  for (let pos = 0; pos < size; pos += CHUNK) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    let i = buf.subarray(0, n).indexOf(needle);
    while (i >= 0 && i < CHUNK) { hits.push(pos + i); i = buf.subarray(0, n).indexOf(needle, i + 1); }
  }
  return hits;
}

async function readUploadForm(req, tmpDir) {
  const boundary = boundaryOf(req.headers['content-type']);
  if (!boundary) throw new Error('Expected a multipart/form-data upload');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `upload-${crypto.randomUUID()}`);
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); out.destroy(); reject(new Error('File is larger than 512 MB')); }
      });
      req.on('error', (err) => { out.destroy(); reject(err); });
      req.on('aborted', () => { out.destroy(); reject(new Error('Upload broke off')); });
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    const fd = fs.openSync(tmp, 'r');
    try {
      // Each part starts after "--boundary" (at the very start, or after CRLF).
      const delim = Buffer.from(`--${boundary}`);
      // A real boundary sits on its own line: CRLF before it, and CRLF or "--" after.
      const at = (p, n) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, p); return b.toString('latin1'); };
      const starts = findAll(fd, size, delim).filter((p) => (p === 0 || at(p - 2, 2) === '\r\n') && ['\r\n', '--'].includes(at(p + delim.length, 2)));
      const fields = {};
      let file = null;
      for (let k = 0; k + 1 < starts.length; k++) {
        const partStart = starts[k] + delim.length + 2; // past the boundary's CRLF
        const partEnd = starts[k + 1] - 2; // before the next boundary's leading CRLF
        const head = Buffer.alloc(Math.min(16 * 1024, Math.max(0, partEnd - partStart)));
        fs.readSync(fd, head, 0, head.length, partStart);
        const sep = head.indexOf('\r\n\r\n');
        if (sep < 0) continue;
        const headers = head.subarray(0, sep).toString('utf8');
        const name = /name="([^"]*)"/i.exec(headers)?.[1];
        const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
        const bodyStart = partStart + sep + 4;
        if (filename != null) {
          if (!file) file = { field: name, name: filename, start: bodyStart, end: partEnd, path: tmp };
        } else if (name && partEnd - bodyStart <= 64 * 1024) {
          const v = Buffer.alloc(Math.max(0, partEnd - bodyStart));
          fs.readSync(fd, v, 0, v.length, bodyStart);
          fields[name] = v.toString('utf8');
        }
      }
      return { fields, file };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

module.exports = { readUploadForm, boundaryOf };
