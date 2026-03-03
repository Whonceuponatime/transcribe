/**
 * Deterministic PDF cable diagram extraction for vessel Ethernet connections.
 * Extracts cable IDs, infers endpoints, pairs connections, produces edges + review list.
 */

const fs = require('fs');
const path = require('path');

// Cable ID patterns: A01-001-15-NN, N50-001-03-NN, N61-002-14, N62-002-03A, 1A000E006, etc.
const CABLE_ID_REGEX = /\b([A-Z]?\d{2,3}-\d{3}-\d{2}[A-Z]?(?:-\w+)?)\b/gi;
// Alternate: digits-dash-digits (e.g. 2935-001, 1A000E006), or dotted (A01.001.15)
const CABLE_ID_ALT_REGEX = /\b([A-Z]?\d{2,4}[.-]\d{2,4}(?:[.-]\d{2,4}[A-Z]?)?(?:[.-]\w+)?)\b/gi;

// Ethernet-only: cable is considered Ethernet only if one of these appears near the callout
const ETHERNET_HINTS = [
  'CAT5', 'CAT6', 'RJ45', 'RJ-45', 'LAN', 'ETH', 'Ethernet', 'UTP', 'FTP', 'PoE', 'CAT5e', 'CAT6a'
];

// Exclude these from being endpoint labels (power/control ratings, wire specs)
const POWER_SPEC_PATTERN = /^\d+\/\d+A$|^\d+W$|^E\d+-\d+\.\d+\/\d+-|^\d+[./]\d+A$/i;
const NOT_CABLE_SAME_SHEET_THRESHOLD = 5; // same ID on same sheet above this = symbol/component

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
 * Polyfill DOMMatrix for Node/serverless (pdf-parse/pdf.js may reference it).
 */
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      if (init && init instanceof Float32Array) {
        this.a = init[0]; this.b = init[1]; this.c = init[2]; this.d = init[3];
        this.e = init[4]; this.f = init[5];
      } else {
        this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      }
    }
    translate(x, y) { this.e += x; this.f += y; return this; }
    scale(x, y) { this.a *= x; this.d *= y || x; return this; }
    inverse() { return this; }
    multiply(other) { return this; }
    transformPoint(p) { return p ? { x: p.x || 0, y: p.y || 0 } : { x: 0, y: 0 }; }
  };
}

/**
 * Extract sheet title (system name) from page text from title block region (top or bottom).
 * Uses first 2 lines or last 2 lines, trimmed; max 80 chars.
 */
function extractSheetTitle(pageText) {
  if (!pageText || !pageText.trim()) return 'Untitled';
  const lines = pageText.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return 'Untitled';
  const fromTop = lines.slice(0, 2).join(' ').trim();
  const fromBottom = lines.slice(-2).join(' ').trim();
  const candidate = fromTop.length >= fromBottom.length ? fromTop : fromBottom;
  return candidate.slice(0, 80) || 'Untitled';
}

/**
 * Extract text from PDF buffer using pdf-parse v1 (serverless-safe; no worker).
 * Returns { pages: [{ pageNum, text, sheetTitle }], fullText }
 */
async function extractPdfText(pdfBuffer) {
  const pdf = require('pdf-parse');
  const data = await pdf(pdfBuffer);
  const fullText = data.text || '';
  const numPages = Math.max(1, data.numpages || (fullText.split(/\f+/).filter(Boolean).length) || 1);

  const pages = [];
  const rawPages = fullText.split(/\f+/);
  for (let i = 0; i < numPages; i++) {
    const text = rawPages[i] || (i === 0 ? fullText : '');
    pages.push({
      pageNum: i + 1,
      text,
      sheetTitle: extractSheetTitle(text)
    });
  }
  if (pages.length === 0) {
    pages.push({ pageNum: 1, text: fullText, sheetTitle: extractSheetTitle(fullText) });
  }
  return { pages, fullText };
}

const EXTRACTION_SOURCE = 'pdf_text';

/**
 * Find cable ID occurrences with context window.
 * Uses primary and alternate regex; tags each occurrence with fileName for multi-file safety.
 */
