/**
 * Vercel serverless image converter.
 * Mirrors the /api/convert-images route from server.js, adapted for Vercel's
 * ephemeral filesystem: files are converted in-memory and returned as
 * base64 data URLs so the client can save them without a separate download
 * round-trip (which couldn't share /tmp across invocations).
 */

module.exports.config = {
  api: {
    bodyParser: false,
    sizeLimit: '50mb'
  }
};

const fs = require('fs');
const path = require('path');
const os = require('os');
const { IncomingForm } = require('formidable');
const sharp = require('sharp');

const MIME_BY_FORMAT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  ico: 'image/png',
  avif: 'image/avif'
};

async function convertToBuffer(inputPath, settings) {
  let pipeline = sharp(inputPath, { failOn: 'none' });

  if (settings.resize) {
    if (settings.maintainAspectRatio) {
      pipeline = pipeline.resize(settings.width, settings.height, {
        fit: 'inside',
        withoutEnlargement: true
      });
    } else {
      pipeline = pipeline.resize(settings.width, settings.height);
    }
  }

  const format = (settings.outputFormat || 'png').toLowerCase();
  const quality = Number.isFinite(settings.quality) ? settings.quality : 90;

  switch (format) {
    case 'png': {
      const compressionLevel = Math.max(0, Math.min(9, Math.floor((100 - quality) / 10)));
      return { buffer: await pipeline.png({ compressionLevel }).toBuffer(), ext: 'png' };
    }
    case 'jpg':
    case 'jpeg':
      return { buffer: await pipeline.jpeg({ quality }).toBuffer(), ext: 'jpg' };
    case 'webp':
      return { buffer: await pipeline.webp({ quality }).toBuffer(), ext: 'webp' };
    case 'gif':
      return { buffer: await pipeline.gif().toBuffer(), ext: 'gif' };
    case 'bmp':
      return { buffer: await pipeline.bmp().toBuffer(), ext: 'bmp' };
    case 'tiff':
      return { buffer: await pipeline.tiff({ quality }).toBuffer(), ext: 'tiff' };
    case 'avif':
      return { buffer: await pipeline.avif({ quality }).toBuffer(), ext: 'avif' };
    case 'ico':
      return { buffer: await pipeline.png({ quality }).toBuffer(), ext: 'png' };
    case 'svg':
      throw new Error('SVG conversion is not supported. Use PNG, JPEG, or WebP.');
    default:
      throw new Error(`Unsupported output format: ${format}`);
  }
}

function cleanupTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-conv-'));

  try {
    const form = new IncomingForm({
      uploadDir: tmpDir,
      keepExtensions: true,
      multiples: true,
      maxFileSize: 50 * 1024 * 1024,
      maxTotalFileSize: 200 * 1024 * 1024
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fld, fls) => err ? reject(err) : resolve({ fields: fld, files: fls }));
    });

    const fileList = Array.isArray(files.files)
      ? files.files
      : (files.files ? [files.files] : []);

    if (fileList.length === 0) {
      cleanupTmp(tmpDir);
      return res.status(400).json({ error: 'No files uploaded' });
    }

    let conversionSettings = {};
    try {
      const raw = Array.isArray(fields.conversionSettings)
        ? fields.conversionSettings[0]
        : fields.conversionSettings;
      conversionSettings = raw ? JSON.parse(raw) : {};
    } catch (_) {
      conversionSettings = {};
    }

    const convertedFiles = [];
    const errors = [];

    for (const file of fileList) {
      const localPath = file.filepath || file.path;
      const originalName = file.originalFilename || file.newFilename || 'image';
      const baseName = path.basename(originalName, path.extname(originalName)) || 'image';

      try {
        const { buffer, ext } = await convertToBuffer(localPath, conversionSettings);
        const filename = `converted_${Date.now()}_${baseName}.${ext}`;
        const mime = MIME_BY_FORMAT[ext] || 'application/octet-stream';
        convertedFiles.push({
          filename,
          originalName,
          mime,
          size: buffer.length,
          dataUrl: `data:${mime};base64,${buffer.toString('base64')}`
        });
      } catch (e) {
        errors.push({ file: originalName, message: e.message });
      }
    }

    cleanupTmp(tmpDir);

    return res.status(200).json({
      success: true,
      convertedFiles,
      totalFiles: fileList.length,
      convertedCount: convertedFiles.length,
      errors
    });
  } catch (error) {
    cleanupTmp(tmpDir);
    console.error('convert-images error:', error);
    return res.status(500).json({
      error: 'Image conversion failed',
      details: error.message
    });
  }
};
