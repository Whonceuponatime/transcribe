/**
 * Deterministic PDF cable diagram extraction for vessel Ethernet connections.
 * Extracts cable IDs, infers endpoints, pairs connections, produces edges + review list.
 */

const fs = require('fs');
const path = require('path');

// Cable ID patterns: A01-001-15-NN, N50-001-03-NN, N61-002-14-NN, N62-002-03A-NN
const CABLE_ID_REGEX = /\b([A-Z]?\d{2,3}-\d{3}-\d{2}[A-Z]?-\w+)\b/gi;

const ETHERNET_HINTS = [
  'CAT5', 'CAT6', 'RJ45', 'RJ-45', 'LAN', 'ETH', 'Ethernet', 'UTP', 'FTP', 'PoE', 'CAT5e', 'CAT6a'
];

const ENDPOINT_KEYWORDS = [
  'RACK', 'SWITCH', 'SW', 'HUB', 'FW', 'FIREWALL', 'PC', 'SERVER', 'CONSOLE', 'PANEL',
  'VDR', 'ECDIS', 'RADAR', 'VSAT', 'SMS', 'IAS', 'CCTV', 'NVR', 'CAM', 'ROUTER', 'AP',
  'TERMINAL', 'DISPLAY', 'MIMIC', 'PLC', 'UPS', 'BMS', 'GMDSS', 'AIS', 'GPS'
];

const MEDIA_KEYWORDS = {
  'CAT6': 'CAT6',
  'CAT6a': 'CAT6',
  'CAT5': 'CAT5',
  'CAT5e': 'CAT5e',
  'RJ45': 'RJ45',
  'RJ-45': 'RJ45',
  'LAN': 'LAN',
  'UTP': 'UTP',
  'FTP': 'FTP',
  'PoE': 'PoE',
  'Ethernet': 'Ethernet'
};

/**
 * Extract text from PDF buffer using pdf-parse.
 * Returns { pages: [{ pageNum, text }], fullText }
 */
async function extractPdfText(pdfBuffer) {
  const pdf = require('pdf-parse');
  const data = await pdf(pdfBuffer);
  const fullText = data.text || '';
  const numPages = data.numpages || 1;

  // pdf-parse doesn't give per-page text by default; split by form-feed or approximate
  const pages = [];
  const rawPages = fullText.split(/\f+/);
  for (let i = 0; i < numPages; i++) {
    pages.push({
      pageNum: i + 1,
      text: rawPages[i] || (i === 0 ? fullText : '')
    });
  }
  if (pages.length === 0) {
    pages.push({ pageNum: 1, text: fullText });
  }
  return { pages, fullText };
}

/**
 * Find cable ID occurrences with context window.
 */
function findCableOccurrences(pages) {
  const occurrences = [];
  for (const page of pages) {
    const lines = page.text.split(/\r?\n/).filter(Boolean);
    const pageText = page.text;
    let match;
    const re = new RegExp(CABLE_ID_REGEX.source, 'gi');
    while ((match = re.exec(pageText)) !== null) {
      const cableId = match[1].toUpperCase();
      const pos = match.index;
      const lineIdx = pageText.substring(0, pos).split(/\r?\n/).length - 1;
      const startLine = Math.max(0, lineIdx - 3);
      const endLine = Math.min(lines.length - 1, lineIdx + 3);
      const contextLines = lines.slice(startLine, endLine + 1);
      const context = contextLines.join('\n');

      const hasEthernetHint = ETHERNET_HINTS.some(h =>
        new RegExp(h.replace(/-/g, '\\-?'), 'i').test(context)
      );

      let media = 'Unknown';
      for (const [kw, val] of Object.entries(MEDIA_KEYWORDS)) {
        if (new RegExp(kw.replace(/-/g, '\\-?'), 'i').test(context)) {
          media = val;
          break;
        }
      }

      occurrences.push({
        cableId,
        pageNum: page.pageNum,
        context,
        contextLines,
        hasEthernetHint,
        media,
        lineIdx
      });
    }
  }
  return occurrences;
}

/**
 * Score and pick best endpoint label from context.
 */
function inferEndpoint(occurrence, strictEthernet = false) {
  const { context, contextLines, hasEthernetHint } = occurrence;
  const tokens = context.split(/\s+/).filter(Boolean);
  let bestLabel = 'UNKNOWN';
  let bestScore = -1;
  const evidence = [];

  for (const token of tokens) {
    const upper = token.toUpperCase().replace(/[,;:\.]/g, '');
    if (upper.length < 2 || /^\d+$/.test(upper)) continue;

    let score = 0;
    for (const kw of ENDPOINT_KEYWORDS) {
      if (upper.includes(kw)) score += 2;
    }
    if (/^(RACK|SW|PANEL|CONSOLE)[\-\d\w]*$/i.test(upper)) score += 1;
    if (upper.length >= 3 && upper.length <= 30) score += 0.5;
    if (score > bestScore && score > 0) {
      bestScore = score;
      bestLabel = token.replace(/[,;:\.]$/g, '');
    }
  }

  let confidence = bestScore > 0 ? Math.min(1, 0.3 + bestScore * 0.2) : 0.2;
  if (hasEthernetHint) confidence = Math.min(1, confidence + 0.15);
  if (!strictEthernet && !hasEthernetHint) confidence *= 0.9;
  if (bestLabel === 'UNKNOWN') confidence = 0.1;

  if (bestLabel !== 'UNKNOWN') {
    evidence.push(bestLabel);
  }

  return { endpoint: bestLabel, confidence, evidence };
}

