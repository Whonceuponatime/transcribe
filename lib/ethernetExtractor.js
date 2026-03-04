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

// Words from title blocks / watermarks that must never become endpoint labels
const NOISE_ENDPOINT_WORDS = [
  'CONFIDENTIAL', 'REV', 'REVISION', 'PAGE', 'SHEET', 'HULL', 'NO', 'HULLNO',
  'OWNER', 'PROJECT', 'PREPARED', 'APPROVED', 'DRAWN', 'DESIGN', 'CHECKED',
  'TITLE', 'SCALE', 'DWG', 'DRAWING', 'ABBREVIATION', 'INDEX', 'LIST',
  'AUTO(MACH)', 'AUTOMACH'
];

// System / area keywords used for system membership hints
const SYSTEM_KEYWORDS = [
  'IAS', 'INTEGRATED AUTOMATION SYSTEM',
  'BMS', 'BALLAST MANAGEMENT SYSTEM', 'BRIDGE MANAGEMENT SYSTEM',
  'VDR', 'VOYAGE DATA RECORDER',
  'SMS', 'SHIPBOARD MANAGEMENT SYSTEM',
  'VSAT',
  'CCTV',
  'ECDIS',
  'RADAR',
  'GMDSS',
  'GPS'
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
 * Extract sheet / page title (system name) from page text from title block region (top or bottom).
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
 * Extract more detailed page meta used for system grouping.
 * Tries to detect patterns like:
 *   "HULL NO. 2729 <SYSTEM NAME> PAGE <xx-xxx>"
 */
function extractPageMeta(fileName, pageNum, pageText) {
  const meta = {
    fileName,
    page: pageNum,
    pageTitle: null,
    pageCode: null,
    pageTitleConfidence: 0,
    headerSnippet: ''
  };
  if (!pageText || !pageText.trim()) return meta;

  const lines = pageText.split(/\r?\n/);
  const headerLines = lines.slice(0, 8).filter(Boolean);
  const header = headerLines.join(' ').trim();
  meta.headerSnippet = header.slice(0, 160);

  // Pattern: HULL NO. 2729 <SYSTEM NAME> PAGE xx-xxx
  const hullMatch = header.match(/HULL\s+NO\.?\s*\d+\s+(.+?)\s+PAGE\s+([0-9A-Z\-]+)/i);
  if (hullMatch) {
    meta.pageTitle = hullMatch[1].trim();
    meta.pageCode = hullMatch[2].trim();
    meta.pageTitleConfidence = 0.9;
    return meta;
  }

  // Fallback: try to extract pageCode from header (e.g. A01-001, N61-001, N39-001)
  const codeMatch = header.match(/\b([A-Z]?\d{2,3}-\d{2,4}(?:-\d{2})?)\b/i);
  if (codeMatch) {
    meta.pageCode = codeMatch[1].trim().toUpperCase();
  }

  // Fallback: first line containing "SYSTEM"
  const systemLine = headerLines.find((ln) => /SYSTEM/i.test(ln));
  if (systemLine) {
    meta.pageTitle = systemLine.trim().slice(0, 80);
    if (!meta.pageCode) {
      const lineCode = systemLine.match(/\b([A-Z]?\d{2,3}-\d{2,4}(?:-\d{2})?)\b/i);
      if (lineCode) meta.pageCode = lineCode[1].trim().toUpperCase();
    }
    meta.pageTitleConfidence = 0.7;
    return meta;
  }

  // Fallback: generic sheet title
  const sheetTitle = extractSheetTitle(pageText);
  meta.pageTitle = sheetTitle;
  if (!meta.pageCode && sheetTitle) {
    const titleCode = sheetTitle.match(/\b([A-Z]?\d{2,3}-\d{2,4}(?:-\d{2})?)\b/i);
    if (titleCode) meta.pageCode = titleCode[1].trim().toUpperCase();
  }
  meta.pageTitleConfidence = 0.4;
  return meta;
}

/**
 * Extract text from PDF buffer using pdf-parse v1 (serverless-safe; no worker).
 * Returns { pages: [{ pageNum, text, sheetTitle, pageMeta }], fullText }
 */
async function extractPdfText(pdfBuffer, fileNameForMeta = '') {
  const pdf = require('pdf-parse');
  const data = await pdf(pdfBuffer);
  const fullText = data.text || '';
  const numPages = Math.max(1, data.numpages || (fullText.split(/\f+/).filter(Boolean).length) || 1);

  const pages = [];
  const rawPages = fullText.split(/\f+/);
  for (let i = 0; i < numPages; i++) {
    const text = rawPages[i] || (i === 0 ? fullText : '');
    const pageMeta = extractPageMeta(fileNameForMeta || '', i + 1, text);
    pages.push({
      pageNum: i + 1,
      text,
      sheetTitle: pageMeta.pageTitle || extractSheetTitle(text),
      pageMeta
    });
  }
  if (pages.length === 0) {
    const pageMeta = extractPageMeta(fileNameForMeta || '', 1, fullText);
    pages.push({
      pageNum: 1,
      text: fullText,
      sheetTitle: pageMeta.pageTitle || extractSheetTitle(fullText),
      pageMeta
    });
  }
  return { pages, fullText };
}

const EXTRACTION_SOURCE = 'pdf_text';

/**
 * Classify page type for triage and system mapping.
 * Returns one of: 'empty' | 'index' | 'spec' | 'system'.
 */
function classifyPageType(pageText, fileName) {
  if (!pageText || !pageText.trim()) {
    return { pageType: 'empty', skipReason: 'no_text' };
  }
  const upper = pageText.toUpperCase();

  // Index / list pages
  if (/INDEX|LIST OF DRAWINGS|LIST OF CABLES|CONTENTS/.test(upper)) {
    return { pageType: 'index', skipReason: 'index_or_list' };
  }

  // Specification / table-heavy pages
  if (/CABLE SPECIFICATION|SPECIFICATION|CABLE LIST|CABLE TABLE/.test(upper) &&
      !/(RJ-45|CAT5|CAT6|ETHERNET)/.test(upper)) {
    return { pageType: 'spec', skipReason: 'spec_or_table' };
  }

  // Default: treat as system sheet
  return { pageType: 'system', skipReason: null };
}

/**
 * Build system mapping based on index/list pages.
 * Example: "A01 INTEGRATED AUTOMATION SYSTEM (IAS)" or "N61 NETWORK".
 */
function buildSystemMapFromPages(pages) {
  const byPrefix = new Map();
  for (const p of pages) {
    const { pageType } = classifyPageType(p.text, p.fileName);
    if (pageType !== 'index') continue;
    const lines = p.text.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([AN]\d{2})\s+(.{5,})$/i);
      if (!m) continue;
      const prefix = m[1].toUpperCase();
      const name = m[2].trim();
      if (!byPrefix.has(prefix)) {
        byPrefix.set(prefix, {
          prefix,
          systemId: prefix,
          systemName: name
        });
      }
    }
  }
  return Array.from(byPrefix.values());
}

