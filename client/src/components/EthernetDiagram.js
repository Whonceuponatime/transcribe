import React, { useCallback, useMemo, useState, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  useReactFlow
} from 'reactflow';
import { toPng, toSvg } from 'html-to-image';
import 'reactflow/dist/style.css';
import './EthernetDiagram.css';

/** Conduit class colors for Zone & Conduit diagram */
const CONDUIT_CLASS_COLORS = {
  tcpip_untrusted: '#e11d48',
  tcpip_internal: '#22c55e',
  zone_traversal: '#3b82f6',
  serial: '#a855f7'
};
const CONDUIT_CLASS_LABELS = {
  tcpip_untrusted: 'TCP/IP (untrusted)',
  tcpip_internal: 'TCP/IP (internal)',
  zone_traversal: 'Zone traversal',
  serial: 'Serial'
};
function getConduitPairKey(from, to) {
  return [from, to].sort().join('|');
}

function getEndpointLabel(ep) {
  if (!ep) return '—';
  if (typeof ep === 'object') return ep.labelRaw || ep.labelNormalized || '—';
  return ep;
}

function getCableId(edge) {
  return edge.cableIdNormalized ?? edge.cableId ?? '—';
}

function normalizeNodeId(label) {
  if (!label) return '';
  return String(label).trim();
}

/**
 * (Removed) System topology graph builder – replaced by Zone & Conduit.
 */
const ZONE_ORDER = ['Cargo', 'Control', 'Nav & Comm', 'Untrusted'];
const ZONE_WIDTH = 520;
const ZONE_HEIGHT = 200;
const SYSTEM_BOX_WIDTH = 100;
const SYSTEM_BOX_HEIGHT = 36;
const SYSTEM_PAD = 12;
const ZONE_PAD = 24;

/**
 * Build Zone & Conduit diagram: zone containers, target systems in grid, only approved conduits as numbered lines.
 */
function buildZoneConduitGraph(scopeResult, conduitStatus, conduitClassOverride) {
  if (!scopeResult?.systems?.length) return { nodes: [], edges: [], approvedConduits: [] };
  const systems = scopeResult.systems || [];
  const edges_system = scopeResult.edges_system || [];
  const status = conduitStatus || {};
  const override = conduitClassOverride || {};

  const approvedConduits = edges_system.filter((e) => status[getConduitPairKey(e.fromSystemId, e.toSystemId)] === 'approved');
  const zoneSet = new Set(systems.map((s) => s.zone || 'Control'));
  const zones = ZONE_ORDER.filter((z) => zoneSet.has(z));
  zones.push(...[...zoneSet].filter((z) => !ZONE_ORDER.includes(z)));

  const nodes = [];
  const edges = [];
  let zoneY = 0;

  zones.forEach((zoneName) => {
    const zoneId = `zone:${zoneName.replace(/\s+/g, '_')}`;
    const zoneSystems = systems.filter((s) => (s.zone || 'Control') === zoneName);
    const rows = Math.ceil(Math.sqrt(zoneSystems.length)) || 1;
    const cols = Math.ceil(zoneSystems.length / rows) || 1;
    const innerW = cols * (SYSTEM_BOX_WIDTH + SYSTEM_PAD) - SYSTEM_PAD + ZONE_PAD * 2;
    const innerH = rows * (SYSTEM_BOX_HEIGHT + SYSTEM_PAD) - SYSTEM_PAD + ZONE_PAD * 2;
    const w = Math.max(ZONE_WIDTH, innerW);
    const h = Math.max(ZONE_HEIGHT, innerH);

    nodes.push({
      id: zoneId,
      type: 'zone',
      data: { label: zoneName, zoneName },
      position: { x: 0, y: zoneY },
      style: { width: w, height: h, zIndex: 0 }
    });

    zoneSystems.forEach((sys, idx) => {
      const systemId = sys.systemId || sys.systemName;
      if (!systemId) return;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = ZONE_PAD + col * (SYSTEM_BOX_WIDTH + SYSTEM_PAD);
      const y = ZONE_PAD + row * (SYSTEM_BOX_HEIGHT + SYSTEM_PAD);
      nodes.push({
        id: systemId,
        type: 'system',
        data: {
          label: sys.displayName || sys.displayLabel || systemId,
          systemId,
          zone: zoneName,
          iconType: sys.iconType || 'box'
        },
        position: { x, y },
        parentId: zoneId,
        extent: 'parent',
        style: { width: SYSTEM_BOX_WIDTH, height: SYSTEM_BOX_HEIGHT, zIndex: 1 }
      });
    });

    zoneY += h + 40;
  });

  approvedConduits.forEach((e, i) => {
    const num = i + 1;
    const pairKey = getConduitPairKey(e.fromSystemId, e.toSystemId);
    const conduitClass = override[pairKey] || e.conduitClass || 'tcpip_internal';
    const color = CONDUIT_CLASS_COLORS[conduitClass] || CONDUIT_CLASS_COLORS.tcpip_internal;
    edges.push({
      id: `conduit-${num}-${e.fromSystemId}-${e.toSystemId}`,
      source: e.fromSystemId,
      target: e.toSystemId,
      type: 'smoothstep',
      label: String(num),
      data: { conduitNumber: num, conduitPayload: e, conduitClass },
      style: { stroke: color, strokeWidth: 2 },
      labelStyle: { fill: color, fontWeight: 600 },
      labelBgStyle: { fill: 'var(--bg-surface)', stroke: color },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4
    });
  });

  return { nodes, edges, approvedConduits };
}

