const fs = require('fs');
const path = require('path');
const os = require('os');
const { IncomingForm } = require('formidable');
const { createClient } = require('@supabase/supabase-js');

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
      details: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-up-'));
  const uploadedPaths = [];

  try {
    const form = new IncomingForm({
      uploadDir: tmpDir,
      keepExtensions: true,
      maxFileSize: 50 * 1024 * 1024
    });

    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, _fields, fileList) => {
        if (err) reject(err);
        else resolve({ files: fileList });
      });
    });

    const fileList = Array.isArray(files.files) ? files.files : (files.files ? [files.files] : []);
    if (fileList.length === 0) {
      cleanup();
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const localPath = f.filepath && fs.existsSync(f.filepath) ? f.filepath : null;
      if (!localPath) continue;
      const buf = fs.readFileSync(localPath);
      const pathInBucket = `temp/${jobId}/${i}.pdf`;
      const { error } = await supabase.storage.from('ethernet-pdfs').upload(pathInBucket, buf, {
        contentType: 'application/pdf',
        upsert: true
      });
      if (error) throw new Error(`Storage upload failed: ${error.message}`);
      uploadedPaths.push(pathInBucket);
    }

    cleanup();
    res.status(200).json({ success: true, storagePaths: uploadedPaths });
  } catch (e) {
    cleanup();
    console.error('Ethernet upload API error:', e);
    res.status(500).json({ error: 'Upload failed', details: e.message });
  }

  function cleanup() {
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    } catch (_) {}
  }
};
