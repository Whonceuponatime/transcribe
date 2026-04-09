# Runtime Metadata (Structured Diagnostic Export)

## A. exact files/functions changed

| File | Change |
|------|--------|
| `lib/runtimeMetadata.js` | **New:** `getRuntimeMetadata()`, `getDiagnosticFeatureFlags()` |
| `lib/diagnosticStructuredExport.js` | `buildStructuredDiagnosticsExport()` return value: `runtime_metadata`, `export_schema_version` bumped to **2** |

---

## B. exact runtime_metadata fields added

Top-level key: **`runtime_metadata`** (object).

| Field | Type | Meaning |
|-------|------|---------|
| `process_name` | string | Basename of `process.argv[1]`, else `process.title`, else `'node'` |
| `execution_mode` | string | `process.env.EXECUTION_MODE` or `TRADER_EXECUTION_MODE`, else `'live'` |
| `git_commit` | string | See **C** |
| `git_branch` | string | See **C** |
| `started_at` | ISO string | `Date.now() - process.uptime()` → approximate **Node process** start for the process answering the export |
| `uptime_seconds` | integer | `Math.floor(process.uptime())` |
| `hostname` | string | `os.hostname()` |
| `feature_flags` | object | See **D** |

---

## C. exact source for git/version/start time

**Git commit (first non-empty):**  
`GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`, `COMMIT_REF`, `SOURCE_VERSION`

**Git branch (first non-empty):**  
`GIT_BRANCH`, `VERCEL_GIT_COMMIT_REF`, `RAILWAY_GIT_BRANCH`, `BRANCH`

**Fallback when commit empty:** `npm_package_version:<version>` from repo root `package.json` `version`, or literal **`unknown`**.

**Fallback when branch empty:** `release:<version>` from same `package.json`, or **`unknown`**.

**Start time:** Not git-derived — derived from **`process.uptime()`** (Node VM start for the process running the export handler).

---

## D. exact feature flag detection logic

Each flag is **`true`** only if **both** hold:

1. **`lib/signalEngine.js`** exports the named function:  
   `getReclaimHarvestDiagnostics` / `getTacticalProfitFloorDiagnostics` / `getPostTrimRunnerDiagnostics`
2. **`lib/cryptoTraderV2.js`** source (read once from disk) **contains** the matching substring:  
   `reclaim_harvest_considered` / `tactical_profit_floor_considered` / `post_trim_runner_considered`

If either check fails, that flag is **`false`** (old bundle, partial deploy, or mismatched files).

---

## E. any limitations

- **Process identity:** `process_name` is the **API/trader Node script** handling the request, not PM2’s display name (set `name` in ecosystem / env if you need it mirrored).
- **Pi vs API host:** If the website calls a **remote API**, metadata reflects the **server running `buildStructuredDiagnosticsExport`**, not the Raspberry Pi unless that same host runs the trader.
- **Git env:** Without CI env vars or injected `GIT_*`, you only get **`npm_package_version:`** / **`release:`** fallbacks from `package.json`.
- **Schema:** Consumers should use `export_schema_version === 2` to expect `runtime_metadata`.
