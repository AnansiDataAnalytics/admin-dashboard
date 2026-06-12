// WED ledger reads — read-only over the Phase 7 collections (releases / changes)
// in the configured WED DB. This is the "what each release pushed" data.
const { getDb } = require('../../shared/db');
const { config } = require('../../shared/config');

async function coll(name) {
  const db = await getDb(config.wedDb);
  return db.collection(name);
}

// Release ledger — one doc per version, newest first.
async function listReleases() {
  const c = await coll('releases');
  return c.find({}, { projection: { _id: 0 } }).sort({ known_from: -1 }).toArray();
}

async function getRelease(version) {
  const c = await coll('releases');
  return c.findOne({ release_version: version }, { projection: { _id: 0 } });
}

// Latest release + a small rollup for the dashboard hero / pipeline card.
async function getSummary() {
  const c = await coll('releases');
  const [total, latest, completed] = await Promise.all([
    c.countDocuments({}),
    c.find({}, { projection: { _id: 0 } }).sort({ known_from: -1 }).limit(1).next(),
    c.countDocuments({ status: 'completed' }),
  ]);
  return { total_releases: total, completed_releases: completed, latest: latest || null };
}

// Typed change events for a release (the granular "what moved"), filter+paginate.
async function listChanges(version, { type, scope, series_code, source, limit = 100, skip = 0 } = {}) {
  const c = await coll('changes');
  const q = { to_release: version };
  if (type) q.type = type;
  if (scope) q.scope = scope;
  if (series_code) q.series_code = series_code;
  if (source) q.source = source; // per-source drill-down (scope='source' events)
  const capped = Math.min(Number(limit) || 100, 500);
  const sk = Number(skip) || 0;
  const [items, total] = await Promise.all([
    c.find(q, { projection: { _id: 0 } }).skip(sk).limit(capped).toArray(),
    c.countDocuments(q),
  ]);
  return { total, limit: capped, skip: sk, items };
}

// Per-source change breakdown for a release: which upstream source columns
// (IMF_IFS, EUS, OECD_EO, WDI, …) moved, and how much. Groups the scope='source'
// events by source × type — the Phase-4/7 multi-source tracking, release-level.
async function sourceBreakdown(version) {
  const c = await coll('changes');
  const rows = await c.aggregate([
    { $match: { to_release: version, scope: 'source' } },
    { $group: { _id: { source: '$source', type: '$type' }, n: { $sum: 1 } } },
  ]).toArray();
  const bySource = new Map();
  for (const r of rows) {
    const src = r._id.source || '(unknown)';
    const entry = bySource.get(src) || { source: src, revision: 0, insert: 0, discontinuation: 0, total: 0 };
    entry[r._id.type] = (entry[r._id.type] || 0) + r.n;
    entry.total += r.n;
    bySource.set(src, entry);
  }
  const sources = [...bySource.values()].sort((a, b) => b.total - a.total);
  const totals = sources.reduce((acc, s) => {
    acc.revision += s.revision; acc.insert += s.insert;
    acc.discontinuation += s.discontinuation; acc.total += s.total;
    return acc;
  }, { revision: 0, insert: 0, discontinuation: 0, total: 0 });
  return { release_version: version, sources, totals };
}

// The diff view for a release: its change_summary (counts + gate) + the biggest
// harmonized revisions (by order-of-magnitude), ready for a diff panel.
async function getDiff(version) {
  const release = await getRelease(version);
  if (!release) return null;
  const c = await coll('changes');
  const top = await c.aggregate([
    { $match: { to_release: version, scope: 'harmonized', type: 'revision' } },
    { $addFields: { _mag: { $abs: { $ifNull: ['$log10_ratio', 0] } } } },
    { $sort: { _mag: -1 } },
    { $limit: 25 },
    { $project: { _id: 0, _mag: 0 } },
  ]).toArray();
  return {
    release_version: version,
    from_release: release.from_release || null,
    known_from: release.known_from || null,
    summary: release.change_summary || null,
    top_revisions: top,
  };
}

module.exports = { listReleases, getRelease, getSummary, listChanges, getDiff, sourceBreakdown };
