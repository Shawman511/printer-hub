const grid = document.getElementById('grid');
const tpl = document.getElementById('card-tpl');
const cards = new Map(); // id -> { el, state, camKind, player }

const STATUS_LABEL = {
  offline: 'Offline', idle: 'Ready', preparing: 'Preparing', heating: 'Heating', printing: 'Printing', pausing: 'Pausing',
  paused: 'Paused', cancelling: 'Cancelling', completed: 'Done', busy: 'Busy', error: 'Error',
};
const ACTIVE = ['printing', 'pausing', 'paused', 'heating'];

// ---- Formatting -----------------------------------------------------------------

function dur(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
// "Auto-leveling · Est. print time 1h 23m" for a printer getting ready to print.
const prepLine = (job) => [job.stage || 'Getting ready', job.estimate && `Est. print time ${dur(job.estimate)}`].filter(Boolean).join(' · ');
// The print's preview beside its name; the image only reloads when the file changes.
function setThumb(img, state) {
  const job = state.job;
  const want = job?.thumb ? `/api/printers/${encodeURIComponent(state.id)}/thumb?f=${encodeURIComponent(job.file)}` : '';
  if (img.dataset.src === want) return;
  img.dataset.src = want;
  img.hidden = !want;
  if (want) { img.onerror = () => { img.hidden = true; }; img.src = want; } else img.removeAttribute('src');
}
const deg = (t) => (t == null ? '—' : `${Math.round(t)}°`);

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

// "340 MB", for file sizes and totals.
function bytesText(b) {
  if (b == null) return '—';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) Account.toLogin();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- Camera ---------------------------------------------------------------------

// Removing an <img> doesn't end its MJPEG download; blank the source first, or
// leaked streams pile up until the browser's per-host connection limit stalls
// every other request to the hub.
function stopMedia(el) {
  if (el.tagName === 'IMG') { el.onload = el.onerror = null; el.src = 'data:,'; }
  else if (el.tagName === 'VIDEO') { el.removeAttribute('src'); el.load(); }
  el.remove();
}

// ---- Camera crop: show only part of the frame (set per printer in the control
// panel). The image is scaled and shifted so the crop fills the box.
const cropObserver = new ResizeObserver((entries) => entries.forEach((e) => layoutCrop(e.target)));

function setCrop(cam, crop) {
  const key = crop ? [crop.x, crop.y, crop.w, crop.h].join(',') : '';
  if (cam.dataset.crop === key) return;
  cam.dataset.crop = key;
  cam.crop = crop || null;
  cam.classList.toggle('cropped', !!crop);
  if (crop) cropObserver.observe(cam); else cropObserver.unobserve(cam);
  layoutCrop(cam);
}

function layoutCrop(cam) {
  const media = cam.querySelector(':scope > img, :scope > video');
  if (!media) return;
  const crop = cam.crop;
  const sw = media.naturalWidth || media.videoWidth, sh = media.naturalHeight || media.videoHeight;
  if (!crop || !sw || !sh) { media.removeAttribute('style'); return; }
  const cw = cam.clientWidth, ch = cam.clientHeight;
  const k = Math.min(cw / (crop.w * sw), ch / (crop.h * sh));
  Object.assign(media.style, {
    position: 'absolute', maxWidth: 'none', objectFit: 'fill',
    width: `${sw * k}px`, height: `${sh * k}px`,
    left: `${(cw - crop.w * sw * k) / 2 - crop.x * sw * k}px`,
    top: `${(ch - crop.h * sh * k) / 2 - crop.y * sh * k}px`,
  });
}

function mountCamera(card) {
  const { el, state } = card;
  const cam = el.querySelector('.cam');
  if (card.camKind === state.camera) return;
  card.player?.destroy();
  card.player = null;
  cam.querySelectorAll('img, video').forEach(stopMedia);
  cam.classList.remove('has-feed');
  card.camKind = state.camera;
  if (!state.camera) return;

  const src = `/api/printers/${encodeURIComponent(state.id)}/camera`;
  if (state.camera === 'mjpeg') {
    const img = new Image();
    img.alt = `${state.name} camera`;
    img.onload = () => { cam.classList.add('has-feed'); layoutCrop(cam); };
    img.onerror = () => fallbackSnapshots(card);
    img.src = src;
    cam.prepend(img);
  } else if (state.camera === 'flv' && window.mpegts?.isSupported()) {
    const video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    cam.prepend(video);
    const player = mpegts.createPlayer({ type: 'flv', isLive: true, url: src }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
    player.attachMediaElement(video);
    player.on(mpegts.Events.ERROR, () => fallbackSnapshots(card));
    video.addEventListener('playing', () => cam.classList.add('has-feed'), { once: true });
    video.addEventListener('loadedmetadata', () => layoutCrop(cam));
    player.load();
    video.play().catch(() => {});
    card.player = { destroy: () => { player.destroy(); } };
  }
}

// When a live stream fails, poll still snapshots instead (and retry the stream later).
function fallbackSnapshots(card) {
  const cam = card.el.querySelector('.cam');
  card.player?.destroy();
  cam.querySelectorAll('img, video').forEach(stopMedia);
  cam.classList.remove('has-feed');
  const img = new Image();
  img.alt = `${card.state.name} camera snapshot`;
  img.onload = () => { cam.classList.add('has-feed'); layoutCrop(cam); };
  cam.prepend(img);
  const base = `/api/printers/${encodeURIComponent(card.state.id)}/snapshot`;
  let failures = 0;
  const refresh = () => { img.src = `${base}?t=${Date.now()}`; };
  img.onerror = () => { cam.classList.remove('has-feed'); failures++; };
  refresh();
  const timer = setInterval(() => {
    if (failures > 5) { clearInterval(timer); retry(); return; }
    refresh();
  }, 2000);
  const retry = () => setTimeout(() => { card.camKind = null; mountCamera(card); }, 30000);
  card.player = { destroy: () => clearInterval(timer) };
}

// ---- Cards ----------------------------------------------------------------------

function createCard(state) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const card = { el, state, camKind: undefined, player: null };
  const id = encodeURIComponent(state.id);

  const run = (btn, action, body) => async () => {
    btn.disabled = true;
    try { await api(`/api/printers/${id}/${action}`, { body: body ? body() : {} }); }
    catch (err) { toast(`${card.state.name}: ${err.message}`, true); }
    finally { btn.disabled = false; }
  };

  const q = (s) => el.querySelector(s);
  q('.act-pause').onclick = run(q('.act-pause'), 'pause');
  q('.act-resume').onclick = run(q('.act-resume'), 'resume');
  q('.act-clear').onclick = run(q('.act-clear'), 'clear');
  q('.act-light').onclick = run(q('.act-light'), 'light', () => ({ on: !card.state.light }));
  q('.act-cancel').onclick = () => confirmCancel(card, run(q('.act-cancel'), 'cancel'));
  q('.act-print').onclick = () => Files.openPrinterFiles(card.state.id);
  q('.cam-full').onclick = () => q('.cam').requestFullscreen?.();

  q('.act-controls').href = `#control/${id}`;

  cards.set(state.id, card);
  grid.append(el);
  Jobs.syncPrinters();
  Files.renderLibrary();
  if (pendingControl === state.id) { pendingControl = null; setTimeout(() => Control.open(state.id)); }
  return card;
}

function render(state) {
  const card = cards.get(state.id) || createCard(state);
  card.state = state;
  const { el } = card;
  const q = (s) => el.querySelector(s);
  const s = state.status;

  el.dataset.s = s;
  el.classList.toggle('offline', !state.online);
  q('.name').textContent = state.name;
  q('.model').textContent = [state.model, state.host].filter(Boolean).join(' · ') || state.type;
  q('.pill').textContent = STATUS_LABEL[s] || s;
  q('.pill').dataset.s = s;

  const job = state.job;
  q('.job').hidden = !job;
  q('.nojob').hidden = !!job;
  q('.nojob').textContent = state.online ? 'No active job' : 'Waiting for printer…';
  if (job) {
    const prep = s === 'preparing';
    q('.file').textContent = prep ? `Preparing ${job.file || 'print'}` : job.file || 'Untitled';
    q('.file').title = job.file || '';
    setThumb(q('.job-thumb'), state);
    q('.stage').hidden = !prep;
    q('.stage').textContent = prep ? prepLine(job) : '';
    q('.fill').style.width = `${Math.min(100, job.progress || 0)}%`;
    q('.pct').textContent = `${(job.progress || 0).toFixed(job.progress % 1 ? 1 : 0)}%`;
    q('.layer').textContent = job.totalLayers ? `${job.layer} / ${job.totalLayers}` : '—';
    q('.elapsed').textContent = dur(job.elapsed);
    q('.remaining').textContent = ACTIVE.includes(s) ? dur(job.remaining) : prep && job.estimate ? `~${dur(job.estimate)}` : '—';
  }

  const temps = q('.temps');
  const entries = Object.entries(state.temps || {});
  temps.hidden = !state.online || !entries.length;
  temps.replaceChildren(...entries.map(([k, t]) => {
    const d = document.createElement('div');
    d.className = 'temp';
    d.innerHTML = `<span class="k"></span><span class="v"></span>`;
    d.firstChild.textContent = k[0].toUpperCase() + k.slice(1);
    d.lastChild.innerHTML = `${deg(t.cur)}${t.target ? ` <small>/ ${deg(t.target)}</small>` : ''}`;
    return d;
  }));

  q('.err').hidden = !state.error;
  q('.err').textContent = state.error || '';

  const caps = state.capabilities || {};
  const on = state.online;
  q('.act-pause').hidden = !(on && caps.pause && (s === 'printing' || s === 'heating'));
  q('.act-resume').hidden = !(on && caps.resume && s === 'paused');
  q('.act-cancel').hidden = !(on && caps.cancel && ['preparing', 'printing', 'heating', 'pausing', 'paused'].includes(s));
  q('.act-clear').hidden = !(on && s === 'completed');
  q('.act-print').hidden = !(on && caps.files && ['idle', 'completed'].includes(s));
  q('.act-light').hidden = !(on && caps.light && state.light != null);
  q('.act-light').setAttribute('aria-checked', String(!!state.light));
  q('.act-light').tabIndex = document.body.dataset.role === 'viewer' ? -1 : 0; // shown, not switchable
  q('.act-light').title = state.light ? 'Light is on. Click to turn it off.' : 'Light is off. Click to turn it on.';

  setCrop(q('.cam'), state.cameraCrop);
  q('.cam').classList.toggle('rec', Timelapses.recording(state.id));
  // The dashboard and control view each hold a camera stream; only run the visible one.
  if (document.querySelector('.view[data-view="control"]').hidden) mountCamera(card);
  else { card.player?.destroy(); card.player = null; card.camKind = undefined; card.el.querySelectorAll('.cam img, .cam video').forEach(stopMedia); }
  Control.onState(state);
  updateSummary();
  const key = `${state.online}:${state.status}`;
  if (card.statusKey !== key) { card.statusKey = key; Files.renderLibrary(); }
}

// The full printer list after one was added, changed or removed in Settings.
function setPrinters(list) {
  const ids = new Set(list.map((p) => p.id));
  for (const [id, card] of cards) {
    if (ids.has(id)) continue;
    card.player?.destroy();
    card.el.querySelectorAll('.cam img, .cam video').forEach(stopMedia);
    card.el.remove();
    cards.delete(id);
    if (Control.printerId === id && location.hash.startsWith('#control')) location.hash = '#printers';
  }
  list.forEach(render);
  updateSummary();
  if (!document.querySelector('.view[data-view~="settings"]').hidden) Setup.render();
}

// What the dashboard says when there are no printers yet.
function updateEmpty() {
  let empty = document.getElementById('grid-empty');
  if (cards.size) { empty?.remove(); return; }
  if (!empty) {
    empty = document.createElement('div');
    empty.id = 'grid-empty';
    empty.className = 'grid-empty';
    grid.append(empty);
  }
  const admin = document.body.dataset.role === 'admin';
  empty.innerHTML = admin
    ? '<h2>Connect your first printer</h2><p>Printer Hub works with Klipper (Moonraker), OctoPrint, Prusa (PrusaLink), FlashForge Adventurer 5M and Anycubic Kobra X printers on your network.</p><a class="btn primary" href="#settings/add">Add a printer</a>'
    : '<h2>No printers yet</h2><p>An admin needs to add printers in Settings.</p>';
}

function updateSummary() {
  updateEmpty();
  const all = [...cards.values()].map((c) => c.state);
  const printing = all.filter((p) => ['preparing', 'printing', 'heating', 'pausing'].includes(p.status)).length;
  const paused = all.filter((p) => p.status === 'paused').length;
  const offline = all.filter((p) => !p.online).length;
  const parts = [`${printing} printing`];
  if (paused) parts.push(`${paused} paused`);
  if (offline) parts.push(`${offline} offline`);
  document.getElementById('summary').textContent = `${all.length} printers · ${parts.join(' · ')}`;
}

// ---- Dialogs --------------------------------------------------------------------

function confirmCancel(card, go) {
  const dlg = document.getElementById('confirm-dlg');
  dlg.querySelector('.confirm-title').textContent = `Cancel print on ${card.state.name}?`;
  dlg.querySelector('.confirm-text').textContent = `${card.state.job?.file || 'The current job'} will be stopped. This can't be undone.`;
  dlg.onclose = () => { if (dlg.returnValue === 'yes') go(); };
  dlg.showModal();
}

// ---- Views ----------------------------------------------------------------------

function showView() {
  // The old Totals page is now a tab of the job log.
  if (location.hash === '#totals') history.replaceState(null, '', '#jobs/items');
  const [view, arg] = (location.hash.slice(1) || 'printers').split('/');
  const known = ['printers', 'control', 'library', 'jobs', 'timelapses', 'account', 'settings', 'users', 'storage'].includes(view) ? view : 'printers';
  if (known === 'control') {
    // Printers arrive over SSE; open once the card exists.
    const id = decodeURIComponent(arg || '');
    if (cards.has(id)) Control.open(id); else pendingControl = id;
  } else {
    Control.close();
  }
  const navFor = { control: 'printers', users: 'settings', storage: 'settings' }[known] || known;
  document.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === navFor ? 'page' : 'false'));
  document.querySelectorAll('.view').forEach((el) => { el.hidden = !el.dataset.view.split(' ').includes(known); });
  if (known === 'jobs') Jobs.show(arg);
  if (known === 'library') Files.renderLibrary();
  if (known === 'account') Account.renderAccount();
  if (known === 'users') Account.renderUsers();
  if (known === 'storage') renderStorage();
  if (known === 'timelapses') Timelapses.render();
  if (known === 'settings') {
    Setup.render();
    if (arg === 'add') { history.replaceState(null, '', '#settings'); Setup.open(); }
  }
  document.getElementById('me').setAttribute('aria-current', known === 'account' ? 'page' : 'false');
}
let pendingControl = null;

