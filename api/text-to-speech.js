/**
 * Vercel serverless TTS — ElevenLabs only.
 *
 * The Express handler in server.js still serves both providers in local dev;
 * this function only exists because /api/text-to-speech 404s on Vercel.
 *
 * Long inputs are split server-side on sentence boundaries and each chunk's
 * audio is streamed back as it arrives, so multi-chunk requests don't hit
 * the Vercel 10s response timeout while waiting on the full conversion.
 */

const MAX_TEXT = 50000;
const CHUNK_TARGET = 4500;
const MAX_CHUNKS = 15;
const DEFAULT_MODEL = 'eleven_multilingual_v2';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  const voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : '';
  const modelId = typeof body.modelId === 'string' && body.modelId.trim()
    ? body.modelId.trim()
    : DEFAULT_MODEL;

  if (!text || !text.trim()) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: 'Text is required' });
  }
  if (text.length > MAX_TEXT) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: `Text exceeds max ${MAX_TEXT} characters` });
  }
  if (!voiceId) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: 'voiceId is required' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim();
  if (!apiKey) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(503).json({
      error: 'ElevenLabs API key not configured. Set ELEVENLABS_API_KEY.'
    });
  }

  let chunks;
  try {
    chunks = chunkText(text, CHUNK_TARGET);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: 'Failed to split text', detail: e.message });
  }

  if (chunks.length === 0) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: 'Text produced no chunks' });
  }
  if (chunks.length > MAX_CHUNKS) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(413).json({
      error: `Text produced ${chunks.length} chunks; maximum is ${MAX_CHUNKS}`
    });
  }

  let started = false;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let elevenResp;
    try {
      elevenResp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
          },
          body: JSON.stringify({
            text: chunk,
            model_id: modelId,
            output_format: 'mp3_44100_128'
          })
        }
      );
    } catch (networkErr) {
      if (!started) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({
          error: 'ElevenLabs request failed',
          detail: networkErr.message
        });
      }
      console.error(`TTS chunk ${i + 1}/${chunks.length} network error mid-stream:`, networkErr.message);
      res.end();
      return;
    }

    if (!elevenResp.ok) {
      let detail = '';
      try { detail = await elevenResp.text(); } catch (_) {}
      if (!started) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(elevenResp.status).json({
          error: `ElevenLabs returned ${elevenResp.status}`,
          detail: detail.slice(0, 500)
        });
      }
      console.error(`TTS chunk ${i + 1}/${chunks.length} returned ${elevenResp.status} mid-stream:`, detail.slice(0, 200));
      res.end();
      return;
    }

    let buf;
    try {
      const arr = await elevenResp.arrayBuffer();
      buf = Buffer.from(arr);
    } catch (readErr) {
      if (!started) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({
          error: 'Failed to read ElevenLabs response body',
          detail: readErr.message
        });
      }
      console.error(`TTS chunk ${i + 1}/${chunks.length} body read error mid-stream:`, readErr.message);
      res.end();
      return;
    }

    if (!started) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      // No Content-Length — Node uses chunked transfer encoding.
      started = true;
    }
    res.write(buf);
  }

  res.end();
};

// ── chunking ──────────────────────────────────────────────────────────────────

function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const sentences = splitIntoSentences(text);
  const packed = packUnits(sentences, maxLen);

  const final = [];
  for (const c of packed) {
    if (c.length <= maxLen) {
      final.push(c);
    } else {
      final.push(...splitOversized(c, maxLen));
    }
  }
  return final;
}

function splitIntoSentences(text) {
  const out = [];
  // Split on paragraph breaks first; preserve them as part of the preceding unit.
  const parts = text.split(/(\n\n+)/);
  for (const part of parts) {
    if (!part) continue;
    if (/^\n\n+$/.test(part)) {
      if (out.length > 0) out[out.length - 1] += part;
      else out.push(part);
      continue;
    }
    // Each match captures up to and including .!? plus following whitespace,
    // or a trailing fragment with no terminator.
    const sents = part.match(/[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g) || [part];
    for (const s of sents) if (s) out.push(s);
  }
  return out;
}

function packUnits(units, maxLen) {
  const chunks = [];
  let cur = '';
  for (const u of units) {
    if (!cur) {
      cur = u;
    } else if (cur.length + u.length <= maxLen) {
      cur += u;
    } else {
      chunks.push(cur);
      cur = u;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function splitOversized(text, maxLen) {
  // Try comma-and-whitespace boundaries first, preserving the comma+space.
  const commaParts = text.split(/(,\s+)/);
  if (commaParts.length > 1) {
    const phrases = [];
    for (let i = 0; i < commaParts.length; i += 2) {
      phrases.push((commaParts[i] || '') + (commaParts[i + 1] || ''));
    }
    const packed = packUnits(phrases, maxLen);
    const out = [];
    for (const p of packed) {
      if (p.length <= maxLen) out.push(p);
      else out.push(...splitOnWords(p, maxLen));
    }
    return out;
  }
  return splitOnWords(text, maxLen);
}

function splitOnWords(text, maxLen) {
  // Preserve whitespace runs so reassembly doesn't mash words together.
  const words = text.split(/(\s+)/);
  return packUnits(words, maxLen);
}