/**
 * Parse DRAWING LIST / INDEX pages to build prefix -> system name mapping.
 * Looks for rows like "N39-001-01  V-SAT SYSTEM", "N50-001  VOIP TELEPHONE SYSTEM", "62-003  CCTV SYSTEM".
 * Returns { prefix: systemName } e.g. { 'N39': 'V-SAT SYSTEM', 'N50': 'VOIP TELEPHONE SYSTEM', '62': 'CCTV SYSTEM' }.
 */
function parseDrawingListFromPages(pages) {
  const prefixToName = new Map();
  const drawingListPage = (p) => {
    const t = (p.text || '').toUpperCase();
    return /DRAWING\s+LIST|LIST\s+OF\s+DRAWINGS|INDEX|EF30100/.test(t);
  };

  const minNameLen = 4;

  for (const p of pages || []) {
    if (!drawingListPage(p)) continue;
    const lines = (p.text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Line format: "N39-001-01  V-SAT SYSTEM" or "N50-001  VOIP TELEPHONE SYSTEM"
      const simple = line.match(/^\s*([AN]?\d{2})-\d{3}(?:-\d{2})?\s+(.{4,})$/i);
      if (simple) {
        const prefixKey = simple[1].toUpperCase();
        const n = simple[2].trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!/^\d+$/.test(n) && !/^[AN]?\d{2}-\d/.test(n)) {
          if (!prefixToName.has(prefixKey) || n.length > (prefixToName.get(prefixKey) || '').length) {
            prefixToName.set(prefixKey, n);
          }
        }
      }
      // Inline: any "N50-001 SYSTEM NAME" or "62-003 CCTV" in the line
      const inlineRe = /\b([AN]?\d{2})-(\d{3}(?:-\d{2})?)\b\s+([A-Z0-9][A-Z0-9\s\/\-\.&()]{3,78})/gi;
      let im;
      while ((im = inlineRe.exec(line)) !== null) {
        const prefixKey = im[1].toUpperCase();
        const n = im[3].trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!/^\d+$/.test(n) && (!prefixToName.has(prefixKey) || n.length > (prefixToName.get(prefixKey) || '').length)) {
          prefixToName.set(prefixKey, n);
        }
      }
    }
  }

  return Object.fromEntries(prefixToName);
}