// Settings → Storage: what the hub keeps on disk.
async function renderStorage() {
  const body = document.getElementById('storage-body');
  try {
    const s = await api('/api/storage');
    const row = (label, href, count, bytes, strong) => {
      const tr = document.createElement('tr');
      const what = document.createElement('td');
      if (href) what.append(Object.assign(document.createElement('a'), { href, textContent: label }));
      else what.textContent = label;
      const n = Object.assign(document.createElement('td'), { className: 'num', textContent: count == null ? '' : count.toLocaleString() });
      const size = Object.assign(document.createElement('td'), { className: `num nowrap${strong ? ' strong' : ''}`, textContent: bytesText(bytes) });
      tr.append(what, n, size);
      return tr;
    };
    body.replaceChildren(
      row('Print files', '#library', s.printFiles.count, s.printFiles.bytes),
      row('Models', '#library', s.models.count, s.models.bytes),
      row('Timelapses', '#timelapses', s.timelapses.count, s.timelapses.bytes),
      row('Everything else (settings, job log)', null, null, s.other.bytes),
      row('Total', null, null, s.total, true),
    );
    document.getElementById('storage-free').textContent = s.disk ? `${bytesText(s.disk.free)} free of ${bytesText(s.disk.size)} on this disk.` : '';
  } catch (err) { toast(err.message, true); }
}
window.addEventListener('hashchange', showView);

