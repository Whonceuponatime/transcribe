/**
 * Snapshot of the live pi-trader process — same feature-flag logic as API (local lib files on Pi).
 */

const os = require('os');
const {
  getDiagnosticFeatureFlags,
  resolveGitCommit,
  resolveGitBranch,
  resolveVersionFallback,
} = require('./runtimeMetadata');

function buildTraderRuntimeSnapshot() {
  const commit = resolveGitCommit();
  const branch = resolveGitBranch();
  const pkgVer = resolveVersionFallback();
  const git_commit = commit || (pkgVer ? `npm_package_version:${pkgVer}` : 'unknown');
  const git_branch = branch || (pkgVer ? `release:${pkgVer}` : 'unknown');

  return {
    process_role: 'pi-trader',
    git_commit,
    git_branch,
    started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    hostname: os.hostname(),
    execution_mode: process.env.EXECUTION_MODE || process.env.TRADER_EXECUTION_MODE || 'live',
    feature_flags: getDiagnosticFeatureFlags(),
  };
}

module.exports = {
  buildTraderRuntimeSnapshot,
};
