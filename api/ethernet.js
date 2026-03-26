/**
 * Consolidated ethernet API handler.
 * Replaces api/ethernet/extract.js and api/ethernet/upload.js.
 * Route via ?action=extract or ?action=upload
 *
 * bodyParser is disabled so formidable can parse multipart uploads.
 * The extract path reads req.body manually after JSON.parse.
 *
 * Old paths kept working via vercel.json rewrites.
 */

// Disable Vercel's automatic body parser — required for formidable multipart parsing.
module.exports.config = { api: { bodyParser: false } };

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { IncomingForm }                          = require('formidable');
const { createClient }                          = require('@supabase/supabase-js');
const { extractEthernetConnections }            = require('../lib/ethernetExtractor');
const { parseScopeCsv, runScopeFirstWorkflow }  = require('../lib/ethernetScopeWorkflow');

const SCHEMA_VERSION = '1.0';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const action = req.query.action || '';

  if (action === 'upload') return handleUpload(req, res);
  if (action === 'extract') return handleExtract(req, res);

  return res.status(400).json({
    error: `Unknown action: "${action}". Valid: upload, extract`,
  });
};

// ── upload ────────────────────────────────────────────────────────────────────
async function handleUpload(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'Supabase not configured', details: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-up-'));

  try {
    const form = new IncomingForm({ uploadDir: tmpDir, keepExtensions: true, maxFileSize: 50 * 1024 * 1024 });
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, _fields, fileList) => err ? reject(err) : resolve({ files: fileList }));
    });

    const fileList = Array.isArray(files.files) ? files.files : (files.files ? [files.files] : []);
    if (fileList.length === 0) { cleanup(tmpDir, []); return res.status(400).json({ error: 'No files uploaded.' }); }

    const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const jobId     = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const uploaded  = [];

    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const localPath = f.filepath && fs.existsSync(f.filepath) ? f.filepath : null;
      if (!localPath) continue;
      const buf         = fs.readFileSync(localPath);
      const bucketPath  = `temp/${jobId}/${i}.pdf`;
      const { error }   = await supabase.storage.from('ethernet-pdfs').upload(bucketPath, buf, { contentType: 'application/pdf', upsert: true });
      if (error) throw new Error(`Storage upload failed: ${error.message}`);
      uploaded.push(bucketPath);
    }

    cleanup(tmpDir, []);
    res.status(200).json({ success: true, storagePaths: uploaded });
  } catch (e) {
    cleanup(tmpDir, []);
    console.error('Ethernet upload error:', e);
    res.status(500).json({ error: 'Upload failed', details: e.message });
  }
}

// ── extract ───────────────────────────────────────────────────────────────────
async function handleExtract(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ success: false, error: 'Supabase not configured', details: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for ethernet extraction.' });
  }

  // bodyParser is off — read and parse JSON body manually
  let body = {};
  try {
    const raw = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end',  ()    => resolve(data));
      req.on('error', reject);
    });
    body = raw ? JSON.parse(raw) : {};
  } catch (_) {}

  const {
    storagePaths, vesselId = 'default',
    strictEthernet = false, minConfidence = 0,
    systemLevelOnly = false, aiEnabled = false,
    fileNames = [], systemsInScopeCsv = '',
    minSystemMapConfidence, allowUnknownSystemEdges = false,
  } = body;

  const params           = { strictEthernet, minConfidence, systemLevelOnly, aiEnabled };
  const resolvedNames    = Array.isArray(fileNames) && fileNames.length > 0
    ? fileNames
    : (Array.isArray(storagePaths) ? storagePaths.map(p => path.basename(p)) : []);

  const jobId     = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = new Date().toISOString();
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'ethernet-'));
  const pdfPaths  = [];

  const buildJob = (status, completedAt) => ({
    jobId, status, createdAt, completedAt, schemaVersion: SCHEMA_VERSION,
    params: { strictEthernet: !!strictEthernet, minConfidence: Number(minConfidence) || 0, systemLevelOnly: !!systemLevelOnly, aiEnabled: !!aiEnabled },
  });

  const emptyResp = (status) => ({
    success: false, job: buildJob(status, new Date().toISOString()),
    vesselId: String(vesselId).trim() || 'default', fileNames: resolvedNames,
    edges: [], review: [], summary: { totalEdges: 0, totalReview: 0, systemLevel: 0, internal: 0, unknown: 0, pagesProcessed: 0, charsExtracted: 0, cableIdsFound: 0, extractionNote: null, ai: { used: false, passesRun: 0 } },
    warnings: [], errors: [], sheets: [], debug: null, scopeResult: null,
  });

  try {
    if (!Array.isArray(storagePaths) || storagePaths.length === 0) {
      return res.status(400).json({ ...emptyResp('failed'), errors: [{ message: 'storagePaths array is required (upload PDFs to Supabase Storage first).' }] });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    for (let i = 0; i < storagePaths.length; i++) {
      const { data, error } = await supabase.storage.from('ethernet-pdfs').download(storagePaths[i]);
      if (error) {
        cleanup(tmpDir, pdfPaths);
        return res.status(500).json({ ...emptyResp('failed'), errors: [{ message: `Failed to fetch ${storagePaths[i]}: ${error.message}`, fileName: resolvedNames[i] }] });
      }
      const buf       = Buffer.from(await data.arrayBuffer());
      const localPath = path.join(tmpDir, `file-${i}${path.extname(storagePaths[i]) || '.pdf'}`);
      fs.writeFileSync(localPath, buf);
      pdfPaths.push(localPath);
    }

    const result = await extractEthernetConnections(pdfPaths, { strictEthernet, minConfidence, systemLevelOnly, aiEnabled, fileNames: resolvedNames });

    let scopeResult = null;
    if (systemsInScopeCsv && String(systemsInScopeCsv).trim()) {
      try {
        const scopeList = parseScopeCsv(systemsInScopeCsv);
        if (scopeList.length > 0) {
          scopeResult = runScopeFirstWorkflow(scopeList, {
            edges: result.edges, review: result.review, summary: result.summary,
            sheets: result.sheets || [], drawingListMapping: result.drawingListMapping || {},
          }, result.sheets || [], {
            minSystemMapConfidence: minSystemMapConfidence != null ? Number(minSystemMapConfidence) : undefined,
            allowUnknownSystemEdges: !!allowUnknownSystemEdges,
            manualAliases: (body.manualAliases && typeof body.manualAliases === 'object') ? body.manualAliases : {},
          });
        }
      } catch (scopeErr) { console.warn('Scope-first workflow failed:', scopeErr.message); }
    }

    cleanup(tmpDir, pdfPaths);
    res.status(200).json({
      success: true,
      job: buildJob('done', new Date().toISOString()),
      vesselId: String(vesselId).trim() || 'default',
      fileNames: resolvedNames,
      edges: result.edges, review: result.review, summary: result.summary,
      warnings: result.warnings || [], errors: result.errors || [],
      sheets: result.sheets || [], debug: result.debug || null, scopeResult,
    });
  } catch (error) {
    cleanup(tmpDir, pdfPaths);
    console.error('Ethernet extraction error:', error);
    res.status(500).json({ ...emptyResp('failed'), errors: [{ message: error.message || 'Ethernet extraction failed' }] });
  }
}

function cleanup(tmpDir, pdfPaths) {
  for (const p of pdfPaths) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }
  try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
}
