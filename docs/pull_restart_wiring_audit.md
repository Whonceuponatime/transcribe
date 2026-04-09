# Pull & Restart vs Diagnostics Export — Wiring Audit

## A. exact files/functions checked

| File | Location |
|------|----------|
| `client/src/components/CryptoTraderDashboard.js` | `deployPi` → `fetch(\`${API}/api/crypto-trader?action=deploy\`, { method: 'POST' })` |
| `api/crypto-trader.js` | `action === 'deploy' && req.method === 'POST'` — upserts `app_settings` key `crypto_deploy_trigger` |
| `pi-trader/index.js` | `pollDeploy()` — reads `crypto_deploy_trigger`, runs `git pull` / `npm install`, `process.exit(0)` |
| `lib/diagnosticStructuredExport.js` | `buildStructuredDiagnosticsExport()` — calls `getRuntimeMetadata()` from `lib/runtimeMetadata.js` |
| `lib/runtimeMetadata.js` | `getRuntimeMetadata()`, `getDiagnosticFeatureFlags()` — reads `lib/cryptoTraderV2.js` from **local disk** via `fs.readFileSync` |

---

## B. exact endpoint/button wiring

1. **Button:** “Pull & Restart” in `CryptoTraderDashboard.js` (Pi Trader section).
2. **Request:** `POST` to **`/api/crypto-trader?action=deploy`** (same origin when `API === ''`).
3. **Handler:** `api/crypto-trader.js` sets Supabase `app_settings.crypto_deploy_trigger` to `{ pending: true, requestedAt: … }`.
4. **Consumer:** `pi-trader/index.js` `pollDeploy` (interval **10s**) sees `pending`, clears flag, runs **`git pull`** with **`cwd = path.resolve(__dirname, '..')`** (repo root **on the machine running `pi-trader`**), then **`npm install --omit=dev`** at that root, then **`process.exit(0)`** so **PM2 restarts the `pi-trader` process** (whatever name is configured for that script).

---

## C. exact host/process being restarted

- **Restarted:** The **Node process** that runs **`pi-trader/index.js`** on the **Raspberry Pi** (or whichever host runs PM2 for that app), after **`git pull` in that host’s repo checkout** (`<repo-root>` = parent of `pi-trader/`).
- **Not restarted by this button:** Any separate **API / website server** (Express, Vercel, etc.) unless it is the same process (unusual).

---

## D. whether it matches the export/trader runtime

| Runtime | Role |
|---------|------|
| **Pi `pi-trader`** | Executes `executeCycleV2`, writes `DECISION_CYCLE` / DB — **updated** by Pull & Restart. |
| **Process serving** `/api/diagnostics/export` **and** `/api/crypto-trader?action=structured-export` | Runs `buildStructuredDiagnosticsExport` + `getRuntimeMetadata()` — reads **`lib/signalEngine.js` / `lib/cryptoTraderV2.js` from its own filesystem**. |

**They are generally not the same machine.** Pull & Restart updates **only** the Pi trader checkout. The **export** reflects whatever code is deployed on the **API host** that answers the HTTP request.

---

## E. exact reason post_trim_runner is still false after restart

`runtime_metadata.feature_flags.post_trim_runner_fields` is computed on the **API server** by:

1. `typeof signalEngine.getPostTrimRunnerDiagnostics === 'function'`, and  
2. `fs.readFileSync(…/lib/cryptoTraderV2.js).includes('post_trim_runner_considered')`.

Restarting **Pi** does **not** change files on the **API** box. If the API deployment still has an older `lib/cryptoTraderV2.js` (no substring) or older `signalEngine` export, **`post_trim_runner_fields` stays `false`** even immediately after Pull & Restart.

`reclaim_harvest_fields` / `tactical_profit_floor_fields` can be `true` because those strings/functions existed in the API bundle **earlier** than `post_trim_runner_*`.

---

## F. exact missing step to make restart affect the real bot runtime

- **For trading behaviour:** Pull & Restart on the **Pi** is already the right step — that updates **`pi-trader`** and live cycles.  
- **For `runtime_metadata.feature_flags` in the downloaded JSON:** Redeploy or **`git pull` + restart the Node process that serves** `api/crypto-trader` / `server.js` (the **same** host and path where `/api/diagnostics/export` runs), so **`lib/runtimeMetadata.js` + `lib/signalEngine.js` + `lib/cryptoTraderV2.js`** on **that** host match the commit you expect.

Optionally set **`GIT_COMMIT` / `GIT_BRANCH`** (or platform equivalents) in the API server environment so `runtime_metadata` shows an unambiguous revision without relying on `package.json` fallbacks.
