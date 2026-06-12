// Formatting helpers shared across the dashboard. Tolerate the shapes the API
// actually returns: ISO strings (Mongo dates serialized to JSON), epoch ms, or
// Date objects.

export function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// "YYYY-MM-DD" from any date-ish value.
export function isoDate(v) {
  if (v == null) return '—';
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export function fmtNum(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—';
}

export function fmtPct(n, digits = 2) {
  return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
}

export function fmtDuration(sec) {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Human relative time, past or future. now defaults to wall clock.
export function relativeTime(v, now = Date.now()) {
  const ts = toMs(v);
  if (ts == null) return 'in progress';
  const diff = ts - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  let phrase;
  if (mins < 1) return 'just now';
  if (mins < 60) phrase = `${mins} min`;
  else if (hrs < 24) phrase = `${hrs} hour${hrs > 1 ? 's' : ''}`;
  else if (days < 60) phrase = `${days} day${days > 1 ? 's' : ''}`;
  else phrase = `${Math.round(days / 30)} month${Math.round(days / 30) > 1 ? 's' : ''}`;
  return diff < 0 ? `${phrase} ago` : `in ${phrase}`;
}

// Compact date+time for detail rows.
export function fmtDateTime(v) {
  const ts = toMs(v);
  if (ts == null) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return isoDate(v);
  }
}

// A short numeric value formatter for cell values that span tiny→huge.
export function fmtValue(v) {
  if (v == null) return '—';
  if (typeof v !== 'number') return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-3) return v.toExponential(2);
  // Trim to a few significant digits without trailing-zero noise.
  return Number(v.toPrecision(6)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// Map a release/run status to the dashboard's visual state vocabulary.
export function stateOf(status) {
  if (status === 'completed' || status === 'success' || status === 'passed') return 'passed';
  if (status === 'failed' || status === 'failure') return 'failed';
  if (status === 'in_progress' || status === 'running' || status === 'queued') return 'running';
  return 'pending';
}
