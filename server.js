const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { FlashForgeDriver } = require('./drivers/flashforge');
const { AnycubicDriver } = require('./drivers/anycubic');
const { ElegooDriver } = require('./drivers/elegoo');
const { MockDriver } = require('./drivers/mock');
const { MoonrakerDriver } = require('./drivers/moonraker');
const { OctoPrintDriver } = require('./drivers/octoprint');
const { PrusaLinkDriver } = require('./drivers/prusalink');
const { PrinterStore } = require('./lib/printers');
const { Timelapses } = require('./lib/timelapse');
const { JobLog, planFilamentUse } = require('./lib/jobs');
const { Library, folderPath, projectFilaments } = require('./lib/library');
const { checkFile } = require('./lib/compat');
const { SpoolStore } = require('./lib/spools');
const { AuthStore, allowed } = require('./lib/auth');
const { version: HUB_VERSION, released: HUB_RELEASED } = require('./package.json');

// Printer types offered in Settings → Printers, in that order.
const DRIVERS = {
  moonraker: MoonrakerDriver,
  octoprint: OctoPrintDriver,
  prusalink: PrusaLinkDriver,
  flashforge: FlashForgeDriver,
  anycubic: AnycubicDriver,
  elegoo: ElegooDriver,
  mock: MockDriver,
};

// ---- Config ------------------------------------------------------------------

const argIdx = process.argv.indexOf('--config');
const configPath = path.resolve(__dirname, argIdx > -1 ? process.argv[argIdx + 1] : process.env.CONFIG_PATH || 'config.json');
if (!fs.existsSync(configPath)) {
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), configPath);
  console.log(`Created ${path.basename(configPath)} from the example.`);
}
// "${NAME}" in config values is replaced by the NAME environment variable
// (empty when unset), so values can come from the environment (e.g. Docker).
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'), (_key, value) => {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(\w+)\}/g, (_m, name) => {
    return process.env[name] ?? '';
  });
});
const port = Number(process.env.PORT) || config.port || 3000;

// Job log lives next to the config, e.g. data/ for config.json, data-demo/ for the demo.
const dataDir = process.env.DATA_DIR || config.dataDir
  ? path.resolve(__dirname, process.env.DATA_DIR || config.dataDir)
  : path.join(__dirname, path.basename(configPath) === 'config.json' ? 'data' : `data-${path.basename(configPath, '.json').replace(/^config\.?/, '') || 'alt'}`);
const jobs = new JobLog(dataDir);
const library = new Library(dataDir);
library.startThumbs();
const spools = new SpoolStore(dataDir, jobs);
const auth = new AuthStore(dataDir);
const printerStore = new PrinterStore(dataDir, DRIVERS, config.printers || []);
const timelapses = new Timelapses(dataDir);
const printers = new Map(); // id -> running driver

// ---- Live updates (Server-Sent Events) ---------------------------------------

const clients = new Map(); // response -> session id
// Finished jobs cleared from the hub (Clear): printer id -> file. The printer
// shows as ready until it reports something else (a new job, or idle itself).
const cleared = new Map();
function view(state) {
  const file = cleared.get(state.id);
  if (file === undefined) return state;
  if (state.status !== 'completed' || (state.job?.file || '') !== file) {
    cleared.delete(state.id);
    return state;
  }
  return { ...state, status: 'idle', job: null };
}
const snapshot = () => [...printers.values()].map((p) => view(p.state));
const broadcast = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.keys()) res.write(msg);
};
// Signing out (or being removed) ends that session's live stream right away.
auth.on('revoked', (ids) => {
  for (const [res, sid] of clients) if (ids.includes(sid)) { res.end(); clients.delete(res); }
});

// "1h 23m 4s" / "1d 2h 3m" (slicer headers) -> seconds.
function parseDuration(text) {
  const units = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, n, u] of String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) total += Number(n) * units[u.toLowerCase()];
  return total || null;
}

function onPrinterUpdate(state) {
  // Before the printer reports a remaining time (e.g. while preparing), use
  // the slicer's estimate from the library copy of the file.
  if (state.job?.file && !state.job.remaining && state.job.estimate === undefined) {
    state.job.estimate = parseDuration(library.findByName(state.job.file)?.estimate);
  }
  // Printers that don't serve a preview themselves can use the library's copy.
  if (state.job?.file && !state.job.thumb) state.job.thumb = !!library.findByName(state.job.file)?.thumb;
  jobs.observe(state);
  const driver = printers.get(state.id);
  if (driver) timelapses.observe(driver, state);
  broadcast('printer', view(state));
}

