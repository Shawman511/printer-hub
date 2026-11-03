// Per-printer control view (#control/<id>): camera, status, jog, temperatures,
// fans, speed and filament slots. Uses api(), toast(), dur(), deg(), prepLine(), setThumb(), setCrop(), cards,
// mountCamera(), confirmCancel() and STATUS_LABEL from app.js.
const Control = (() => {
  const $ = (id) => document.getElementById(id);
  const root = document.querySelector('.view[data-view="control"]');
  const enc = encodeURIComponent;
  // A card-shaped object so app.js's mountCamera() can drive this view's camera.
  const view = { el: root, state: null, camKind: undefined, player: null };
  let printerId = null;
  let step = 10;
  let uploadMode = 'upload';
  let cropping = null; // crop being drawn: { x, y, w, h } as fractions of the frame
  const editing = new Set(); // inputs the user is touching; don't overwrite them from live updates

  const BUSY = ['preparing', 'printing', 'pausing', 'paused', 'heating', 'cancelling', 'busy'];

  async function send(cmd, label) {
    try {
      await api(`/api/printers/${enc(printerId)}/control`, { body: cmd });
      if (label) toast(label);
    } catch (err) { toast(err.message, true); }
  }

  // ---- Open / close -------------------------------------------------------------

  function open(id) {
    if (!cards.has(id)) { location.hash = '#printers'; return; }
    if (printerId !== id) {
      close();
      printerId = id;
      view.camKind = undefined;
    }
    syncPrinterSelect();
    render(cards.get(id).state, true);
  }

  function close() {
    view.player?.destroy();
    view.player = null;
    root.querySelector('.ctl-cam').querySelectorAll('img, video').forEach(stopMedia);
    root.querySelector('.ctl-cam').classList.remove('has-feed');
    view.camKind = undefined;
  }

  function syncPrinterSelect() {
    const sel = $('ctl-printer');
    sel.replaceChildren(...[...cards.values()].map((c) => new Option(c.state.name, c.state.id)));
    sel.value = printerId;
  }

  // ---- Rendering ----------------------------------------------------------------

  function render(state, force = false) {
    if (state.id !== printerId) return;
    view.state = state;
    const s = state.status;
    const job = state.job;
    const caps = state.capabilities || {};
    const ctl = caps.control || {};
    const busy = BUSY.includes(s);

    $('ctl-name').textContent = state.name;
    $('ctl-pill').textContent = STATUS_LABEL[s] || s;
    $('ctl-pill').dataset.s = s;
    root.dataset.s = s;
    const prep = s === 'preparing' && job;
    $('ctl-file-name').textContent = prep ? `Preparing ${job.file || 'print'}` : job?.file || (state.online ? 'No active job' : 'Printer offline');
    setThumb($('ctl-thumb'), state);
    $('ctl-stage').hidden = !prep;
    $('ctl-stage').textContent = prep ? prepLine(job) : '';
    $('ctl-file-name').title = job?.file || '';
    $('ctl-fill').style.width = `${Math.min(100, job?.progress || 0)}%`;
    $('ctl-pct').textContent = job ? `${(job.progress || 0).toFixed(job.progress % 1 ? 1 : 0)}%` : '—';
    $('ctl-layer').textContent = job?.totalLayers ? `${job.layer} / ${job.totalLayers}` : '—';
    // While preparing, the slicer estimate stands in (marked ~: setup time isn't included).
    const remaining = job && BUSY.includes(s) ? job.remaining || (prep ? job.estimate : null) : null;
    const approx = prep && !job.remaining ? '~' : '';
    $('ctl-remaining').textContent = remaining ? approx + dur(remaining) : '—';
    $('ctl-eta').textContent = remaining
      ? approx + new Date(Date.now() + remaining * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : '—';
    $('ctl-err').hidden = !state.error;
    $('ctl-err').textContent = state.error || '';

    const act = (name) => root.querySelector(`[data-act="${name}"]`);
    act('pause').hidden = !(state.online && (s === 'printing' || (s === 'heating' && caps.pauseWhileHeating !== false)));
    act('resume').hidden = !(state.online && s === 'paused');
    act('clear').hidden = !(state.online && s === 'completed');
    act('cancel').hidden = !(state.online && ['preparing', 'printing', 'heating', 'pausing', 'paused'].includes(s));
    act('light').hidden = !(state.online && caps.light && state.light != null);
    act('light').setAttribute('aria-checked', String(!!state.light));
    act('light').title = state.light ? 'Light is on. Click to turn it off.' : 'Light is off. Click to turn it on.';
    act('motorsOff').hidden = !ctl.motorsOff;
    act('motorsOff').disabled = busy || !state.online;

    // Motion
    const canMove = state.online && ctl.jog && !busy;
    root.querySelectorAll('.ctl-motion .wedge, .ctl-motion .hub, .ctl-motion button').forEach((el) => {
      if (el.closest('#ctl-step')) return;
      el.classList.toggle('disabled', !canMove);
      if (el.tagName === 'BUTTON') el.disabled = !canMove;
      el.setAttribute('aria-disabled', String(!canMove));
    });
    $('ctl-motion-note').textContent = !state.online ? 'Printer offline.'
      : busy ? 'Movement is locked while a print is running.'
        : 'Home the axes before moving. Moves are relative, in mm.';

    renderTemps(state, ctl, force);
    renderFans(state, ctl, force);
    renderSpeed(state, force);
    renderSlots(state);
    mountCamera(view);
    if (!cropping) setCrop(root.querySelector('.ctl-cam'), state.cameraCrop);
  }

  // ---- Camera crop editor (admins) ---------------------------------------------
  // Shows the whole frame; drag a box over it to pick what every view shows.

  function frameRect() {
    const cam = root.querySelector('.ctl-cam');
    const media = cam.querySelector(':scope > img, :scope > video');
    const sw = media?.naturalWidth || media?.videoWidth, sh = media?.naturalHeight || media?.videoHeight;
    if (!sw || !sh) return null;
    const k = Math.min(cam.clientWidth / sw, cam.clientHeight / sh);
    return { x: (cam.clientWidth - sw * k) / 2, y: (cam.clientHeight - sh * k) / 2, w: sw * k, h: sh * k };
  }

  function drawCropBox() {
    const box = $('ctl-crop-box');
    const r = frameRect();
    box.hidden = !cropping || !r;
    if (box.hidden) return;
    Object.assign(box.style, {
      left: `${r.x + cropping.x * r.w}px`, top: `${r.y + cropping.y * r.h}px`,
      width: `${cropping.w * r.w}px`, height: `${cropping.h * r.h}px`,
    });
  }

  function endCrop() {
    cropping = null;
    $('ctl-crop-editor').hidden = true;
    root.querySelector('.ctl-cam').classList.remove('editing-crop');
    setCrop(root.querySelector('.ctl-cam'), view.state?.cameraCrop);
  }

  async function saveCrop(crop) {
    try {
      await api(`/api/printer-setup/${enc(printerId)}`, { method: 'PATCH', body: { cameraCrop: crop } });
      toast(crop ? 'Camera crop saved' : 'Showing the full camera frame');
      view.state.cameraCrop = crop; // the live update follows
      endCrop();
    } catch (err) { toast(err.message, true); }
  }

  function initCrop() {
    const cam = root.querySelector('.ctl-cam');
    const editor = $('ctl-crop-editor');
    $('ctl-crop').addEventListener('click', () => {
      if (!frameRect()) { toast('Wait for the camera picture first', true); return; }
      cropping = view.state?.cameraCrop ? { ...view.state.cameraCrop } : { x: 0, y: 0, w: 1, h: 1 };
      setCrop(cam, null); // show the whole frame while choosing
      cam.classList.add('editing-crop');
      editor.hidden = false;
      requestAnimationFrame(drawCropBox);
    });
    $('ctl-crop-cancel').addEventListener('click', endCrop);
    $('ctl-crop-reset').addEventListener('click', () => saveCrop(null));
    $('ctl-crop-save').addEventListener('click', () => saveCrop(cropping));

    let start = null;
    const at = (e) => {
      const r = frameRect(), b = cam.getBoundingClientRect();
      const clamp = (v) => Math.min(1, Math.max(0, v));
      return { x: clamp((e.clientX - b.left - r.x) / r.w), y: clamp((e.clientY - b.top - r.y) / r.h) };
    };
    editor.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.crop-bar') || !frameRect()) return;
      start = at(e);
      editor.setPointerCapture(e.pointerId);
    });
    editor.addEventListener('pointermove', (e) => {
      if (!start) return;
      const p = at(e);
      cropping = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      drawCropBox();
    });
    editor.addEventListener('pointerup', () => {
      start = null;
      if (cropping && (cropping.w < 0.05 || cropping.h < 0.05)) { cropping = { x: 0, y: 0, w: 1, h: 1 }; drawCropBox(); }
    });
  }

  function heaterRow(key, label, t, max) {
    let row = $(`ctl-temp-${key}`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'ctl-row';
      row.id = `ctl-temp-${key}`;
      row.innerHTML = `
        <span class="ctl-row-label"></span>
        <span class="ctl-row-cur"></span>
        <input type="range" min="0" step="1" aria-label="">
        <input type="number" min="0" step="1" class="ctl-num" aria-label="">
        <button type="button" class="btn small">Set</button>`;
      const [range, num, btn] = row.querySelectorAll('input, button');
      const sync = (from, to) => { to.value = from.value; };
      for (const el of [range, num]) {
        el.addEventListener('focus', () => editing.add(row.id));
        el.addEventListener('blur', () => setTimeout(() => editing.delete(row.id), 300));
      }
      range.addEventListener('input', () => sync(range, num));
      num.addEventListener('input', () => sync(num, range));
      range.addEventListener('change', () => apply());
      num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
      btn.addEventListener('click', () => apply());
      const apply = () => {
        editing.delete(row.id);
        send({ action: 'temp', heater: key, target: Number(num.value) }, `${label} → ${num.value}°C`);
      };
      $('ctl-temps').append(row);
    }
    const [range, num] = row.querySelectorAll('input');
    row.querySelector('.ctl-row-label').textContent = label;
    row.querySelector('.ctl-row-cur').innerHTML = `${deg(t?.cur)} <small>/ ${t?.target ? deg(t.target) : 'off'}</small>`;
    range.max = num.max = max;
    range.setAttribute('aria-label', `${label} target`);
    num.setAttribute('aria-label', `${label} target °C`);
    if (!editing.has(row.id)) range.value = num.value = Math.round(t?.target || 0);
    row.style.setProperty('--fill', `${Math.min(100, ((t?.cur || 0) / max) * 100)}%`);
  }

  function renderTemps(state, ctl) {
    const limits = ctl.limits || { nozzle: 300, bed: 110 };
    const heaters = ctl.temps || [];
    if (!heaters.length) { $('ctl-temps').innerHTML = '<p class="dlg-hint">Temperature control isn’t available for this printer.</p>'; return; }
    if (heaters.includes('nozzle')) heaterRow('nozzle', 'Nozzle', state.temps?.nozzle, limits.nozzle);
    if (heaters.includes('bed')) heaterRow('bed', 'Bed', state.temps?.bed, limits.bed);
    if (state.temps?.chamber) {
      let row = $('ctl-temp-chamber');
      if (!row) {
        row = Object.assign(document.createElement('div'), { className: 'ctl-row readonly', id: 'ctl-temp-chamber' });
        row.innerHTML = '<span class="ctl-row-label">Chamber</span><span class="ctl-row-cur"></span>';
        $('ctl-temps').append(row);
      }
      row.querySelector('.ctl-row-cur').textContent = deg(state.temps.chamber.cur);
    }
    $('ctl-presets').hidden = !state.online;
  }

  function renderFans(state, ctl) {
    const box = $('ctl-fans');
    const settable = new Set(ctl.fans || []);
    const fans = { part: state.fans?.part ?? null, ...state.fans };
    const labels = { part: 'Part fan', aux: 'Aux fan', chamber: 'Chamber fan' };
    for (const [key, pct] of Object.entries(fans)) {
      if (pct == null && !settable.has(key)) continue;
      const id = `ctl-fan-${key}`;
      let row = $(id);
      if (!row) {
        row = Object.assign(document.createElement('div'), { className: 'ctl-row fan', id });
        row.innerHTML = `<span class="ctl-row-label"></span><span class="ctl-row-cur"></span>${settable.has(key) ? '<input type="range" min="0" max="100" step="5">' : ''}`;
        const range = row.querySelector('input');
        if (range) {
          range.addEventListener('pointerdown', () => editing.add(id));
          range.addEventListener('input', () => { row.querySelector('.ctl-row-cur').textContent = `${range.value}%`; });
          range.addEventListener('change', () => {
            editing.delete(id);
            send({ action: 'fan', fan: key, pct: Number(range.value) }, `${labels[key]} → ${range.value}%`);
          });
          range.setAttribute('aria-label', `${labels[key] || key} speed`);
        }
        box.append(row);
      }
      row.querySelector('.ctl-row-label').textContent = labels[key] || key;
      const range = row.querySelector('input');
      if (!editing.has(id)) {
        row.querySelector('.ctl-row-cur').textContent = pct == null ? '—' : `${Math.round(pct)}%`;
        if (range) range.value = Math.round(pct || 0);
      }
      if (range) range.disabled = !state.online;
    }
  }

  function renderSpeed(state) {
    const box = $('ctl-speed');
    const sp = state.speed;
    if (!sp) { box.replaceChildren(); box.dataset.kind = ''; return; }
    if (box.dataset.kind !== sp.kind) {
      box.dataset.kind = sp.kind;
      box.replaceChildren();
      const label = Object.assign(document.createElement('span'), { className: 'ctl-row-label', textContent: 'Print speed' });
      const row = Object.assign(document.createElement('div'), { className: 'ctl-row speed' });
      row.append(label);
      if (sp.kind === 'mode') {
        const seg = Object.assign(document.createElement('div'), { className: 'seg', role: 'radiogroup' });
        seg.setAttribute('aria-label', 'Print speed mode');
        for (const o of sp.options) {
          const b = Object.assign(document.createElement('button'), { type: 'button', textContent: o.label });
          b.dataset.value = o.value;
          b.setAttribute('role', 'radio');
          b.onclick = () => send({ action: 'speed', value: o.value }, `Speed → ${o.label}`);
          seg.append(b);
        }
        row.append(seg);
      } else {
        const cur = Object.assign(document.createElement('span'), { className: 'ctl-row-cur' });
        const range = Object.assign(document.createElement('input'), { type: 'range', min: sp.min, max: sp.max, step: 5 });
        range.setAttribute('aria-label', 'Print speed percent');
        range.addEventListener('pointerdown', () => editing.add('speed'));
        range.addEventListener('input', () => { cur.textContent = `${range.value}%`; });
        range.addEventListener('change', () => { editing.delete('speed'); send({ action: 'speed', value: Number(range.value) }, `Speed → ${range.value}%`); });
        row.append(cur, range);
      }
      box.append(row);
    }
    if (sp.kind === 'mode') {
      box.querySelectorAll('[data-value]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.value) === Number(sp.value))));
    } else if (!editing.has('speed')) {
      box.querySelector('input').value = sp.value;
      box.querySelector('.ctl-row-cur').textContent = `${sp.value}%`;
    }
  }

  // Slots come from the printer (Kobra X ACE) or are a single virtual slot for
  // single-extruder printers. Remaining filament comes from the hub's own roll
  // tracking, not the printer (whose "100%" is a placeholder).
  let spools = [];

  function renderSlots(state) {
    const box = $('ctl-slots');
    $('ctl-slots-refresh').hidden = !state.slots;
    const slots = state.slots?.length
      ? state.slots
      : [{ index: 0, color: null, type: '', ready: true, single: true }];
    const mine = spools.filter((s) => s.printerId === state.id);
    const sig = JSON.stringify([state.id, slots, mine]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.replaceChildren(...slots.map((s) => {
      const roll = mine.find((r) => r.slot === s.index);
      const color = roll?.color || s.color;
      const el = document.createElement('div');
      el.className = 'spool' + (s.ready ? '' : ' empty') + (roll && roll.percent != null && roll.percent < 15 ? ' low' : '');
      el.innerHTML = `<div class="spool-reel"><span class="spool-color"></span></div>
        <span class="spool-type"></span><span class="spool-meta"></span>
        <div class="spool-bar" hidden><div></div></div><span class="spool-left"></span>
        <div class="spool-actions"></div>`;
      if (color) el.querySelector('.spool-color').style.background = `rgb(${color.join(',')})`;
      el.querySelector('.spool-type').textContent = !s.ready ? 'Empty' : (roll?.material || s.type || (s.single ? 'Spool' : 'Unknown'));
      el.querySelector('.spool-meta').textContent = s.single ? (roll?.brand || 'Single extruder') : `Slot ${s.index + 1}${roll?.brand ? ` · ${roll.brand}` : ''}`;
      if (roll) {
        const bar = el.querySelector('.spool-bar');
        bar.hidden = false;
        bar.firstElementChild.style.width = `${Math.max(0, Math.min(100, roll.percent ?? 0))}%`;
        el.querySelector('.spool-left').textContent = `${roll.remainingGrams} g left · ${roll.percent}%`;
        el.title = `${roll.remainingGrams} g of ${roll.capacityGrams} g left (estimated from ${Math.round(roll.usedGrams)} g printed since ${new Date(roll.baseAt).toLocaleDateString()}${Math.round(roll.liveGrams) ? `, including ${Math.round(roll.liveGrams)} g from the print running now` : ''})`;
      } else {
        el.querySelector('.spool-left').textContent = s.ready ? 'Roll not set' : '';
      }
      const actions = el.querySelector('.spool-actions');
      if (s.ready) {
        const nb = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'New roll' });
        nb.onclick = () => openRoll('new', state, s, roll);
        actions.append(nb);
        if (roll) {
          const ab = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost', textContent: 'Adjust' });
          ab.onclick = () => openRoll('adjust', state, s, roll);
          actions.append(ab);
        }
      }
      return el;
    }));
  }

  const hex = (c) => '#' + (c || [204, 204, 204]).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  function openRoll(mode, state, slot, roll) {
    const dlg = $('roll-dlg');
    const f = dlg.querySelector('form');
    const where = slot.single ? state.name : `${state.name}, slot ${slot.index + 1}`;
    dlg.querySelector('.rd-title').textContent = mode === 'new' ? 'New roll' : 'Adjust roll';
    dlg.querySelector('.rd-hint').textContent = mode === 'new'
      ? `Loaded into ${where}. Filament used by prints on this slot is subtracted from here on.`
      : `${where}: estimated ${roll.remainingGrams} g left of ${roll.capacityGrams} g.`;
    dlg.querySelector('.rd-new').hidden = mode !== 'new';
    dlg.querySelector('.rd-adjust').hidden = mode !== 'adjust';
    dlg.querySelector('.rd-remove').hidden = mode !== 'adjust';
    f.reset();
    if (mode === 'new') {
      f.capacity.value = String(roll?.capacityGrams && [1000, 750, 500, 250, 2000, 3000].includes(roll.capacityGrams) ? roll.capacityGrams : 1000);
      f.material.value = slot.type || roll?.material || '';
      f.color.value = hex(slot.color || roll?.color);
      f.brand.value = roll?.brand || '';
    } else {
      f.adjust.value = roll.remainingGrams;
    }
    dlg.querySelector('.rd-remove').onclick = async () => {
      if (!confirm(`Stop tracking the roll in ${where}?`)) return;
      try { await api(`/api/spools/${enc(roll.id)}`, { method: 'DELETE' }); dlg.close(); } catch (err) { toast(err.message, true); }
    };
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'save') return;
      try {
        if (mode === 'new') {
          await api('/api/spools', { body: {
            printerId: state.id, slot: slot.index, capacityGrams: Number(f.capacity.value),
            remainingGrams: f.remaining.value === '' ? undefined : Number(f.remaining.value),
            material: f.material.value.trim() || null, color: rgb(f.color.value), brand: f.brand.value.trim() || null,
          } });
          toast(`New roll set for ${where}`);
        } else {
          await api(`/api/spools/${enc(roll.id)}`, { method: 'PATCH', body: { remainingGrams: Number(f.adjust.value) } });
          toast(`Roll set to ${f.adjust.value} g`);
        }
      } catch (err) { toast(err.message, true); }
    };
    dlg.returnValue = '';
    dlg.showModal();
  }

  function setSpools(list) {
    spools = list;
    if (view.state && !root.hidden) renderSlots(view.state);
  }

  // ---- Wiring -------------------------------------------------------------------

  function init() {
    $('ctl-printer').addEventListener('change', (e) => { location.hash = `#control/${enc(e.target.value)}`; });

    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      uploadMode = b.dataset.mode;
      root.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    }));
    const drop = $('ctl-drop');
    const handle = (file) => file && Files.uploadToPrinter(file, printerId, { print: uploadMode === 'print', progressEl: $('ctl-progress') });
    $('ctl-file').addEventListener('change', (e) => { handle(e.target.files[0]); e.target.value = ''; });
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));
    $('ctl-browse').addEventListener('click', () => Files.openPrinterFiles(printerId));

    root.querySelector('.ctl-cam .cam-full').addEventListener('click', () => root.querySelector('.ctl-cam').requestFullscreen?.());
    initCrop();

    const act = (name, fn) => root.querySelector(`[data-act="${name}"]`).addEventListener('click', fn);
    const simple = (path) => async () => {
      try { await api(`/api/printers/${enc(printerId)}/${path}`, { body: {} }); } catch (err) { toast(err.message, true); }
    };
    act('pause', simple('pause'));
    act('resume', simple('resume'));
    act('clear', simple('clear'));
    act('cancel', () => confirmCancel({ state: view.state }, simple('cancel')));
    act('light', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await api(`/api/printers/${enc(printerId)}/light`, { body: { on: !view.state.light } }); } catch (err) { toast(err.message, true); }
      finally { btn.disabled = false; }
    });
    act('motorsOff', () => send({ action: 'motorsOff' }, 'Motors off'));

    // Step size
    $('ctl-step').querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      step = Number(b.dataset.step);
      $('ctl-step').querySelectorAll('[data-step]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    }));

    // Jog pad (SVG wedges are keyboard-focusable role=button groups)
    const activate = (el, fn) => {
      el.addEventListener('click', () => { if (el.getAttribute('aria-disabled') !== 'true') fn(); });
      el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute('aria-disabled') !== 'true') { e.preventDefault(); fn(); } });
    };
    root.querySelectorAll('.jog .wedge').forEach((w) => activate(w, () => {
      const d = step * Number(w.dataset.dir);
      send({ action: 'jog', axis: w.dataset.axis, distance: d });
    }));
    root.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => {
      send({ action: 'jog', axis: 'z', distance: Math.min(step, 10) * Number(b.dataset.z) });
    }));
    root.querySelectorAll('[data-home]').forEach((el) => activate(el, () => send({ action: 'home', axes: el.dataset.home }, `Homing ${el.dataset.home.toUpperCase()}`)));

    // Temperature presets: nozzle,bed
    $('ctl-presets').querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', async () => {
      const [nozzle, bed] = b.dataset.preset.split(',').map(Number);
      const limits = view.state?.capabilities?.control?.limits || {};
      await send({ action: 'temp', heater: 'nozzle', target: Math.min(nozzle, limits.nozzle ?? nozzle) });
      await send({ action: 'temp', heater: 'bed', target: Math.min(bed, limits.bed ?? bed) });
      toast(nozzle ? `Preheating for ${b.textContent}` : 'Cooling down');
    }));

    $('ctl-slots-refresh').addEventListener('click', async () => {
      try { await api(`/api/printers/${enc(printerId)}/slots`, { body: {} }); } catch (err) { toast(err.message, true); }
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    open,
    close,
    setSpools,
    onState: (state) => { if (state.id === printerId && !root.hidden) render(state); },
    get printerId() { return printerId; },
  };
})();
