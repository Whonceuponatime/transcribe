import React, { useState, useRef } from 'react';
import JSZip from 'jszip';
import './EthernetExtractor.css';
import { supabase } from '../lib/supabase';
import EthernetDiagram from './EthernetDiagram';

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function EthernetExtractor() {
  const [files, setFiles] = useState([]);
  const [vesselId, setVesselId] = useState('');
  const [systemsInScopeCsv, setSystemsInScopeCsv] = useState('');
  const [manualAliases, setManualAliases] = useState({});
  const [strictEthernet, setStrictEthernet] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(''); // "uploading" | "extracting"
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('edges');
  const [filterTag, setFilterTag] = useState('system'); // system = system_level+unknown, internal, all
  const fileInputRef = useRef(null);

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const list = Array.from(e.dataTransfer?.files || []).filter(
      f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    if (list.length) setFiles(prev => [...prev, ...list]);
  };

  const handleFileSelect = (e) => {
    const list = Array.from(e.target?.files || []).filter(
      f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    if (list.length) setFiles(prev => [...prev, ...list]);
    e.target.value = '';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const removeFile = (idx) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const runExtraction = async () => {
    if (!files.length) {
      setError('Please upload at least one PDF.');
      return;
    }
    if (!supabase) {
      setError('Supabase is not configured. Ethernet extraction requires Supabase Storage.');
      return;
    }
    setError(null);
    setLoading(true);
    setResult(null);
    setLoadingStatus('uploading');
    const statusTimer = setTimeout(() => setLoadingStatus('extracting'), 2000);
    const fileNames = files.map(f => f.name);
    let storagePaths = [];

    try {
      // Upload directly to Supabase Storage to avoid Vercel's ~4.5 MB request body limit.
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const safePath = `temp/${jobId}/${i}.pdf`;
        const { error: uploadErr } = await supabase.storage
          .from('ethernet-pdfs')
          .upload(safePath, file, { contentType: 'application/pdf', upsert: true });
        if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);
        storagePaths.push(safePath);
      }

      if (!storagePaths.length) throw new Error('No storage paths returned.');

      clearTimeout(statusTimer);
      setLoadingStatus('extracting');

      const res = await fetch('/api/ethernet/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storagePaths,
          vesselId: vesselId || 'default',
          systemsInScopeCsv: systemsInScopeCsv.trim() || undefined,
          manualAliases: Object.keys(manualAliases).length ? manualAliases : undefined,
          strictEthernet,
          minConfidence: 0,
          systemLevelOnly: false,
          aiEnabled,
          fileNames
        })
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg = data.errors?.length ? data.errors.map(e => e.message).join('; ') : (data.details || data.error || 'Extraction failed');
        throw new Error(errMsg);
      }
      setResult(data);

      if (supabase) {
        await supabase.storage.from('ethernet-pdfs').remove(storagePaths);
      }
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      clearTimeout(statusTimer);
      setLoading(false);
      setLoadingStatus('');
    }
  };

  const clearAll = () => {
    setFiles([]);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Normalize edge for display (contract: from/to are objects with labelRaw/labelNormalized)
  const edgeFrom = (e) => (e.from && typeof e.from === 'object' ? e.from.labelRaw || e.from.labelNormalized : e.from) ?? '—';
  const edgeTo = (e) => (e.to && typeof e.to === 'object' ? e.to.labelRaw || e.to.labelNormalized : e.to) ?? '—';
  const edgeCableId = (e) => e.cableIdNormalized ?? e.cableId ?? '—';
  const edgePageRefs = (e) => (e.pageRefs && e.pageRefs.length) ? e.pageRefs.map(r => (typeof r === 'object' && r.fileName != null ? `${r.fileName} p.${r.page}` : String(r))).join('; ') : '';

  const filteredEdges = result?.edges
    ? result.edges.filter(e => {
        if (filterTag === 'all') return true;
        if (filterTag === 'internal') return e.tag === 'internal';
        return e.tag === 'system_level' || e.tag === 'unknown';
      })
    : [];

  const downloadJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify({
      success: result.success,
      job: result.job,
      vesselId: result.vesselId,
      fileNames: result.fileNames,
      edges: result.edges,
      review: result.review,
      summary: result.summary,
      warnings: result.warnings || [],
      errors: result.errors || []
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'connections.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadCsv = () => {
    if (!result) return;
    const headers = ['From', 'To', 'Cable ID', 'Media', 'Pages', 'Confidence', 'Tag'];
    const rows = (result.edges || []).map(e => [
      edgeFrom(e),
      edgeTo(e),
      edgeCableId(e),
      e.media,
      edgePageRefs(e) || (Array.isArray(e.pageRefs) ? e.pageRefs.map(r => typeof r === 'object' ? `${r.fileName} p.${r.page}` : r).join('; ') : ''),
      e.confidence,
      e.tag
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'connections.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const reviewPageRefs = (r) => {
    if (!r.pageRefs || !r.pageRefs.length) return '';
    return r.pageRefs.map(ref => typeof ref === 'object' && ref.fileName != null ? `${ref.fileName} p.${ref.page}` : String(ref)).join(', ');
  };

  const downloadReview = () => {
    if (!result) return;
    let md = '# Ethernet Connections – Review List\n\n';
    md += '## Unpaired / Ambiguous / Extra / Unknown endpoint\n\n';
    for (const r of result.review || []) {
      const id = r.cableIdNormalized ?? r.cableIdRaw ?? r.cableId;
      md += `- **${id}** (${r.type})`;
      if (r.endpoint) md += ` → ${r.endpoint}`;
      md += ` | ${reviewPageRefs(r)}`;
      if (r.candidates?.length) {
        md += ' | Candidates: ';
        md += r.candidates.map(c => (c.fromLabel && c.toLabel ? `${c.fromLabel}–${c.toLabel}` : c)).join('; ');
      }
      md += '\n';
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'review.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  const debug = result?.debug;
  const hasDebug = !!debug;

  const downloadDebugFile = (filename, content, mimeType) => {
    const blob = new Blob([content], { type: mimeType || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadNodeDedupReportJson = () => {
    if (!debug) return;
    downloadDebugFile('node_dedup_report.json', JSON.stringify(debug.nodeDedupReport || [], null, 2), 'application/json');
  };

  const downloadNodeDedupReportCsv = () => {
    if (!debug) return;
    const rows = (debug.nodeDedupReport || []).map((n) => [
      n.nodeId,
      n.labelNormalized,
      (n.rawLabels || []).slice(0, 10).join('; '),
      n.rawLabelCount ?? 0,
      n.occurrenceCount ?? 0,
      (n.pages || []).map((p) => `${p.fileName || ''} p.${p.page ?? ''}`).join('; '),
      (n.topEvidenceSnippets || []).slice(0, 5).join(' | '),
      n.type || ''
    ]);
    const headers = ['nodeId', 'labelNormalized', 'rawLabels', 'rawLabelCount', 'occurrenceCount', 'pages', 'topEvidenceSnippets', 'type'];
    const csv = [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
    downloadDebugFile('node_dedup_report.csv', csv, 'text/csv');
  };

  const downloadCableOccurrencesCsv = () => {
    if (!debug) return;
    const occs = debug.cableOccurrencesForDebug || [];
    const headers = [
      'cableIdRaw', 'cableIdNormalized', 'fileName', 'page', 'position',
      'ethernetHintFound', 'ethernetHintText', 'pickedEndpointRaw', 'pickedEndpointNormalized', 'endpointScore',
      'filteredOut', 'filterReason', 'nearbyTextSample'
    ];
    const rows = occs.map((o) => [
      o.cableIdRaw,
      o.cableIdNormalized,
      o.fileName,
      o.page,
      o.position ? (typeof o.position === 'object' && o.position.line != null ? `line ${o.position.line}` : JSON.stringify(o.position)) : '',
      o.ethernetHintFound ?? false,
      o.ethernetHintText ?? '',
      o.pickedEndpointRaw ?? '',
      o.pickedEndpointNormalized ?? '',
      o.endpointScore ?? '',
      o.filteredOut ?? false,
      o.filterReason ?? '',
      (o.nearbyTextSample || '').replace(/\r?\n/g, ' ')
    ]);
    const csv = [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
    downloadDebugFile('cable_occurrences.csv', csv, 'text/csv');
  };

  const downloadPairingLog = () => {
    if (!debug) return;
    downloadDebugFile('pairing_log.json', JSON.stringify(debug.pairingLog || [], null, 2), 'application/json');
  };

  const downloadSummaryDebug = () => {
    if (!debug) return;
    downloadDebugFile('summary_debug.json', JSON.stringify(debug.summaryDebug || {}, null, 2), 'application/json');
  };

  const downloadPageInventoryCsv = () => {
    if (!debug || !Array.isArray(debug.pageInventory)) return;
    const headers = [
      'fileName',
      'page',
      'pageType',
      'skipReason',
      'pageTitle',
      'pageCode',
      'ethernetKeywordHits',
      'uniqueCableIds',
      'ethernetCableIds',
      'duplicateTextHits'
    ];
    const rows = debug.pageInventory.map((p) => [
      p.fileName,
      p.page,
      p.pageType,
      p.skipReason || '',
      p.pageTitle || '',
      p.pageCode || '',
      p.ethernetKeywordHits ?? 0,
      Array.isArray(p.uniqueCableIds) ? p.uniqueCableIds.join('; ') : '',
      Array.isArray(p.ethernetCableIds) ? p.ethernetCableIds.join('; ') : '',
      p.duplicateTextHits ?? 0
    ]);
    const csv = [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
    downloadDebugFile('page_inventory.csv', csv, 'text/csv');
  };

  const downloadCableStatsCsv = () => {
    if (!debug) return;
    const pairingLog = debug.pairingLog || [];
    const occs = debug.cableOccurrencesForDebug || [];
    const ethernetByCable = {};
    occs.forEach((o) => {
      const id = o.cableIdNormalized || o.cableIdRaw;
      if (!id) return;
      if (!ethernetByCable[id]) ethernetByCable[id] = { ethernet: 0, total: 0 };
      ethernetByCable[id].total += 1;
      if (o.ethernetHintFound) ethernetByCable[id].ethernet += 1;
    });
    const headers = [
      'cableIdRaw',
      'cableIdNormalized',
      'occurrenceCount',
      'classification',
      'status',
      'rejectReason',
      'topEndpointCandidates'
    ];
    const rows = pairingLog.map((p) => {
      const idNorm = p.cableIdNormalized || p.cableIdRaw;
      const stats = idNorm ? ethernetByCable[idNorm] : null;
      let classification = 'unknown';
      if (stats && stats.ethernet > 0) classification = 'ethernet';
      const topEndpoints = Array.isArray(p.occurrences)
        ? p.occurrences
            .slice(0, 3)
            .map((o) => o.endpointLabelPicked || '')
            .filter(Boolean)
            .join('; ')
        : '';
      return [
        p.cableIdRaw || '',
        p.cableIdNormalized || '',
        p.occurrenceCount ?? '',
        classification,
        p.status || p.type || '',
        p.reason || '',
        topEndpoints
      ];
    });
    const csv = [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
    downloadDebugFile('cable_stats.csv', csv, 'text/csv');
  };

  const downloadFalsePositives = () => {
    if (!debug) return;
    const occs = debug.cableOccurrencesForDebug || [];
    const samples = occs
      .filter((o) => o.filteredOut && o.filterReason)
      .slice(0, 200)
      .map((o) => ({
        cableIdRaw: o.cableIdRaw,
        cableIdNormalized: o.cableIdNormalized,
        fileName: o.fileName,
        page: o.page,
        filterReason: o.filterReason,
        nearbyTextSample: o.nearbyTextSample
      }));
    downloadDebugFile('false_positive_samples.json', JSON.stringify(samples, null, 2), 'application/json');
  };

  const downloadEdgeProvenance = () => {
    if (!result) return;
    const edges = result.edges || [];
    const provenance = edges.map((e) => ({
      cableIdRaw: e.cableIdRaw,
      cableIdNormalized: e.cableIdNormalized,
      fromLabel: edgeFrom(e),
      toLabel: edgeTo(e),
      media: e.media,
      confidence: e.confidence ?? 0,
      pageRefs: e.pageRefs || [],
      sheetRefs: e.sheetRefs || [],
      occurrences: e.occurrences || [],
      evidence: e.evidence || []
    }));
    downloadDebugFile('edge_provenance.json', JSON.stringify(provenance, null, 2), 'application/json');
  };
  const downloadDebugBundleZip = async () => {
    if (!debug) return;
    const zip = new JSZip();
    zip.file('node_dedup_report.json', JSON.stringify(debug.nodeDedupReport || [], null, 2));
    const nodeCsvRows = (debug.nodeDedupReport || []).map((n) => [
      n.nodeId,
      n.labelNormalized,
      (n.rawLabels || []).slice(0, 10).join('; '),
      n.rawLabelCount ?? 0,
      n.occurrenceCount ?? 0,
      (n.pages || []).map((p) => `${p.fileName || ''} p.${p.page ?? ''}`).join('; '),
      (n.topEvidenceSnippets || []).slice(0, 5).join(' | '),
      n.type || ''
    ]);
    const nodeCsvHeaders = ['nodeId', 'labelNormalized', 'rawLabels', 'rawLabelCount', 'occurrenceCount', 'pages', 'topEvidenceSnippets', 'type'];
    zip.file('node_dedup_report.csv', [nodeCsvHeaders.map(csvEscape).join(','), ...nodeCsvRows.map((r) => r.map(csvEscape).join(','))].join('\n'));
    const occs = debug.cableOccurrencesForDebug || [];
    const occHeaders = ['cableIdRaw', 'cableIdNormalized', 'fileName', 'page', 'position', 'ethernetHintFound', 'ethernetHintText', 'pickedEndpointRaw', 'pickedEndpointNormalized', 'endpointScore', 'filteredOut', 'filterReason', 'nearbyTextSample'];
    const occRows = occs.map((o) => [
      o.cableIdRaw,
      o.cableIdNormalized,
      o.fileName,
      o.page,
      o.position ? (typeof o.position === 'object' && o.position.line != null ? `line ${o.position.line}` : JSON.stringify(o.position)) : '',
      o.ethernetHintFound ?? false,
      o.ethernetHintText ?? '',
      o.pickedEndpointRaw ?? '',
      o.pickedEndpointNormalized ?? '',
      o.endpointScore ?? '',
      o.filteredOut ?? false,
      o.filterReason ?? '',
      (o.nearbyTextSample || '').replace(/\r?\n/g, ' ')
    ]);
    const occCsv = [occHeaders.map(csvEscape).join(','), ...occRows.map((r) => r.map(csvEscape).join(','))].join('\n');
    zip.file('cable_occurrences.csv', occCsv);
    zip.file('pairing_log.json', JSON.stringify(debug.pairingLog || [], null, 2));
    zip.file('summary_debug.json', JSON.stringify(debug.summaryDebug || {}, null, 2));
    if (Array.isArray(debug.pageInventory)) {
      const piHeaders = ['fileName', 'page', 'pageType', 'skipReason', 'pageTitle', 'pageCode', 'ethernetKeywordHits', 'uniqueCableIds', 'ethernetCableIds', 'duplicateTextHits'];
      const piRows = debug.pageInventory.map((p) => [
        p.fileName,
        p.page,
        p.pageType,
        p.skipReason || '',
        p.pageTitle || '',
        p.pageCode || '',
        p.ethernetKeywordHits ?? 0,
        Array.isArray(p.uniqueCableIds) ? p.uniqueCableIds.join('; ') : '',
        Array.isArray(p.ethernetCableIds) ? p.ethernetCableIds.join('; ') : '',
        p.duplicateTextHits ?? 0
      ]);
      const piCsv = [piHeaders.map(csvEscape).join(','), ...piRows.map((r) => r.map(csvEscape).join(','))].join('\n');
      zip.file('page_inventory.csv', piCsv);
    }
    const pairingLog = debug.pairingLog || [];
    const ethernetByCable = {};
    occs.forEach((o) => {
      const id = o.cableIdNormalized || o.cableIdRaw;
      if (!id) return;
      if (!ethernetByCable[id]) ethernetByCable[id] = { ethernet: 0, total: 0 };
      ethernetByCable[id].total += 1;
      if (o.ethernetHintFound) ethernetByCable[id].ethernet += 1;
    });
    const csHeaders = ['cableIdRaw', 'cableIdNormalized', 'occurrenceCount', 'classification', 'status', 'rejectReason', 'topEndpointCandidates'];
    const csRows = pairingLog.map((p) => {
      const idNorm = p.cableIdNormalized || p.cableIdRaw;
      const stats = idNorm ? ethernetByCable[idNorm] : null;
      let classification = 'unknown';
      if (stats && stats.ethernet > 0) classification = 'ethernet';
      const topEndpoints = Array.isArray(p.occurrences)
        ? p.occurrences
            .slice(0, 3)
            .map((o) => o.endpointLabelPicked || '')
            .filter(Boolean)
            .join('; ')
        : '';
      return [
        p.cableIdRaw || '',
        p.cableIdNormalized || '',
        p.occurrenceCount ?? '',
        classification,
        p.status || p.type || '',
        p.reason || '',
        topEndpoints
      ];
    });
    const csCsv = [csHeaders.map(csvEscape).join(','), ...csRows.map((r) => r.map(csvEscape).join(','))].join('\n');
    zip.file('cable_stats.csv', csCsv);

    if (result?.scopeResult?.target_coverage?.length) {
      zip.file('target_coverage.json', JSON.stringify(result.scopeResult.target_coverage, null, 2));
    }
    if (result?.scopeResult?.excluded_edges?.length) {
      zip.file('excluded_edges.json', JSON.stringify(result.scopeResult.excluded_edges, null, 2));
    }
    if (result?.scopeResult?.systems?.length) {
      zip.file('zones_systems.json', JSON.stringify(result.scopeResult.systems, null, 2));
    }
    if (result?.scopeResult?.edges_system?.length) {
      zip.file('conduits_system_level.json', JSON.stringify(result.scopeResult.edges_system, null, 2));
    }

    const fpSamples = occs
      .filter((o) => o.filteredOut && o.filterReason)
      .slice(0, 200)
      .map((o) => ({
        cableIdRaw: o.cableIdRaw,
        cableIdNormalized: o.cableIdNormalized,
        fileName: o.fileName,
        page: o.page,
        filterReason: o.filterReason,
        nearbyTextSample: o.nearbyTextSample
      }));
    zip.file('false_positive_samples.json', JSON.stringify(fpSamples, null, 2));

    const edges = result?.edges || [];
    const provenance = edges.map((e) => ({
      cableIdRaw: e.cableIdRaw,
      cableIdNormalized: e.cableIdNormalized,
      fromLabel: edgeFrom(e),
      toLabel: edgeTo(e),
      media: e.media,
      confidence: e.confidence ?? 0,
      pageRefs: e.pageRefs || [],
      sheetRefs: e.sheetRefs || [],
      occurrences: e.occurrences || [],
      evidence: e.evidence || []
    }));
    zip.file('edge_provenance.json', JSON.stringify(provenance, null, 2));

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ethernet-debug-${result?.job?.jobId || Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="ethernet-extractor">
      <div className="ethernet-upload-section">
        <label className="ethernet-label">Vessel / Project ID</label>
        <input
          type="text"
          className="ethernet-input"
          placeholder="e.g. VESSEL-001"
          value={vesselId}
          onChange={e => setVesselId(e.target.value)}
        />
        <label className="ethernet-label">Systems in scope (CSV)</label>
        <textarea
          className="ethernet-scope-csv"
          placeholder="system_name, vendor, tags&#10;IAS&#10;VDR&#10;Main Engine&#10;VSAT,CCTV"
          value={systemsInScopeCsv}
          onChange={e => setSystemsInScopeCsv(e.target.value)}
          rows={4}
          aria-describedby="scope-csv-hint"
        />
        <p id="scope-csv-hint" className="ethernet-hint">
          Optional: one system per line or CSV with columns system_name, vendor, tags, code_patterns, zone. Zone (e.g. Control, Nav &amp; Comm, Untrusted, Cargo) is used for Zone &amp; Conduit diagram.
        </p>
        <div className="ethernet-option">
          <input
            type="checkbox"
            id="strict-ether"
            checked={strictEthernet}
            onChange={e => setStrictEthernet(e.target.checked)}
          />
          <label htmlFor="strict-ether">Strict Ethernet only (exclude cables without CAT6/RJ45/etc hints)</label>
        </div>
        <div className="ethernet-option">
          <input
            type="checkbox"
            id="ai-enabled"
            checked={aiEnabled}
            onChange={e => setAiEnabled(e.target.checked)}
          />
          <label htmlFor="ai-enabled">AI refinement (critic) for edges (uses OpenAI)</label>
        </div>
        <div
          className="ethernet-dropzone"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
        >
          <p>Drop PDFs here or click to select</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            onChange={handleFileSelect}
            className="ethernet-file-input"
            aria-hidden
          />
        </div>
        {files.length > 0 && (
          <>
            <div className="ethernet-ready-banner">
              <span className="ethernet-ready-icon" aria-hidden>✓</span>
              <span>{files.length} PDF{files.length !== 1 ? 's' : ''} ready — click Extract to start</span>
            </div>
            <ul className="ethernet-file-list">
              {files.map((f, i) => (
                <li key={i}>
                  <span>{f.name}</span>
                  <span className="ethernet-file-size">({(f.size / 1024).toFixed(1)} KB)</span>
                  <button type="button" className="btn-ghost" onClick={() => removeFile(i)}>Remove</button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="ethernet-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={!files.length || loading}
            onClick={runExtraction}
          >
            {loading ? (
              <span className="ethernet-btn-loading">
                <span className="ethernet-spinner" aria-hidden />
                {loadingStatus === 'uploading' ? 'Uploading PDFs…' : 'Extracting connections…'}
              </span>
            ) : (
              'Extract Ethernet Connections'
            )}
          </button>
          <button type="button" className="btn-ghost" onClick={clearAll} disabled={loading}>Clear</button>
        </div>
        {loading && (
          <div className="ethernet-loading-status">
            <div className="ethernet-loading-row">
              <span className="ethernet-spinner" aria-hidden />
              <span>{loadingStatus === 'uploading' ? 'Uploading PDFs to server…' : 'Analyzing cable diagrams…'}</span>
            </div>
            <p className="ethernet-loading-hint">This may take a moment for large files.</p>
          </div>
        )}
      </div>

      {error && <div className="ethernet-error">{error}</div>}

      {result && (
        <div className="ethernet-results">
          {result.job && (
            <div className="ethernet-job-meta">
              <span className="ethernet-job-id">Job: {result.job.jobId}</span>
              <span>Status: {result.job.status}</span>
              <span>Created: {result.job.createdAt}</span>
              {result.job.completedAt && <span>Completed: {result.job.completedAt}</span>}
              {result.job.params && (
                <span className="ethernet-params">
                  strictEthernet: {String(result.job.params.strictEthernet)} • minConfidence: {result.job.params.minConfidence} • aiEnabled: {String(result.job.params.aiEnabled)}
                </span>
              )}
            </div>
          )}
          <div className="ethernet-summary">
            {result.summary.totalEdges} paired • {result.summary.totalReview} in review •
            System-level: {result.summary.systemLevel} • Internal: {result.summary.internal}
            {result.summary.pagesProcessed != null && (
              <span> • {result.summary.pagesProcessed} page(s), {result.summary.charsExtracted ?? 0} chars, {result.summary.cableIdsFound ?? 0} cable IDs</span>
            )}
            {result.summary.ai && (
              <span> • AI: {result.summary.ai.used ? 'on' : 'off'} (passes: {result.summary.ai.passesRun})</span>
            )}
            {result.scopeResult && (
              <span className="ethernet-scope-summary">
                • Scope: {result.scopeResult.systems?.length ?? 0} systems, {result.scopeResult.summary?.pagesMapped ?? 0} pages mapped, {result.scopeResult.summary?.pagesUnknown ?? 0} unknown, {result.scopeResult.edges_system?.length ?? 0} system-level edges
                {result.scopeResult.summary?.excluded_edges > 0 && `, ${result.scopeResult.summary.excluded_edges} excluded`}
                {result.scopeResult.summary?.mapping_conflicts > 0 && `, ${result.scopeResult.summary.mapping_conflicts} conflict(s)`}
                {result.scopeResult.summary?.target_projected && ' (target-projected)'}
              </span>
            )}
          </div>
          {result.summary.extractionNote && (
            <div className="ethernet-extraction-note" role="alert">
              {result.summary.extractionNote}
            </div>
          )}
          {(result.warnings && result.warnings.length > 0) && (
            <div className="ethernet-warnings" role="alert">
              <strong>Warnings</strong>
              <ul>{result.warnings.map((w, i) => <li key={i}>{w.message}{w.fileName ? ` (${w.fileName})` : ''}</li>)}</ul>
            </div>
          )}
          {(result.errors && result.errors.length > 0) && (
            <div className="ethernet-errors" role="alert">
              <strong>Errors</strong>
              <ul>{result.errors.map((err, i) => <li key={i}>{err.message}{err.fileName ? ` — ${err.fileName}` : ''}</li>)}</ul>
            </div>
          )}
          <div className="ethernet-tabs">
            <button
              type="button"
              className={activeTab === 'edges' ? 'active' : ''}
              onClick={() => setActiveTab('edges')}
            >
              Paired Connections
            </button>
            <button
              type="button"
              className={activeTab === 'review' ? 'active' : ''}
              onClick={() => setActiveTab('review')}
            >
              Review ({(result.review && result.review.length) || 0})
            </button>
            <button
              type="button"
              className={activeTab === 'diagram' ? 'active' : ''}
              onClick={() => setActiveTab('diagram')}
            >
              Diagram
            </button>
            {result.scopeResult && (
              <button
                type="button"
                className={activeTab === 'scope' ? 'active' : ''}
                onClick={() => setActiveTab('scope')}
              >
                Scope / Page map
              </button>
            )}
            {result.scopeResult?.target_coverage?.length > 0 && (
              <button
                type="button"
                className={activeTab === 'targets' ? 'active' : ''}
                onClick={() => setActiveTab('targets')}
              >
                Targets
              </button>
            )}
            {hasDebug && (
              <button
                type="button"
                className={activeTab === 'debug' ? 'active' : ''}
                onClick={() => setActiveTab('debug')}
              >
                Debug bundle
              </button>
            )}
          </div>
          {activeTab === 'diagram' && (
            <EthernetDiagram result={result} scopeResult={result.scopeResult} />
          )}
          {activeTab === 'scope' && result.scopeResult && (
            <div className="ethernet-scope-panel">
              <h4>Systems in scope</h4>
              <ul className="ethernet-scope-systems">
                {(result.scopeResult.systems || []).map((s, i) => (
                  <li key={i}><strong>{s.systemId}</strong> {s.aliases?.length ? `(${s.aliases.slice(0, 3).join(', ')})` : ''} {s.codePatterns?.length ? ` [codes: ${s.codePatterns.slice(0, 3).join(', ')}]` : ''}</li>
                ))}
              </ul>
              <h4>Page → system mapping</h4>
              <p className="ethernet-hint">ruleUsed: codePattern (pageCode) → titleStrong → titleWeak → unknown. Below-threshold pages map to unknown_system and are excluded from system edges unless allowed.</p>
              <div className="ethernet-scope-table-wrap">
                <table className="ethernet-scope-table">
                  <thead>
                    <tr><th>File</th><th>Page</th><th>Page code</th><th>Page title</th><th>System</th><th>Rule</th><th>Confidence</th><th>Matched</th><th>Evidence</th></tr>
                  </thead>
                  <tbody>
                    {(result.scopeResult.page_system_map || []).map((row, i) => (
                      <tr key={i} className={row.out_of_scope ? 'out-of-scope' : (row.systemId === result.scopeResult.unknown_system ? 'unknown-system' : '')}>
                        <td>{row.fileName}</td>
                        <td>{row.page}</td>
                        <td><code>{row.pageCode || '—'}</code></td>
                        <td>{row.pageTitle || '—'}</td>
                        <td>{row.systemId || '—'}</td>
                        <td>{row.ruleUsed || '—'}</td>
                        <td>{(row.mappingConfidence * 100).toFixed(0)}%</td>
                        <td>{(row.matchedTokens || []).length ? row.matchedTokens.join(', ') : '—'}</td>
                        <td><span className="ethernet-scope-evidence">{row.evidence || '—'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(result.scopeResult.mapping_conflicts && result.scopeResult.mapping_conflicts.length > 0) && (
                <>
                  <h4>Mapping conflicts</h4>
                  <p className="ethernet-hint">Pages where codePattern suggests one system but title suggests another.</p>
                  <div className="ethernet-scope-table-wrap">
                    <table className="ethernet-scope-table">
                      <thead>
                        <tr><th>File</th><th>Page</th><th>Page code</th><th>Code → system</th><th>Title → system</th><th>Confidence</th></tr>
                      </thead>
                      <tbody>
                        {result.scopeResult.mapping_conflicts.map((c, i) => (
                          <tr key={i} className="mapping-conflict">
                            <td>{c.fileName}</td>
                            <td>{c.page}</td>
                            <td><code>{c.pageCode || '—'}</code></td>
                            <td>{c.codeSuggestedSystem}</td>
                            <td>{c.titleSuggestedSystem}</td>
                            <td>{(c.mappingConfidence * 100).toFixed(0)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
          {activeTab === 'targets' && result.scopeResult?.target_coverage?.length > 0 && (
            <div className="ethernet-targets-panel">
              <h4>Target coverage</h4>
              <p className="ethernet-hint">Only targets with resolved endpoints and Ethernet evidence appear in the topology. Others are listed here.</p>
              <div className="ethernet-scope-table-wrap">
                <table className="ethernet-scope-table">
                  <thead>
                    <tr><th>Target</th><th>Pages mapped</th><th>Ethernet occurrences</th><th>Edges found</th><th>Reason (if 0)</th></tr>
                  </thead>
                  <tbody>
                    {(result.scopeResult.target_coverage || []).map((row, i) => (
                      <tr key={i} className={row.edgesFound === 0 ? 'target-zero-edges' : ''}>
                        <td><strong>{row.target}</strong></td>
                        <td>{row.pagesMapped}</td>
                        <td>{row.ethernetOccurrences}</td>
                        <td>{row.edgesFound}</td>
                        <td>{row.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(result.scopeResult.unmappedLabels || []).length > 0 && (
                <>
                  <h4>Top unmapped labels</h4>
                  <p className="ethernet-hint">Map these to a target via alias override below, then re-run Extract.</p>
                  <ul className="ethernet-unmapped-list">
                    {(result.scopeResult.unmappedLabels || []).slice(0, 20).map((u, i) => (
                      <li key={i}><code>{u.label}</code> ({u.count}×)</li>
                    ))}
                  </ul>
                </>
              )}
              <h4>Manual alias override</h4>
              <p className="ethernet-hint">Map a device label to a target system. Re-run Extract to apply.</p>
              <div className="ethernet-alias-override">
                <input
                  type="text"
                  id="alias-label"
                  className="ethernet-input"
                  placeholder="e.g. SMS RACK"
                  aria-label="Endpoint label"
                />
                <span className="ethernet-alias-arrow">→</span>
                <select id="alias-target" className="ethernet-input" aria-label="Target system">
                  <option value="">Select target…</option>
                  {(result.scopeResult.systems || []).map((s, i) => (
                    <option key={i} value={s.systemId}>{s.displayLabel || s.systemId}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    const label = document.getElementById('alias-label')?.value?.trim();
                    const target = document.getElementById('alias-target')?.value;
                    if (label && target) {
                      setManualAliases(prev => ({ ...prev, [label.toUpperCase()]: target }));
                      document.getElementById('alias-label').value = '';
                      document.getElementById('alias-target').value = '';
                    }
                  }}
                >
                  Add alias
                </button>
              </div>
              {Object.keys(manualAliases).length > 0 && (
                <div className="ethernet-alias-list">
                  <strong>Current overrides:</strong>
                  <ul>
                    {Object.entries(manualAliases).map(([k, v]) => (
                      <li key={k}><code>{k}</code> → {v}
                        <button type="button" className="btn-ghost" onClick={() => setManualAliases(prev => { const n = { ...prev }; delete n[k]; return n; })}>Remove</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {activeTab === 'debug' && hasDebug && (
            <div className="ethernet-debug-panel">
              <p className="ethernet-debug-desc">
                Use the debug bundle to investigate duplicates, wrong edges, label normalization, repeated symbols/legends, cableId regex matches, or pairing logic.
              </p>
              <div className="ethernet-debug-files">
                <strong>Contents:</strong>
                <ul>
                  <li><code>node_dedup_report.json/csv</code> — per nodeId: rawLabels, occurrenceCount, pages, evidence</li>
                  <li><code>cable_occurrences.csv</code> — one row per detected cable occurrence before pairing (endpoint, score, filteredOut)</li>
                  <li><code>pairing_log.json</code> — per cableId: status (paired/unpaired/ambiguous/extra/rejected), chosenPair, occurrences</li>
                  <li><code>summary_debug.json</code> — diagnostics: uniqueCableIds, paired/ambiguous/unpaired lists, topRepeatedLabels, pagesWithLowText</li>
                </ul>
                <p className="ethernet-debug-note">Overlay images (PNG per page) are not generated; use file+page in the CSVs to correlate with the PDFs.</p>
              </div>
              {debug.summaryDebug?.pageTitleIssues && debug.summaryDebug.pageTitleIssues.length > 0 && (
                <div className="ethernet-debug-files">
                  <strong>Pages without clear system title</strong>
                  <ul>
                    {debug.summaryDebug.pageTitleIssues.map((p, i) => (
                      <li key={i}>
                        {p.fileName} p.{p.page} — title: {p.pageTitle || '—'} (conf {(p.confidence * 100).toFixed(0)}%)<br />
                        <span className="ethernet-debug-header-snippet">{p.headerSnippet}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="ethernet-debug-actions">
                <button type="button" className="btn-primary" onClick={downloadDebugBundleZip}>
                  Download debug bundle (ZIP)
                </button>
                <div className="ethernet-debug-separate">
                  <button type="button" className="btn-secondary" onClick={downloadNodeDedupReportJson}>node_dedup_report.json</button>
                  <button type="button" className="btn-secondary" onClick={downloadNodeDedupReportCsv}>node_dedup_report.csv</button>
                  <button type="button" className="btn-secondary" onClick={downloadCableOccurrencesCsv}>cable_occurrences.csv</button>
                  <button type="button" className="btn-secondary" onClick={downloadPairingLog}>pairing_log.json</button>
                  <button type="button" className="btn-secondary" onClick={downloadSummaryDebug}>summary_debug.json</button>
                  <button type="button" className="btn-secondary" onClick={downloadPageInventoryCsv}>page_inventory.csv</button>
                  <button type="button" className="btn-secondary" onClick={downloadCableStatsCsv}>cable_stats.csv</button>
                  <button type="button" className="btn-secondary" onClick={downloadFalsePositives}>false_positive_samples.json</button>
                  <button type="button" className="btn-secondary" onClick={downloadEdgeProvenance}>edge_provenance.json</button>
                </div>
              </div>
            </div>
          )}
          {activeTab === 'edges' && (
            <>
              <div className="ethernet-filter">
                <label>Filter:</label>
                <select value={filterTag} onChange={e => setFilterTag(e.target.value)}>
                  <option value="system">System-level + Unknown</option>
                  <option value="internal">Internal only</option>
                  <option value="all">All</option>
                </select>
              </div>
              <div className="ethernet-table-wrap">
                <table className="ethernet-table">
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>To</th>
                      <th>Cable ID</th>
                      <th>Media</th>
                      <th>Pages (file)</th>
                      <th>Confidence</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEdges.map((e, i) => (
                      <tr key={i}>
                        <td>{edgeFrom(e)}</td>
                        <td>{edgeTo(e)}</td>
                        <td><code>{edgeCableId(e)}</code></td>
                        <td>{e.media}</td>
                        <td className="ethernet-page-refs">{edgePageRefs(e)}</td>
                        <td>{(e.confidence ?? 0).toFixed(2)}</td>
                        <td className="ethernet-evidence">
                          {Array.isArray(e.evidence) && e.evidence.length > 0
                            ? e.evidence.slice(0, 4).map((ev, j) =>
                                typeof ev === 'object' && ev.text != null
                                  ? <span key={j} title={`${ev.role || ''} ${ev.fileName || ''} p.${ev.page || ''}`}>{ev.text}{j < Math.min(3, e.evidence.length - 1) ? '; ' : ''}</span>
                                  : <span key={j}>{String(ev)}; </span>
                              )
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {activeTab === 'review' && (
            <div className="ethernet-review-list">
              {(result.review && result.review.length > 0) ? result.review.map((r, i) => (
                <div key={i} className="ethernet-review-item">
                  <div className="ethernet-review-header">
                    <strong>{r.cableIdNormalized ?? r.cableIdRaw ?? r.cableId}</strong>
                    <span className="ethernet-review-type">{r.type}</span>
                    {r.confidence != null && <span className="ethernet-review-conf">{(r.confidence * 100).toFixed(0)}%</span>}
                  </div>
                  <div className="ethernet-review-page-refs">Refs: {reviewPageRefs(r)}</div>
                  {r.occurrences && r.occurrences.length > 0 && (
                    <div className="ethernet-review-occurrences">
                      <strong>Occurrences:</strong>
                      <ul>
                        {r.occurrences.map((occ, j) => (
                          <li key={j}>
                            {occ.fileName} p.{occ.page} — “{occ.foundCableIdText}” → {occ.endpointLabelPicked}
                            {occ.ethernetHintFound && ' [Ethernet]'}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {r.evidence && r.evidence.length > 0 && (
                    <div className="ethernet-review-evidence">
                      <strong>Evidence:</strong>
                      <ul>
                        {r.evidence.map((ev, j) => (
                          <li key={j}>
                            {typeof ev === 'object' && ev.text != null
                              ? `${ev.role || '—'}: “${ev.text}”${ev.fileName ? ` (${ev.fileName} p.${ev.page})` : ''}`
                              : String(ev)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {r.candidates && r.candidates.length > 0 && (
                    <div className="ethernet-review-candidates">
                      <strong>Candidates:</strong>
                      <ul>
                        {r.candidates.map((c, j) => (
                          <li key={j}>
                            {c.fromLabel} → {c.toLabel}
                            {c.confidence != null && ` (${(c.confidence * 100).toFixed(0)}%)`}
                            {c.reason && ` — ${c.reason}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )) : <p className="ethernet-empty">No items for review.</p>}
            </div>
          )}
          <div className="ethernet-export">
            <button type="button" className="btn-secondary" onClick={downloadJson}>Download JSON</button>
            <button type="button" className="btn-secondary" onClick={downloadCsv}>Download CSV</button>
            <button type="button" className="btn-secondary" onClick={downloadReview}>Download Review.md</button>
            {hasDebug && (
              <>
                <span className="ethernet-export-sep">|</span>
                <button type="button" className="btn-secondary" onClick={downloadDebugBundleZip}>Debug bundle (ZIP)</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
