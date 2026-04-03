/**
 * Audio transcription via OpenAI Whisper.
 *
 * Runs as a Vercel Edge Function (runtime: 'edge') which supports up to 128 MB
 * request bodies — bypassing the 4.5 MB limit of Node.js serverless functions.
 *
 * The browser POSTs multipart/form-data with the audio file directly here.
 * This function forwards the file to OpenAI Whisper and returns the transcription.
 */

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'OpenAI API key not configured. Set OPENAI_API_KEY.' }),
      { status: 503, headers }
    );
  }

  try {
    const formData  = await req.formData();
    const audioFile = formData.get('audio');
    const language  = formData.get('language');

    if (!audioFile) {
      return new Response(
        JSON.stringify({ error: 'No audio file uploaded' }),
        { status: 400, headers }
      );
    }

    // Forward to OpenAI Whisper
    const openaiForm = new FormData();
    openaiForm.append('file', audioFile, audioFile.name || 'audio.mp3');
    openaiForm.append('model', 'whisper-1');
    openaiForm.append('response_format', 'text');
    if (language && language !== 'auto') {
      openaiForm.append('language', language);
    }

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body:    openaiForm,
    });

    const transcription = await whisperRes.text();

    if (!whisperRes.ok) {
      return new Response(
        JSON.stringify({ error: 'OpenAI transcription failed', details: transcription }),
        { status: whisperRes.status, headers }
      );
    }

    return new Response(
      JSON.stringify({ success: true, transcription }),
      { status: 200, headers }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Transcription failed', details: error.message }),
      { status: 500, headers }
    );
  }
}
