# Diagnostic Export Unification (Bot Repo)

## A. exact files/functions changed

| File | Function / location | Role |
|------|---------------------|------|
| `lib/diagnosticStructuredExport.js` | `buildStructuredDiagnosticsExport(supabase, { hours })` | Single builder: parallel Supabase reads, blocker aggregation, JSON payload |
| `lib/diagnosticStructuredExport.js` | `normalizeBlockerKey()` | Normalizes blocker strings for counting (same idea as diagnostic-export) |
| `api/crypto-trader.js` | `action === 'structured-export'` `GET` | `Content-Disposition: diagnostics-{hours}h.json` |
| `server.js` | `app.get('/api/diagnostics/export', ...)` | Same payload for Node hosts serving the API |
| `api/crypto-trader.js` | Unknown-action error string | Lists `structured-export` |

---

## B. exact source-of-truth tables/data used

| Data | Supabase source |
|------|-----------------|
| Active bot config | `bot_config` (singleton row, `select * limit 1`) |
| Latest system state | `app_settings` keys: `system_freeze`, `current_regime`, `risk_engine_state`, `kill_switch`, `pi_heartbeat`, `v2_portfolio_snapshot`, `latest_reconciliation` |
| Open positions | `positions` where `state in ('open','adopted','partial')`, `select *` |
| Recent fills | `v2_fills` where `executed_at >= since` (cap 2000) |
| Recent orders / intents | `orders` where `created_at >= since` (cap 2000) |
| Recent DECISION_CYCLE | `bot_events` `event_type = 'DECISION_CYCLE'` (cap 5000) |
| Recent EXIT_EVALUATION | `bot_events` `event_type = 'EXIT_EVALUATION'` (cap 3000) |
| Recent RECONCILIATION | `bot_events` `event_type = 'RECONCILIATION'` (cap 500) |
| Recent EXECUTION | `bot_events` `event_type = 'EXECUTION'` (cap 2000) |
| Recent warn/error | `bot_events` `severity in ('warn','error')` (cap 500) |

**Not used:** `crypto_bot_logs` (PM2-backed text digest), raw console streams.

---

## C. exact export JSON structure

Top-level object (fields beyond the requested template are versioned and documented):

```json
{
  "export_schema_version": 1,
  "generated_at": "<ISO8601>",
  "window_hours": 24,
  "window_since_iso": "<ISO8601>",
  "active_bot_config": {},
  "latest_system_state": {},
  "open_positions": [],
  "recent_fills_executions": [],
  "recent_orders_intents": [],
  "recent_decision_cycles": [],
  "recent_exit_evaluations": [],
  "recent_reconciliation_events": [],
  "recent_error_events": [],
  "blocker_summaries": [],
  "buy_sell_counts": { "buy": 0, "sell": 0 },
  "top_blockers_by_count": []
}
```

- **`recent_fills_executions`:** Discriminated union: rows with `record_type: "v2_fill"` (full `v2_fills` row) and `record_type: "execution_event"` (trimmed `bot_events` EXECUTION fields).
- **`blocker_summaries`:** `{ "source": "DECISION_CYCLE.sell"|"DECISION_CYCLE.buy"|"EXIT_EVALUATION", "blocker_normalized": "<string>", "count": <number> }` sorted by count descending (from `DECISION_CYCLE.context_json.sell_checks.final_sell_blocker`, buy `final_reason` when buy ineligible, `EXIT_EVALUATION.context_json.blocker_summary`).
- **`top_blockers_by_count`:** First 25 entries of `blocker_summaries`.

---

## D. exact endpoint/script added

| Mechanism | URL / invocation |
|-----------|------------------|
| Crypto-trader action | `GET /api/crypto-trader?action=structured-export&hours=24` |
| Dedicated route (same server) | `GET /api/diagnostics/export?hours=24` |
| Download filename | `Content-Disposition: attachment; filename="diagnostics-{hours}h.json"` (e.g. `diagnostics-24h.json` when `hours=24`) |
| Programmatic | `require('./lib/diagnosticStructuredExport').buildStructuredDiagnosticsExport(supabase, { hours: 24 })` |

---

## E. any old logging code demoted

**None removed or disabled.** `pi-trader` `writeLog` → `crypto_bot_logs`, `DECISION_CYCLE` / `EXIT_EVALUATION` writes, and execution traces remain. This export is **additive**: structured DB rows are the recommended analysis source; PM2 / raw text logs are **non-canonical** by design only in documentation, not by deleting code paths.

---

## F. any limitations

- **Row caps:** Large windows may truncate lists (5000 / 3000 / 2000 limits); increase in code if needed.
- **Blockers:** Counts derive from `DECISION_CYCLE` / `EXIT_EVALUATION` structured fields only; not from `crypto_bot_logs` text.
- **Vercel static-only:** If the site is hosted without a Node API, call the same host that serves `api/crypto-trader` (env `REACT_APP_*` / dashboard API base URL).
- **`hours`:** Clamped to 1–168; default 24.
- **Supabase:** Requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` on the process serving the API.
