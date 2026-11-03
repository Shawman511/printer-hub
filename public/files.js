// Printer files, uploads, the print dialog (filament slot mapping) and the
// hub's file library. Uses api(), toast() and cards from app.js.
const Files = (() => {
  let library = [];
  let folders = [];
  let libKind = 'print';
  let libFolder = ''; // '' is everything, NO_FOLDER the files in no folder
  const NO_FOLDER = '\0';
  const libTags = new Set(); // lower case
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const rgb = (c) => `rgb(${(c || [0, 0, 0]).slice(0, 3).join(',')})`;
  const size = (b) => bytesText(b);
  const printerName = (id) => cards.get(id)?.state.name || id;
  const canPrint = (p) => p && p.online && p.capabilities?.files && ['idle', 'completed'].includes(p.status);

  // Raw-body upload with progress (XHR, since fetch has no upload progress).
  function upload(url, file, progressEl) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fill = progressEl?.querySelector('.progress-fill');
      const text = progressEl?.querySelector('.progress-text');
      if (progressEl) progressEl.hidden = false;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable || !progressEl) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        fill.style.width = `${pct}%`;
        text.textContent = pct < 100 ? `Uploading ${file.name}… ${pct}%` : `Sending ${file.name} on…`;
      };
      xhr.onload = () => {
        if (progressEl) progressEl.hidden = true;
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => { if (progressEl) progressEl.hidden = true; reject(new Error('Upload failed: network error')); };
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(file);
    });
  }

  // ---- Files on a printer ---------------------------------------------------

  let filesFor = null;

  async function openPrinterFiles(printerId) {
    filesFor = printerId;
    const dlg = $('files-dlg');
    dlg.querySelector('.dlg-name').textContent = printerName(printerId);
    dlg.querySelector('.file-filter').value = '';
    if (!dlg.open) dlg.showModal();
    await loadPrinterFiles();
  }

  async function loadPrinterFiles() {
    const dlg = $('files-dlg');
    const list = dlg.querySelector('.file-list');
    list.innerHTML = '<li class="empty">Loading…</li>';
    try {
      const files = await api(`/api/printers/${enc(filesFor)}/files`);
      list.replaceChildren(...(files.length ? files.map((f) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.title = f.name;
        b.innerHTML = '<span class="fname"></span><span class="fsize"></span>';
        b.firstChild.textContent = f.name;
        b.lastChild.textContent = f.size ? size(f.size) : '';
        // A picture if the library has this file; printers don't offer one in their lists.
        b.prepend(thumbTile(library.find((i) => i.name === f.name || i.previousNames?.includes(f.name)) || { name: f.name }, 'file-thumb'));
        b.onclick = () => { dlg.close(); openPrint(filesFor, f.name); };
        li.append(b);
        return li;
      }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No files on the printer yet — upload one above.' })]));
      filterPrinterFiles();
    } catch (err) {
      list.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: err.message }));
    }
  }

  function filterPrinterFiles() {
    const q = $('files-dlg').querySelector('.file-filter').value.trim().toLowerCase();
    $('files-dlg').querySelectorAll('.file-list li').forEach((li) => {
      if (li.classList.contains('empty')) return;
      li.hidden = q && !li.textContent.toLowerCase().includes(q);
    });
  }

  // Uploads to a printer (kept in the library too). From the files dialog by
  // default; the control view passes its own printer, progress bar and mode.
  async function uploadToPrinter(file, printerId = filesFor, opts = {}) {
    const dlg = $('files-dlg');
    const progressEl = opts.progressEl || dlg.querySelector('.progress');
    const printAfter = opts.print ?? dlg.querySelector('.upload-print').checked;
    try {
      const res = await upload(`/api/printers/${enc(printerId)}/upload?name=${enc(file.name)}`, file, progressEl);
      if (res.model) {
        // Models can't be printed directly: slice for this printer first.
        if (dlg.open) dlg.close();
        const item = library.find((i) => i.id === res.libraryId) || { id: res.libraryId, name: res.file };
        lastSlice.printerId = printerId;
        toast(`${res.file} is a model. Saved to the library; slice it to print.`);
        if (slicer.available) openSlice(item);
        return;
      }
      toast(`Sent ${res.file} to ${printerName(printerId)}`);
      if (printAfter) {
        if (dlg.open) dlg.close();
        openPrint(printerId, res.file);
      } else if (dlg.open) {
        loadPrinterFiles();
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---- Print dialog -----------------------------------------------------------

  let printReq = 0;

  async function openPrint(printerId, file) {
    const dlg = $('print-dlg');
    const body = dlg.querySelector('.pd-body');
    const start = dlg.querySelector('.pd-start');
    const req = ++printReq;
    dlg.querySelector('.pd-printer').textContent = printerName(printerId);
    dlg.querySelector('.pd-file').textContent = file;
    body.innerHTML = '<p class="dlg-hint">Loading print options…</p>';
    start.disabled = true;
    dlg.returnValue = '';
    dlg.showModal();

    let opts;
    try {
      opts = await api(`/api/printers/${enc(printerId)}/print-options?file=${enc(file)}`);
    } catch (err) {
      if (req !== printReq) return;
      const lib = library.find((i) => i.name === file || i.previousNames?.includes(file));
      body.innerHTML = '';
      body.append(Object.assign(document.createElement('p'), { className: 'err', textContent: err.message }));
      if (lib) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Send from library first' });
        b.onclick = async () => {
          b.disabled = true;
          try { await sendFromLibrary(lib.id, printerId); openPrint(printerId, lib.name); }
          catch (e) { toast(e.message, true); b.disabled = false; }
        };
        body.append(b);
      }
      return;
    }
    if (req !== printReq) return;

    body.replaceChildren();
    const selects = new Map();
    if (opts.colors.length) {
      const many = opts.colors.length > 1;
      const h = Object.assign(document.createElement('p'), { className: 'pd-section', textContent: many ? `Check these ${opts.colors.length} colors` : 'Filament for each color' });
      body.append(h);
      if (many) body.append(Object.assign(document.createElement('p'), { className: 'dlg-hint', textContent: 'Each color prints from the slot beside it. Check they match what is loaded.' }));
      for (const c of opts.colors) {
        const row = document.createElement('div');
        row.className = 'map-row';
        row.innerHTML = `<span class="swatch"></span><span class="map-label"></span><span class="map-arrow">→</span><span class="swatch slot-swatch"></span>`;
        row.children[0].style.background = rgb(c.color);
        row.children[1].textContent = `Color ${c.index + 1} · ${c.material}${c.grams ? ` · ${c.grams.toFixed(1)} g` : ''}`;
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `Slot for color ${c.index + 1}`);
        for (const s of opts.slots) {
          const o = new Option(`Slot ${s.index + 1} · ${s.type}${s.ready ? '' : ' (not loaded)'}`, s.index, false, s.index === c.slot);
          sel.add(o);
        }
        if (c.slot == null) sel.add(new Option('Pick a slot', '', true, true), 0);
        const note = Object.assign(document.createElement('p'), { className: 'map-note', hidden: true });
        const paintSlot = () => {
          const s = opts.slots.find((x) => String(x.index) === sel.value);
          row.children[3].style.background = s ? rgb(s.color) : 'transparent';
          sel.classList.toggle('warn', !!s && !s.ready);
          // Only a clear difference: printers report colors loosely.
          const far = s && c.color.reduce((n, v, i) => n + (v - (s.color[i] ?? 0)) ** 2, 0) > 120 ** 2;
          const base = (t) => String(t || '').split(/\s+/)[0].toUpperCase();
          const problems = s ? [!s.ready && 'this slot is empty', c.material && s.type && !base(s.type).includes(base(c.material)) && !base(c.material).includes(base(s.type)) && `this slot has ${s.type}, the file wants ${c.material}`, far && 'this slot looks like a different color'].filter(Boolean) : [];
          note.textContent = problems.length ? `Color ${c.index + 1}: ${problems.join('; ')}.` : '';
          note.hidden = !problems.length;
        };
        sel.onchange = () => { paintSlot(); if (colorsOk) colorsOk.checked = false; validate(); };
        paintSlot();
        row.append(sel);
        body.append(row, note);
        selects.set(c.index, sel);
      }
    }
    // A multicolor print wastes a lot if a color is wrong, so it needs a yes.
    let colorsOk = null;
    if (opts.colors.length > 1) {
      const label = document.createElement('label');
      label.className = 'check pd-colors-ok';
      colorsOk = Object.assign(document.createElement('input'), { type: 'checkbox', onchange: () => validate() });
      label.append(colorsOk, ' I checked the colors and slots');
      body.append(label);
    }
    const checks = new Map();
    for (const o of opts.options) {
      const label = document.createElement('label');
      label.className = 'check';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!o.default });
      label.append(box, ` ${o.label}`);
      body.append(label);
      checks.set(o.key, box);
    }
    const warn = document.createElement('p');
    warn.className = 'dlg-hint';
    warn.textContent = 'Make sure the bed is clear before starting.';
    body.append(warn);

    function validate() {
      start.disabled = [...selects.values()].some((s) => s.value === '') || (colorsOk && !colorsOk.checked);
    }
    validate();

    dlg.onclose = async () => {
      if (dlg.returnValue !== 'start' || req !== printReq) return;
      const mapping = Object.fromEntries([...selects].map(([k, s]) => [k, Number(s.value)]));
      const payload = { file, mapping, ...Object.fromEntries([...checks].map(([k, b]) => [k, b.checked])) };
      try {
        await api(`/api/printers/${enc(printerId)}/print`, { body: payload });
        toast(`Starting ${file} on ${printerName(printerId)}`);
      } catch (err) { toast(err.message, true); }
    };
  }

  // ---- Library ----------------------------------------------------------------

  async function sendFromLibrary(id, printerId) {
    await api(`/api/library/${enc(id)}/send`, { body: { printerId } });
    toast(`Sent to ${printerName(printerId)}`);
  }

  function suggestPrinter(item) {
    const model = (item.printerModel || '').toLowerCase();
    const all = [...cards.values()].map((c) => c.state);
    return all.find((p) => model && (model.includes((p.model || '').toLowerCase()) || (p.model || '').toLowerCase().includes(model)))
      || all.find((p) => model.includes('kobra') && p.type === 'anycubic')
      || all.find((p) => (model.includes('flashforge') || model.includes('adventurer')) && p.type === 'flashforge')
      || null;
  }

  // ---- Folders and tags -----------------------------------------------------------

  const within = (item, folder) => item.folder === folder || !!item.folder?.startsWith(`${folder}/`);
  const inFolder = (item) => (libFolder === '' ? true : libFolder === NO_FOLDER ? !item.folder : within(item, libFolder));

  function moveToFolder(id, folder) {
    api(`/api/library/${enc(id)}`, { method: 'PATCH', body: { folder } }).catch((err) => toast(err.message, true));
  }

  // Files can be dragged from the table onto a folder.
  function folderRow(label, value, count, depth = 0) {
    const li = document.createElement('li');
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'lib-folder' });
    b.style.paddingLeft = `${8 + depth * 14}px`;
    b.title = value && value !== NO_FOLDER ? value : label;
    b.append(
      Object.assign(document.createElement('span'), { className: 'lib-folder-name', textContent: label }),
      Object.assign(document.createElement('span'), { className: 'count', textContent: count || '' }),
    );
    if (libFolder === value) b.setAttribute('aria-current', 'true');
    b.onclick = () => { libFolder = value; renderLibrary(); };
    if (value !== '') {
      b.ondragover = (e) => { if (e.dataTransfer.types.includes('application/x-lib-item')) { e.preventDefault(); b.classList.add('over'); } };
      b.ondragleave = () => b.classList.remove('over');
      b.ondrop = (e) => {
        e.preventDefault();
        b.classList.remove('over');
        const id = e.dataTransfer.getData('application/x-lib-item');
        if (id) moveToFolder(id, value === NO_FOLDER ? '' : value);
      };
    }
    li.append(b);
    return li;
  }

  function renderFolders(all) {
    if (libFolder && libFolder !== NO_FOLDER && !folders.includes(libFolder)) libFolder = '';
    const rows = [folderRow('All files', '', all.length)];
    if (folders.length) rows.push(folderRow('No folder', NO_FOLDER, all.filter((i) => !i.folder).length));
    for (const f of folders) {
      const parts = f.split('/');
      const li = folderRow(parts[parts.length - 1], f, all.filter((i) => within(i, f)).length, parts.length - 1);
      const tools = Object.assign(document.createElement('span'), { className: 'lib-folder-tools' });
      const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost icon', textContent: '✎', title: 'Rename folder' });
      edit.setAttribute('aria-label', `Rename folder ${f}`);
      edit.onclick = () => openFolder(f);
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost icon', textContent: '✕', title: 'Remove folder' });
      del.setAttribute('aria-label', `Remove folder ${f}`);
      del.onclick = async () => {
        const n = library.filter((i) => within(i, f)).length;
        const up = parts.slice(0, -1).join('/') || 'no folder';
        if (!confirm(n ? `Remove the folder ${f}? Its ${n === 1 ? 'file moves' : `${n} files move`} to ${up}. No files are deleted.` : `Remove the folder ${f}?`)) return;
        try { await api('/api/library/folders', { method: 'DELETE', body: { folder: f } }); } catch (err) { toast(err.message, true); }
      };
      tools.append(edit, del);
      li.append(tools);
      rows.push(li);
    }
    $('lib-folder-list').replaceChildren(...rows);
    const into = libFolder && libFolder !== NO_FOLDER ? libFolder : '';
    $('lib-drop-target').textContent = into ? ` New files go into ${into}.` : '';
  }

  function tagChip(tag, onclick) {
    const on = libTags.has(tag.toLowerCase());
    const b = Object.assign(document.createElement('button'), { type: 'button', className: `lib-tag${on ? ' on' : ''}`, textContent: tag, title: on ? `Stop filtering by ${tag}` : `Show files tagged ${tag}` });
    b.setAttribute('aria-pressed', String(on));
    b.onclick = onclick || (() => {
      const k = tag.toLowerCase();
      if (!libTags.delete(k)) libTags.add(k);
      renderLibrary();
    });
    return b;
  }

  function renderTagFilter(shown) {
    const names = new Map();
    for (const i of shown) for (const t of i.tags || []) if (!names.has(t.toLowerCase())) names.set(t.toLowerCase(), t);
    // Filters in use stay visible, or they couldn't be turned off.
    for (const k of libTags) if (!names.has(k)) names.set(k, k);
    const box = $('lib-tag-filter');
    box.hidden = !names.size;
    box.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'lib-tag-label', textContent: 'Tags' }),
      ...[...names.values()].sort((a, b) => a.localeCompare(b)).map((t) => tagChip(t)),
    );
  }

  function rowExtras(i) {
    const box = Object.assign(document.createElement('span'), { className: 'lib-row-tags' });
    box.append(...colorDots(i), ...(i.tags || []).map((t) => tagChip(t)));
    return box;
  }

  function editButton(i) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost icon', textContent: '✎', title: 'Rename, move or tag' });
    b.setAttribute('aria-label', `Edit ${i.name}`);
    b.onclick = () => openEdit(i);
    return b;
  }

  function makeDraggable(tr, i) {
    tr.draggable = true;
    tr.ondragstart = (e) => {
      e.dataTransfer.setData('application/x-lib-item', i.id);
      e.dataTransfer.effectAllowed = 'move';
    };
  }

  function openEdit(item) {
    const dlg = $('lib-edit-dlg');
    const f = dlg.querySelector('form');
    const ext = (/\.[^.]+$/.exec(item.name) || [''])[0];
    const err = dlg.querySelector('.err');
    err.hidden = true;
    f.name.value = ext ? item.name.slice(0, -ext.length) : item.name;
    dlg.querySelector('.lib-ext').textContent = ext;
    dlg.querySelector('.lib-rename-hint').hidden = !(item.sentTo || []).length;
    f.folder.value = item.folder || '';
    f.tags.value = (item.tags || []).join(', ');
    $('lib-folder-options').replaceChildren(...folders.map((x) => new Option('', x)));

    // Tags already in use, to pick from.
    const paintSuggest = () => {
      const mine = new Set(f.tags.value.split(',').map((t) => t.trim().toLowerCase()));
      const seen = new Map();
      for (const i of library) for (const t of i.tags || []) if (!mine.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
      dlg.querySelector('.lib-tag-suggest').replaceChildren(...[...seen.values()].sort((a, b) => a.localeCompare(b)).map((t) => Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'lib-tag',
        textContent: `+ ${t}`,
        onclick: () => { f.tags.value = [f.tags.value.trim().replace(/,$/, ''), t].filter(Boolean).join(', '); paintSuggest(); },
      })));
    };
    f.tags.oninput = paintSuggest;
    paintSuggest();
    dlg.querySelector('.lib-edit-cancel').onclick = () => dlg.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        await api(`/api/library/${enc(item.id)}`, { method: 'PATCH', body: { name: f.name.value + ext, folder: f.folder.value, tags: f.tags.value.split(',') } });
        dlg.close();
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      }
    };
    dlg.showModal();
    f.name.select();
  }

  // A new folder goes inside the one being viewed. Renaming edits the last part;
  // type a / to move it, as the whole path then replaces it.
  function openFolder(existing) {
    const dlg = $('lib-folder-dlg');
    const f = dlg.querySelector('form');
    const err = dlg.querySelector('.err');
    const parent = existing ? existing.split('/').slice(0, -1).join('/') : (libFolder === NO_FOLDER ? '' : libFolder);
    err.hidden = true;
    dlg.querySelector('.lib-folder-title').textContent = existing ? 'Rename folder' : 'New folder';
    dlg.querySelector('.lib-folder-hint').textContent = parent ? `Inside ${parent}.` : 'At the top level.';
    f.folder.value = existing ? existing.split('/').pop() : '';
    dlg.querySelector('.lib-folder-cancel').onclick = () => dlg.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      err.hidden = true;
      const path = [parent, f.folder.value].filter(Boolean).join('/');
      try {
        const r = existing
          ? await api('/api/library/folders', { method: 'PATCH', body: { from: existing, to: path } })
          : await api('/api/library/folders', { body: { folder: path } });
        if (!existing || libFolder === existing) libFolder = r.folder;
        // The live update may arrive after this answer: don't lose the selection.
        if (!folders.includes(r.folder)) folders = [...folders, r.folder];
        renderLibrary();
        dlg.close();
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      }
    };
    dlg.showModal();
    f.folder.select();
  }

  // What a hub-sliced file was sliced with, to tell its versions apart.
  function sliceSummary(i) {
    const s = i.sliceSettings;
    if (!s) return null;
    const o = s.options || {};
    const name = (el, v) => [...(document.querySelector(`#slice-dlg [name=${el}]`)?.options || [])].find((x) => x.value === v)?.textContent.split(':')[0];
    return [
      s.process?.replace(/ @.*$/, ''),
      o.vase ? 'vase mode' : `${o.infill ?? '?'}% infill`,
      o.infillPattern && name('infillPattern', o.infillPattern),
      !o.vase && o.walls && `${o.walls} walls`,
      o.topLayers !== '' && o.topLayers != null && `${o.topLayers} top layers`,
      o.bottomLayers !== '' && o.bottomLayers != null && `${o.bottomLayers} bottom layers`,
      o.supports && o.supports !== 'off' && !o.vase && `${o.supports} supports`,
      o.brim && 'brim',
      o.seam && `${name('seam', o.seam)} seam`,
      o.ironing && o.ironing !== 'no ironing' && `ironing: ${name('ironing', o.ironing)}`,
      o.fuzzySkin && o.fuzzySkin !== 'none' && 'fuzzy skin',
    ].filter(Boolean).join(', ');
  }

  // A file's picture, or a tile with its type where there's none yet.
  function thumbTile(item, cls = 'lib-thumb') {
    const source = item.thumb ? item : item.kind === 'model' ? library.find((s) => s.modelId === item.id && s.thumb) : null;
    if (source) return Object.assign(document.createElement('img'), { className: cls, src: `/api/library/${enc(source.id)}/thumb`, alt: '', loading: 'lazy' });
    return Object.assign(document.createElement('span'), { className: `${cls} empty`, textContent: (/\.([^.]+)$/.exec(item.name) || [])[1]?.toUpperCase() || '' });
  }

  // Models get their picture from the 3D preview in the browser, one at a time,
  // while the Library is open. Very large ones are left out: they'd stall the page.
  const MAX_MODEL_THUMB = 100 * 1024 * 1024;
  const modelThumbsTried = new Set();
  let drawingModel = false;

  async function drawNextModelThumb() {
    if (drawingModel || !window.Preview?.thumbnail) return;
    if (document.querySelector('[data-role="viewer"]') || document.querySelector('.view[data-view="library"]').hidden) return;
    const m = library.find((i) => i.kind === 'model' && !i.thumb && !modelThumbsTried.has(i.id) && window.Preview.supports(i.name) && i.size <= MAX_MODEL_THUMB);
    if (!m) return;
    drawingModel = true;
    modelThumbsTried.add(m.id);
    try {
      const body = await window.Preview.thumbnail(m);
      const res = await fetch(`/api/library/${enc(m.id)}/thumb`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      console.warn(`No preview for ${m.name}: ${err.message}`);
    }
    drawingModel = false;
    drawNextModelThumb();
  }

  // The picture, large. For files with no 3D preview.
  function showImage(item) {
    const source = item.thumb ? item : library.find((s) => s.modelId === item.id && s.thumb);
    if (!source) return toast(`No preview for ${item.name}`, true);
    const dlg = $('thumb-dlg');
    dlg.querySelector('.td-title').textContent = item.name;
    dlg.querySelector('.td-img').src = `/api/library/${enc(source.id)}/thumb`;
    dlg.showModal();
  }

  // A row's picture, as a button that opens its preview.
  function previewButton(item) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'lib-thumb-btn', title: 'Preview' });
    b.setAttribute('aria-label', `Preview ${item.name}`);
    b.append(thumbTile(item));
    b.onclick = () => (item.kind === 'model' && window.Preview?.supports(item.name) ? window.Preview.open(item) : showImage(item));
    return b;
  }

  // A row's name, as a button that starts what the file is for.
  function nameButton(item, title, run) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'lib-name lib-name-btn', textContent: item.name, title });
    b.onclick = run;
    return b;
  }

  function colorDots(item) {
    if (!(item.colors?.length > 1)) return [];
    return item.colors.map((c) => {
      const dot = Object.assign(document.createElement('span'), { className: 'swatch lib-dot', title: `Color ${c.index + 1} · ${c.material}${c.grams ? ` · ${Math.round(c.grams)} g` : ''}` });
      dot.style.background = c.color;
      return dot;
    });
  }

  function renderLibrary() {
    const body = $('lib-body');
    if (!body) return;
    const q = $('lib-search').value.trim().toLowerCase();
    const prints = library.filter((i) => i.kind !== 'model');
    const models = library.filter((i) => i.kind === 'model');
    $('lib-count-print').textContent = prints.length || '';
    $('lib-count-model').textContent = models.length || '';
    const panel = libKind === 'model' ? models : prints;
    renderFolders(panel);
    renderTagFilter(panel.filter(inFolder));
    const hasTags = (i) => [...libTags].every((k) => (i.tags || []).some((t) => t.toLowerCase() === k));
    const matches = (i) => inFolder(i) && hasTags(i) && (!q || [i.name, i.printerModel, i.folder, ...(i.tags || [])].some((v) => (v || '').toLowerCase().includes(q)));
    const filtering = q || libFolder || libTags.size;
    $('model-empty').textContent = filtering ? 'No models match. Try another folder, tag or search.' : 'No models yet. Drop .stl, .obj, .step or .3mf files above.';
    $('lib-empty').textContent = filtering ? 'No print files match. Try another folder, tag or search.' : "No print files yet. Drop some above, slice a model, or upload from a printer's Start print dialog.";
    const shown = panel.filter(matches);
    const noun = libKind === 'model' ? 'model' : 'print file';
    const total = (list) => bytesText(list.reduce((n, i) => n + (i.size || 0), 0));
    $('lib-total').hidden = !panel.length;
    $('lib-total').textContent = shown.length === panel.length
      ? `${panel.length} ${noun}${panel.length === 1 ? '' : 's'} · ${total(panel)} on disk`
      : `Showing ${shown.length} of ${panel.length} ${noun}s · ${total(shown)} of ${total(panel)} on disk`;
    renderModels(models.filter(matches));
    const items = prints.filter(matches);
    const printers = [...cards.values()].map((c) => c.state);
    body.replaceChildren(...items.map((i) => {
      const tr = document.createElement('tr');
      const td = (text, cls) => { const el = document.createElement('td'); if (cls) el.className = cls; el.textContent = text ?? ''; tr.append(el); return el; };
      const name = td('', 'item lib-item');
      name.title = [i.name, sliceSummary(i), i.slicer && `Sliced with ${i.slicer}`, i.material, i.estimate && `Est. ${i.estimate}`].filter(Boolean).join('\n');
      const added = new Date(i.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const sent = (i.sentTo || []).map(printerName).join(', ');
      const model = i.modelId && library.find((m) => m.id === i.modelId);
      // Preview from the file (the hub's slicer, the slicer that made it, or drawn from its toolpaths).
      const thumb = previewButton(i);
      let print;
      const text = Object.assign(document.createElement('span'), { className: 'lib-text' });
      const row = Object.assign(document.createElement('div'), { className: 'lib-row' });
      row.append(thumb, text);
      name.append(row);
      text.append(
        nameButton(i, 'Print this file', () => {
          if (print.disabled) toast(print.title || 'This file can\u2019t be printed right now', true);
          else print.click();
        }),
        Object.assign(document.createElement('span'), {
          className: 'lib-sub',
          textContent: [
            libFolder === '' && i.folder,
            model ? `Sliced from ${model.name}` : `Added ${added}`,
            i.copies > 1 && `${i.copies} copies`,
            i.material, i.grams && `${Math.round(i.grams)} g`, i.estimate,
            i.bedTemp != null && (i.bedTemp < 45 ? `bed only ${i.bedTemp}°C (${i.bedType || 'plate'}), re-slice` : `bed ${i.bedTemp}°C`),
            sent && `On ${sent}`,
            !i.printerModel && !i.slicedFor && 'Target printer unknown, check before printing',
          ].filter(Boolean).join(' · '),
        }),
        rowExtras(i),
      );
      makeDraggable(tr, i);
      td(i.printerModel || (i.slicedFor ? printerName(i.slicedFor) : '—'), 'nowrap');
      td(size(i.size), 'num nowrap');

      const actions = document.createElement('td');
      actions.className = 'actions';
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      const sel = document.createElement('select');
      sel.className = 'small';
      sel.setAttribute('aria-label', 'Printer');
      // Printers the file wasn't sliced for are listed but can't be picked.
      const fit = (id) => i.fits?.[id] || { ok: true, unknown: true };
      for (const p of printers) {
        const f = fit(p.id);
        const o = new Option(f.ok ? p.name : `${p.name} (sliced for another printer)`, p.id);
        o.disabled = !f.ok;
        sel.add(o);
      }
      const match = printers.find((p) => fit(p.id).ok && !fit(p.id).unknown) || suggestPrinter(i) || printers.find((p) => fit(p.id).ok);
      if (match) sel.value = match.id;
      const send = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Send' });
      print = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small primary', textContent: 'Print…' });
      const sync = () => {
        const p = cards.get(sel.value)?.state;
        const f = fit(sel.value);
        send.disabled = !f.ok || !(p && p.online && p.capabilities?.files);
        print.disabled = !f.ok || !canPrint(p);
        const why = !f.ok ? `This file ${f.reason}` : p && !canPrint(p) ? `${p.name} is ${p.online ? p.status : 'offline'}` : '';
        print.title = send.title = why;
      };
      if (!printers.some((p) => fit(p.id).ok)) sel.disabled = true;
      sel.onchange = sync;
      sync();
      send.onclick = async () => {
        send.disabled = true;
        try { await sendFromLibrary(i.id, sel.value); } catch (err) { toast(err.message, true); }
        sync();
      };
      print.onclick = async () => {
        print.disabled = true;
        try {
          if (!(i.sentTo || []).includes(sel.value)) await sendFromLibrary(i.id, sel.value);
          openPrint(sel.value, i.name);
        } catch (err) { toast(err.message, true); }
        sync();
      };
      const dl = Object.assign(document.createElement('a'), { className: 'btn small ghost icon', textContent: '⤓', title: 'Download', href: `/api/library/${enc(i.id)}/download` });
      dl.setAttribute('aria-label', `Download ${i.name}`);
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost icon', textContent: '✕', title: 'Delete from library' });
      del.setAttribute('aria-label', `Delete ${i.name}`);
      del.onclick = async () => {
        if (!confirm(`Delete ${i.name} from the hub library? Copies already on printers stay there.`)) return;
        try { await api(`/api/library/${enc(i.id)}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); }
      };
      wrap.append(sel, send, print, editButton(i), dl, del);
      actions.append(wrap);
      tr.append(actions);
      return tr;
    }));
    $('lib-empty').hidden = items.length > 0;
    drawNextModelThumb();
  }

  // ---- Models -------------------------------------------------------------------

  let slicer = { available: false, printers: [] };

  async function refreshSlicer() {
    try { slicer = await api('/api/slicer'); } catch { slicer = { available: false, printers: [] }; }
    const el = $('slicer-status');
    const v = slicer.version && slicer.version !== 'unknown' ? ` ${slicer.version}` : '';
    el.textContent = slicer.available ? `Slicer ready · OrcaSlicer${v}` : 'Slicer offline';
    el.classList.toggle('off', !slicer.available);
    el.title = slicer.error || '';
    renderLibrary();
  }

  function renderModels(models) {
    const body = $('model-body');
    body.replaceChildren(...models.map((m) => {
      const tr = document.createElement('tr');
      const slices = library.filter((i) => i.modelId === m.id);
      const name = document.createElement('td');
      name.className = 'item lib-item';
      const text = Object.assign(document.createElement('span'), { className: 'lib-text' });
      const modelRow = Object.assign(document.createElement('div'), { className: 'lib-row' });
      modelRow.append(previewButton(m), text);
      name.append(modelRow);
      text.append(
        nameButton(m, 'Slice this model', () => {
          if (slicer.available) openSlice(m);
          else toast('The slicer service is not running', true);
        }),
        Object.assign(document.createElement('span'), { className: 'lib-sub', textContent: [libFolder === '' && m.folder, `Added ${new Date(m.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`].filter(Boolean).join(' · ') }),
        rowExtras(m),
      );
      makeDraggable(tr, m);
      const sl = document.createElement('td');
      sl.className = 'nowrap';
      sl.textContent = slices.length
        ? [...new Set(slices.map((s) => printerName(s.slicedFor)))].map((p) => `${p} (${slices.filter((s) => printerName(s.slicedFor) === p).length})`).join(', ')
        : '—';
      const sz = Object.assign(document.createElement('td'), { className: 'num nowrap', textContent: size(m.size) });
      const actions = document.createElement('td');
      actions.className = 'actions';
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      if (window.Preview?.supports(m.name)) {
        const pv = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Preview' });
        pv.onclick = () => window.Preview.open(m);
        wrap.append(pv);
      }
      const go = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small primary', textContent: 'Slice…' });
      go.disabled = !slicer.available;
      go.title = slicer.available ? '' : 'The slicer service is not running';
      go.onclick = () => openSlice(m);
      const dl = Object.assign(document.createElement('a'), { className: 'btn small ghost icon', textContent: '⤓', title: 'Download', href: `/api/library/${enc(m.id)}/download` });
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost icon', textContent: '✕', title: 'Delete model' });
      del.onclick = async () => {
        if (!confirm(`Delete ${m.name}? Its sliced print files stay in the library.`)) return;
        try { await api(`/api/library/${enc(m.id)}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); }
      };
      wrap.append(go, editButton(m), dl, del);
      actions.append(wrap);
      tr.append(name, sl, sz, actions);
      return tr;
    }));
    $('model-empty').hidden = models.length > 0;
  }

  function showLibPanel(kind) {
    document.querySelectorAll('[data-lib]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.lib === kind)));
    document.querySelectorAll('[data-lib-panel]').forEach((p) => { p.hidden = p.dataset.libPanel !== kind; });
    try { localStorage.setItem('libPanel', kind); } catch { /* storage unavailable */ }
    libKind = kind;
    renderLibrary();
  }

  // ---- Slice dialog ---------------------------------------------------------------

  const lastSlice = (() => { try { return JSON.parse(localStorage.getItem('lastSlice') || '{}'); } catch { return {}; } })();

  async function openSlice(model) {
    const dlg = $('slice-dlg');
    const f = dlg.querySelector('form');
    const status = dlg.querySelector('.sd-status');
    const go = dlg.querySelector('.sd-go');
    dlg.querySelector('.sd-model').textContent = model.name;
    dlg.querySelector('.sd-fields').hidden = false;
    dlg.querySelector('.sd-project').hidden = true;
    status.hidden = true;
    go.hidden = false;
    go.disabled = false;
    go.textContent = 'Slice';
    dlg.querySelector('.sd-close').textContent = 'Cancel';

    const printers = [...cards.values()].map((c) => c.state).filter((p) => slicer.printers.includes(p.id));
    f.printerId.replaceChildren(...printers.map((p) => new Option(p.name, p.id)));
    if (lastSlice.printerId && printers.some((p) => p.id === lastSlice.printerId)) f.printerId.value = lastSlice.printerId;
    f.copies.value = lastSlice.copies || 1;
    f.infill.value = lastSlice.infill ?? 15;
    f.supports.value = lastSlice.supports || 'off';
    f.walls.value = lastSlice.walls || 2;
    f.brim.checked = !!lastSlice.brim;
    f.orient.checked = !!lastSlice.orient;

    // The settings beyond Basics. Blank uses the preset. Vase mode isn't
    // remembered: it changes the whole print, so it's chosen each time.
    const MORE = { strength: ['infillPattern', 'topLayers', 'bottomLayers'], surface: ['seam', 'ironing', 'fuzzySkin'], support: ['supportAngle', 'supportWhere', 'brimWidth', 'skirtLoops'] };
    for (const key of Object.values(MORE).flat()) f[key].value = lastSlice.more?.[key] ?? '';
    f.vase.checked = false;
    const tabs = [...dlg.querySelectorAll('[data-sd-tab]')];
    const showTab = (name) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.sdTab === name)));
      dlg.querySelectorAll('[data-sd-panel]').forEach((p) => { p.hidden = p.dataset.sdPanel !== name; });
    };
    tabs.forEach((t) => { t.onclick = () => showTab(t.dataset.sdTab); });
    showTab('basics');
    const reset = dlg.querySelector('.sd-reset');
    const VASE_OFF = ['copies', 'infill', 'walls', 'supports', 'topLayers', 'ironing', 'supportAngle', 'supportWhere'];
    // Shows what's changed on each tab, and turns off what doesn't apply.
    const syncMore = () => {
      for (const t of tabs) {
        const count = t.querySelector('.count');
        if (!count) continue;
        const n = MORE[t.dataset.sdTab].filter((key) => f[key].value !== '').length + (t.dataset.sdTab === 'surface' && f.vase.checked ? 1 : 0);
        count.textContent = n || '';
      }
      const vase = f.vase.checked;
      for (const key of VASE_OFF) f[key].disabled = vase;
      if (!dlg.querySelector('.sd-project').hidden) f.copies.disabled = true;
      if (!vase) {
        f.supportAngle.disabled = f.supports.value === 'off';
        f.supportWhere.disabled = f.supports.value === 'off';
      }
      f.brimWidth.disabled = !f.brim.checked;
      dlg.querySelector('.sd-vase-note').hidden = !vase;
      reset.hidden = !Object.values(MORE).flat().some((key) => f[key].value !== '') && !vase;
    };
    f.oninput = syncMore;
    f.onchange = syncMore;
    reset.onclick = () => {
      for (const key of Object.values(MORE).flat()) f[key].value = '';
      f.vase.checked = false;
      syncMore();
    };
    syncMore();
    const infillLabel = () => { dlg.querySelector('.sd-infill-val').textContent = `${f.infill.value}%`; };
    f.infill.oninput = infillLabel;
    infillLabel();

    const loadProfiles = async () => {
      f.process.replaceChildren(new Option('Loading…', ''));
      f.filament.replaceChildren(new Option('Loading…', ''));
      try {
        const pr = await api(`/api/slicer/profiles?printerId=${enc(f.printerId.value)}`);
        const pick = (sel, names, def, remembered) => {
          sel.replaceChildren(...names.map((n) => new Option(n.replace(/ @.*$/, ''), n)));
          sel.value = names.includes(remembered) ? remembered : def;
        };
        const mem = lastSlice.byPrinter?.[f.printerId.value] || {};
        pick(f.process, pr.processes, pr.defaults.process, mem.process);
        pick(f.filament, pr.filaments, pr.defaults.filament, mem.filament);
        const beds = pr.bedTypes || [];
        f.bedType.replaceChildren(...beds.map((b) => new Option(b.label, b.value)));
        f.bedType.value = beds.some((b) => b.value === mem.bedType) ? mem.bedType : (pr.defaults.bedType || beds[0]?.value || '');
      } catch (err) {
        f.process.replaceChildren(new Option(err.message, ''));
        f.filament.replaceChildren();
      }
    };
    f.printerId.onchange = loadProfiles;
    dlg.showModal();
    await loadProfiles();

    // A slicer project brings its own colors, so there's no one filament to pick.
    const box = dlg.querySelector('.sd-project');
    const pick = dlg.querySelector('.sd-filament-pick');
    box.hidden = true;
    pick.hidden = false;
    let projectColors = [];
    if (/\.3mf$/i.test(model.name)) {
      projectColors = await api(`/api/library/${enc(model.id)}/project`).catch(() => []);
      if (projectColors.length) {
        dlg.querySelector('.sd-project-colors').replaceChildren(...projectColors.map((c) => {
          const el = Object.assign(document.createElement('span'), { className: 'sd-color', title: c.preset || '' });
          const dot = Object.assign(document.createElement('span'), { className: 'swatch' });
          dot.style.background = c.color;
          el.append(dot, `${c.index + 1} · ${c.type || 'Filament'}`);
          return el;
        }));
        box.hidden = false;
        pick.hidden = true;
        f.copies.value = 1;
        f.vase.checked = false;
        syncMore();
      }
    }

    go.onclick = async () => {
      if (!f.process.value || !f.filament.value) return;
      const printerId = f.printerId.value;
      const body = {
        printerId,
        process: f.process.value,
        filament: f.filament.value,
        bedType: f.bedType.value || undefined,
        copies: f.vase.checked ? 1 : Number(f.copies.value) || 1,
        orient: f.orient.checked,
        options: {
          infill: Number(f.infill.value),
          supports: f.supports.value,
          brim: f.brim.checked,
          walls: Number(f.walls.value) || 2,
          infillPattern: f.infillPattern.value,
          topLayers: f.topLayers.value,
          bottomLayers: f.bottomLayers.value,
          seam: f.seam.value,
          ironing: f.ironing.value,
          fuzzySkin: f.fuzzySkin.value,
          supportAngle: f.supportAngle.value,
          ...(f.supportWhere.value ? { supportBuildPlateOnly: f.supportWhere.value === 'plate' } : {}),
          brimWidth: f.brimWidth.value,
          skirtLoops: f.skirtLoops.value,
          vase: f.vase.checked,
        },
      };
      Object.assign(lastSlice, { printerId, copies: Number(f.copies.value) || 1, infill: body.options.infill, supports: body.options.supports, brim: body.options.brim, walls: body.options.walls, orient: body.orient });
      lastSlice.more = Object.fromEntries(Object.values(MORE).flat().map((key) => [key, f[key].value]));
      lastSlice.byPrinter = { ...(lastSlice.byPrinter || {}), [printerId]: { process: body.process, filament: body.filament, bedType: body.bedType } };
      try { localStorage.setItem('lastSlice', JSON.stringify(lastSlice)); } catch { /* storage unavailable */ }

      go.disabled = true;
      go.textContent = 'Slicing…';
      status.hidden = false;
      status.className = 'sd-status';
      showTab('basics');
      status.textContent = `Slicing ${body.copies > 1 ? `${body.copies} copies ` : ''}for ${printerName(printerId)}. Large models can take a few minutes.`;
      try {
        const item = await api(`/api/library/${enc(model.id)}/slice`, { body });
        dlg.querySelector('.sd-fields').hidden = true;
        reset.hidden = true;
        status.className = 'sd-status ok';
        status.replaceChildren(
          Object.assign(document.createElement('strong'), { textContent: 'Sliced' }),
          document.createTextNode(` ${[item.estimate, item.grams && `${Math.round(item.grams)} g`, `${item.copies} ${item.copies === 1 ? 'copy' : 'copies'}`, item.colors?.length > 1 && `${item.colors.length} colors`].filter(Boolean).join(' · ')}`),
          Object.assign(document.createElement('span'), { className: 'lib-sub', textContent: [item.bedTemp != null && `Bed ${item.bedTemp}°C`, item.nozzleTemp && `nozzle ${item.nozzleTemp}°C`, item.bedType].filter(Boolean).join(' · ') }),
          Object.assign(document.createElement('span'), { className: 'lib-sub', textContent: item.name }),
        );
        if (item.bedTemp != null && item.bedTemp < 45) {
          status.append(Object.assign(document.createElement('span'), { className: 'err', textContent: `Heads up: the bed only heats to ${item.bedTemp}°C on this plate setting.` }));
        }
        go.hidden = true;
        dlg.querySelector('.sd-close').textContent = 'Done';
        const print = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: 'Send & print…' });
        const p = cards.get(printerId)?.state;
        print.disabled = !canPrint(p);
        print.title = p && !canPrint(p) ? `${p.name} is ${p.online ? p.status : 'offline'}` : '';
        print.onclick = async () => {
          print.disabled = true;
          try {
            await sendFromLibrary(item.id, printerId);
            dlg.close();
            openPrint(printerId, item.name);
          } catch (err) { toast(err.message, true); print.disabled = false; }
        };
        status.append(print);
      } catch (err) {
        status.className = 'sd-status bad';
        status.textContent = err.message;
        go.disabled = false;
        go.textContent = 'Slice';
      }
    };
  }

  async function addToLibrary(fileList) {
    for (const file of fileList) {
      try {
        const into = libFolder && libFolder !== NO_FOLDER ? libFolder : '';
        const item = await upload(`/api/library?name=${enc(file.name)}${into ? `&folder=${enc(into)}` : ''}`, file, $('lib-progress'));
        toast(`Saved ${file.name} to ${into || (item.kind === 'model' ? 'Models' : 'Print files')}`);
        showLibPanel(item.kind === 'model' ? 'model' : 'print');
      } catch (err) { toast(`${file.name}: ${err.message}`, true); }
    }
  }

  function initLibrary() {
    const drop = $('lib-drop');
    $('lib-input').addEventListener('change', (e) => { addToLibrary([...e.target.files]); e.target.value = ''; });
    $('lib-search').addEventListener('input', renderLibrary);
    $('lib-new-folder').addEventListener('click', () => openFolder());
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => addToLibrary([...e.dataTransfer.files]));

    const fdlg = $('files-dlg');
    fdlg.querySelector('.upload-input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) uploadToPrinter(f);
    });
    fdlg.querySelector('.file-filter').addEventListener('input', filterPrinterFiles);
    fdlg.querySelector('.lib-link').addEventListener('click', () => fdlg.close());

    document.querySelectorAll('[data-lib]').forEach((b) => b.addEventListener('click', () => showLibPanel(b.dataset.lib)));
    let saved = 'print';
    try { saved = localStorage.getItem('libPanel') || 'print'; } catch { /* storage unavailable */ }
    showLibPanel(saved);
    refreshSlicer();
    setInterval(refreshSlicer, 60000);
  }

  document.addEventListener('DOMContentLoaded', initLibrary);

  function setLibrary(items) { library = items; renderLibrary(); }
  function setFolders(list) { folders = list; renderLibrary(); }

  return { openPrinterFiles, openPrint, setLibrary, setFolders, renderLibrary, uploadToPrinter, showImage };
})();
