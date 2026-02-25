const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const { extractEthernetConnections } = require('../../lib/ethernetExtractor');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    res.status(503).json({
      error: 'Supabase not configured',
      details: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for ethernet extraction.'
    });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethernet-'));
  const pdfPaths = [];

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { storagePaths, vesselId = 'default', strictEthernet = false, fileNames = [] } = body;

    if (!storagePaths || !Array.isArray(storagePaths) || storagePaths.length === 0) {
      res.status(400).json({ error: 'storagePaths array is required (upload PDFs to Supabase Storage first).' });
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    for (let i = 0; i < storagePaths.length; i++) {
      const storagePath = storagePaths[i];
      const { data, error } = await supabase.storage.from('ethernet-pdfs').download(storagePath);
      if (error) {
        throw new Error(`Failed to fetch ${storagePath}: ${error.message}`);
      }
      const buf = Buffer.from(await data.arrayBuffer());
      const localPath = path.join(tmpDir, `file-${i}${path.extname(storagePath) || '.pdf'}`);
      fs.writeFileSync(localPath, buf);
      pdfPaths.push(localPath);
    }

    const result = await extractEthernetConnections(pdfPaths, { strictEthernet });
    cleanup();

    res.status(200).json({
      success: true,
      vesselId: String(vesselId).trim() || 'default',
      fileNames: Array.isArray(fileNames) ? fileNames : storagePaths.map(p => path.basename(p)),
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
