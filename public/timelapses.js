// Timelapses view (#timelapses): videos the hub recorded from printer cameras,
// plus the ones stored on Klipper and OctoPrint printers. Uses api(), toast()
// and cards from app.js.
const Timelapses = (() => {
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  let items = [];
  let loaded = false;

  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const mb = (n) => (n ? bytesText(n) : '');
  const STATUS = { recording: 'Recording', encoding: 'Making video', failed: 'Failed' };

  function setAll(list) {
    items = list;
    loaded = true;
    for (const card of cards.values()) card.el.querySelector('.cam').classList.toggle('rec', recording(card.state.id));
    if (!$('tl-grid').closest('.view').hidden) render();
  }

  const recording = (printerId) => items.some((i) => i.printerId === printerId && i.status === 'recording');

  function play(title, src, download) {
    const dlg = $('tl-dlg');
    dlg.querySelector('.tl-title').textContent = title;
    const video = dlg.querySelector('video');
    video.src = src;
    dlg.querySelector('.tl-download').href = download;
    dlg.showModal();
    video.play().catch(() => {});
  }

  function card(i) {
    const ready = i.status === 'ready';
    const poster = ready
      ? el('img', { src: `/api/timelapses/${enc(i.id)}/poster`, alt: '', loading: 'lazy' })
      : el('span', { className: 'tl-wait', textContent: STATUS[i.status] || i.status });
    if (ready) poster.onerror = () => poster.replaceWith(el('span', { className: 'tl-wait', textContent: '▶' }));
    const media = el('button', { type: 'button', className: 'tl-media', disabled: !ready, title: ready ? 'Play' : '' }, poster);
    const video = `/api/timelapses/${enc(i.id)}/video`;
    if (ready) media.onclick = () => play(i.file, video, `${video}?download`);
    const meta = [i.printerName, when(i.startedAt), i.seconds && `${Math.round(i.seconds)} s`, mb(i.size),
      i.outcome && i.outcome !== 'completed' && `print ${i.outcome}`].filter(Boolean).join(' · ');
    const actions = el('div', { className: 'tl-actions' });
    if (ready) actions.append(el('a', { className: 'btn small ghost', href: `${video}?download`, textContent: 'Download' }));
    if (i.status !== 'recording') {
      actions.append(Object.assign(el('button', { type: 'button', className: 'btn small ghost danger tl-del', textContent: 'Delete' }), {
        onclick: async () => {
          if (!confirm(`Delete the timelapse of ${i.file}?`)) return;
          try { await api(`/api/timelapses/${enc(i.id)}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); }
        },
      }));
    }
    const info = el('div', { className: 'tl-info' },
      el('strong', { className: 'tl-file', textContent: i.file, title: i.file }),
      el('span', { className: 'tl-meta', textContent: meta }),
      ...(i.status === 'recording' ? [el('span', { className: 'tl-live', textContent: `● Recording${i.frames ? ` · ${i.frames} frames` : ''}` })] : []),
      ...(i.error && i.status !== 'ready' ? [el('span', { className: 'tl-error', textContent: i.error })] : []),
      actions);
    return el('article', { className: `tl-card${ready ? '' : ` is-${i.status}`}` }, media, info);
  }

  async function render() {
    if (!loaded) { try { setAll(await api('/api/timelapses')); } catch (err) { toast(err.message, true); } return; }
    $('tl-grid').replaceChildren(...items.map(card));
    // Measured on the server: it includes previews and frames still being recorded.
    $('tl-total').hidden = !items.length;
    storageInfo(true).then((s) => {
      $('tl-total').textContent = `${s.timelapses.count} timelapse${s.timelapses.count === 1 ? '' : 's'} · ${bytesText(s.timelapses.bytes)} on disk${s.disk ? ` · ${bytesText(s.disk.free)} free` : ''}`;
    }).catch(() => { $('tl-total').hidden = true; });
    $('tl-empty').hidden = items.length > 0;
    // The printers' own timelapses (Klipper, OctoPrint) are fetched on demand.
    try {
      const printers = await api('/api/timelapses/printers');
      $('tl-printers').hidden = !printers.length;
      $('tl-native').replaceChildren(...printers.flatMap((p) => p.items.map((t) => {
        const src = `/api/printers/${enc(p.printerId)}/timelapse?name=${enc(t.name)}`;
        const playBtn = el('button', { type: 'button', className: 'btn small', textContent: 'Play' });
        playBtn.onclick = () => play(t.name, src, src);
        return el('li', {},
          el('div', { className: 'tl-info' }, el('strong', { textContent: t.name }), el('span', { className: 'tl-meta', textContent: [p.printerName, when(t.date), mb(t.size)].filter(Boolean).join(' · ') })),
          el('div', { className: 'tl-actions' }, playBtn, el('a', { className: 'btn small ghost', href: src, download: t.name.split('/').pop(), textContent: 'Download' })));
      })));
    } catch { $('tl-printers').hidden = true; }
  }

  $('tl-dlg').addEventListener('close', () => { const v = $('tl-dlg').querySelector('video'); v.pause(); v.removeAttribute('src'); v.load(); });

  return { setAll, render, recording };
})();
