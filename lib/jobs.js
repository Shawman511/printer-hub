// Print job log: watches normalized printer state and records each job from
// start to finish, persisted as JSON in data/. Each job carries a quantity
// (items per plate), defaulted from the last quantity used for the same model.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ACTIVE = ['printing', 'heating', 'pausing', 'paused', 'cancelling'];
const OUTCOMES = ['printing', 'completed', 'cancelled', 'failed', 'unknown'];
const RESUME_WINDOW_MS = 30 * 60 * 1000;

// "1024-1448-Shark Holder_plate(01)_PLA_0.2_3h0m44s.gcode" -> "Shark Holder"
// so re-slices of the same model group together.
function itemName(file) {
  let n = String(file || '').replace(/^.*[\\/]/, '');
  n = n.replace(/\.(gcode|gx|g|3mf|bgcode)$/i, '');
  n = n.replace(/^\d{4}-\d{4}-/, '');
  // Hub-sliced: <model>_<printer>_<0.20mm>_<material>[_x4][_v2]
  n = n.replace(/_[A-Za-z0-9-]+_\d+\.\d+mm_[A-Za-z0-9.+-]+?(_x\d+)?(_v\d+)?$/, '');
  n = n.replace(/_(PLA|PETG|ABS|ASA|TPU|PA|PC|PVA|HIPS|PET|CF|SILK)[^_]*_\d+(\.\d+)?_[\dhms]+$/i, '');
  const plate = /_plate\((\d+)\)$/i.exec(n);
  n = n.replace(/_plate\(\d+\)$/i, '');
  if (plate && +plate[1] > 1) n += ` (plate ${+plate[1]})`;
  return n.replace(/_/g, ' ').trim() || String(file);
}
const itemKey = (file) => itemName(file).toLowerCase();

// Filament used so far: the full plan for completed jobs, otherwise the plan
// scaled by how far the print got.
function filamentUsed(job) {
  if (!Array.isArray(job.filamentPlan)) return [];
  const factor = job.outcome === 'completed' ? 1 : Math.max(0, Math.min(1, (job.progress || 0) / 100));
  return job.filamentPlan.map((p) => ({ slot: p.slot, grams: Math.round(p.grams * factor * 10) / 10 }));
}

function applyFilament(job) {
  if (!Array.isArray(job.filamentPlan)) return;
  job.filament = filamentUsed(job);
  job.grams = Math.round(job.filament.reduce((n, p) => n + p.grams, 0) * 10) / 10;
}

// Grams per slot for a job. `colors` are the file's colors and the slot each
// prints from; some printers report 0 g for every color (the Kobra X does for
// files the hub sliced), and then the total goes to the slot they share. With
// several slots and no weights there's no telling the split, so it's unassigned.
function planFilamentUse(colors, total, multi) {
  if (colors?.some((c) => c.grams > 0)) return colors.map((c) => ({ slot: c.slot, grams: c.grams || 0 }));
  if (!total) return null;
  if (!multi) return [{ slot: 0, grams: total }];
  const slots = new Set((colors || []).map((c) => c.slot));
  return [{ slot: slots.size === 1 ? [...slots][0] : null, grams: total }];
}

