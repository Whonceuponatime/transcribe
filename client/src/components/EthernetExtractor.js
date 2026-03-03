import React, { useState, useRef } from 'react';
import './EthernetExtractor.css';
import { supabase } from '../lib/supabase';

export default function EthernetExtractor() {
  const [files, setFiles] = useState([]);
  const [vesselId, setVesselId] = useState('');
  const [strictEthernet, setStrictEthernet] = useState(false);
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
          strictEthernet,
          minConfidence: 0,
          systemLevelOnly: false,
          aiEnabled: false,
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
        <div className="ethernet-option">
          <input
            type="checkbox"
            id="strict-ether"
            checked={strictEthernet}
            onChange={e => setStrictEthernet(e.target.checked)}
          />
          <label htmlFor="strict-ether">Strict Ethernet only (exclude cables without CAT6/RJ45/etc hints)</label>
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
          </div>
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
          </div>
        </div>
      )}
    </div>
  );
}
