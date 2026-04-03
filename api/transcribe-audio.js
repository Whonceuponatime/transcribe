/**
 * Vercel serverless function for direct audio-to-text transcription via OpenAI Whisper.
 *
 * Flow (avoids Vercel's 4.5 MB request-body limit):
 *   1. Browser uploads audio directly to Supabase Storage via a signed URL
 *      (obtained from /api/audio-upload-url).
 *   2. Browser POSTs { storagePath, language? } JSON here.
 *   3. This function downloads the audio from Supabase to /tmp, sends it to
 *      OpenAI Whisper, deletes the Supabase file, and returns the transcription.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const http  = require('http');
const { OpenAI }       = require('openai');
const { createClient } = require('@supabase/supabase-js');

const BUCKET             = 'audio-temp';
const WHISPER_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB — OpenAI Whisper hard limit

function downloadUrl(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        return downloadUrl(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed with status ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error',  reject);
    }).on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
  if (!apiKey) {
    return res.status(503).json({ error: 'OpenAI API key not configured. Set OPENAI_API_KEY.' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  }

  const body        = req.body || {};
  const storagePath = body.storagePath;
  const language    = body.language;

  if (!storagePath) {
    return res.status(400).json({ error: 'storagePath is required' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Generate a short-lived signed download URL so we can fetch the file.
  const { data: signData, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 120); // 2-minute expiry

  if (signError) {
    return res.status(500).json({ error: 'Could not create download URL', details: signError.message });
  }

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-tx-'));
  const ext     = path.extname(storagePath) || '.mp3';
  const tmpFile = path.join(tmpDir, `audio${ext}`);

  try {
    await downloadUrl(signData.signedUrl, tmpFile);

    const fileSize = fs.statSync(tmpFile).size;
    if (fileSize > WHISPER_SIZE_LIMIT) {
      return res.status(413).json({
        error: `Audio file is too large for transcription (${(fileSize / 1024 / 1024).toFixed(1)} MB). Maximum is 25 MB. Please compress or trim the file.`,
      });
    }

    const transcriptionOptions = {
      file:            fs.createReadStream(tmpFile),
      model:           'whisper-1',
      response_format: 'text',
    };
    if (language && language !== 'auto') {
      transcriptionOptions.language = language;
    }

    const openai        = new OpenAI({ apiKey });
    const transcription = await openai.audio.transcriptions.create(transcriptionOptions);

    return res.status(200).json({
      success:             true,
      transcription,
      fileSize:            (fileSize / 1024 / 1024).toFixed(2) + ' MB',
      transcriptionLength: typeof transcription === 'string' ? transcription.length : 0,
      processingType:      'direct_audio',
    });

  } catch (error) {
    console.error('Audio transcription error:', error);
    return res.status(500).json({ error: 'Audio transcription failed', details: error.message });

  } finally {
    // Clean up local tmp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    // Delete from Supabase Storage
    supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
  }
};
