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
import dagre from 'dagre';
import { toPng, toSvg } from 'html-to-image';
import 'reactflow/dist/style.css';
import './EthernetDiagram.css';

const NODE_WIDTH = 160;
const NODE_HEIGHT = 40;

function normalizeNodeId(label) {
  if (label == null || label === '') return 'UNKNOWN';
  const s = String(label)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/\s*\[[^\]]*\]\s*/g, '')
    .trim();
  return s || 'UNKNOWN';
}

function getEndpointLabel(ep) {
  if (!ep) return '—';
  if (typeof ep === 'object') return ep.labelRaw || ep.labelNormalized || '—';
  return ep;
}

function getCableId(edge) {
  return edge.cableIdNormalized ?? edge.cableId ?? '—';
}

function applyFilters(edges, filters, sheetFilter) {
  const { minConfidence, showInternal, includeUnknown, search } = filters;
  let list = edges || [];
  if (sheetFilter) {
    list = list.filter((e) =>
      (e.sheetRefs || e.pageRefs || []).some(
        (r) => r.fileName === sheetFilter.fileName && r.page === sheetFilter.page
      )
    );
  }
  const conf = minConfidence / 100;
  list = list.filter((e) => (e.confidence ?? 0) >= conf);
  const tagOk = (e) => {
    if (e.tag === 'internal') return showInternal;
    if (e.tag === 'unknown') return includeUnknown;
    return e.tag === 'system_level';
  };
  list = list.filter(tagOk);
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((e) => {
      const fromL = getEndpointLabel(e.from);
      const toL = getEndpointLabel(e.to);
      const cableId = getCableId(e);
      return (
        fromL.toLowerCase().includes(q) ||
        toL.toLowerCase().includes(q) ||
        cableId.toLowerCase().includes(q)
      );
    });
  }
  return list;
}

function getLayoutedNodesEdges(nodes, edges, direction = 'LR') {
  if (nodes.length === 0) return { nodes: [], edges };

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 80 });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  const layoutedNodes = nodes.map((n) => {
    const pos = g.node(n.id);
    const x = (pos && pos.x != null) ? pos.x - NODE_WIDTH / 2 : 0;
    const y = (pos && pos.y != null) ? pos.y - NODE_HEIGHT / 2 : 0;
    return {
      ...n,
      position: { x, y }
    };
  });

  return { nodes: layoutedNodes, edges };
}

/**
 * Build graph from scope-first result: nodes = systems, edges = edges_system (simplified topology).
 */
function buildSystemTopologyGraph(scopeResult) {
  if (!scopeResult || !scopeResult.systems || !scopeResult.edges_system) {
    return { nodes: [], edges: [] };
  }
  const systems = scopeResult.systems || [];
  const byId = new Map();
  systems.forEach((s) => {
    const id = s.systemId || s.systemName;
    if (!id) return;
    byId.set(id, s);
  });

  const systemIds = new Set();
  scopeResult.edges_system.forEach((e) => {
    systemIds.add(e.fromSystemId);
    systemIds.add(e.toSystemId);
  });

  const nodes = [];
  systemIds.forEach((id) => {
    const sys = byId.get(id);
    const likelyNetworked = sys ? !!sys.likelyNetworked : true;
    if (!likelyNetworked && !sys) return;
    const label = sys?.displayLabel || id;
    nodes.push({
      id,
      type: 'default',
      data: {
        label,
        isSystemNode: true,
        systemTag: sys?.systemTag,
        likelyNetworked,
        systemId: id
      },
      position: { x: 0, y: 0 }
    });
  });
  const flowEdges = scopeResult.edges_system.map((e, i) => {
    const cableLabel = Array.isArray(e.cableIds) ? e.cableIds.slice(0, 3).join(', ') : (e.cableIds || e.cableIds?.[0] || '');
    const mediaStr = Array.isArray(e.mediaTypes) ? e.mediaTypes.join(', ') : (e.media || '');
    const countStr = e.edgeCount != null ? ` (${e.edgeCount})` : '';
    const label = cableLabel ? `${cableLabel}${(e.cableIds?.length > 3 ? '…' : '')} ${mediaStr}${countStr}`.trim() : (mediaStr + countStr) || `${e.fromSystemId}–${e.toSystemId}`;
    return {
      id: `scope-${i}-${e.fromSystemId}-${e.toSystemId}`,
      source: e.fromSystemId,
      target: e.toSystemId,
      label: label || `${e.fromSystemId}–${e.toSystemId}`,
      data: { systemEdgePayload: e, edgePayload: e.edgeDetail }
    };
  });
  return getLayoutedNodesEdges(nodes, flowEdges);
}

