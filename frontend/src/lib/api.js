// Thin client for the admin backend. Configure the base via NEXT_PUBLIC_API_BASE
// (defaults to the local backend dev server).
const BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000/api';

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try { detail = (await res.json()).error || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

const wedBase = '/pipelines/wed';
const v = (s) => encodeURIComponent(s);

// SSE endpoint for live run updates (the dashboard opens one EventSource here
// instead of polling). Same origin as the REST base.
export const streamUrl = `${BASE}${wedBase}/stream`;

export const api = {
  // Ledger (real data from the Phase 7 collections).
  wedSummary: () => get(`${wedBase}/summary`),
  wedReleases: () => get(`${wedBase}/releases`),
  wedRelease: (ver) => get(`${wedBase}/releases/${v(ver)}`),
  wedDiff: (ver) => get(`${wedBase}/releases/${v(ver)}/diff`),
  wedChanges: (ver, query = '') => get(`${wedBase}/releases/${v(ver)}/changes${query}`),
  wedSources: (ver) => get(`${wedBase}/releases/${v(ver)}/sources`),

  // Source-level execution health (per-source pass/fail under the Stata step).
  wedSourceHealth: () => get(`${wedBase}/source-health`),

  // Operational runs (populated by the webhook + heartbeats; [] until a live run).
  wedRuns: () => get(`${wedBase}/runs`),
  wedRun: (runId) => get(`${wedBase}/runs/${v(runId)}`),
};
