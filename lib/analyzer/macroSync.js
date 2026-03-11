/**
 * Pull FRED series (macro). Cache for use in snapshots. Do not treat as live.
 */

const { fetchAllMacro } = require('./adapters/fredMacroProvider');

const DAYS_BACK = 730;

function observationStart() {
  const d = new Date();
  d.setDate(d.getDate() - DAYS_BACK);
  return d.toISOString().slice(0, 10);
}

async function syncMacro(apiKey) {
  const start = observationStart();
  return fetchAllMacro(apiKey, start);
}

module.exports = { syncMacro, observationStart };