function buildTopologyGraph(result, filters, sheetFilter = null) {
  const edges = applyFilters(result.edges || [], filters, sheetFilter);
  const nodeIds = new Set();
  edges.forEach((e) => {
    const fromL = getEndpointLabel(e.from);
    const toL = getEndpointLabel(e.to);
    nodeIds.add(normalizeNodeId(fromL));
    nodeIds.add(normalizeNodeId(toL));
  });

  const nodes = Array.from(nodeIds).map((id) => ({
    id,
    type: 'default',
    data: { label: id },
    position: { x: 0, y: 0 }
  }));

  const flowEdges = edges.map((e, i) => {
    const fromId = normalizeNodeId(getEndpointLabel(e.from));
    const toId = normalizeNodeId(getEndpointLabel(e.to));
    const label = `${getCableId(e)} ${e.media || ''}`.trim();
    return {
      id: `topo-${i}-${fromId}-${toId}`,
      source: fromId,
      target: toId,
      label,
      data: { edgePayload: e }
    };
  });

  return getLayoutedNodesEdges(nodes, flowEdges);
}

function buildCableCentricGraph(result, filters) {
  const review = (result.review || []).filter((r) => r.type !== 'symbol_or_component');
  const { minConfidence, search } = filters;
  const conf = minConfidence / 100;
  const q = search && search.trim() ? search.trim().toLowerCase() : '';

  const nodes = [];
  const flowEdges = [];
  const endpointIds = new Set();

  review.forEach((r, ri) => {
    const cableId = r.cableIdNormalized ?? r.cableIdRaw ?? r.cableId ?? `cable-${ri}`;
    const cableNodeId = `cable:${cableId}`;
    if ((r.confidence ?? 0) < conf) return;
    if (q && !cableId.toLowerCase().includes(q)) {
      const occLabels = (r.occurrences || []).map((o) => (o.endpointLabelPicked || '').toLowerCase());
      const candLabels = (r.candidates || []).flatMap((c) => [c.fromLabel, c.toLabel].map((l) => (l || '').toLowerCase()));
      if (!occLabels.some((l) => l.includes(q)) && !candLabels.some((l) => l.includes(q))) return;
    }

    nodes.push({
      id: cableNodeId,
      type: 'cable',
      data: { label: cableId, reviewItem: r },
      position: { x: 0, y: 0 }
    });

    const endpointLabels = new Set();
    (r.occurrences || []).forEach((occ) => {
      const lbl = occ.endpointLabelPicked;
      if (lbl) endpointLabels.add(lbl);
    });
    (r.candidates || []).forEach((c) => {
      if (c.fromLabel) endpointLabels.add(c.fromLabel);
      if (c.toLabel) endpointLabels.add(c.toLabel);
    });

    endpointLabels.forEach((label) => {
      const eid = normalizeNodeId(label);
      endpointIds.add(eid);
      flowEdges.push({
        id: `rev-${ri}-${cableNodeId}-${eid}`,
        source: cableNodeId,
        target: eid,
        label: `${cableId} ${r.media || ''} ${(r.confidence * 100).toFixed(0)}%`.trim(),
        data: { reviewItem: r, endpointLabel: label }
      });
    });
  });

  endpointIds.forEach((id) => {
    nodes.push({
      id,
      type: 'default',
      data: { label: id },
      position: { x: 0, y: 0 }
    });
  });

  const edges = flowEdges;
  return getLayoutedNodesEdges(nodes, edges);
}

function CableNode({ data }) {
  return (
    <div className="ethernet-diagram-node ethernet-diagram-node--cable">
      {data.label}
    </div>
  );
}

const nodeTypes = { cable: CableNode };