// Drivers start once the server is listening; printers added later start at once.
let started = false;
function attach(cfg) {
  const Driver = DRIVERS[cfg.type];
  if (!Driver) { console.warn(`Skipping ${cfg.id}: unknown type "${cfg.type}"`); return; }
  let driver;
  try { driver = new Driver(cfg, { pollIntervalMs: config.pollIntervalMs }); } catch (err) { console.warn(`Skipping ${cfg.id}: ${err.message}`); return; }
  driver.state.cameraCrop = cfg.cameraCrop || null; // applied by the browser
  driver.on('update', onPrinterUpdate);
  printers.set(cfg.id, driver);
  if (started) driver.start();
}
async function detach(id) {
  const driver = printers.get(id);
  if (!driver) return;
  printers.delete(id);
  driver.removeAllListeners('update');
  await driver.stop().catch(() => {});
}
// Connects with a config from the setup form (saved or not) for up to 10 s
// and reports what the printer said.
async function testPrinter(cfg) {
  let driver;
  try {
    driver = new DRIVERS[cfg.type]({ ...cfg, id: cfg.id || 'setup-test' }, { pollIntervalMs: 2000 });
    const state = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(driver.state), 10000);
      driver.on('update', (s) => { if (s.online || s.error) { clearTimeout(timer); resolve(s); } });
      Promise.resolve(driver.start()).catch((err) => { clearTimeout(timer); resolve({ online: false, error: err.message }); });
    });
    return {
      ok: !!state.online,
      status: state.status || null,
      model: state.model || null,
      firmware: state.firmware || null,
      error: state.online ? null : state.error || 'No answer from the printer within 10 seconds',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    driver?.removeAllListeners('update');
    await driver?.stop().catch(() => {});
  }
}

for (const cfg of printerStore.all()) attach(cfg);
// True when two printer configs differ only in hub-side settings (camera crop,
// timelapses) that don't need the printer reconnected.
const onlyCropChanged = (a, b) => {
  const strip = ({ cameraCrop, timelapse, ...rest }) => JSON.stringify(rest);
  return !!a && !!b && strip(a) === strip(b);
};

printerStore.on('change', async ({ added, updated, removed, previous }) => {
  // A new crop doesn't need a reconnect: update the running printer in place.
  const running = updated && printers.get(updated.id);
  if (running && onlyCropChanged(updated, previous)) {
    running.cfg = updated;
    running.state.cameraCrop = updated.cameraCrop || null;
    broadcast('printer', view(running.state));
    return;
  }
  if (removed || updated) await detach(removed || updated.id);
  if (added || updated) attach(added || updated);
  broadcast('printers', snapshot());
});
timelapses.on('change', (list) => broadcast('timelapses', list));
jobs.on('job', (job) => {
  broadcast('job', job);
  // Plan when a job opens; try once more when it ends if no weight was known yet.
  if (!job.filamentPlan && !job.manual) planFilament(job, job.outcome === 'printing' ? 'start' : 'end');
  if (job.filament) broadcast('spools', spools.list()); // a finished job changes roll estimates
});
jobs.on('reset', () => { broadcast('jobs', jobs.list()); broadcast('spools', spools.list()); });
spools.on('change', () => broadcast('spools', spools.list()));

// Printers may report 0 g per color; a file the hub sliced knows the real figures.
function withLibraryGrams(file, colors) {
  const known = library.findByName(file)?.colors;
  if (!known || !colors) return colors;
  return colors.map((c) => ({ ...c, grams: c.grams || known.find((k) => k.index === c.index)?.grams || 0 }));
}

