const fs = require('fs');
const path = require('path');
const os = require('os');
const { IncomingForm } = require('formidable');
const { extractEthernetConnections } = require('../../lib/ethernetExtractor');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethernet-'));
  const pdfPaths = [];

  try {
    const form = new IncomingForm({
      uploadDir: tmpDir,
      keepExtensions: true,
      maxFileSize: 50 * 1024 * 1024
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, fileList) => {
        if (err) reject(err);
        else resolve({ fields: f, files: fileList });
      });
    });

    const fileList = Array.isArray(files.files) ? files.files : (files.files ? [files.files] : []);
    if (fileList.length === 0) {
      cleanup();
      res.status(400).json({ error: 'No PDF files uploaded' });
      return;
    }

    for (const f of fileList) {
      if (f.filepath && fs.existsSync(f.filepath)) {
        const ext = path.extname(f.originalFilename || '').toLowerCase();
        const dest = path.join(tmpDir, `file-${Date.now()}-${Math.random().toString(36).slice(2)}${ext || '.pdf'}`);
        fs.renameSync(f.filepath, dest);
        pdfPaths.push(dest);
      }
    }

    if (pdfPaths.length === 0) {
      cleanup();
      res.status(400).json({ error: 'No valid PDF files' });
      return;
    }

    const vesselId = (fields.vesselId && fields.vesselId[0]) ? String(fields.vesselId[0]).trim() : 'default';
    const strictEthernet = (fields.strictEthernet && fields.strictEthernet[0]) === 'true';
    const fileNames = fileList.map(f => f.originalFilename || 'unknown.pdf');

    const result = await extractEthernetConnections(pdfPaths, { strictEthernet });
    cleanup();

    res.status(200).json({
      success: true,
      vesselId,
      fileNames,
      edges: result.edges,
      review: result.review,
      summary: result.summary
    });
  } catch (error) {
    cleanup();
    console.error('Ethernet extraction error:', error);
    res.status(500).json({
      error: 'Ethernet extraction failed',
      details: error.message
    });
  }

  function cleanup() {
    for (const p of pdfPaths) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  }
};
