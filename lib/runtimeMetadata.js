/**
 * Runtime metadata for structured diagnostic export — proves which Node bundle is serving the API.
 * No strategy logic; safe to require from api/crypto-trader and server routes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let cachedV2Source = null;
function readCryptoTraderV2SourceOnce() {
  if (cachedV2Source !== null) return cachedV2Source;
  try {
    cachedV2Source = fs.readFileSync(path.join(__dirname, 'cryptoTraderV2.js'), 'utf8');
  } catch (_) {
    cachedV2Source = '';
  }
  return cachedV2Source;
}

/**
 * Feature flags = signalEngine exports the diagnostic helpers AND cryptoTraderV2 embeds matching sell_checks keys.
 */
function getDiagnosticFeatureFlags() {
  const se = require('./signalEngine');
  const v2 = readCryptoTraderV2SourceOnce();
  return {
    reclaim_harvest_fields:
      typeof se.getReclaimHarvestDiagnostics === 'function' && v2.includes('reclaim_harvest_considered'),
    tactical_profit_floor_fields:
      typeof se.getTacticalProfitFloorDiagnostics === 'function' && v2.includes('tactical_profit_floor_considered'),
    post_trim_runner_fields:
      typeof se.getPostTrimRunnerDiagnostics === 'function' && v2.includes('post_trim_runner_considered'),
    runner_protect_fields:
      typeof se.getRunnerProtectDiagnostics === 'function' && v2.includes('runner_protect_considered'),
  };
}

function resolveGitCommit() {
  return (
    process.env.GIT_COMMIT
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.RAILWAY_GIT_COMMIT_SHA
    || process.env.RENDER_GIT_COMMIT
    || process.env.COMMIT_REF
    || process.env.SOURCE_VERSION
    || ''
  );
}

function resolveGitBranch() {
  return (
    process.env.GIT_BRANCH
    || process.env.VERCEL_GIT_COMMIT_REF
    || process.env.RAILWAY_GIT_BRANCH
    || process.env.BRANCH
    || ''
  );
}

function resolveVersionFallback() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require('../package.json').version || '';
  } catch (_) {
    return '';
  }
}

/**
 * @returns {object} API/export host snapshot for diagnostics JSON
 */
function getApiRuntimeMetadata() {
  const commit = resolveGitCommit();
  const branch = resolveGitBranch();
  const pkgVer = resolveVersionFallback();
  const git_commit = commit || (pkgVer ? `npm_package_version:${pkgVer}` : 'unknown');
  const git_branch = branch || (pkgVer ? `release:${pkgVer}` : 'unknown');

  const scriptPath = process.argv[1] || '';
  const process_name = path.basename(scriptPath) || process.title || 'node';

  return {
    process_name,
    execution_mode: process.env.EXECUTION_MODE || process.env.TRADER_EXECUTION_MODE || 'live',
    git_commit,
    git_branch,
    // Approximate Node process start (same process serving the export).
    started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    hostname: os.hostname(),
    feature_flags: getDiagnosticFeatureFlags(),
  };
}

/** @deprecated use getApiRuntimeMetadata */
const getRuntimeMetadata = getApiRuntimeMetadata;

module.exports = {
  getApiRuntimeMetadata,
  getRuntimeMetadata,
  getDiagnosticFeatureFlags,
  resolveGitCommit,
  resolveGitBranch,
  resolveVersionFallback,
};
