const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const { extractEthernetConnections } = require('../../lib/ethernetExtractor');
const { parseScopeCsv, runScopeFirstWorkflow } = require('../../lib/ethernetScopeWorkflow');

const SCHEMA_VERSION = '1.0';

function buildJob(jobId, status, createdAt, completedAt, params) {
  return {
    jobId,
    status,
    createdAt,
    completedAt,
    schemaVersion: SCHEMA_VERSION,
    params: {
      strictEthernet: !!params.strictEthernet,
      minConfidence: Number(params.minConfidence) || 0,
      systemLevelOnly: !!params.systemLevelOnly,
      aiEnabled: !!params.aiEnabled
    }
  };
}

function emptyResponse(job, vesselId, fileNames) {
  return {
    success: false,
    job,
    vesselId: String(vesselId).trim() || 'default',
    fileNames: Array.isArray(fileNames) ? fileNames : [],
    edges: [],
    review: [],
    summary: {
      totalEdges: 0,
      totalReview: 0,
      systemLevel: 0,
      internal: 0,
      unknown: 0,
      pagesProcessed: 0,
      charsExtracted: 0,
      cableIdsFound: 0,
      extractionNote: null,
      ai: { used: false, passesRun: 0 }
    },
    warnings: [],
    errors: [],
    sheets: [],
    debug: null,
    scopeResult: null
  };
}

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
      success: false,
      error: 'Supabase not configured',
      details: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for ethernet extraction.'
    });
    return;
  }

  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = new Date().toISOString();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethernet-'));
  const pdfPaths = [];

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const {
    storagePaths,
    vesselId = 'default',
    strictEthernet = false,
    minConfidence = 0,
    systemLevelOnly = false,
    aiEnabled = false,
    fileNames = [],
    systemsInScopeCsv = '',
    minSystemMapConfidence,
    allowUnknownSystemEdges = false
  } = body;

  const params = { strictEthernet, minConfidence, systemLevelOnly, aiEnabled };
  const resolvedFileNames = Array.isArray(fileNames) && fileNames.length > 0
    ? fileNames
    : (Array.isArray(storagePaths) ? storagePaths.map(p => path.basename(p)) : []);

  try {
    if (!storagePaths || !Array.isArray(storagePaths) || storagePaths.length === 0) {
      const completedAt = new Date().toISOString();
      const job = buildJob(jobId, 'failed', createdAt, completedAt, params);
      res.status(400).json({
        ...emptyResponse(job, vesselId, resolvedFileNames),
        errors: [{ message: 'storagePaths array is required (upload PDFs to Supabase Storage first).' }]
      });
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    for (let i = 0; i < storagePaths.length; i++) {
      const storagePath = storagePaths[i];
      const { data, error } = await supabase.storage.from('ethernet-pdfs').download(storagePath);
      if (error) {
        const completedAt = new Date().toISOString();
        const job = buildJob(jobId, 'failed', createdAt, completedAt, params);
        res.status(500).json({
          ...emptyResponse(job, vesselId, resolvedFileNames),
          errors: [{ message: `Failed to fetch ${storagePath}: ${error.message}`, fileName: resolvedFileNames[i] }]
        });
        return;
      }
      const buf = Buffer.from(await data.arrayBuffer());
      const localPath = path.join(tmpDir, `file-${i}${path.extname(storagePath) || '.pdf'}`);
      fs.writeFileSync(localPath, buf);
      pdfPaths.push(localPath);
    }

    const result = await extractEthernetConnections(pdfPaths, {
      strictEthernet,
      minConfidence,
      systemLevelOnly,
      aiEnabled,
      fileNames: resolvedFileNames
    });

    let scopeResult = null;
    if (systemsInScopeCsv && String(systemsInScopeCsv).trim()) {
      try {
        const scopeList = parseScopeCsv(systemsInScopeCsv);
        if (scopeList.length > 0) {
          scopeResult = runScopeFirstWorkflow(scopeList, {
            edges: result.edges,
            review: result.review,
            summary: result.summary,
            sheets: result.sheets || [],
            drawingListMapping: result.drawingListMapping || {}
          }, result.sheets || [], {
            minSystemMapConfidence: minSystemMapConfidence != null ? Number(minSystemMapConfidence) : undefined,
            allowUnknownSystemEdges: !!allowUnknownSystemEdges,
            manualAliases: (body.manualAliases && typeof body.manualAliases === 'object') ? body.manualAliases : {}
          });
        }
      } catch (scopeErr) {
        console.warn('Scope-first workflow failed:', scopeErr.message);
      }
    }

    cleanup();

    const completedAt = new Date().toISOString();
    const job = buildJob(jobId, 'done', createdAt, completedAt, params);

    res.status(200).json({
      success: true,
      job,
      vesselId: String(vesselId).trim() || 'default',
      fileNames: resolvedFileNames,
      edges: result.edges,
      review: result.review,
      summary: result.summary,
      warnings: result.warnings || [],
      errors: result.errors || [],
      sheets: result.sheets || [],
      debug: result.debug || null,
      scopeResult
    });
  } catch (error) {
    cleanup();
    console.error('Ethernet extraction error:', error);
    const completedAt = new Date().toISOString();
    const job = buildJob(jobId, 'failed', createdAt, completedAt, params);
    res.status(500).json({
      ...emptyResponse(job, vesselId, resolvedFileNames),
      errors: [{ message: error.message || 'Ethernet extraction failed' }]
    });
  }

  function cleanup() {
    for (const p of pdfPaths) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  }
};