// Works out how many grams a new job will take from each slot, best source first:
// 1. what the hub knew when it started the print (file colors + chosen slots),
// 2. the file's per-color weights as the printer reports them (slots guessed),
// 3. the file's total weight (library or printer estimate), when it reports no per-color weights.
const planning = new Set();
async function planFilament(job, phase) {
  const key = `${job.id}:${phase}`;
  if (planning.has(key)) return;
  planning.add(key);
  const p = printers.get(job.printerId);
  if (!p) return;
  const multi = !!p.state.slots?.length;
  let colors = null;
  const ls = p.hubStart;
  if (ls && ls.file === job.file && Date.now() - ls.at < 30 * 60 * 1000 && ls.perSlot?.length) colors = ls.perSlot;
  if (!colors && multi) {
    try {
      colors = withLibraryGrams(job.file, (await p.printOptions(job.file)).colors);
    } catch { /* file details unavailable */ }
  }
  const plan = planFilamentUse(colors, library.findByName(job.file)?.grams ?? p.state.job?.grams, multi);
  if (plan) jobs.setFilamentPlan(job.id, plan);
}
jobs.on('progress', () => broadcast('spools', spools.list()));
library.on('change', () => { broadcast('library', libraryView()); broadcast('folders', library.folders()); });

// Refuses print files sliced for a different printer.
function assertFits(item, printer) {
  const fit = checkFile(item, printer.cfg, printer.state.name);
  if (!fit.ok) throw new Error(`${item.name} ${fit.reason}. Slice it for this printer instead.`);
}

// Library entries as sent to the browser, with per-printer compatibility.
const libraryView = () => library.list().map((i) => (i.kind === 'model' ? i : {
  ...i,
  fits: Object.fromEntries([...printers.values()].map((p) => {
    const f = checkFile(i, p.cfg, p.state.name);
    return [p.state.id, { ok: f.ok, unknown: !!f.unknown, reason: f.reason || null }];
  })),
}));

// Sends a library file to a printer's own storage.
async function sendToPrinter(item, printer) {
  if (item.kind === 'model') throw new Error(`${item.name} is a model; slice it first`);
  assertFits(item, printer);
  await printer.upload(item.name, library.read(item.id));
  library.markSent(item.id, printer.state.id);
}

// New jobs default their item count to the number of copies the hub sliced.
jobs.quantityHint = (file) => library.findByName(file)?.copies ?? null;

// ---- Slicer service (OrcaSlicer CLI in its own container) ---------------------

const SLICER_URL = process.env.SLICER_URL || config.slicerUrl || null;
// The Orca machine preset a printer slices with: its own choice in Settings,
// else its type's default (FlashForge and Anycubic have one).
const slicerProfileFor = (p) => p.cfg.slicer || DRIVERS[p.cfg.type]?.meta?.slicer || null;

