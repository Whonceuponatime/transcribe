import React, { useState, useRef } from 'react';
import './EthernetExtractor.css';

export default function EthernetExtractor() {
  const [files, setFiles] = useState([]);
  const [vesselId, setVesselId] = useState('');
  const [strictEthernet, setStrictEthernet] = useState(false);
  const [loading, setLoading] = useState(false);
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

  const removeFile = (idx) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const runExtraction = async () => {
    if (!files.length) {
      setError('Please upload at least one PDF.');
      return;
    }
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const form = new FormData();
      files.forEach(f => form.append('files', f));
      form.append('vesselId', vesselId || 'default');
      form.append('strictEthernet', strictEthernet);
      const res = await fetch('/api/ethernet/extract', {
        method: 'POST',
        body: form
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || 'Extraction failed');
      setResult(data);
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const clearAll = () => {
    setFiles([]);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

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
      vesselId: result.vesselId,
      fileNames: result.fileNames,
      edges: result.edges,
      review: result.review,
      summary: result.summary
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
    const rows = result.edges.map(e => [
      e.from,
      e.to,
      e.cableId,
      e.media,
      (e.pageRefs || []).join(';'),
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

  const downloadReview = () => {
    if (!result) return;
    let md = '# Ethernet Connections – Review List\n\n';
    md += '## Unpaired / Ambiguous\n\n';
    for (const r of result.review) {
      md += `- **${r.cableId}** (${r.type})`;
      if (r.endpoint) md += ` → ${r.endpoint}`;
      if (r.pageRefs?.length) md += ` | Pages: ${r.pageRefs.join(', ')}`;
      if (r.candidates?.length) md += ` | Candidates: ${r.candidates.join(', ')}`;
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
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
        >
          <p>Drop PDFs here or click to select</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            onChange={handleFileSelect}
            className="ethernet-file-input"
          />
        </div>
        {files.length > 0 && (
          <ul className="ethernet-file-list">
            {files.map((f, i) => (
              <li key={i}>
                <span>{f.name}</span>
                <button type="button" className="btn-ghost" onClick={() => removeFile(i)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <div className="ethernet-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={!files.length || loading}
            onClick={runExtraction}
          >
            {loading ? 'Extracting…' : 'Extract Ethernet Connections'}
          </button>
          <button type="button" className="btn-ghost" onClick={clearAll}>Clear</button>
        </div>
      </div>

      {error && <div className="ethernet-error">{error}</div>}

      {result && (
        <div className="ethernet-results">
          <div className="ethernet-summary">
            {result.summary.totalEdges} paired • {result.summary.totalReview} in review •
            System-level: {result.summary.systemLevel} • Internal: {result.summary.internal}
          </div>
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
              Review ({result.review.length})
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
                      <th>Pages</th>
                      <th>Confidence</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEdges.map((e, i) => (
                      <tr key={i}>
                        <td>{e.from}</td>
                        <td>{e.to}</td>
                        <td><code>{e.cableId}</code></td>
                        <td>{e.media}</td>
                        <td>{(e.pageRefs || []).join(', ')}</td>
                        <td>{(e.confidence ?? 0).toFixed(2)}</td>
                        <td className="ethernet-evidence">{(e.evidence || []).slice(0, 3).join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {activeTab === 'review' && (
            <div className="ethernet-review-list">
              {result.review.map((r, i) => (
                <div key={i} className="ethernet-review-item">
                  <strong>{r.cableId}</strong> — {r.type}
                  {r.endpoint && <span> → {r.endpoint}</span>}
                  {r.pageRefs?.length && <span> (p.{r.pageRefs.join(', ')})</span>}
                  {r.candidates?.length && <span> Candidates: {r.candidates.join(', ')}</span>}
                </div>
              ))}
              {result.review.length === 0 && <p className="ethernet-empty">No items for review.</p>}
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