/**
 * Extract system/cable prefix from a normalized cable ID, e.g. A01 from A01-001-15-NN.
 */
function extractSystemPrefixFromCableId(cableIdNormalized) {
  if (!cableIdNormalized) return null;
  const m = String(cableIdNormalized).match(/^([A-Z]?\d{2,3})[-.]/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Guess endpoint type from an uppercased endpoint label.
 */
function guessEndpointType(upper) {
  if (upper.includes('RACK')) return 'rack';
  if (upper.includes('SWITCH') || /\bSW\b/.test(upper)) return 'switch';
  if (upper.includes('FW') || upper.includes('FIREWALL')) return 'firewall';
  if (upper.includes('CONSOLE')) return 'console';
  if (upper.includes('PANEL')) return 'panel';
  if (upper.includes('VDR')) return 'vdr';
  if (upper.includes('ECDIS')) return 'ecdis';
  if (upper.includes('RADAR')) return 'radar';
  if (upper.includes('VSAT')) return 'vsat';
  if (upper.includes('CCTV')) return 'cctv';
  if (upper.includes('SMS')) return 'sms';
  if (upper.includes('IAS')) return 'ias';
  return 'unknown';
}

/**
 * Collect multiple endpoint candidates from a context window instead of picking just one.
 */
function collectEndpointCandidates(contextLines) {
  const text = Array.isArray(contextLines) ? contextLines.join(' ') : String(contextLines || '');
  const tokens = text.split(/\s+/).filter(Boolean);
  const byNorm = new Map();

  for (const token of tokens) {
    const raw = token.replace(/[,;:\.]/g, '');
    const upper = raw.toUpperCase();
    if (upper.length < 2 || /^\d+$/.test(upper)) continue;
    if (POWER_SPEC_PATTERN.test(upper)) continue;
    if (NOISE_ENDPOINT_WORDS.includes(upper)) continue;

    let score = 0;
    let keywordHit = false;
    for (const kw of ENDPOINT_KEYWORDS) {
      if (upper.includes(kw)) {
        score += 2;
        keywordHit = true;
      }
    }
    if (/^(RACK|SW|PANEL|CONSOLE)[-\d\w]*$/i.test(upper)) {
      score += 1;
      keywordHit = true;
    }
    // Enforce strict whitelist: require at least one keyword.
    if (!keywordHit) continue;
    if (upper.length >= 3 && upper.length <= 30) score += 0.5;

    const existing = byNorm.get(upper);
    if (!existing || score > existing.score) {
      byNorm.set(upper, {
        label: raw,
        normalizedLabel: upper,
        score,
        snippet: text.slice(0, 160),
        typeGuess: guessEndpointType(upper)
      });
    }
  }

  return Array.from(byNorm.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

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
    if (NOISE_ENDPOINT_WORDS.includes(upper)) continue; // exclude title-block / watermark words

    let score = 0;
    let keywordHit = false;
    for (const kw of ENDPOINT_KEYWORDS) {
      if (upper.includes(kw)) {
        score += 2;
        keywordHit = true;
      }
    }
    if (/^(RACK|SW|PANEL|CONSOLE)[\-\d\w]*$/i.test(upper)) {
      score += 1;
      keywordHit = true;
    }
    // Enforce strict endpoint whitelist: must hit at least one device/system keyword
    if (!keywordHit) continue;
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

/** Normalize endpoint label to stable nodeId (match frontend). */
function normalizeNodeIdForDebug(label) {
  if (label == null || label === '') return 'UNKNOWN';
  return String(label)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/\s*\[[^\]]*\]\s*/g, '')
    .trim() || 'UNKNOWN';
}

/**
 * Group by cable_id, pair or mark for review.
 * Builds contract: edges with from/to objects, pageRefs, sheetRefs, occurrences, evidence.
 * Also builds pairingLog for debug bundle.
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
  const pairingLog = [];

  function toLogOccurrence(o) {
    return {
      fileName: o.fileName,
      page: o.pageNum,
      foundCableIdText: o.cableIdRaw,
      endpointLabelPicked: o.ep.labelRaw,
      endpointNormalized: o.ep.labelNormalized,
      endpointScore: o.ep.labelScore,
      endpointConfidence: o.ep.endpointConfidence
    };
  }

  for (const [cableIdNorm, list] of Object.entries(byCable)) {
    let listToUse = list;
    if (strictEthernet) {
      listToUse = list.filter((o) => o.hasEthernetHint);
      if (listToUse.length === 0) {
        pairingLog.push({
          cableId: list[0]?.cableIdRaw ?? cableIdNorm,
          cableIdNormalized: cableIdNorm,
          occurrenceCount: list.length,
          status: 'rejected',
          chosenPair: null,
          pairConfidence: null,
          reason: 'strictEthernet: no Ethernet hint on any occurrence',
          occurrences: list.map(toLogOccurrence)
        });
        continue;
      }
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
      pairingLog.push({
        cableId: (listToUse[0] && listToUse[0].cableIdRaw) || cableIdNorm,
        cableIdNormalized: cableIdNorm,
        occurrenceCount: listToUse.length,
        status: 'symbol_or_component',
        chosenPair: null,
        pairConfidence: null,
        reason: `Same ID appears ${maxSameSheet} times on one sheet`,
        occurrences: listToUse.map(toLogOccurrence)
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
      pairingLog.push({
        cableId: cableIdRaw,
        cableIdNormalized: cableIdNorm,
        occurrenceCount: 1,
        status: type,
        chosenPair: null,
        pairConfidence: o.ep.endpointConfidence,
        reason: 'single occurrence',
        occurrences: listToUse.map(toLogOccurrence)
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
        pairingLog.push({
          cableId: cableIdRaw,
          cableIdNormalized: cableIdNorm,
          occurrenceCount: 2,
          status: 'rejected',
          chosenPair: [{ fileName: a.fileName, page: a.pageNum }, { fileName: b.fileName, page: b.pageNum }],
          pairConfidence: edgeConf,
          reason: 'below minConfidence threshold',
          occurrences: listToUse.map(toLogOccurrence)
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
      pairingLog.push({
        cableId: cableIdRaw,
        cableIdNormalized: cableIdNorm,
        occurrenceCount: 2,
        status: 'paired',
        chosenPair: [{ fileName: a.fileName, page: a.pageNum }, { fileName: b.fileName, page: b.pageNum }],
        pairConfidence: edgeConf,
        reason: 'exactly two occurrences',
        occurrences: listToUse.map(toLogOccurrence)
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
          pairingLog.push({
            cableId: cableIdRaw,
            cableIdNormalized: cableIdNorm,
            occurrenceCount: listToUse.length,
            status: 'ambiguous',
            chosenPair: [{ fileName: a.fileName, page: a.pageNum }, { fileName: b.fileName, page: b.pageNum }],
            pairConfidence: edgeConf,
            reason: '3+ occurrences, top pair below minConfidence',
            occurrences: listToUse.map(toLogOccurrence)
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
          pairingLog.push({
            cableId: cableIdRaw,
            cableIdNormalized: cableIdNorm,
            occurrenceCount: listToUse.length,
            status: 'paired',
            chosenPair: [{ fileName: a.fileName, page: a.pageNum }, { fileName: b.fileName, page: b.pageNum }],
            pairConfidence: edgeConf,
            reason: '3+ occurrences, top pair by score gap',
            occurrences: listToUse.map(toLogOccurrence)
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
        pairingLog.push({
          cableId: cableIdRaw,
          cableIdNormalized: cableIdNorm,
          occurrenceCount: listToUse.length,
          status: 'ambiguous',
          chosenPair: null,
          pairConfidence: sorted[0]?.ep?.endpointConfidence ?? 0,
          reason: '3+ occurrences, no clear score gap',
          occurrences: listToUse.map(toLogOccurrence)
        });
      }
    }
  }

  return { edges, review, pairingLog };
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
  const pagesWithLowText = [];
  const pageMetas = [];
  const allPagesForDrawingList = [];
  let totalChars = 0;
  let pagesProcessed = 0;
  const warnings = [];
  const errors = [];

  for (let i = 0; i < pdfPaths.length; i++) {
    const pdfPath = pdfPaths[i];
    const fileName = fileNames[i] || path.basename(pdfPath) || `file-${i}.pdf`;
    try {
      const buf = fs.readFileSync(pdfPath);
      const { pages, fullText } = await extractPdfText(buf, fileName);
      pagesProcessed += pages.length;
      totalChars += (fullText && fullText.length) || 0;
      pages.forEach((p) => {
        if (p.pageMeta) pageMetas.push(p.pageMeta);
        sheets.push({
          fileName,
          page: p.pageNum,
          sheetTitle: p.pageMeta?.pageTitle || p.sheetTitle || 'Untitled',
          pageCode: p.pageMeta?.pageCode || null
        });
        allPagesForDrawingList.push({ text: p.text, fileName, page: p.pageNum });
        if ((p.text && p.text.trim().length) < 50) {
          pagesWithLowText.push({ fileName, page: p.pageNum });
        }
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

  const drawingListMapping = parseDrawingListFromPages(allPagesForDrawingList);

  const { edges, review, pairingLog } = pairConnections(allOccurrences, strictEthernet, minConfidence);

  const symbolCableIds = new Set(
    (review || []).filter((r) => r.type === 'symbol_or_component').map((r) => r.cableIdNormalized)
  );

  function getEthernetHintText(context) {
    if (!context) return '';
    const upper = context.toUpperCase();
    for (const h of ETHERNET_HINTS) {
      const re = new RegExp(h.replace(/-/g, '\\-?'), 'i');
      const m = context.match(re);
      if (m) return m[0];
    }
    return '';
  }

  const cableOccurrencesForDebug = allOccurrences.map((occ) => {
    const ep = inferEndpoint(occ, strictEthernet);
    const filteredOut =
      (strictEthernet && !occ.hasEthernetHint) || symbolCableIds.has(occ.cableIdNormalized);
    let filterReason = '';
    if (strictEthernet && !occ.hasEthernetHint) filterReason = 'no_ethernet_hint';
    else if (symbolCableIds.has(occ.cableIdNormalized)) filterReason = 'symbol_or_component';

    return {
      cableIdRaw: occ.cableIdRaw,
      cableIdNormalized: occ.cableIdNormalized,
      fileName: occ.fileName,
      page: occ.pageNum,
      position: occ.lineIdx != null ? { line: occ.lineIdx } : null,
      ethernetHintFound: occ.hasEthernetHint,
      ethernetHintText: getEthernetHintText(occ.context),
      pickedEndpointRaw: ep.labelRaw,
      pickedEndpointNormalized: ep.labelNormalized,
      endpointScore: ep.labelScore,
      filteredOut,
      filterReason: filterReason || null,
      nearbyTextSample: (occ.context && occ.context.slice(0, 300)) || ''
    };
  });

  const nodeMap = new Map();
  function addEndpoint(labelRaw, labelNormalized, type, pageRef, evidenceSnippet) {
    const nodeId = normalizeNodeIdForDebug(labelRaw);
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        nodeId,
        labelNormalized: nodeId,
        rawLabels: [],
        rawLabelCount: 0,
        occurrenceCount: 0,
        pages: [],
        topEvidenceSnippets: [],
        type: type || 'unknown'
      });
    }
    const n = nodeMap.get(nodeId);
    if (labelRaw && !n.rawLabels.includes(labelRaw)) n.rawLabels.push(labelRaw);
    n.rawLabelCount = n.rawLabels.length;
    n.occurrenceCount += 1;
    if (pageRef && !n.pages.some((p) => p.fileName === pageRef.fileName && p.page === pageRef.page)) {
      n.pages.push(pageRef);
    }
    if (evidenceSnippet && n.topEvidenceSnippets.length < 10) {
      n.topEvidenceSnippets.push(String(evidenceSnippet).slice(0, 150));
    }
  }

  (edges || []).forEach((e) => {
    if (e.from && typeof e.from === 'object') {
      addEndpoint(
        e.from.labelRaw,
        e.from.labelNormalized,
        e.from.type,
        e.pageRefs && e.pageRefs[0],
        e.from.locationHint
      );
    }
    if (e.to && typeof e.to === 'object') {
      addEndpoint(
        e.to.labelRaw,
        e.to.labelNormalized,
        e.to.type,
        e.pageRefs && e.pageRefs[1],
        e.to.locationHint
      );
    }
  });
  (review || []).filter((r) => r.type !== 'symbol_or_component').forEach((r) => {
    (r.occurrences || []).forEach((occ) => {
      const label = occ.endpointLabelPicked;
      if (label) {
        addEndpoint(
          label,
          (label || '').toUpperCase(),
          'unknown',
          { fileName: occ.fileName, page: occ.page },
          null
        );
      }
    });
  });

  const nodeDedupReport = Array.from(nodeMap.values()).map((n) => ({
    ...n,
    rawLabels: n.rawLabels.slice(0, 10),
    topEvidenceSnippets: n.topEvidenceSnippets.slice(0, 10)
  }));

  const topRepeatedLabels = [...nodeDedupReport]
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, 20)
    .map((n) => ({ label: n.nodeId, count: n.occurrenceCount }));

  const cableIdCounts = new Map();
  allOccurrences.forEach((o) => {
    const id = o.cableIdNormalized;
    cableIdCounts.set(id, (cableIdCounts.get(id) || 0) + 1);
  });
  const topRepeatedCableIds = Array.from(cableIdCounts.entries())
    .map(([id, count]) => ({ cableId: id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const rawLabelSet = new Set();
  nodeDedupReport.forEach((n) => n.rawLabels.forEach((l) => rawLabelSet.add(l)));

  const pageTitleIssues = (pageMetas || [])
    .filter((m) => !m.pageTitle || m.pageTitleConfidence < 0.6)
    .map((m) => ({
      fileName: m.fileName,
      page: m.page,
      pageTitle: m.pageTitle,
      pageCode: m.pageCode,
      headerSnippet: m.headerSnippet,
      confidence: m.pageTitleConfidence
    }));

  const summaryDebug = {
    rawTextItems: { pagesProcessed, totalChars },
    totalCableOccurrences: allOccurrences.length,
    uniqueCableIdsRaw: [...new Set(allOccurrences.map((o) => o.cableIdRaw))],
    uniqueCableIdsNormalized: [...new Set(allOccurrences.map((o) => o.cableIdNormalized))],
    pairedCableIds: (edges || []).map((e) => e.cableIdNormalized),
    ambiguousCableIds: (review || []).filter((r) => r.type === 'ambiguous').map((r) => r.cableIdNormalized),
    unpairedCableIds: (review || [])
      .filter((r) => r.type === 'unpaired' || r.type === 'unknown_endpoint')
      .map((r) => r.cableIdNormalized),
    symbolOrComponentCableIds: (review || []).filter((r) => r.type === 'symbol_or_component').map((r) => r.cableIdNormalized),
    nodeCountRaw: rawLabelSet.size,
    nodeCountDeduped: nodeDedupReport.length,
    edgeCountRaw: (edges || []).length,
    edgeCountRendered: (edges || []).length,
    topRepeatedLabels,
    topRepeatedCableIds,
    pagesWithLowText,
    pageTitleIssues
  };

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
    sheets,
    drawingListMapping: drawingListMapping || {},
    debug: {
      nodeDedupReport,
      cableOccurrencesForDebug,
      pairingLog: pairingLog || [],
      summaryDebug,
      drawingListMapping: drawingListMapping || {}
    }
  };
}

/**
 * Stage 1 – deterministic candidate extraction (no AI).
 * Builds a CandidateBundle used by the AI refiner:
 *  - systems[]: preliminary system entries with page titles and prefixes
 *  - candidates[]: one entry per cable occurrence with endpoint candidates and evidence
 *  - pageInventory[]: page triage information for debugging and tuning
 */
async function extractEthernetCandidates(pdfPaths, options = {}) {
  const { fileNames = [] } = options;

  const allPages = [];
  const filePages = [];

  // First pass: read PDFs and collect all pages for system mapping
  for (let i = 0; i < pdfPaths.length; i++) {
    const pdfPath = pdfPaths[i];
    const fileName = fileNames[i] || path.basename(pdfPath) || `file-${i}.pdf`;
    const buf = fs.readFileSync(pdfPath);
    const { pages } = await extractPdfText(buf, fileName);
    filePages.push({ fileName, pages });
    pages.forEach((p) => {
      allPages.push({
        fileName,
        page: p.pageNum,
        text: p.text,
        pageMeta: p.pageMeta
      });
    });
  }

  // Build system mapping from index/list pages
  const systemMap = buildSystemMapFromPages(allPages);

  const systemsById = new Map();
  const pageInventoryMap = new Map(); // key: fileName:page
  const candidates = [];
  let nextCandidateId = 1;

  // Helper to register a system entry
  function registerSystem(systemId, systemName, fileName, page, confidence, source) {
    if (!systemId) return;
    const key = systemId;
    if (!systemsById.has(key)) {
      systemsById.set(key, {
        systemId: key,
        systemName: systemName || key,
        fileNames: new Set(),
        pageRefs: [],
        titleConfidence: confidence ?? 0,
        source
      });
    }
    const sys = systemsById.get(key);
    sys.fileNames.add(fileName);
    if (!sys.pageRefs.some((r) => r.fileName === fileName && r.page === page)) {
      sys.pageRefs.push({ fileName, page });
    }
    if (confidence != null && confidence > sys.titleConfidence) {
      sys.titleConfidence = confidence;
    }
  }

  // Seed systems from systemMap (index-based)
  for (const entry of systemMap) {
    registerSystem(entry.systemId, entry.systemName, entry.fileName || '', entry.page || 0, 0.8, 'index');
  }

  // Second pass: classify pages, extract cable occurrences and build candidates
  for (const fp of filePages) {
    const { fileName, pages } = fp;

    // Initialize pageInventory entries
    for (const p of pages) {
      const key = `${fileName}:${p.pageNum}`;
      const { pageType, skipReason } = classifyPageType(p.text, fileName);
      const meta = p.pageMeta || {};
      pageInventoryMap.set(key, {
        fileName,
        page: p.pageNum,
        pageType,
        skipReason,
        pageTitle: meta.pageTitle || p.sheetTitle || 'Untitled',
        pageCode: meta.pageCode || null,
        ethernetKeywordHits: 0,
        uniqueCableIds: new Set(),
        ethernetCableIds: new Set(),
        duplicateTextHits: 0
      });

      // Register systems from page titles
      if (meta.pageTitle) {
        const sysId = meta.pageTitle.toUpperCase();
        registerSystem(sysId, meta.pageTitle, fileName, p.pageNum, meta.pageTitleConfidence || 0.6, 'pageTitle');
      }
    }

    // Extract cable occurrences for this file
    const occs = findCableOccurrences(pages, fileName);

    for (const occ of occs) {
      const key = `${occ.fileName}:${occ.pageNum}`;
      const inv = pageInventoryMap.get(key);
      if (!inv) continue;

      const hasEthernet = !!occ.hasEthernetHint;
      if (hasEthernet) inv.ethernetKeywordHits += 1;

      inv.uniqueCableIds.add(occ.cableIdNormalized);
      if (hasEthernet) inv.ethernetCableIds.add(occ.cableIdNormalized);

      // Only build candidates from system sheets; still record inventory for others
      if (inv.pageType !== 'system') continue;

      const endpointCandidates = collectEndpointCandidates(occ.contextLines || []);
      const systemPrefix = extractSystemPrefixFromCableId(occ.cableIdNormalized);

      let systemIdGuess = null;
      let systemNameGuess = null;
      let systemSource = null;

      // Priority a) page title
      if (inv.pageTitle && inv.pageTitle !== 'Untitled') {
        systemIdGuess = inv.pageTitle.toUpperCase();
        systemNameGuess = inv.pageTitle;
        systemSource = 'pageTitle';
      }

      // Priority b) systemMap rule based on cableId prefix
      if (!systemIdGuess && systemPrefix) {
        const mapped = systemMap.find((m) => m.prefix === systemPrefix);
        if (mapped) {
          systemIdGuess = mapped.systemId;
          systemNameGuess = mapped.systemName;
          systemSource = 'index';
        }
      }

      // Priority c) nearby system keyword scan
      if (!systemIdGuess && occ.context) {
        const upperCtx = occ.context.toUpperCase();
        for (let i = 0; i < SYSTEM_KEYWORDS.length; i++) {
          const kw = SYSTEM_KEYWORDS[i];
          if (upperCtx.includes(kw.toUpperCase())) {
            systemIdGuess = kw.toUpperCase();
            systemNameGuess = kw;
            systemSource = 'keyword';
            break;
          }
        }
      }

      // Register guessed system (if any)
      if (systemIdGuess) {
        registerSystem(systemIdGuess, systemNameGuess || systemIdGuess, occ.fileName, occ.pageNum, 0.5, systemSource || 'guess');
      }

      const candidateId = `cand-${nextCandidateId++}`;
      candidates.push({
        id: candidateId,
        cableIdRaw: occ.cableIdRaw,
        cableIdNormalized: occ.cableIdNormalized,
        fileName: occ.fileName,
        page: occ.pageNum,
        pageTitle: inv.pageTitle,
        pageCode: inv.pageCode,
        systemPrefix,
        systemIdGuess,
        systemNameGuess,
        systemSource,
        ethernetLikely: hasEthernet,
        media: occ.media,
        ethernetHints: hasEthernet ? [/* captured by debug later via context */] : [],
        endpointCandidates,
        evidenceWindow: (occ.context && occ.context.slice(0, 400)) || '',
        lineIdx: occ.lineIdx
      });
    }
  }

  const pageInventory = Array.from(pageInventoryMap.values()).map((inv) => ({
    ...inv,
    uniqueCableIds: Array.from(inv.uniqueCableIds),
    ethernetCableIds: Array.from(inv.ethernetCableIds)
  }));

  const systems = Array.from(systemsById.values()).map((s) => ({
    systemId: s.systemId,
    systemName: s.systemName,
    fileNames: Array.from(s.fileNames),
    pageRefs: s.pageRefs,
    titleConfidence: s.titleConfidence,
    source: s.source
  }));

  return {
    systems,
    systemMap,
    candidates,
    pageInventory
  };
}

module.exports = {
  extractPdfText,
  findCableOccurrences,
  inferEndpoint,
  pairConnections,
  extractEthernetConnections,
  extractEthernetCandidates,
  CABLE_ID_REGEX,
  ETHERNET_HINTS,
  ENDPOINT_KEYWORDS
};