function findCableOccurrences(pages, fileName) {
  const occurrences = [];
  const seen = new Set();

  function addMatch(page, pageText, lines, cableIdRaw, pos) {
    const cableIdNormalized = cableIdRaw.toUpperCase().replace(/\./g, '-');
    const key = `${fileName}:${page.pageNum}:${pos}:${cableIdNormalized}`;
    if (seen.has(key)) return;
    seen.add(key);

    const lineIdx = Math.max(0, pageText.substring(0, pos).split(/\r?\n/).length - 1);
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
      cableIdRaw,
      cableIdNormalized,
      pageNum: page.pageNum,
      fileName,
      sheetTitle: page.sheetTitle || 'Untitled',
      context,
      contextLines,
      hasEthernetHint,
      media,
      lineIdx
    });
  }

  for (const page of pages) {
    const lines = page.text.split(/\r?\n/).filter(Boolean);
    const pageText = page.text;
    if (!pageText.trim()) continue;

    const re1 = new RegExp(CABLE_ID_REGEX.source, 'gi');
    let match;
    while ((match = re1.exec(pageText)) !== null) {
      addMatch(page, pageText, lines, match[1], match.index);
    }

    const re2 = new RegExp(CABLE_ID_ALT_REGEX.source, 'gi');
    while ((match = re2.exec(pageText)) !== null) {
      addMatch(page, pageText, lines, match[1], match.index);
    }
  }
  return occurrences;
}

/**
 * Score and pick best endpoint label from context.
 * Returns structured endpoint for contract: labelRaw, labelNormalized, type, locationHint, endpointConfidence, labelScore.
 * Note: Endpoint is inferred by text proximity. Leader-line tracing (PDF vector geometry or page image + line
 * detection) would set endpointSource to 'traced' and validate connection by following the drawn line to the box.
 */
