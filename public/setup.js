// Settings → Printers (admins): add, edit, test and remove printers. The form
// is built from each printer type's fields (GET /api/printer-setup/types).
// Uses api(), toast(), cards and STATUS_LABEL from app.js.
const Setup = (() => {
  const $ = (id) => document.getElementById(id);
  let types = null;     // [{ type, label, help, fields, slicer }]
  let machines = null;  // [{ vendor, machines }] from OrcaSlicer, or false if the slicer is down
  let editing = null;   // printer being edited, or null when adding

  const typeOf = (t) => types?.find((x) => x.type === t);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  async function loadTypes() {
    if (!types) types = await api('/api/printer-setup/types');
    return types;
  }

  async function render() {
    if (document.body.dataset.role !== 'admin') return;
    let list;
    try { [list] = await Promise.all([api('/api/printer-setup'), loadTypes()]); } catch (err) { toast(err.message, true); return; }
    $('ps-empty').hidden = list.length > 0;
    $('ps-list').replaceChildren(...list.map((p) => {
      const live = cards.get(p.id)?.state;
      const s = live ? (live.online ? live.status : 'offline') : 'offline';
      const pill = el('span', { className: 'pill', textContent: STATUS_LABEL[s] || s });
      pill.dataset.s = s;
      const where = [typeOf(p.type)?.label || p.type, p.host].filter(Boolean).join(' · ');
      const info = el('div', { className: 'ps-info' },
        el('strong', { textContent: p.name }),
        el('span', { className: 'ps-where', textContent: where }),
        ...(live?.error && !live.online ? [el('span', { className: 'ps-error', textContent: live.error })] : []));
      const edit = el('button', { className: 'btn small', type: 'button', textContent: 'Edit' });
      edit.onclick = () => open(p);
      return el('li', {}, info, pill, edit);
    }));
  }

  // ---- Dialog ---------------------------------------------------------------------

  function fieldInput(f, p) {
    const val = p?.[f.key];
    if (f.type === 'checkbox') {
      const input = el('input', { type: 'checkbox', name: f.key, checked: !!val });
      return el('label', { className: 'check' }, input, f.label);
    }
    const input = el('input', {
      name: f.key,
      type: f.type === 'password' ? 'password' : 'text',
      value: f.type === 'password' ? '' : val ?? '',
      placeholder: f.type === 'password' && p?.[`${f.key}Set`] ? 'Saved — leave empty to keep it' : f.placeholder || '',
      autocomplete: f.type === 'password' ? 'new-password' : 'off',
      spellcheck: false,
    });
    input.required = !!f.required && !(f.type === 'password' && p?.[`${f.key}Set`]);
    const label = el('label', {}, `${f.label}${f.required ? '' : ' (optional)'}`, input);
    return f.help ? el('div', { className: 'ps-field' }, label, el('p', { className: 'dlg-hint', textContent: f.help })) : label;
  }

  function showType(type, p) {
    const t = typeOf(type);
    $('ps-type-help').textContent = t?.help || '';
    $('ps-fields').replaceChildren(...(t?.fields || []).map((f) => fieldInput(f, p)));
    // A new printer of a type with a known profile starts with that profile.
    if (!p) pickSlicer(t?.slicer || null);
  }

  async function loadMachines() {
    if (machines !== null) return machines;
    try { machines = await api('/api/printer-setup/machines'); } catch { machines = false; }
    return machines;
  }

  function fillMachines(vendor, machine) {
    const sel = $('ps-machine');
    const list = (machines || []).find((v) => v.vendor === vendor)?.machines || [];
    sel.replaceChildren(...list.map((m) => new Option(m, m, false, m === machine)));
    sel.disabled = !list.length;
    // Most people have a 0.4 mm nozzle; pick that when nothing is chosen yet.
    if (!machine && list.length) sel.value = list.find((m) => /\b0\.4\b/.test(m)) || list[0];
  }

  function pickSlicer(slicer) {
    $('ps-vendor').value = slicer?.vendor || '';
    fillMachines(slicer?.vendor || '', slicer?.machine);
  }

  async function open(p = null) {
    editing = p;
    await loadTypes();
    const form = $('ps-form');
    form.reset();
    $('ps-result').hidden = true;
    form.querySelector('.ps-title').textContent = p ? `Edit ${p.name}` : 'Add a printer';
    const typeSel = $('ps-type');
    typeSel.replaceChildren(...types.map((t) => new Option(t.label, t.type)));
    typeSel.value = p?.type || types[0].type;
    typeSel.disabled = !!p; // a different type is a different printer
    form.elements.namedItem('name').value = p?.name || '';
    form.elements.namedItem('modelMatch').value = p?.modelMatch || '';
    $('ps-timelapse').checked = p?.timelapse !== false;
    // A value set through the API may not be in the list.
    const pick = (sel, value, label) => {
      if (![...sel.options].some((o) => o.value === value)) sel.add(new Option(label, value));
      sel.value = value;
    };
    const every = p?.timelapseEvery;
    pick($('ps-tl-every'), every?.seconds ? `seconds:${every.seconds}` : `layers:${every?.layers || 1}`, every?.seconds ? `Every ${every.seconds} seconds` : `Every ${every?.layers} layers`);
    pick($('ps-tl-length'), String(p?.timelapseLength || 0), `${p?.timelapseLength} seconds`);
    $('ps-timelapse-opts').hidden = !$('ps-timelapse').checked;
    $('ps-timelapse').onchange = () => { $('ps-timelapse-opts').hidden = !$('ps-timelapse').checked; };
    form.querySelector('.ps-advanced').open = !!p?.modelMatch;
    $('ps-delete').hidden = !p;

    const m = await loadMachines();
    const vendorSel = $('ps-vendor');
    vendorSel.replaceChildren(new Option('Don’t slice for this printer', ''), ...(m || []).map((v) => new Option(v.vendor, v.vendor)));
    vendorSel.disabled = !m;
    $('ps-slicer-hint').textContent = m
      ? 'The OrcaSlicer profile used when you slice models for this printer. Pick the closest match; "Custom" has generic Klipper and Marlin printers.'
      : 'The slicer isn’t running, so the profile can’t be picked now. You can set it later.';
    showType(typeSel.value, p);
    if (p) pickSlicer(p.slicer || typeOf(p.type)?.slicer || null);
    $('ps-dlg').showModal();
    form.elements.namedItem('name').focus();
  }

  function values() {
    const form = $('ps-form');
    const t = typeOf($('ps-type').value);
    const out = {
      type: t.type, name: form.elements.namedItem('name').value.trim(),
      modelMatch: form.elements.namedItem('modelMatch').value.trim(), timelapse: $('ps-timelapse').checked,
    };
    const [unit, n] = $('ps-tl-every').value.split(':');
    out.timelapseEvery = { [unit]: Number(n) };
    out.timelapseLength = Number($('ps-tl-length').value);
    for (const f of t.fields) {
      const input = form.elements[f.key];
      out[f.key] = f.type === 'checkbox' ? input.checked : input.value.trim();
    }
    const vendor = $('ps-vendor').value;
    if (!$('ps-vendor').disabled) out.slicer = vendor ? { vendor, machine: $('ps-machine').value } : null;
    if (editing) out.id = editing.id;
    return out;
  }

  function result(text, ok) {
    const r = $('ps-result');
    r.textContent = text;
    r.className = `ps-result ${ok ? 'ok' : 'bad'}`;
    r.hidden = false;
  }

  $('ps-type').onchange = (e) => showType(e.target.value, null);
  $('ps-vendor').onchange = (e) => fillMachines(e.target.value, null);
  $('ps-add').onclick = () => open(null);
  $('ps-cancel').onclick = () => $('ps-dlg').close();

  $('ps-test').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    result('Connecting… (up to 10 seconds)', true);
    try {
      const r = await api('/api/printer-setup/test', { body: values() });
      if (r.ok) result(`Connected: ${[r.model, r.firmware, STATUS_LABEL[r.status] || r.status].filter(Boolean).join(' · ')}`, true);
      else result(`Couldn’t connect: ${r.error}`, false);
    } catch (err) {
      result(err.message, false);
    } finally {
      btn.disabled = false;
    }
  };

  $('ps-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = values();
    try {
      if (editing) await api(`/api/printer-setup/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: v });
      else await api('/api/printer-setup', { body: v });
      $('ps-dlg').close();
      toast(editing ? `Saved ${v.name}` : `Added ${v.name}`);
      render();
    } catch (err) {
      result(err.message, false);
    }
  });

  $('ps-delete').onclick = async () => {
    if (!editing || !confirm(`Remove ${editing.name}? Its job history and filament rolls stay in the log.`)) return;
    try {
      await api(`/api/printer-setup/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
      $('ps-dlg').close();
      toast(`Removed ${editing.name}`);
      render();
    } catch (err) {
      result(err.message, false);
    }
  };

  return { render, open };
})();
