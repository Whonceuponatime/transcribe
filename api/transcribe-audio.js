/**
 * Vercel serverless function for direct audio-to-text transcription via OpenAI Whisper.
 * Mirrors the /api/transcribe-audio route in server.js for production deployments.
 *
 * Body parsing is disabled so formidable can handle multipart audio file uploads.
 */

module.exports.config = { api: { bodyParser: false } };

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { IncomingForm } = require('formidable');
const { OpenAI }       = require('openai');

const SUPPORTED_FORMATS  = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'];
const WHISPER_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB — OpenAI Whisper hard limit

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
  if (!apiKey) {
    return res.status(503).json({ error: 'OpenAI API key not configured. Set OPENAI_API_KEY.' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-tx-'));

  try {
    const form = new IncomingForm({
      uploadDir: tmpDir,
      keepExtensions: true,
      maxFileSize: 30 * 1024 * 1024, // 30 MB upload cap
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const fileEntry = Array.isArray(files.audio) ? files.audio[0] : files.audio;
    if (!fileEntry) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const originalName = fileEntry.originalFilename || fileEntry.name || 'audio';
    const ext = path.extname(originalName).toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext)) {
      return res.status(400).json({
        error: 'Unsupported audio format',
        supportedFormats: SUPPORTED_FORMATS,
        receivedFormat: ext,
      });
    }

    const audioPath = fileEntry.filepath || fileEntry.path;
    const fileSize  = fileEntry.size;

    if (fileSize > WHISPER_SIZE_LIMIT) {
      return res.status(413).json({
        error: `Audio file too large for transcription (${(fileSize / 1024 / 1024).toFixed(1)} MB). Maximum size is 25 MB. Please compress or trim your audio file.`,
      });
    }

    const language = Array.isArray(fields.language) ? fields.language[0] : fields.language;
    const transcriptionOptions = {
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'text',
    };
    if (language && language !== 'auto') {
      transcriptionOptions.language = language;
    }

    const openai = new OpenAI({ apiKey });
    const transcription = await openai.audio.transcriptions.create(transcriptionOptions);

    return res.status(200).json({
      success: true,
      transcription,
      filename: originalName,
      fileSize: (fileSize / 1024 / 1024).toFixed(2) + ' MB',
      transcriptionLength: typeof transcription === 'string' ? transcription.length : 0,
      processingType: 'direct_audio',
    });

  } catch (error) {
    console.error('Audio transcription error:', error);
    return res.status(500).json({
      error: 'Audio transcription failed',
      details: error.message,
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
};