function inferEndpoint(occurrence, strictEthernet = false) {
  const { context, contextLines, hasEthernetHint } = occurrence;
  const tokens = context.split(/\s+/).filter(Boolean);
  let bestLabel = 'UNKNOWN';
  let bestScore = -1;
  const evidenceStrings = [];

  for (const token of tokens) {
    const upper = token.toUpperCase().replace(/[,;:\.]/g, '');
    if (upper.length < 2 || /^\d+$/.test(upper)) continue;
    if (POWER_SPEC_PATTERN.test(upper)) continue; // exclude power/control/spec labels

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

  let endpointConfidence = bestScore > 0 ? Math.min(1, 0.3 + bestScore * 0.2) : 0.2;
  if (hasEthernetHint) endpointConfidence = Math.min(1, endpointConfidence + 0.15);
  if (!strictEthernet && !hasEthernetHint) endpointConfidence *= 0.9;
  if (bestLabel === 'UNKNOWN') endpointConfidence = 0.1;

  if (bestLabel !== 'UNKNOWN') {
    evidenceStrings.push(bestLabel);
  }

  const labelRaw = bestLabel;
  const labelNormalized = bestLabel.toUpperCase();
  const type = bestLabel === 'UNKNOWN' ? 'unknown' : 'device';
  const locationHint = (contextLines && contextLines[0]) ? String(contextLines[0]).slice(0, 80) : '';

  return {
    labelRaw,
    labelNormalized,
    type,
    locationHint,
    endpointConfidence,
    labelScore: bestScore,
    evidenceStrings
  };
}

function toPageRef(occ) {
  return { fileName: occ.fileName, page: occ.pageNum };
}

function toSheetRef(occ) {
  return { fileName: occ.fileName, page: occ.pageNum, sheetTitle: occ.sheetTitle || 'Untitled' };
}

function toOccurrenceContract(occ, ep) {
  return {
    fileName: occ.fileName,
    page: occ.pageNum,
    sheetTitle: occ.sheetTitle || 'Untitled',
    foundCableIdText: occ.cableIdRaw,
    endpointLabelPicked: ep.labelRaw,
    labelScore: ep.labelScore,
    ethernetHintFound: occ.hasEthernetHint,
    extractionSource: EXTRACTION_SOURCE,
    endpointSource: 'proximity' // leader-line tracing would set 'traced' when implemented
  };
}

function toEvidenceItem(text, fileName, page, role) {
  return { text: String(text).slice(0, 200), fileName, page, role, extractionSource: EXTRACTION_SOURCE };
}

function buildEvidenceFromOccurrences(occA, occB, epA, epB, cableIdRaw) {
  const out = [];
  out.push(toEvidenceItem(cableIdRaw, occA.fileName, occA.pageNum, 'cable_id'));
  out.push(toEvidenceItem(epA.labelRaw, occA.fileName, occA.pageNum, 'from_label'));
  out.push(toEvidenceItem(epB.labelRaw, occB.fileName, occB.pageNum, 'to_label'));
  if (occA.hasEthernetHint || occB.hasEthernetHint) {
    const o = occA.hasEthernetHint ? occA : occB;
    out.push(toEvidenceItem('Ethernet hint in context', o.fileName, o.pageNum, 'ethernet_hint'));
  }
  return out;
}

function inferEdgeTag(fromLabel, toLabel) {
  const fromNorm = fromLabel.toUpperCase();
  const toNorm = toLabel.toUpperCase();
  if (fromNorm === 'UNKNOWN' || toNorm === 'UNKNOWN') return 'unknown';
  if (fromNorm === toNorm) return 'internal';
  return 'system_level';
}

/**
 * Group by cable_id, pair or mark for review.
 * Builds contract: edges with from/to objects, pageRefs, sheetRefs, occurrences, evidence.
 * Ethernet-only: when strictEthernet, only occurrences with hasEthernetHint are considered.
 * Not-a-cable: same ID appearing many times on same sheet = symbol/component, no edges.
 */
function pairConnections(occurrences, strictEthernet, minConfidence = 0) {
  const withEndpoints = occurrences.map(o => ({
    ...o,
    ep: inferEndpoint(o, strictEthernet)
  }));

  const byCable = {};
  for (const occ of withEndpoints) {
    const id = occ.cableIdNormalized;
    if (!byCable[id]) byCable[id] = [];
    byCable[id].push(occ);
  }

  const edges = [];
  const review = [];

  for (const [cableIdNorm, list] of Object.entries(byCable)) {
    let listToUse = list;
    if (strictEthernet) {
      listToUse = list.filter((o) => o.hasEthernetHint);
      if (listToUse.length === 0) continue; // no Ethernet hint, skip
    }

    const perSheetCount = {};
    for (const o of listToUse) {
      const key = `${o.fileName}:${o.pageNum}:${o.sheetTitle || 'Untitled'}`;
      perSheetCount[key] = (perSheetCount[key] || 0) + 1;
    }
    const maxSameSheet = Math.max(...Object.values(perSheetCount), 0);
    if (maxSameSheet > NOT_CABLE_SAME_SHEET_THRESHOLD) {
      review.push({
        type: 'symbol_or_component',
        cableIdRaw: (listToUse[0] && listToUse[0].cableIdRaw) || cableIdNorm,
        cableIdNormalized: cableIdNorm,
        media: (listToUse[0] && listToUse[0].media) || 'Unknown',
        confidence: 0,
        pageRefs: listToUse.map(toPageRef),
        sheetRefs: listToUse.map(toSheetRef),
        occurrences: listToUse.map((o) => toOccurrenceContract(o, o.ep)),
        evidence: [],
        reason: `Same ID appears ${maxSameSheet} times on one sheet; treated as symbol/component.`
      });
      continue;
    }

    const sorted = [...listToUse].sort((a, b) => b.ep.endpointConfidence - a.ep.endpointConfidence);
    const cableIdRaw = (listToUse[0] && listToUse[0].cableIdRaw) || cableIdNorm;

    if (listToUse.length === 1) {
      const o = sorted[0];
      const type = o.ep.labelRaw === 'UNKNOWN' ? 'unknown_endpoint' : 'unpaired';
      const pageRefs = [toPageRef(o)];
      const sheetRefs = [toSheetRef(o)];
      const occsContract = [toOccurrenceContract(o, o.ep)];
      const evidence = [
        toEvidenceItem(o.cableIdRaw, o.fileName, o.pageNum, 'cable_id'),
        toEvidenceItem(o.ep.labelRaw, o.fileName, o.pageNum, o.ep.labelRaw === 'UNKNOWN' ? 'unknown_endpoint' : 'from_label')
      ];
      if (o.hasEthernetHint) evidence.push(toEvidenceItem('Ethernet hint', o.fileName, o.pageNum, 'ethernet_hint'));

      review.push({
        type,
        cableIdRaw,
        cableIdNormalized: cableIdNorm,
        media: o.media,
        confidence: o.ep.endpointConfidence,
        pageRefs,
        sheetRefs,
        occurrences: occsContract,
        evidence
      });
    } else if (listToUse.length === 2) {
      const a = sorted[0];
      const b = sorted[1];
      const edgeConf = Math.min(a.ep.endpointConfidence, b.ep.endpointConfidence);
      if (minConfidence > 0 && edgeConf < minConfidence) {
        review.push({
          type: 'unknown_endpoint',
          cableIdRaw,
          cableIdNormalized: cableIdNorm,
          media: a.media || b.media,
          confidence: edgeConf,
          pageRefs: [toPageRef(a), toPageRef(b)],
          sheetRefs: [toSheetRef(a), toSheetRef(b)],
          occurrences: [toOccurrenceContract(a, a.ep), toOccurrenceContract(b, b.ep)],
          evidence: buildEvidenceFromOccurrences(a, b, a.ep, b.ep, cableIdRaw)
        });
        continue;
      }
      const tag = inferEdgeTag(a.ep.labelRaw, b.ep.labelRaw);
      const pageRefs = [toPageRef(a), toPageRef(b)];
      const sheetRefs = [toSheetRef(a), toSheetRef(b)];
      edges.push({
        cableIdRaw,
        cableIdNormalized: cableIdNorm,
        media: a.media || b.media,
        tag,
        confidence: edgeConf,
        direction: 'undirected',
        from: {
          labelRaw: a.ep.labelRaw,
          labelNormalized: a.ep.labelNormalized,
          type: a.ep.type,
          locationHint: a.ep.locationHint,
          endpointConfidence: a.ep.endpointConfidence
        },
        to: {
          labelRaw: b.ep.labelRaw,
          labelNormalized: b.ep.labelNormalized,
          type: b.ep.type,
          locationHint: b.ep.locationHint,
          endpointConfidence: b.ep.endpointConfidence
        },
        pageRefs,
        sheetRefs,
        occurrences: [toOccurrenceContract(a, a.ep), toOccurrenceContract(b, b.ep)],
        evidence: buildEvidenceFromOccurrences(a, b, a.ep, b.ep, cableIdRaw)
      });
    } else {
      const top2 = sorted.slice(0, 2);
      const rest = sorted.slice(2);
      const scoreGap = top2[0].ep.endpointConfidence - (top2[1]?.ep.endpointConfidence ?? 0);

      if (scoreGap >= 0.3) {
        const a = top2[0];
        const b = top2[1];
        const edgeConf = Math.min(a.ep.endpointConfidence, b.ep.endpointConfidence);
        if (minConfidence > 0 && edgeConf < minConfidence) {
          review.push({
            type: 'ambiguous',
            cableIdRaw,
            cableIdNormalized: cableIdNorm,
            media: a.media || b.media,
            confidence: edgeConf,
            pageRefs: listToUse.map(toPageRef),
            sheetRefs: listToUse.map(toSheetRef),
            occurrences: listToUse.map((o) => toOccurrenceContract(o, o.ep)),
            evidence: buildEvidenceFromOccurrences(a, b, a.ep, b.ep, cableIdRaw),
            candidates: [{ fromLabel: a.ep.labelRaw, toLabel: b.ep.labelRaw, confidence: edgeConf, reason: 'top pair by score' }]
          });
        } else {
          const tag = inferEdgeTag(a.ep.labelRaw, b.ep.labelRaw);
          edges.push({
            cableIdRaw,
            cableIdNormalized: cableIdNorm,
            media: a.media || b.media,
            tag,
            confidence: edgeConf,
            direction: 'undirected',
            from: {
              labelRaw: a.ep.labelRaw,
              labelNormalized: a.ep.labelNormalized,
              type: a.ep.type,
              locationHint: a.ep.locationHint,
              endpointConfidence: a.ep.endpointConfidence
            },
            to: {
              labelRaw: b.ep.labelRaw,
              labelNormalized: b.ep.labelNormalized,
              type: b.ep.type,
              locationHint: b.ep.locationHint,
              endpointConfidence: b.ep.endpointConfidence
            },
            pageRefs: listToUse.map(toPageRef),
            sheetRefs: listToUse.map(toSheetRef),
            occurrences: [toOccurrenceContract(a, a.ep), toOccurrenceContract(b, b.ep)],
            evidence: buildEvidenceFromOccurrences(a, b, a.ep, b.ep, cableIdRaw)
          });
        }
        for (const r of rest) {
          review.push({
            type: 'extra',
            cableIdRaw,
            cableIdNormalized: cableIdNorm,
            media: r.media,
            confidence: r.ep.endpointConfidence,
            pageRefs: [toPageRef(r)],
            sheetRefs: [toSheetRef(r)],
            occurrences: [toOccurrenceContract(r, r.ep)],
            evidence: [
              toEvidenceItem(r.cableIdRaw, r.fileName, r.pageNum, 'cable_id'),
              toEvidenceItem(r.ep.labelRaw, r.fileName, r.pageNum, 'to_label')
            ],
            candidates: [{ fromLabel: top2[0].ep.labelRaw, toLabel: r.ep.labelRaw, confidence: r.ep.endpointConfidence, reason: 'extra occurrence' }]
          });
        }
      } else {
        const allPageRefs = listToUse.map(toPageRef);
        const allSheetRefs = listToUse.map(toSheetRef);
        const allOccs = listToUse.map((o) => toOccurrenceContract(o, o.ep));
        const candidates = sorted.slice(0, 4).map((o, i) => ({
          fromLabel: i === 0 ? o.ep.labelRaw : sorted[0].ep.labelRaw,
          toLabel: o.ep.labelRaw,
          confidence: o.ep.endpointConfidence,
          reason: 'ambiguous multiple occurrences'
        }));
        review.push({
          type: 'ambiguous',
          cableIdRaw,
          cableIdNormalized: cableIdNorm,
          media: (listToUse[0] && listToUse[0].media) || 'Unknown',
          confidence: sorted[0]?.ep?.endpointConfidence ?? 0,
          pageRefs: allPageRefs,
          sheetRefs: allSheetRefs,
          occurrences: allOccs,
          evidence: listToUse.length > 0
            ? [
                toEvidenceItem(cableIdRaw, listToUse[0].fileName, listToUse[0].pageNum, 'cable_id'),
                ...listToUse.slice(0, 2).flatMap((o) => [
                  toEvidenceItem(o.ep.labelRaw, o.fileName, o.pageNum, 'from_label'),
                  toEvidenceItem(o.ep.labelRaw, o.fileName, o.pageNum, 'to_label')
                ])
              ]
            : [],
          candidates
        });
      }
    }
  }

  return { edges, review };
}

/**
 * Main extraction pipeline.
 * Returns edges, review, summary, warnings, errors per contract.
 */
async function extractEthernetConnections(pdfPaths, options = {}) {
  const {
    strictEthernet = false,
    minConfidence = 0,
    systemLevelOnly = false,
    aiEnabled = false,
    fileNames = []
  } = options;

  const allOccurrences = [];
  const sheets = [];
  let totalChars = 0;
  let pagesProcessed = 0;
  const warnings = [];
  const errors = [];

  for (let i = 0; i < pdfPaths.length; i++) {
    const pdfPath = pdfPaths[i];
    const fileName = fileNames[i] || path.basename(pdfPath) || `file-${i}.pdf`;
    try {
      const buf = fs.readFileSync(pdfPath);
      const { pages, fullText } = await extractPdfText(buf);
      pagesProcessed += pages.length;
      totalChars += (fullText && fullText.length) || 0;
      pages.forEach((p) => {
        sheets.push({ fileName, page: p.pageNum, sheetTitle: p.sheetTitle || 'Untitled' });
      });
      if (!fullText || fullText.trim().length === 0) {
        warnings.push({ message: 'No text extracted; page(s) may be scanned or image-only.', fileName });
      }
      const occs = findCableOccurrences(pages, fileName);
      allOccurrences.push(...occs);
    } catch (err) {
      errors.push({ message: err.message || 'Failed to process file', fileName });
    }
  }

  const { edges, review } = pairConnections(allOccurrences, strictEthernet, minConfidence);

  const summary = {
    totalEdges: edges.length,
    totalReview: review.length,
    systemLevel: edges.filter(e => e.tag === 'system_level').length,
    internal: edges.filter(e => e.tag === 'internal').length,
    unknown: edges.filter(e => e.tag === 'unknown').length,
    pagesProcessed,
    charsExtracted: totalChars,
    cableIdsFound: allOccurrences.length,
    ai: { used: !!aiEnabled, passesRun: aiEnabled ? 0 : 0 }
  };

  const nearlyEmpty = edges.length === 0 && review.length <= 1;
  if (edges.length === 0 && review.length === 0) {
    if (totalChars === 0) {
      summary.extractionNote = 'No text was extracted from the PDFs. They may be scanned images—try OCR, or ensure the files contain selectable text.';
    } else {
      summary.extractionNote = `Extracted ${totalChars} characters from ${pagesProcessed} page(s) but no cable IDs matched. Cable IDs are expected to look like A01-001-15-NN or N61-002-14. If your diagrams use a different format, the parser may need to be updated.`;
    }
  } else if (nearlyEmpty && totalChars > 0) {
    summary.extractionNote = `Only ${review.length} cable ID(s) found with no pair; low confidence items are in review.`;
  }

  return {
    edges,
    review,
    summary,
    warnings,
    errors,
    sheets
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
