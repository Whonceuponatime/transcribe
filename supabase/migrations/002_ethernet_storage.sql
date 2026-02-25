-- Storage bucket for Ethernet PDF uploads (avoids Vercel payload limit)
-- Run this in Supabase SQL Editor, or create bucket manually: Storage → New bucket → id: ethernet-pdfs, Private, 50MB, PDF only
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ethernet-pdfs',
  'ethernet-pdfs',
  false,
  52428800,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = 52428800,
  allowed_mime_types = ARRAY['application/pdf'];

-- Allow authenticated users to upload
DROP POLICY IF EXISTS "Authenticated users can upload ethernet PDFs" ON storage.objects;
CREATE POLICY "Authenticated users can upload ethernet PDFs"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'ethernet-pdfs');

-- Allow authenticated users to read their uploads (for cleanup)
DROP POLICY IF EXISTS "Authenticated users can read ethernet PDFs" ON storage.objects;
CREATE POLICY "Authenticated users can read ethernet PDFs"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'ethernet-pdfs');

-- Service role bypasses RLS for server-side downloads
