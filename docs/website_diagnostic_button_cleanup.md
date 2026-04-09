# Website Diagnostic Button Cleanup

## A. exact files/components changed

| File | Change |
|------|--------|
| `client/src/components/CryptoTraderDashboard.js` | Pi Trader action row: one primary “Download diagnostic JSON (24h)” button; `downloadStructuredDiagnostic()`; legacy buttons moved under `<details>` “Advanced / legacy tools” |

---

## B. exact old buttons removed/hidden

Removed from the **main** Pi Trader button row (no longer top-level):

- **Export Logs**
- **Diagnostic (24h)** (legacy `diagnostic-export`)
- **Verify Trades (24h)**
- **Tuning Audit (24h)**

Those four remain available under **Advanced / legacy tools** (collapsed `<details>`).

---

## C. exact new button added

- **Label:** `Download diagnostic JSON (24h)` (or `Downloading…` while in flight)
- **Style:** `ct__btn ct__btn--primary` next to **Pull & Restart**
- **Handler:** `downloadStructuredDiagnostic(24)` → saves `diagnostics-24h.json`

---

## D. exact endpoint used

1. **Primary:** `GET {API}/api/diagnostics/export?hours=24` (same origin as dashboard; `API` from env / build).
2. **Fallback (HTTP 404 only):** `GET {API}/api/crypto-trader?action=structured-export&hours=24` — same payload from `lib/diagnosticStructuredExport.js`.

---

## E. whether redeploy is required

**Yes** — client bundle must be rebuilt and deployed (e.g. `npm run build` + host static deploy). The API routes must already exist on the backend (`/api/diagnostics/export` on Node `server.js`, or `structured-export` on `api/crypto-trader.js`).

---

## F. any limitations

- **404 fallback:** Only triggers on status **404**; other errors surface as-is.
- **CORS / API base:** `REACT_APP_*` / dashboard `API` must point at the server that exposes these routes.
- **Legacy exports** differ in schema from the canonical structured export (`diagnostic-export` vs `buildStructuredDiagnosticsExport`).
