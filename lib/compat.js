// Which printer a print file was sliced for. G-code sliced for one printer can
// crash or ruin a print on another (different bed size, start G-code, nozzle
// offsets), so the hub refuses mismatched sends and starts.

// Slicer "printer_model" patterns per printer type; a printer can override
// with "modelMatch" (a regex string) in config.
const DEFAULT_MATCH = {
  flashforge: /flashforge|adventurer\s*5m|\bad5m\b/i,
  anycubic: /kobra\s*x\b/i,
  elegoo: /centauri\s*carbon\s*2|\bcc2\b/i,
};

function matcherFor(cfg) {
  if (cfg.modelMatch) return new RegExp(cfg.modelMatch, 'i');
  return DEFAULT_MATCH[cfg.type] || null;
}

// Returns { ok, reason, model } for printing `item` (a library entry, or just
// { printerModel }) on the printer with config `cfg`.
function checkFile(item, cfg, printerName) {
  if (item.slicedFor) {
    return item.slicedFor === cfg.id
      ? { ok: true, model: item.printerModel || null }
      : { ok: false, model: item.printerModel || null, reason: `was sliced by the hub for another printer, not ${printerName}` };
  }
  const model = item.printerModel;
  if (!model) return { ok: true, unknown: true, model: null };
  const re = matcherFor(cfg);
  if (!re) return { ok: true, unknown: true, model };
  return re.test(model)
    ? { ok: true, model }
    : { ok: false, model, reason: `was sliced for ${model}, not ${printerName}` };
}

module.exports = { checkFile, matcherFor };