class JobLog extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'jobs.json');
    fs.mkdirSync(dir, { recursive: true });
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.jobs = saved.jobs || [];
    this.defaults = saved.defaults || {}; // itemKey -> items per plate
    this.lastStatus = new Map();
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ jobs: this.jobs, defaults: this.defaults }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  changed(job) {
    this.save();
    this.emit('job', job);
  }

  openJob(printerId) {
    return this.jobs.find((j) => j.printerId === printerId && j.outcome === 'printing');
  }

  // Called on every printer state update.
  observe(state) {
    if (!state.online) return; // never close jobs on a connection blip
    const prev = this.lastStatus.get(state.id);
    this.lastStatus.set(state.id, state.status);
    let open = this.openJob(state.id);
    const job = state.job;

    if (ACTIVE.includes(state.status) && job?.file) {
      if (open && open.file !== job.file) {
        this.close(open, 'unknown', `Printer moved on to ${job.file}`);
        open = null;
      }
      if (!open) open = this.resumed(state);
      if (!open) {
        const key = itemKey(job.file);
        const hint = this.quantityHint?.(job.file);
        open = {
          id: crypto.randomUUID(),
          printerId: state.id,
          printerName: state.name,
          file: job.file,
          item: itemName(job.file),
          // A file the hub sliced knows its copy count; otherwise use the model's default.
          quantity: hint ?? this.defaults[key] ?? 1,
          quantitySet: hint != null || key in this.defaults,
          outcome: 'printing',
          startedAt: Date.now() - (job.elapsed ? job.elapsed * 1000 : 0),
          endedAt: null,
          printSeconds: 0,
          progress: 0,
          notes: '',
        };
        this.jobs.push(open);
        this.changed(open);
      }
      const progress = job.progress || 0;
      const printSeconds = Math.max(open.printSeconds, job.elapsed || 0);
      if (progress !== open.progress || printSeconds !== open.printSeconds) {
        // Rolls count down as a print runs; each whole percent is often enough.
        const nextPercent = Math.floor(progress) !== Math.floor(open.progress);
        open.progress = progress;
        open.printSeconds = printSeconds;
        open.lastSeen = Date.now();
        // Persist progress at most once a minute; final state is saved on close.
        if (!open.savedAt || Date.now() - open.savedAt > 60000) { open.savedAt = Date.now(); this.save(); }
        if (nextPercent && open.filamentPlan) this.emit('progress', open);
      }
      return;
    }

    if (!open) return;
    if (state.status === 'completed') this.close(open, 'completed');
    else if (state.status === 'error') this.close(open, 'failed', state.error || 'Printer reported an error');
    else if (state.status === 'idle') {
      // Some printers go straight back to idle after finishing (and those that
      // report whole percents may stop at 99). If the hub was restarted while
      // this job was open, we can't tell what happened.
      const finished = open.progress >= 99 || (job && job.progress >= 99);
      if (finished) this.close(open, 'completed');
      else if (prev === undefined) this.close(open, 'unknown', 'The hub restarted during this print and found the printer idle');
      else this.close(open, 'cancelled', 'Printer went back to idle without reporting a finish');
    }
  }

  // A printer that reports an error or idle for a moment and then carries on is
  // still on the same print: reopen its job rather than leave a failed entry
  // and start a second one. A real re-print starts again from the beginning.
  resumed(state) {
    const { file, progress = 0, elapsed } = state.job;
    const last = this.jobs
      .filter((j) => j.printerId === state.id && j.file === file && !j.manual && j.endedAt && ['failed', 'cancelled', 'unknown'].includes(j.outcome))
      .sort((a, b) => b.endedAt - a.endedAt)[0];
    if (!last || Date.now() - last.endedAt > RESUME_WINDOW_MS || !(last.progress >= 1)) return null;
    if ((progress || 0) < last.progress - 2 || (elapsed && elapsed < (last.printSeconds || 0) - 120)) return null;
    console.log(`Job log: ${state.name} resumed ${file} at ${Math.round(progress || 0)}%, reopening the job (it had ended: ${last.endReason || last.outcome})`);
    last.outcome = 'printing';
    last.endedAt = null;
    delete last.endReason;
    delete last.filament;
    delete last.grams;
    this.changed(last);
    return last;
  }

  close(job, outcome, reason) {
    job.outcome = outcome;
    job.endedAt = Date.now();
    if (reason) {
      job.endReason = `${reason} (at ${Math.round(job.progress || 0)}%)`;
      console.log(`Job log: ${job.printerName} ${job.file} ended as ${outcome}: ${job.endReason}`);
    } else {
      delete job.endReason;
    }
    if (!job.printSeconds) job.printSeconds = Math.round((job.endedAt - job.startedAt) / 1000);
    if (outcome === 'completed') job.progress = 100;
    delete job.savedAt;
    applyFilament(job);
    this.changed(job);
  }

  // The planned grams per slot for a job, worked out when it starts (from the
  // file's per-color weights and the slot mapping, or its total weight).
  setFilamentPlan(id, plan) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || !Array.isArray(plan) || !plan.length) return;
    job.filamentPlan = plan.map((p) => ({ slot: p.slot ?? null, grams: Math.round((Number(p.grams) || 0) * 10) / 10 }));
    if (job.outcome !== 'printing') applyFilament(job);
    this.changed(job);
  }

  list() {
    return [...this.jobs].sort((a, b) => b.startedAt - a.startedAt);
  }

  // Edits from the UI. Setting quantity also becomes the default for this
  // model, and fills in earlier jobs of it that were never given one.
  edit(id, patch) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error('Unknown job');
    if (patch.quantity != null) {
      const q = Math.max(0, Math.min(10000, Math.round(Number(patch.quantity)) || 0));
      job.quantity = q;
      job.quantitySet = true;
      this.setDefault(itemKey(job.file), q);
    }
    if (patch.outcome && OUTCOMES.includes(patch.outcome) && patch.outcome !== 'printing') {
      job.outcome = patch.outcome;
      job.endedAt = job.endedAt || Date.now();
      if (patch.outcome === 'completed') delete job.endReason;
      applyFilament(job);
    }
    if (patch.notes != null) job.notes = String(patch.notes).slice(0, 500);
    this.save();
    this.emit('reset');
    return job;
  }

  setDefault(key, q) {
    this.defaults[key] = q;
    for (const other of this.jobs) {
      if (!other.quantitySet && itemKey(other.file) === key) { other.quantity = q; other.quantitySet = true; }
    }
  }

  remove(id) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) throw new Error('Unknown job');
    this.jobs.splice(i, 1);
    this.save();
    this.emit('reset');
  }

  // A renamed file is still the same item: keep its items per plate.
  renamedFile(oldFile, newFile) {
    const from = itemKey(oldFile);
    const to = itemKey(newFile);
    if (from !== to && from in this.defaults && !(to in this.defaults)) {
      this.defaults[to] = this.defaults[from];
      this.save();
    }
  }

  // Back-fill prints made before the hub was logging: `plates` completed jobs.
  addManual({ file, printerId, printerName, plates = 1, quantity, hours = 0, date }) {
    if (!file) throw new Error('Item name is required');
    const n = Math.max(1, Math.min(1000, Math.round(Number(plates)) || 1));
    const key = itemKey(file);
    const q = quantity != null && quantity !== '' ? Math.max(0, Math.round(Number(quantity)) || 0) : (this.defaults[key] ?? 1);
    if (quantity != null && quantity !== '') this.setDefault(key, q);
    const startedAt = date ? new Date(date).getTime() || Date.now() : Date.now();
    const secs = Math.round((Number(hours) || 0) * 3600);
    for (let i = 0; i < n; i++) {
      this.jobs.push({
        id: crypto.randomUUID(), printerId: printerId || null, printerName: printerName || 'Manual entry',
        file, item: itemName(file), quantity: q, quantitySet: true, outcome: 'completed',
        startedAt, endedAt: startedAt + secs * 1000, printSeconds: secs, progress: 100, notes: '', manual: true,
      });
    }
    this.save();
    this.emit('reset');
  }

  csv() {
    // Spreadsheets run a cell starting with = + - @ as a formula; file names and
    // notes come from users and printers, so those get a leading apostrophe.
    const esc = (v) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
    const rows = [['started', 'ended', 'printer', 'item', 'file', 'outcome', 'items_per_plate', 'print_hours', 'filament_g', 'manual', 'notes']];
    for (const j of this.list()) {
      rows.push([
        new Date(j.startedAt).toISOString(), j.endedAt ? new Date(j.endedAt).toISOString() : '',
        j.printerName, j.item, j.file, j.outcome, j.quantity, (j.printSeconds / 3600).toFixed(2), j.grams ?? '', j.manual ? 'yes' : '', j.notes,
      ]);
    }
    return rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }
}

module.exports = { JobLog, itemName, itemKey, planFilamentUse, filamentUsed };