/**
 * Group by cable_id, pair or mark for review.
 */
function pairConnections(occurrences, strictEthernet) {
  const withEndpoints = occurrences.map(o => ({
    ...o,
    ep: inferEndpoint(o, strictEthernet)
  }));

  const byCable = {};
  for (const occ of withEndpoints) {
    const id = occ.cableId;
    if (!byCable[id]) byCable[id] = [];
    byCable[id].push(occ);
  }

  const edges = [];
  const review = [];

  for (const [cableId, list] of Object.entries(byCable)) {
    const sorted = [...list].sort((a, b) => b.ep.confidence - a.ep.confidence);

    if (list.length === 1) {
      const o = sorted[0];
      review.push({
        type: 'unpaired',
        cableId,
        endpoint: o.ep.endpoint,
        confidence: o.ep.confidence,
        pageRefs: [o.pageNum],
        evidence: o.ep.evidence,
        media: o.media
      });
    } else if (list.length === 2) {
      const a = sorted[0];
      const b = sorted[1];
      const edgeConf = Math.min(a.ep.confidence, b.ep.confidence);
      const tag = inferEdgeTag(a.ep.endpoint, b.ep.endpoint);

      edges.push({
        from: a.ep.endpoint,
        to: b.ep.endpoint,
        cableId,
        media: a.media || b.media,
        pageRefs: [...new Set([a.pageNum, b.pageNum])],
        confidence: edgeConf,
        evidence: [...a.ep.evidence, ...b.ep.evidence],
        tag
      });
    } else {
      const top2 = sorted.slice(0, 2);
      const rest = sorted.slice(2);
      const scoreGap = top2[0].ep.confidence - (top2[1]?.ep.confidence ?? 0);

      if (scoreGap >= 0.3) {
        const a = top2[0];
        const b = top2[1];
        const edgeConf = Math.min(a.ep.confidence, b.ep.confidence);
        const tag = inferEdgeTag(a.ep.endpoint, b.ep.endpoint);
        edges.push({
          from: a.ep.endpoint,
          to: b.ep.endpoint,
          cableId,
          media: a.media || b.media,
          pageRefs: [...new Set(list.map(o => o.pageNum))],
          confidence: edgeConf,
          evidence: [...a.ep.evidence, ...b.ep.evidence],
          tag
        });
        for (const r of rest) {
          review.push({
            type: 'extra',
            cableId,
            endpoint: r.ep.endpoint,
            pageRefs: [r.pageNum],
            evidence: r.ep.evidence
          });
        }
      } else {
        review.push({
          type: 'ambiguous',
          cableId,
          occurrences: list.length,
          pageRefs: [...new Set(list.map(o => o.pageNum))],
          candidates: sorted.map(o => o.ep.endpoint)
        });
      }
    }
  }

  return { edges, review };
}

function inferEdgeTag(from, to) {
  const fromNorm = from.toUpperCase();
  const toNorm = to.toUpperCase();
  if (fromNorm === 'UNKNOWN' || toNorm === 'UNKNOWN') return 'unknown';
  if (fromNorm === toNorm) return 'internal';
  return 'system_level';
}

/**
 * Main extraction pipeline.
 */
async function extractEthernetConnections(pdfPaths, options = {}) {
  const { strictEthernet = false } = options;
  const allOccurrences = [];

  for (const pdfPath of pdfPaths) {
    const buf = fs.readFileSync(pdfPath);
    const { pages } = await extractPdfText(buf);
    const occs = findCableOccurrences(pages);
    allOccurrences.push(...occs);
  }

  const { edges, review } = pairConnections(allOccurrences, strictEthernet);

  return {
    edges,
    review,
    summary: {
      totalEdges: edges.length,
      totalReview: review.length,
      systemLevel: edges.filter(e => e.tag === 'system_level').length,
      internal: edges.filter(e => e.tag === 'internal').length,
      unknown: edges.filter(e => e.tag === 'unknown').length
    }
  };
}

module.exports = {
  extractPdfText,
  findCableOccurrences,
  inferEndpoint,
  pairConnections,
  extractEthernetConnections,
  CABLE_ID_REGEX,
  ETHERNET_HINTS,
  ENDPOINT_KEYWORDS
};
