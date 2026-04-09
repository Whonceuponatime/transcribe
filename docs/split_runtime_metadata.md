# Split runtime metadata (canonical diagnostics export)

## A. exact files/functions changed

| File | Change |
|------|--------|
| `lib/runtimeMetadata.js` | Renamed `getRuntimeMetadata` implementation to `getApiRuntimeMetadata`; kept `getRuntimeMetadata` as deprecated alias; exported `resolveGitCommit`, `resolveGitBranch`, `resolveVersionFallback`. |
| `lib/traderRuntimeSnapshot.js` | **New:** `buildTraderRuntimeSnapshot()` — builds Pi trader snapshot object. |
| `lib/diagnosticStructuredExport.js` | `buildStructuredDiagnosticsExport()` — uses `getApiRuntimeMetadata()`; selects `app_settings` key `trader_runtime_metadata`; returns `api_runtime_metadata`, `trader_runtime_metadata`, `trader_runtime_metadata_updated_at`; `export_schema_version` **3**; removed top-level `runtime_metadata`. |
| `pi-trader/index.js` | On load: `persistTraderRuntimeMetadata()` (async) + `setInterval` every 15 minutes; upserts `trader_runtime_metadata` via `buildTraderRuntimeSnapshot()`. |

## B. exact app_settings key written by pi-trader

- **`trader_runtime_metadata`**

## C. exact export fields added

Top-level keys on the structured diagnostics JSON payload:

- **`api_runtime_metadata`** — return value of `getApiRuntimeMetadata()` (API/export host process).
- **`trader_runtime_metadata`** — `app_settings.value` for key `trader_runtime_metadata`, or `null` if missing/error.
- **`trader_runtime_metadata_updated_at`** — `app_settings.updated_at` for that row, or `null`.

Removed from export (replaced by above):

- **`runtime_metadata`** (use `api_runtime_metadata` instead).

Schema bump:

- **`export_schema_version`**: **3**

## D. exact feature flag detection logic for pi-trader

Same as API: `getDiagnosticFeatureFlags()` in `lib/runtimeMetadata.js` — requires `./signalEngine` and reads `lib/cryptoTraderV2.js` once from disk; flags are true when:

- **`reclaim_harvest_fields`**: `typeof signalEngine.getReclaimHarvestDiagnostics === 'function'` **and** `cryptoTraderV2.js` source contains `'reclaim_harvest_considered'`.
- **`tactical_profit_floor_fields`**: `typeof signalEngine.getTacticalProfitFloorDiagnostics === 'function'` **and** source contains `'tactical_profit_floor_considered'`.
- **`post_trim_runner_fields`**: `typeof signalEngine.getPostTrimRunnerDiagnostics === 'function'` **and** source contains `'post_trim_runner_considered'`.

Pi-trader calls this via `buildTraderRuntimeSnapshot()` → `getDiagnosticFeatureFlags()` using **local** `lib` files on the Pi.

## E. any limitations

- **`trader_runtime_metadata`** is only updated while **pi-trader** is running; if the Pi is down or DB write fails, the export shows `null` or a stale `updated_at`.
- **Canonical export** still runs on the **API host**; **`api_runtime_metadata`** reflects that Node process’s disk and env, not the Pi unless they are the same machine.
- **`GIT_COMMIT` / `GIT_BRANCH`** (and similar env vars) apply to whichever process is evaluated — API for `api_runtime_metadata`, Pi for `trader_runtime_metadata` when pi-trader writes the snapshot.
