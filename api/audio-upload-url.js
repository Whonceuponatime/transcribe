/**
 * Returns a Supabase signed upload URL so the browser can PUT an audio file
 * directly to Supabase Storage — bypassing Vercel's 4.5 MB request-body limit.
 *
 * POST /api/audio-upload-url
 * Body: { filename: string }
 * Response: { storagePath: string, token: string, signedUrl: string }
 */

const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'audio-temp';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  }

  const { filename = 'audio' } = req.body || {};
  const safeName    = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const storagePath = `temp/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Ensure bucket exists (no-op if already created).
  await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (error) {
    return res.status(500).json({ error: 'Could not create signed upload URL', details: error.message });
  }

  return res.status(200).json({
    storagePath,
    token:     data.token,
    signedUrl: data.signedUrl,
  });
};
