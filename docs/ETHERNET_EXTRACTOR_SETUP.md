# Ethernet Connections Extractor – Setup

## Overview

The **Extract Ethernet Connections (PDF)** feature parses vessel cable-diagram PDFs and produces a system-to-system Ethernet connection list with cable IDs, media types, page references, confidence scores, and a review list for unpaired/ambiguous items.

**PDFs are uploaded to Supabase Storage first**, then the API fetches them for processing. This avoids Vercel’s ~4.5 MB request body limit.

## Supabase Setup (Required)

### 1. Run Migrations

```bash
# If using Supabase CLI
supabase db push

# Or run manually in Supabase SQL Editor:
# 1. supabase/migrations/001_ethernet_jobs.sql
# 2. supabase/migrations/002_ethernet_storage.sql
```

### 2. Storage Bucket

The migration `002_ethernet_storage.sql` creates the `ethernet-pdfs` bucket and RLS policies. Authenticated users can upload; the service role can read for processing.

### 3. Environment Variables

**Client** (already configured for auth):
- `REACT_APP_SUPABASE_URL`
- `REACT_APP_SUPABASE_ANON_KEY`

**Server / Vercel API** (required for ethernet extraction):
- `SUPABASE_URL` – Project URL
- `SUPABASE_SERVICE_ROLE_KEY` – For server-side Storage downloads

Add these in Vercel → Project → Settings → Environment Variables.

## Current Behavior

- **Client**: Uploads PDFs to `ethernet-pdfs` bucket → calls API with storage paths (small JSON payload).
- **API**: Fetches PDFs from Storage → processes → returns results → client deletes temp files from Storage.
- **Vercel**: No payload limit issue; execution time limits still apply (60s pro plan).

## Cable ID Patterns Supported

- `A01-001-15-NN`, `N50-001-03-NN`, `N61-002-14-NN`, `N62-002-03A-NN`
- Regex: `[A-Z]?\d{2,3}-\d{3}-\d{2}[A-Z]?-\w+`

## Phase 2 (AI Assist)

Planned enhancements:

- AI vision for unpaired/ambiguous cases
- Structured JSON output with evidence
- Page-level cropping and reasoning passes
