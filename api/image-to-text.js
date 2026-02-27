const { OpenAI } = require('openai');

const FORMAT_INSTRUCTIONS = {
  plain: 'Output only the transcribed text as plain text. No markdown, no formatting.',
  markdown: 'Output the transcribed text using Markdown where appropriate (headings, lists, emphasis).',
  structured: 'Output the transcribed text in a structured way: use Markdown for tables (pipe syntax), lists, and headings where the image has structure.'
};

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
    if (!apiKey) {
      res.status(503).json({ error: 'OpenAI API key not configured. Set OPENAI_API_KEY.' });
      return;
    }

    const openai = new OpenAI({ apiKey });
    const body = req.body || {};
    const { image: imageDataUrl, images: imagesRaw, format = 'plain', instructions: userInstructions } = body;

    const imageList = Array.isArray(imagesRaw) && imagesRaw.length > 0
      ? imagesRaw.filter(u => u && typeof u === 'string')
      : (imageDataUrl && typeof imageDataUrl === 'string' ? [imageDataUrl] : []);

    if (imageList.length === 0) {
      res.status(400).json({ error: 'At least one image is required (images array or image).' });
      return;
    }

    const multiImage = imageList.length > 1;
    const systemText = `You are an accurate OCR and transcription assistant. Your task is to transcribe all text visible in the image(s) into the requested format.
${FORMAT_INSTRUCTIONS[format] || FORMAT_INSTRUCTIONS.plain}
Preserve line breaks and paragraph structure. Do not add commentary or labels—output only the transcribed content.${multiImage ? `

You will receive ${imageList.length} images in sequence. Transcribe each image in order. Between transcriptions, add a clear separator so the reader knows where one image ends and the next begins. Use this format:
--- Image 2 ---
(or --- Image 3 ---, etc. for subsequent images)

Maintain consistent formatting within each section. The first image needs no header.` : ''}`;

    const userContent = [];
    if (userInstructions && userInstructions.trim()) {
      userContent.push({
        type: 'text',
        text: `User instructions: ${userInstructions.trim()}\n\nTranscribe the image(s) below according to these instructions.${multiImage ? ` Process ${imageList.length} images in order.` : ''}`
      });
    }
    imageList.forEach((url) => {
      userContent.push({ type: 'image_url', image_url: { url } });
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userContent }
      ],
      max_tokens: Math.min(16384, 4096 * imageList.length),
      temperature: 0.2
    });

    const text = (completion.choices[0]?.message?.content || '').trim();
    res.status(200).json({ success: true, text });
  } catch (error) {
    console.error('Image-to-text API error:', error);
    res.status(500).json({
      error: 'Image transcription failed',
      details: error.message
    });
  }
};