function CableNode({ data }) {
  return (
    <div className="ethernet-diagram-node ethernet-diagram-node--cable">
      {data.label}
    </div>
  );
}

function ZoneNode({ data }) {
  return (
    <div className="ethernet-diagram-zone-node">
      <span className="ethernet-diagram-zone-label">{data.label || data.zoneName}</span>
    </div>
  );
}

function SystemNode({ data }) {
  return (
    <div className="ethernet-diagram-system-node">
      {data.label || data.systemId}
    </div>
  );
}

const nodeTypes = {
  cable: CableNode,
  zone: ZoneNode,
  system: SystemNode
};

function ConduitBuilderTable({ edges_system, conduitStatus, conduitClassOverride, onStatusChange, onClassOverride }) {
  const pairKey = (from, to) => getConduitPairKey(from, to);
  const classes = Object.keys(CONDUIT_CLASS_LABELS);
  if (!edges_system?.length) return <p className="ethernet-conduit-empty">No candidate conduits. Run extraction with targets in scope.</p>;
  return (
    <div className="ethernet-conduit-builder">
      <h4>Conduit Builder</h4>
      <p className="ethernet-hint">Approve conduits to include in the Zone &amp; Conduit diagram. Only approved conduits are drawn.</p>
      <div className="ethernet-conduit-table-wrap">
        <table className="ethernet-conduit-table">
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Class</th>
              <th>Confidence</th>
              <th>Evidence</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {edges_system.map((e, i) => {
              const key = pairKey(e.fromSystemId, e.toSystemId);
              const status = conduitStatus[key] || '';
              const cls = conduitClassOverride[key] ?? e.conduitClass ?? 'tcpip_internal';
              const ev = (e.evidence && e.evidence[0]) ? (typeof e.evidence[0] === 'object' && e.evidence[0].text != null ? e.evidence[0].text : String(e.evidence[0])).slice(0, 60) : '—';
              return (
                <tr key={i} className={status === 'approved' ? 'conduit-approved' : status === 'rejected' ? 'conduit-rejected' : ''}>
                  <td>{e.fromSystemId}</td>
                  <td>{e.toSystemId}</td>
                  <td>
                    <select
                      value={cls}
                      onChange={(evt) => onClassOverride(key, evt.target.value)}
                      aria-label="Conduit class"
                    >
                      {classes.map((c) => (
                        <option key={c} value={c}>{CONDUIT_CLASS_LABELS[c] || c}</option>
                      ))}
                    </select>
                  </td>
                  <td>{((e.confidence ?? 0) * 100).toFixed(0)}%</td>
                  <td className="ethernet-conduit-evidence">{ev}{ev.length >= 60 ? '…' : ''}</td>
                  <td>
                    <div className="ethernet-conduit-actions">
                      <button type="button" className={status === 'approved' ? 'active' : ''} onClick={() => onStatusChange(key, 'approved')}>Approve</button>
                      <button type="button" className={status === 'rejected' ? 'active' : ''} onClick={() => onStatusChange(key, 'rejected')}>Reject</button>
                      <button type="button" className={status === 'needs_info' ? 'active' : ''} onClick={() => onStatusChange(key, 'needs_info')}>Needs-info</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConduitListPanel({ approvedConduits, conduitClassOverride }) {
  if (!approvedConduits?.length) return <div className="ethernet-conduit-list-panel"><p>No approved conduits.</p></div>;
  const pairKey = (from, to) => getConduitPairKey(from, to);
  return (
    <div className="ethernet-conduit-list-panel">
      <h4>Conduit list</h4>
      <ul className="ethernet-conduit-list">
        {approvedConduits.map((e, i) => {
          const num = i + 1;
          const cls = (conduitClassOverride || {})[pairKey(e.fromSystemId, e.toSystemId)] ?? e.conduitClass ?? 'tcpip_internal';
          const color = CONDUIT_CLASS_COLORS[cls];
          return (
            <li key={i} className="ethernet-conduit-list-item">
              <span className="ethernet-conduit-num" style={{ borderColor: color }}>{num}</span>
              <div>
                <strong>{e.fromSystemId}</strong> ↔ <strong>{e.toSystemId}</strong>
                <div className="ethernet-conduit-detail">Cable IDs: {(e.cableIds || []).slice(0, 5).join(', ')}{(e.cableIds?.length > 5 ? '…' : '')}</div>
                <div className="ethernet-conduit-detail">Pages: {(e.pageRefs || []).slice(0, 3).map((r) => `${r.fileName} p.${r.page}`).join('; ')}</div>
                {(e.evidence || []).slice(0, 2).map((ev, j) => (
                  <div key={j} className="ethernet-conduit-evidence-line">{typeof ev === 'object' && ev.text != null ? ev.text : String(ev)}</div>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SingleDiagram({ initialNodes, initialEdges, onSelectNode, onSelectEdge, flowWrapClassName }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);
  return (
    <div className={`ethernet-diagram-flow-wrap ${flowWrapClassName || ''}`.trim()}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelectNode(node.id, node.data)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id, edge.data)}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        maxZoom={1.5}
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}

function DiagramInner({
  result,
  scopeResult,
  onSelectNode,
  onSelectEdge,
  conduitStatus,
  conduitClassOverride,
  onConduitStatusChange,
  onConduitClassOverride
}) {
  const hasScope = scopeResult && scopeResult.systems && scopeResult.edges_system?.length >= 0;
  const zoneGraph = useMemo(() => {
    if (!scopeResult || !hasScope) return { nodes: [], edges: [], approvedConduits: [] };
    return buildZoneConduitGraph(scopeResult, conduitStatus, conduitClassOverride);
  }, [scopeResult, conduitStatus, conduitClassOverride, hasScope]);

  return (
    <div className="ethernet-diagram-toolbar">
      <div className="ethernet-diagram-toolbar-row">
        {hasScope && (
          <>
            <ConduitBuilderTable
              edges_system={scopeResult.edges_system}
              conduitStatus={conduitStatus}
              conduitClassOverride={conduitClassOverride}
              onStatusChange={onConduitStatusChange}
              onClassOverride={onConduitClassOverride}
            />
            <div className="ethernet-conduit-legend">
              <strong>Conduit classes:</strong>
              {Object.entries(CONDUIT_CLASS_LABELS).map(([cls, label]) => (
                <span key={cls} className="ethernet-conduit-legend-item">
                  <span className="ethernet-conduit-legend-swatch" style={{ background: CONDUIT_CLASS_COLORS[cls] }} />
                  {label}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="ethernet-diagram-main-wrap">
        <SingleDiagram
          initialNodes={zoneGraph.nodes}
          initialEdges={zoneGraph.edges}
          onSelectNode={onSelectNode}
          onSelectEdge={onSelectEdge}
          flowWrapClassName="ethernet-diagram-flow-wrap--zone"
        />
        {hasScope && zoneGraph.approvedConduits?.length > 0 && (
          <ConduitListPanel approvedConduits={zoneGraph.approvedConduits} conduitClassOverride={conduitClassOverride} />
        )}
      </div>
    </div>
  );
}

function SidePanel({ selection, result, scopeResult, onClose }) {
  if (!selection || !result) return null;
  const { type, id, data } = selection;

  if (type === 'edge' && data?.conduitPayload) {
    const e = data.conduitPayload;
    const num = data.conduitNumber;
    const conduitClass = data.conduitClass || e.conduitClass;
    return (
      <div className="ethernet-diagram-panel">
        <div className="ethernet-diagram-panel-header">
          <h3>Conduit {num}: {e.fromSystemId} ↔ {e.toSystemId}</h3>
          <button type="button" className="ethernet-diagram-panel-close" onClick={onClose}>×</button>
        </div>
        <div className="ethernet-diagram-panel-section">
          <p><strong>Class:</strong> {conduitClass}</p>
          <strong>Cable IDs</strong>
          <ul>{((e.cableIds && e.cableIds.length) ? e.cableIds : []).map((c, i) => (
            <li key={i}>{c}{e.cableIdCounts && e.cableIdCounts[c] != null ? ` (×${e.cableIdCounts[c]})` : ''}</li>
          ))}</ul>
          <strong>Page refs</strong>
          <ul className="ethernet-diagram-evidence">
            {(e.pageRefs || []).slice(0, 10).map((r, i) => (
              <li key={i}>{r.fileName} p.{r.page}</li>
            ))}
          </ul>
          <strong>Evidence</strong>
          <ul className="ethernet-diagram-evidence">
            {(e.evidence || []).slice(0, 10).map((ev, i) => (
              <li key={i}>{typeof ev === 'object' && ev.text != null ? `${ev.fileName || ''} p.${ev.page ?? ''}: ${ev.text}` : String(ev)}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (type === 'edge' && data?.systemEdgePayload) {
    const e = data.systemEdgePayload;
    const edgeCount = e.edgeCount ?? (e.cableIds?.length ?? 0);
    const mediaTypes = e.mediaTypes ?? (e.media ? [e.media] : []);
    return (
      <div className="ethernet-diagram-panel">
        <div className="ethernet-diagram-panel-header">
          <h3>System link: {e.fromSystemId} ↔ {e.toSystemId}</h3>
          <button type="button" className="ethernet-diagram-panel-close" onClick={onClose}>×</button>
        </div>
        <div className="ethernet-diagram-panel-section">
          {edgeCount > 0 && <p><strong>Aggregated:</strong> {edgeCount} device edge(s), media: {Array.isArray(mediaTypes) ? mediaTypes.join(', ') : e.media}</p>}
          <strong>Cable IDs</strong>
          <ul>{((e.cableIds && e.cableIds.length) ? e.cableIds : []).map((c, i) => (
            <li key={i}>{c}{e.cableIdCounts && e.cableIdCounts[c] != null ? ` (×${e.cableIdCounts[c]})` : ''}</li>
          ))}</ul>
          <strong>Page refs</strong>
          <ul className="ethernet-diagram-evidence">
            {(e.pageRefs || []).slice(0, 10).map((r, i) => (
              <li key={i}>{r.fileName} p.{r.page}</li>
            ))}
          </ul>
          <strong>Evidence</strong>
          <ul className="ethernet-diagram-evidence">
            {(e.evidence || []).slice(0, 10).map((ev, i) => (
              <li key={i}>{typeof ev === 'object' && ev.text != null ? `${ev.fileName || ''} p.${ev.page ?? ''}: ${ev.text}` : String(ev)}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (type === 'node') {
    const edges = (result.edges || []).filter((e) => {
      const fromId = normalizeNodeId(getEndpointLabel(e.from));
      const toId = normalizeNodeId(getEndpointLabel(e.to));
      return fromId === id || toId === id;
    });
    const reviewLinks = (result.review || []).filter((r) => {
      const cableNodeId = `cable:${r.cableIdNormalized ?? r.cableIdRaw ?? r.cableId}`;
      if (cableNodeId === id) return true;
      const occ = (r.occurrences || []).some((o) => normalizeNodeId(o.endpointLabelPicked) === id);
      const cand = (r.candidates || []).some(
        (c) => normalizeNodeId(c.fromLabel) === id || normalizeNodeId(c.toLabel) === id
      );
      return occ || cand;
    });

    return (
      <div className="ethernet-diagram-panel">
        <div className="ethernet-diagram-panel-header">
          <h3>Node: {id}</h3>
          <button type="button" className="ethernet-diagram-panel-close" onClick={onClose}>×</button>
        </div>
        <div className="ethernet-diagram-panel-section">
          <strong>Related edges ({edges.length + reviewLinks.length})</strong>
          {edges.map((e, i) => (
            <div key={`e-${i}`} className="ethernet-diagram-panel-item">
              <span className="ethernet-diagram-panel-cable">{getCableId(e)}</span>
              {getEndpointLabel(e.from)} → {getEndpointLabel(e.to)} | {e.media} | {(e.confidence * 100).toFixed(0)}%
              {e.evidence && e.evidence.length > 0 && (
                <ul className="ethernet-diagram-evidence">
                  {e.evidence.slice(0, 5).map((ev, j) => (
                    <li key={j}>
                      {typeof ev === 'object' && ev.text != null
                        ? `${ev.fileName || ''} p.${ev.page ?? ''}: ${ev.text}`
                        : String(ev)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {reviewLinks.map((r, i) => (
            <div key={`r-${i}`} className="ethernet-diagram-panel-item">
              <span className="ethernet-diagram-panel-cable">{r.cableIdNormalized ?? r.cableIdRaw}</span>
              {r.type} | {(r.confidence * 100).toFixed(0)}%
              {r.evidence && r.evidence.length > 0 && (
                <ul className="ethernet-diagram-evidence">
                  {r.evidence.slice(0, 5).map((ev, j) => (
                    <li key={j}>
                      {typeof ev === 'object' && ev.text != null
                        ? `${ev.fileName || ''} p.${ev.page ?? ''}: ${ev.text}`
                        : String(ev)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === 'edge') {
    const edgePayload = data?.edgePayload;
    const reviewItem = data?.reviewItem;
    if (edgePayload) {
      const occ = edgePayload.occurrences || [];
      const ev = edgePayload.evidence || [];
      return (
        <div className="ethernet-diagram-panel">
          <div className="ethernet-diagram-panel-header">
            <h3>Edge: {getCableId(edgePayload)}</h3>
            <button type="button" className="ethernet-diagram-panel-close" onClick={onClose}>×</button>
          </div>
          <div className="ethernet-diagram-panel-section">
            <strong>Two occurrences used to pair (file + page)</strong>
            {occ.map((o, i) => (
              <div key={i} className="ethernet-diagram-occurrence-ref">
                <span className="ethernet-diagram-file-page">{o.fileName} p.{o.page}</span>
                {o.sheetTitle && <span className="ethernet-diagram-sheet-ref"> — {o.sheetTitle}</span>}
                <span> “{o.foundCableIdText}” → {o.endpointLabelPicked}</span>
              </div>
            ))}
            <strong>Evidence</strong>
            <ul className="ethernet-diagram-evidence">
              {ev.map((e, i) => (
                <li key={i}>
                  {typeof e === 'object' && e.text != null ? `${e.fileName || ''} p.${e.page ?? ''} [${e.role}]: ${e.text}` : String(e)}
                </li>
              ))}
            </ul>
            <p className="ethernet-diagram-highlight-hint">
              Highlight on original page: open the PDF at the file and page above to verify. In-app overlay (future).
            </p>
          </div>
        </div>
      );
    }
    if (reviewItem) {
      const occ = reviewItem.occurrences || [];
      const ev = reviewItem.evidence || [];
      return (
        <div className="ethernet-diagram-panel">
          <div className="ethernet-diagram-panel-header">
            <h3>Cable: {reviewItem.cableIdNormalized ?? reviewItem.cableIdRaw}</h3>
            <button type="button" className="ethernet-diagram-panel-close" onClick={onClose}>×</button>
          </div>
          <div className="ethernet-diagram-panel-section">
            <strong>Occurrences</strong>
            {occ.map((o, i) => (
              <div key={i}>{o.fileName} p.{o.page} — “{o.foundCableIdText}” → {o.endpointLabelPicked}</div>
            ))}
            <strong>Evidence</strong>
            <ul className="ethernet-diagram-evidence">
              {ev.map((e, i) => (
                <li key={i}>
                  {typeof e === 'object' && e.text != null ? `${e.fileName || ''} p.${e.page ?? ''} [${e.role}]: ${e.text}` : String(e)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
  }

  return null;
}

function ExportButtons({ flowRef }) {
  const reactFlowInstance = useReactFlow();

  const exportPng = useCallback(() => {
    const wrap = document.querySelector('.ethernet-diagram-flow-wrap');
    if (!wrap) return;
    toPng(wrap, { pixelRatio: 2, backgroundColor: 'var(--bg-surface, #1a1a1a)' }).then((dataUrl) => {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'ethernet-diagram.png';
      a.click();
    });
  }, []);

  const exportSvg = useCallback(() => {
    const wrap = document.querySelector('.ethernet-diagram-flow-wrap');
    if (!wrap) return;
    toSvg(wrap, { backgroundColor: 'var(--bg-surface, #1a1a1a)' }).then((dataUrl) => {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'ethernet-diagram.svg';
      a.click();
    });
  }, []);

  const exportDrawio = useCallback(() => {
    const edges = reactFlowInstance.getEdges();
    const lines = ['from,to,conduitNumber,cableIds,mediaTypes,confidence'];
    edges.forEach((e) => {
      const from = e.source;
      const to = e.target;
      const payload = e.data?.conduitPayload;
      if (!payload) return;
      const num = e.data?.conduitNumber ?? '';
      const cableIds = (payload.cableIds || []).join('; ');
      const media = (payload.mediaTypes || payload.media || '').toString();
      const conf = payload.confidence ?? '';
      lines.push(`"${from}","${to}","${num}","${cableIds}","${media}","${conf}"`);
    });
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ethernet-conduits-drawio.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, [reactFlowInstance]);

  return (
    <div className="ethernet-diagram-export">
      <button type="button" className="btn-secondary" onClick={exportPng}>Export PNG</button>
      <button type="button" className="btn-secondary" onClick={exportSvg}>Export SVG</button>
      <button type="button" className="btn-secondary" onClick={exportDrawio}>Export for draw.io (CSV)</button>
    </div>
  );
}

function DiagramContent({
  result,
  scopeResult,
  selection,
  onSelectNode,
  onSelectEdge,
  onClosePanel,
  conduitStatus,
  conduitClassOverride,
  onConduitStatusChange,
  onConduitClassOverride
}) {
  return (
    <div className="ethernet-diagram-root">
      <ReactFlowProvider>
        <DiagramInner
          result={result}
          scopeResult={scopeResult}
          onSelectNode={onSelectNode}
          onSelectEdge={onSelectEdge}
          conduitStatus={conduitStatus}
          conduitClassOverride={conduitClassOverride}
          onConduitStatusChange={onConduitStatusChange}
          onConduitClassOverride={onConduitClassOverride}
        />
        <ExportButtons />
        {selection && (
          <div className="ethernet-diagram-panel-wrap">
            <SidePanel selection={selection} result={result} scopeResult={scopeResult} onClose={onClosePanel} />
          </div>
        )}
      </ReactFlowProvider>
    </div>
  );
}

export default function EthernetDiagram({ result, scopeResult }) {
  const [selection, setSelection] = useState(null);
  const [conduitStatus, setConduitStatus] = useState({});
  const [conduitClassOverride, setConduitClassOverride] = useState({});

  const onSelectNode = useCallback((id, data) => {
    setSelection({ type: 'node', id, data });
  }, []);
  const onSelectEdge = useCallback((id, data) => {
    setSelection({ type: 'edge', id, data });
  }, []);
  const onClosePanel = useCallback(() => setSelection(null), []);

  const onConduitStatusChange = useCallback((pairKey, status) => {
    setConduitStatus((prev) => ({ ...prev, [pairKey]: status }));
  }, []);
  const onConduitClassOverride = useCallback((pairKey, conduitClass) => {
    setConduitClassOverride((prev) => ({ ...prev, [pairKey]: conduitClass }));
  }, []);

  if (!result) {
    return <div className="ethernet-diagram-empty">Run extraction first to see the diagram.</div>;
  }

  return (
    <DiagramContent
      result={result}
      scopeResult={scopeResult}
      selection={selection}
      onSelectNode={onSelectNode}
      onSelectEdge={onSelectEdge}
      onClosePanel={onClosePanel}
      conduitStatus={conduitStatus}
      conduitClassOverride={conduitClassOverride}
      onConduitStatusChange={onConduitStatusChange}
      onConduitClassOverride={onConduitClassOverride}
    />
  );
}