function SingleDiagram({ initialNodes, initialEdges, onSelectNode, onSelectEdge }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);
  return (
    <div className="ethernet-diagram-flow-wrap">
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

function DiagramInner({ result, scopeResult, onSelectNode, onSelectEdge }) {
  const hasScope = scopeResult && scopeResult.systems && scopeResult.edges_system?.length >= 0;
  const [mode, setMode] = useState(hasScope ? 'system' : 'topology');
  // Default to higher confidence to avoid spaghetti graphs
  const [minConfidence, setMinConfidence] = useState(60);
  const [showInternal, setShowInternal] = useState(false);
  // Default to system-level edges only; unknown can be toggled on
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [search, setSearch] = useState('');
  // Group by sheet by default to keep each diagram small and readable
  const [groupBySheet, setGroupBySheet] = useState(true);
  const [showDrillDown, setShowDrillDown] = useState(false);
  const filters = useMemo(
    () => ({ minConfidence, showInternal, includeUnknown, search }),
    [minConfidence, showInternal, includeUnknown, search]
  );

  const sheets = useMemo(() => result?.sheets ?? [], [result?.sheets]);
  const groupBySheetEnabled = groupBySheet && mode === 'topology' && sheets.length > 0 && !hasScope;

  const singleGraph = useMemo(() => {
    if (!result) return { nodes: [], edges: [] };
    if (mode === 'system' && hasScope) return buildSystemTopologyGraph(scopeResult);
    if (mode === 'cable') return buildCableCentricGraph(result, filters);
    return buildTopologyGraph(result, filters, null);
  }, [result, scopeResult, mode, filters, hasScope]);

  const sheetsGraphs = useMemo(() => {
    if (!groupBySheetEnabled || !result) return [];
    return sheets.map((sheet) => {
      const { nodes: n, edges: e } = buildTopologyGraph(result, filters, {
        fileName: sheet.fileName,
        page: sheet.page
      });
      return { sheet, nodes: n, edges: e };
    });
  }, [result, filters, sheets, groupBySheetEnabled]);

  return (
    <div className="ethernet-diagram-toolbar">
      <div className="ethernet-diagram-toolbar-row">
        <label>
          Mode:
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {hasScope && (
              <option value="system">System topology (scope)</option>
            )}
            <option value="topology">Topology (device-level)</option>
            <option value="cable">Cable-centric</option>
          </select>
        </label>
        {hasScope && mode === 'system' && (
          <label>
            <input type="checkbox" checked={showDrillDown} onChange={(e) => setShowDrillDown(e.target.checked)} />
            Drill-down (device-level edges)
          </label>
        )}
        <label className="ethernet-diagram-slider-label">
          Min confidence: {minConfidence}%
          <input
            type="range"
            min={0}
            max={100}
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
          />
        </label>
        {mode === 'topology' && (
          <>
            <label>
              <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
              Show internal
            </label>
            <label>
              <input type="checkbox" checked={includeUnknown} onChange={(e) => setIncludeUnknown(e.target.checked)} />
              Include unknown
            </label>
            {sheets.length > 0 && (
              <label>
                <input type="checkbox" checked={groupBySheet} onChange={(e) => setGroupBySheet(e.target.checked)} />
                Group by sheet
              </label>
            )}
          </>
        )}
        <input
          type="text"
          className="ethernet-diagram-search"
          placeholder="Search cable or endpoint..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {groupBySheetEnabled && sheetsGraphs.length > 0 ? (
        <div className="ethernet-diagram-by-sheet">
          {sheetsGraphs.map(({ sheet, nodes: n, edges: e }) => (
            <div key={`${sheet.fileName}-${sheet.page}`} className="ethernet-diagram-sheet-group">
              <h4 className="ethernet-diagram-sheet-title">
                {sheet.sheetTitle} — {sheet.fileName} p.{sheet.page}
              </h4>
              {n.length > 0 || e.length > 0 ? (
                <SingleDiagram
                  initialNodes={n}
                  initialEdges={e}
                  onSelectNode={onSelectNode}
                  onSelectEdge={onSelectEdge}
                />
              ) : (
                <p className="ethernet-diagram-sheet-empty">No system-level edges on this sheet.</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <>
          <SingleDiagram
            initialNodes={singleGraph.nodes}
            initialEdges={singleGraph.edges}
            onSelectNode={onSelectNode}
            onSelectEdge={onSelectEdge}
          />
          {hasScope && mode === 'system' && showDrillDown && scopeResult?.edges_detail?.length > 0 && (
            <div className="ethernet-diagram-drilldown">
              <h4>Device-level edges (drill-down)</h4>
              <p className="ethernet-diagram-drilldown-hint">Internal wiring; only boundary-to-boundary across systems appear in the graph above.</p>
              <ul className="ethernet-diagram-drilldown-list">
                {scopeResult.edges_detail.slice(0, 50).map((e, i) => (
                  <li key={i}>
                    {e.fromSystemId || '?'} → {e.toSystemId || '?'}: {getCableId(e)} {e.from?.labelRaw || e.from} → {e.to?.labelRaw || e.to}
                    {e.fromBoundary && e.toBoundary ? ' [boundary↔boundary]' : ' [internal]'}
                  </li>
                ))}
                {scopeResult.edges_detail.length > 50 && (
                  <li>… and {scopeResult.edges_detail.length - 50} more</li>
                )}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SidePanel({ selection, result, scopeResult, onClose }) {
  if (!selection || !result) return null;
  const { type, id, data } = selection;

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
    const lines = ['from,to,cableId,media,confidence'];
    edges.forEach((e) => {
      const from = e.source;
      const to = e.target;
      const cableId = e.data?.edgePayload ? getCableId(e.data.edgePayload) : (e.label || '').split(' ')[0] || '';
      const media = (e.data?.edgePayload?.media ?? (e.label || '').split(' ').slice(1).join(' ')) || '';
      const conf = (e.data?.edgePayload?.confidence ?? e.data?.reviewItem?.confidence) ?? '';
      lines.push(`"${from}","${to}","${cableId}","${media}","${conf}"`);
    });
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ethernet-diagram-drawio.csv';
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

function DiagramContent({ result, scopeResult, selection, onSelectNode, onSelectEdge, onClosePanel }) {
  return (
    <div className="ethernet-diagram-root">
      <ReactFlowProvider>
        <DiagramInner
          result={result}
          scopeResult={scopeResult}
          onSelectNode={onSelectNode}
          onSelectEdge={onSelectEdge}
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

  const onSelectNode = useCallback((id, data) => {
    setSelection({ type: 'node', id, data });
  }, []);
  const onSelectEdge = useCallback((id, data) => {
    setSelection({ type: 'edge', id, data });
  }, []);
  const onClosePanel = useCallback(() => setSelection(null), []);

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
    />
  );
}
