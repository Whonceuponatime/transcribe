# Ethernet Connections Extractor – Setup

## Overview

The **Extract Ethernet Connections (PDF)** feature parses vessel cable-diagram PDFs and produces a system-to-system Ethernet connection list with cable IDs, media types, page references, confidence scores, and a review list for unpaired/ambiguous items.

## Supabase Setup (Optional for MVP)

To persist jobs and store PDFs in Supabase:

### 1. Run Migration

```bash
# If using Supabase CLI
supabase db push

# Or run manually in Supabase SQL Editor:
# Copy contents of supabase/migrations/001_ethernet_jobs.sql
```

### 2. Storage Bucket

Create a bucket `vessel-cables` in Supabase Storage (Dashboard → Storage → New bucket).
Set RLS policies as needed for your app.

### 3. Environment Variables

- `SUPABASE_URL` – Project URL
- `SUPABASE_SERVICE_ROLE_KEY` – For server-side uploads and DB writes

## Current Behavior (MVP)

- **Without Supabase**: PDFs are uploaded to the server, processed in-memory, and results are returned directly. No persistence.
- **Local dev**: Run `npm run dev` (backend) and ensure client proxy points to it. Use `/api/ethernet/extract`.
- **Vercel**: The `api/ethernet/extract.js` serverless function handles the request. Uses `/tmp` for temporary file storage. Large PDFs may hit execution limits (60s pro plan).

## Cable ID Patterns Supported

- `A01-001-15-NN`, `N50-001-03-NN`, `N61-002-14-NN`, `N62-002-03A-NN`
- Regex: `[A-Z]?\d{2,3}-\d{3}-\d{2}[A-Z]?-\w+`

## Phase 2 (AI Assist)

Planned enhancements:

- AI vision for unpaired/ambiguous cases
- Structured JSON output with evidence
- Page-level cropping and reasoning passes
