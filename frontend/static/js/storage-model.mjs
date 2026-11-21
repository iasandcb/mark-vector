// Pure helpers for the storage screen. No DOM, so node:test can import them.

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const whole = Math.abs(value - Math.round(value)) < 0.05;
  const digits = value >= 10 || whole ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function usageWarning(usage) {
  return Boolean(usage && usage.warning);
}

// Only the four ids the server accepts. Anything else on the row (titles,
// sizes, a path) stays in the browser.
export function deleteRequest(recordings, indexes) {
  const wanted = indexes instanceof Set ? indexes : new Set(indexes);
  return {
    recordings: (recordings || []).filter((_, index) => wanted.has(index)).map((row) => ({
      project_id: row.project_id,
      conv_id: row.conv_id,
      filename: row.filename,
      recording_id: row.recording_id,
    })),
  };
}

export function cleanupDecision(preview, confirmed) {
  const originals = Array.isArray(preview?.originals) ? preview.originals.length : 0;
  const plays = Array.isArray(preview?.play_copies) ? preview.play_copies.length : 0;
  return {
    originals,
    plays,
    freedBytes: Number(preview?.freed_bytes) || 0,
    empty: originals + plays === 0,
    proceed: confirmed === true && originals + plays > 0,
  };
}

export function previewLines(preview) {
  const lines = [];
  for (const row of preview?.originals || []) {
    lines.push({
      kind: "original",
      label: [row.project_title || row.project_id, row.folder_title, row.filename, row.recording_id].filter(Boolean).join(" · "),
      size: Number(row.size) || 0,
    });
  }
  for (const row of preview?.play_copies || []) {
    lines.push({
      kind: "play",
      label: [row.filename, row.name].filter(Boolean).join(" · "),
      size: Number(row.size) || 0,
    });
  }
  return lines;
}