async function slicerCall(pathname, body, timeoutMs = 10000) {
  if (!SLICER_URL) throw new Error('No slicer service configured');
  const res = await fetch(new URL(pathname, SLICER_URL), {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Slicer error ${res.status}`);
  return data;
}

let slicerStatus = { available: false, checkedAt: 0 };
let machineList = null; // cached /machines from the slicer
async function slicerHealth() {
  if (!SLICER_URL) return { available: false };
  if (Date.now() - slicerStatus.checkedAt < 30000) return slicerStatus;
  try {
    const h = await slicerCall('/health', null, 3000);
    slicerStatus = { available: true, version: h.version, step: !!h.step, busy: h.busy, checkedAt: Date.now() };
  } catch (err) {
    slicerStatus = { available: false, error: err.message, checkedAt: Date.now() };
  }
  return slicerStatus;
}

const tag = (s) => String(s).replace(/[^A-Za-z0-9.+-]+/g, '_').replace(/^_+|_+$/g, '');

async function sliceModel(item, printer, body) {
  const profile = slicerProfileFor(printer);
  if (!profile) throw new Error(`No slicer profile for ${printer.state.name}`);
  const copies = Math.max(1, Math.min(64, Math.round(Number(body.copies) || 1)));
  const result = await slicerCall('/slice', {
    input: library.filePath(item),
    vendor: profile.vendor,
    machine: profile.machine,
    process: body.process,
    filament: body.filament,
    copies,
    orient: !!body.orient,
    bedType: body.bedType,
    options: body.options || {},
    projectFilaments: /\.3mf$/i.test(item.name) ? projectFilaments(library.filePath(item)) : [],
    paintInfo: printer.cfg.type === 'anycubic',
  }, 25 * 60 * 1000);
  try {
    const layer = (/^(\d+\.\d+mm)/.exec(body.process || '') || [])[1] || 'custom';
    const material = tag((result.stats.material || 'PLA').split(';')[0]);
    const base = tag(item.name.replace(/\.[^.]+$/, ''));
    const name = `${base}_${tag(printer.state.id)}_${layer}_${material}${copies > 1 ? `_x${copies}` : ''}.gcode`;
    return await library.addFromStream(name, fs.createReadStream(result.output), {
      modelId: item.id,
      ...(item.folder ? { folder: item.folder } : {}),
      ...(item.tags ? { tags: item.tags } : {}),
      copies,
      slicedFor: printer.state.id,
      sliceSettings: { process: body.process, filament: body.filament, bedType: result.stats.bedType, options: body.options || {} },
      grams: result.stats.grams,
      colors: result.stats.colors,
      estimate: result.stats.time,
      bedType: result.stats.bedType,
      bedTemp: result.stats.bedTemp,
      nozzleTemp: result.stats.nozzleTemp,
    }, { newVersion: true });
  } finally {
    slicerCall('/cleanup', { id: result.id }).catch(() => {});
  }
}

// ---- HTTP helpers ------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

// ---- Sign-in -------------------------------------------------------------------

const COOKIE = 'hub_session';
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
  const i = c.indexOf('=');
  return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
}));
// Behind an HTTPS reverse proxy the cookie gets the Secure flag.
const isHttps = (req) => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function sessionCookie(req, token, maxAge) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge != null) attrs.push(`Max-Age=${maxAge}`);
  if (isHttps(req)) attrs.push('Secure');
  return attrs.join('; ');
}
const clearCookie = (req) => sessionCookie(req, '', 0);
// Behind a reverse proxy, count failed sign-ins per real client (X-Forwarded-For).
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === 'true' : !!config.trustProxy;
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

// Changes must come from the hub's own pages: browsers send Origin on
// cross-site POSTs, so a page elsewhere can't drive the printers with your cookie.
function sameOrigin(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true; // non-browser clients (curl, scripts)
  try { return new URL(src).host === req.headers.host; } catch { return false; }
}

// /api/auth/* and /api/users/*. Returns true when it handled the request.
async function authRoutes(req, res, url, parts, ctx) {
  const ip = clientIp(req);
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    return json(res, 200, {
      user: ctx?.user || null,
      setup: auth.needsSetup(),
      ...(ctx ? { hub: { version: HUB_VERSION, released: HUB_RELEASED } } : {}),
    }), true;
  }
  if (url.pathname === '/api/auth/setup' && req.method === 'POST') {
    const body = await readBody(req);
    const user = await auth.setup(body, ip);
    console.log(`First admin "${user.username}" created from ${ip}`);
    const { token, maxAge } = auth.createSession(auth.getUser(user.id), { remember: true, ip, userAgent: req.headers['user-agent'] });
    return json(res, 200, { user }, { 'Set-Cookie': sessionCookie(req, token, maxAge) }), true;
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { token, maxAge, session } = await auth.login(body, { ip, userAgent: req.headers['user-agent'] });
      return json(res, 200, { user: auth.publicUser(auth.getUser(session.userId)) }, { 'Set-Cookie': sessionCookie(req, token, maxAge) }), true;
    } catch (err) {
      console.warn(`Failed sign-in for "${String(body.username || '').slice(0, 40)}" from ${ip}`);
      return json(res, err.status || 400, { error: err.message }), true;
    }
  }
  if (parts[1] !== 'auth' && parts[1] !== 'users') return false;
  if (!ctx) return json(res, 401, { error: 'Sign in required' }), true;

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.logout(ctx);
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) }), true;
  }
  if (url.pathname === '/api/auth/password' && req.method === 'POST') {
    const body = await readBody(req);
    await auth.changeOwnPassword(ctx, body.current, body.password);
    return json(res, 200, { ok: true }), true;
  }
  if (parts[1] === 'auth' && parts[2] === 'sessions') {
    if (req.method === 'GET' && !parts[3]) return json(res, 200, auth.listSessions(ctx.user.id, ctx.sessionId)), true;
    if (req.method === 'DELETE' && !parts[3]) { auth.revokeOthers(ctx); return json(res, 200, { ok: true }), true; }
    if (req.method === 'DELETE') { auth.revoke(ctx.user.id, parts[3]); return json(res, 200, { ok: true }), true; }
  }
  if (parts[1] === 'users') {
    if (ctx.user.role !== 'admin') return json(res, 403, { error: 'Only admins can manage users' }), true;
    if (!parts[2] && req.method === 'GET') return json(res, 200, auth.listUsers()), true;
    if (!parts[2] && req.method === 'POST') return json(res, 200, await auth.createUser(await readBody(req))), true;
    if (parts[2] && req.method === 'PATCH') return json(res, 200, await auth.updateUser(parts[2], await readBody(req), ctx)), true;
    if (parts[2] && req.method === 'DELETE') { auth.deleteUser(parts[2], ctx); return json(res, 200, { ok: true }), true; }
  }
  return json(res, 404, { error: 'Not found' }), true;
}

// A file with Range support (videos must be seekable).
function sendFile(req, res, file, type, extra = {}) {
  let size;
  try { size = fs.statSync(file).size; } catch { return json(res, 404, { error: 'Not found' }); }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
  }
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}), ...SECURITY_HEADERS, ...extra,
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

// A preview image from the library (they never change, so browsers may cache them).
function sendThumb(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'No preview' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400', ...SECURITY_HEADERS });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

// Pipes an upstream camera/image URL through to the browser, so the page never
// needs direct access to printer ports (and works from outside the LAN via this host).
function proxy(req, res, source, { timeoutMs = 8000 } = {}) {
  if (!source) return json(res, 404, { error: 'Not available' });
  const lib = source.url.startsWith('https') ? https : http;
  // Range is passed through so videos can be seeked.
  const range = req.headers.range ? { Range: req.headers.range } : {};
  const upstream = lib.get(source.url, { headers: { ...(source.headers || {}), ...range }, rejectUnauthorized: false }, (up) => {
    const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    for (const [from, to] of [['content-type', 'Content-Type'], ['content-length', 'Content-Length'], ['content-range', 'Content-Range'], ['accept-ranges', 'Accept-Ranges']]) {
      if (up.headers[from]) headers[to] = up.headers[from];
    }
    res.writeHead(up.statusCode || 502, headers);
    up.pipe(res);
    upstream.setTimeout(0);
  });
  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) json(res, 502, { error: err.message });
    else res.destroy();
  });
  req.on('close', () => upstream.destroy());
}

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/jobs.js': ['public/jobs.js', 'text/javascript; charset=utf-8'],
  '/files.js': ['public/files.js', 'text/javascript; charset=utf-8'],
  '/preview.js': ['public/preview.js', 'text/javascript; charset=utf-8'],
  '/control.js': ['public/control.js', 'text/javascript; charset=utf-8'],
  '/account.js': ['public/account.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['public/theme.js', 'text/javascript; charset=utf-8'],
  '/setup.js': ['public/setup.js', 'text/javascript; charset=utf-8'],
  '/timelapses.js': ['public/timelapses.js', 'text/javascript; charset=utf-8'],
  '/login': ['public/login.html', 'text/html; charset=utf-8'],
  '/login.js': ['public/login.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/vendor/mpegts.js': ['node_modules/mpegts.js/dist/mpegts.js', 'text/javascript; charset=utf-8'],
};

// ---- Routes ------------------------------------------------------------------

const ACTIONS = {
  pause: (p) => p.pause(),
  resume: (p) => p.resume(),
  cancel: (p) => p.cancel(),
  clear: async (p) => {
    if (view(p.state).status !== 'completed') throw new Error('There’s no finished print to clear');
    await p.clear();
    cleared.set(p.state.id, p.state.job?.file || '');
    broadcast('printer', view(p.state));
  },
  light: (p, body) => p.setLight(!!body.on),
  control: (p, body) => p.control(body),
  slots: (p) => (p.refreshSlots ? p.refreshSlots() : p.state.slots),
  print: (p, body) => {
    if (!body.file) throw new Error('file is required');
    // Files the library knows are checked here; drivers check what the printer
    // itself reports (e.g. the Kobra X's per-file printer_model).
    const known = library.findByName(String(body.file));
    if (known && known.kind !== 'model') assertFits(known, p);
    return (async () => {
      // Remember grams per slot for this start so the job can charge the right rolls.
      const opts = await p.printOptions(String(body.file)).catch(() => null);
      const perSlot = withLibraryGrams(String(body.file), opts?.colors)?.map((c) => ({ slot: body.mapping?.[c.index] != null ? Number(body.mapping[c.index]) : c.slot, grams: c.grams || 0 })) ?? null;
      p.hubStart = { file: String(body.file), at: Date.now(), perSlot };
      return p.startPrint(String(body.file), { mapping: body.mapping, autoLevel: body.autoLevel });
    })();
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // three.js for the model preview: /vendor/three/three.module.js and /vendor/three/addons/...
  if (req.method === 'GET' && url.pathname.startsWith('/vendor/three/')) {
    const rel = url.pathname.slice('/vendor/three/'.length);
    const root = rel.startsWith('addons/') ? path.join(__dirname, 'node_modules/three/examples/jsm') : path.join(__dirname, 'node_modules/three/build');
    const file = path.resolve(root, rel.replace(/^addons\//, ''));
    if (!file.startsWith(root + path.sep) || !file.endsWith('.js')) return json(res, 404, { error: 'Not found' });
    return fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    });
  }

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(buf);
    });
  }

  if (parts[0] !== 'api') return json(res, 404, { error: 'Not found' });
  if (url.pathname === '/api/health') return json(res, 200, { ok: true });

  // Everything else under /api needs a signed-in user with a role that allows it.
  const ctx = auth.resolve(cookies(req)[COOKIE]);
  if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return json(res, 403, { error: 'Cross-site request refused' });
  try {
    if (await authRoutes(req, res, url, parts, ctx)) return;
  } catch (err) {
    return json(res, err.status || 400, { error: err.message });
  }
  if (!ctx) return json(res, 401, { error: 'Sign in required' }, { 'Set-Cookie': clearCookie(req) });
  if (!allowed(ctx.user.role, req.method, url.pathname)) return json(res, 403, { error: `Your account (${ctx.user.role}) can only watch, not change things` });

  if (url.pathname === '/api/printers' && req.method === 'GET') return json(res, 200, snapshot());

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: jobs\ndata: ${JSON.stringify(jobs.list())}\n\n`);
    res.write(`event: library\ndata: ${JSON.stringify(libraryView())}\n\n`);
    res.write(`event: folders\ndata: ${JSON.stringify(library.folders())}\n\n`);
    res.write(`event: spools\ndata: ${JSON.stringify(spools.list())}\n\n`);
    clients.set(res, ctx.sessionId);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  // /api/jobs, /api/jobs/:id, /api/jobs.csv
  if (url.pathname === '/api/jobs.csv' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="print-jobs.csv"' });
    return res.end(jobs.csv());
  }
  if (parts[1] === 'jobs') {
    try {
      if (!parts[2] && req.method === 'GET') return json(res, 200, jobs.list());
      if (!parts[2] && req.method === 'POST') {
        const body = await readBody(req);
        const p = body.printerId && printers.get(body.printerId);
        jobs.addManual({ ...body, printerName: p ? p.state.name : undefined });
        return json(res, 200, { ok: true });
      }
      if (parts[2] && req.method === 'PATCH') return json(res, 200, jobs.edit(parts[2], await readBody(req)));
      if (parts[2] && req.method === 'DELETE') { jobs.remove(parts[2]); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/timelapses[/:id[/video|/poster]], /api/timelapses/printers — recorded here, and the printers' own
  if (parts[1] === 'timelapses') {
    try {
      if (!parts[2] && req.method === 'GET') return json(res, 200, timelapses.list());
      if (parts[2] === 'printers' && req.method === 'GET') {
        // Timelapses stored on Klipper (moonraker-timelapse) and OctoPrint printers.
        const out = await Promise.all([...printers.values()].filter((p) => p.listTimelapses && p.state.online).map(async (p) => ({
          printerId: p.state.id, printerName: p.state.name,
          items: await Promise.race([p.listTimelapses(), new Promise((r) => setTimeout(() => r([]), 6000))]).catch(() => []),
        })));
        return json(res, 200, out.filter((p) => p.items.length));
      }
      const item = timelapses.get(parts[2]);
      if (parts[3] === 'video' && req.method === 'GET') {
        if (item.status !== 'ready') return json(res, 404, { error: 'Not ready' });
        const name = `${(item.file || 'timelapse').replace(/\.[^.]+$/, '')}_timelapse.mp4`;
        return sendFile(req, res, timelapses.videoPath(item), 'video/mp4',
          url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {});
      }
      if (parts[3] === 'poster' && req.method === 'GET') return sendFile(req, res, timelapses.posterPath(item), 'image/jpeg');
      if (!parts[3] && req.method === 'DELETE') { timelapses.remove(item.id); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/printer-setup[/:id], /types, /test — Settings → Printers (admins only)
  if (parts[1] === 'printer-setup') {
    try {
      if (parts[2] === 'types' && req.method === 'GET') {
        return json(res, 200, Object.entries(DRIVERS).map(([type, D]) => ({ type, ...D.meta })));
      }
      if (parts[2] === 'machines' && req.method === 'GET') {
        // OrcaSlicer's printer presets by vendor, for the "Slice with" picker.
        if (!machineList) machineList = await slicerCall('/machines', null, 20000);
        return json(res, 200, machineList);
      }
      if (parts[2] === 'test' && req.method === 'POST') {
        const body = await readBody(req);
        const prev = body.id ? printerStore.get(body.id) : null;
        return json(res, 200, await testPrinter(printerStore.clean(body, prev && prev.type === body.type ? prev : null)));
      }
      if (!parts[2] && req.method === 'GET') return json(res, 200, printerStore.list());
      if (!parts[2] && req.method === 'POST') return json(res, 200, printerStore.view(printerStore.add(await readBody(req))));
      if (parts[2] && req.method === 'PATCH') return json(res, 200, printerStore.view(printerStore.update(parts[2], await readBody(req))));
      if (parts[2] && req.method === 'DELETE') { printerStore.remove(parts[2]); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/spools, /api/spools/:id — filament rolls per printer slot
  if (parts[1] === 'spools') {
    try {
      if (!parts[2] && req.method === 'GET') return json(res, 200, spools.list());
      if (!parts[2] && req.method === 'POST') {
        const body = await readBody(req);
        if (!printers.has(body.printerId)) throw new Error('Unknown printer');
        return json(res, 200, spools.install(body));
      }
      if (parts[2] && req.method === 'PATCH') return json(res, 200, spools.adjust(parts[2], (await readBody(req)).remainingGrams));
      if (parts[2] && req.method === 'DELETE') { spools.remove(parts[2]); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/slicer, /api/slicer/profiles?printerId=
  if (parts[1] === 'slicer') {
    try {
      if (!parts[2]) {
        const h = await slicerHealth();
        const supported = [...printers.values()].filter((p) => slicerProfileFor(p)).map((p) => p.state.id);
        return json(res, 200, { available: h.available, version: h.version || null, step: !!h.step, error: h.error || null, printers: supported });
      }
      if (parts[2] === 'profiles') {
        const p = printers.get(url.searchParams.get('printerId'));
        if (!p) throw new Error('Unknown printer');
        const profile = slicerProfileFor(p);
        if (!profile) throw new Error(`No slicer profile for ${p.state.name}`);
        return json(res, 200, await slicerCall(`/profiles?vendor=${encodeURIComponent(profile.vendor)}&machine=${encodeURIComponent(profile.machine)}`));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/library, /api/library/:id[/download|/send|/slice]
  if (parts[1] === 'library') {
    try {
      if (!parts[2] && req.method === 'GET') return json(res, 200, libraryView());
      if (!parts[2] && req.method === 'POST') {
        const folder = folderPath(url.searchParams.get('folder'));
        return json(res, 200, await library.addFromStream(url.searchParams.get('name'), req, folder ? { folder } : {}));
      }
      if (parts[2] === 'folders') {
        if (req.method === 'GET') return json(res, 200, library.folders());
        const body = await readBody(req);
        if (req.method === 'POST') return json(res, 200, { folder: library.addFolder(body.folder) });
        if (req.method === 'PATCH') return json(res, 200, { folder: library.renameFolder(body.from, body.to) });
        if (req.method === 'DELETE') { library.removeFolder(body.folder); return json(res, 200, { ok: true }); }
        return json(res, 404, { error: 'Not found' });
      }
      const item = library.get(parts[2]);
      if (parts[3] === 'project' && req.method === 'GET') {
        return json(res, 200, /\.3mf$/i.test(item.name) ? projectFilaments(library.filePath(item)) : []);
      }
      if (parts[3] === 'thumb' && req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 4 * 1024 * 1024) throw new Error('Preview is too large');
          chunks.push(c);
        }
        library.setThumb(item.id, Buffer.concat(chunks));
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'thumb' && req.method === 'GET') {
        const p = library.thumbPath(item);
        return p ? sendThumb(res, p) : json(res, 404, { error: 'No preview' });
      }
      if (parts[3] === 'download' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': item.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        });
        return fs.createReadStream(library.filePath(item)).pipe(res);
      }
      if (parts[3] === 'slice' && req.method === 'POST') {
        const body = await readBody(req);
        const p = printers.get(body.printerId);
        if (!p) throw new Error('Unknown printer');
        if (item.kind !== 'model') throw new Error('Only models can be sliced');
        return json(res, 200, await sliceModel(item, p, body));
      }
      if (parts[3] === 'send' && req.method === 'POST') {
        const body = await readBody(req);
        const p = printers.get(body.printerId);
        if (!p) throw new Error('Unknown printer');
        await sendToPrinter(item, p);
        return json(res, 200, { ok: true, file: item.name });
      }
      if (!parts[3] && req.method === 'PATCH') {
        const oldName = item.name;
        const updated = library.update(item.id, await readBody(req));
        if (updated.name !== oldName) jobs.renamedFile(oldName, updated.name);
        return json(res, 200, updated);
      }
      if (!parts[3] && req.method === 'DELETE') { library.remove(item.id); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/printers/:id/:resource
  const printer = parts[1] === 'printers' && printers.get(parts[2]);
  if (!printer) return json(res, 404, { error: 'Unknown printer' });
  const resource = parts[3];

  try {
    if (req.method === 'GET') {
      if (resource === 'camera') {
        if (printer.serveCamera) return printer.serveCamera(req, res);
        return proxy(req, res, printer.cameraSource());
      }
      if (resource === 'snapshot') return proxy(req, res, printer.snapshotSource());
      if (resource === 'timelapse') {
        const name = url.searchParams.get('name') || '';
        if (!printer.timelapseSource || !name || name.includes('..')) return json(res, 404, { error: 'Not found' });
        return proxy(req, res, printer.timelapseSource(name), { timeoutMs: 30000 });
      }
      if (resource === 'thumb') {
        const source = printer.thumbSource();
        if (source) return proxy(req, res, source);
        const own = library.thumbPath(printer.state.job && library.findByName(printer.state.job.file));
        if (own) return sendThumb(res, own);
        return json(res, 404, { error: 'No preview' });
      }
      if (resource === 'files') return json(res, 200, await printer.listFiles());
      if (resource === 'print-options') return json(res, 200, await printer.printOptions(String(url.searchParams.get('file') || '')));
    }
    // Upload from the browser: kept in the library, then sent to the printer.
    if (req.method === 'POST' && resource === 'upload') {
      const item = await library.addFromStream(url.searchParams.get('name'), req);
      if (item.kind === 'model') return json(res, 200, { ok: true, model: true, file: item.name, libraryId: item.id });
      try {
        await sendToPrinter(item, printer);
      } catch (err) {
        throw new Error(`Saved to the library, but the printer didn't take it: ${err.message}`);
      }
      return json(res, 200, { ok: true, file: item.name, libraryId: item.id });
    }
    if (req.method === 'POST' && ACTIONS[resource]) {
      await ACTIONS[resource](printer, await readBody(req));
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

// HUB_RESET_PASSWORD=<username> sets a new random password for that user at
// startup and prints it to the log (for a forgotten admin password). Remove the
// variable again afterwards.
async function resetFromEnv() {
  const name = process.env.HUB_RESET_PASSWORD;
  if (!name) return;
  const user = auth.users.find((u) => u.username === name.trim().toLowerCase());
  if (!user) return console.warn(`HUB_RESET_PASSWORD: no user "${name}"`);
  const pw = require('node:crypto').randomBytes(9).toString('base64url');
  await auth.updateUser(user.id, { password: pw });
  console.log(`
*** Password for "${user.username}" reset to: ${pw}
*** Sign in, change it under Account, and remove HUB_RESET_PASSWORD.
`);
}

server.listen(port, async () => {
  console.log(`Printer Hub running at http://localhost:${port}`);
  await resetFromEnv().catch((err) => console.error('Password reset failed:', err.message));
  if (auth.needsSetup()) console.log(`
*** First run: open the hub and create the admin account with setup code ${auth.issueSetupCode()}
`);
  started = true;
  if (!printers.size) console.log('No printers yet: add them in the hub under Settings → Printers.');
  for (const p of printers.values()) {
    console.log(`  - ${p.state.name} (${p.cfg.type}${p.cfg.host ? ' @ ' + p.cfg.host : ''})`);
    p.start();
  }
});

process.on('SIGINT', async () => {
  await Promise.all([...printers.values()].map((p) => p.stop()));
  process.exit(0);
});