// ---- Live updates ---------------------------------------------------------------

function connect() {
  const conn = document.getElementById('conn');
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => { conn.classList.add('live'); setPrinters(JSON.parse(e.data)); });
  es.addEventListener('printers', (e) => setPrinters(JSON.parse(e.data)));
  es.addEventListener('timelapses', (e) => Timelapses.setAll(JSON.parse(e.data)));
  es.addEventListener('printer', (e) => render(JSON.parse(e.data)));
  es.addEventListener('jobs', (e) => Jobs.setAll(JSON.parse(e.data)));
  es.addEventListener('job', (e) => Jobs.upsert(JSON.parse(e.data)));
  es.addEventListener('library', (e) => Files.setLibrary(JSON.parse(e.data)));
  es.addEventListener('folders', (e) => Files.setFolders(JSON.parse(e.data)));
  es.addEventListener('spools', (e) => Control.setSpools(JSON.parse(e.data)));
  es.onerror = async () => {
    conn.classList.remove('live'); // EventSource reconnects on its own...
    // ...unless the session ended (signed out elsewhere, or the account was removed).
    if (!(await Account.load())) es.close();
  };
}

// Signed-in check first; the sign-in page sends the browser back here after.
Account.load().then((me) => { if (me) { showView(); connect(); } });
