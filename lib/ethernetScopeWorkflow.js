/**
 * Scope-first Ethernet extraction workflow.
 * PageCode-driven mapping, confidence thresholding, boundary/internal classification,
 * aggregated edges_system, and expanded debug outputs.
 */

const path = require('path');

const UNKNOWN_SYSTEM = 'unknown_system';
const DEFAULT_MIN_SYSTEM_MAP_CONFIDENCE = 0.75;

// PageCode pattern: A01-001, N61-001, 61-001, 39-001, EF70100, etc.
const PAGE_CODE_REGEX = /\b([A-Z]?\d{2,3}-\d{2,4}(?:-\d{2})?)\b/gi;
const PAGE_CODE_STRICT = /^([AN]\d{2}-\d{3})$/i;

// Scope classification keywords
const NETWORK_KEYWORDS = [
  'SYSTEM',
  'NETWORK',
  'MANAGEMENT',
  'CCTV',
  'VDR',
  'ECDIS',
  'RADAR',
  'RADIO',
  'INMARSAT',
  'VSAT',
  'AIS',
  'GPS',
  'TELEPHONE',
  'P.A',
  'PA SYSTEM',
  'SMART SHIP'
];

const MECH_POWER_KEYWORDS = [
  'PUMP',
  'HEATER',
  'COMPRESSOR',
  'TRANSFORMER',
  'SWITCHBOARD',
  'FILTER',
  'BOILER',
  'GENERATOR',
  'VALVE'
];

// Boundary: must match whitelist or strong evidence to be boundary_device
const BOUNDARY_WHITELIST = [
  'RACK',
  'MAIN RACK',
  'SWITCH',
  'SW',
  'HUB',
  'FW',
  'FIREWALL',
  'SERVER',
  'ROUTER',
  'CONSOLE',
  'EXCHANGER',
  'VDR',
  'ECDIS',
  'RADAR',
  'VSAT',
  'VSAT RACK',
  'SMS RACK',
  'ROUTER',
  'NVR',
  'PLC'
];

// Internal: any match forces internal_component even with ethernet hints
const INTERNAL_BLACKLIST = [
  'PANEL',
  'J.B',
  'JUNCTION BOX',
  'TERMINAL',
  'TERMINAL STRIP',
  'UPS',
  'PRINTER',
  'CAMERA',
  'LAMP',
  'AC220V',
  'I/O',
  'IO MODULE',
  'MIMIC',
  'DISPLAY',
  'CONDUCTOR',
  'RATING',
  'SPEC',
  'WIRE',
  'CABLE SPEC',
  '63/16A',
  '25W',
  'E3-0.6',
  'ABBREVIATION',
  'LEGEND',
  'REVISION'
];

const POWER_SPEC_PATTERN = /^\d+\/\d+A$|^\d+W$|^E\d+-\d+\.\d+\/\d+-|^\d+[./]\d+A$/i;

// Media types that indicate Ethernet; only these edges contribute to edges_system.
const ETHERNET_MEDIA = ['CAT5', 'CAT5e', 'CAT6', 'CAT6a', 'RJ45', 'RJ-45', 'LAN', 'UTP', 'FTP', 'PoE', 'Ethernet'];
function isEthernetEdge(edge) {
  const media = (edge.media || 'Unknown').toString().toUpperCase();
  if (media === 'UNKNOWN') {
    const occs = edge.occurrences || [];
    return occs.some((o) => o.ethernetHintFound === true);
  }
  return ETHERNET_MEDIA.some((m) => media.includes(m.toUpperCase()));
}

// Pages that are clearly not system diagrams → out_of_scope when no code/title match
const OUT_OF_SCOPE_TITLE_HINTS = /^(COVER|TITLE|INDEX|LIST OF|LEGEND|ABBREVIATION|CONTENTS|REVISION\s*HISTORY)$/i;

/**
 * Extract pageCode from title/header text (e.g. A01-001, N61-001).
 */
function extractPageCodeFromText(titleOrHeader) {
  if (!titleOrHeader || !String(titleOrHeader).trim()) return null;
  const s = String(titleOrHeader).trim();
  // Prefer strict form first
  const strictMatch = s.match(PAGE_CODE_STRICT);
  if (strictMatch) return strictMatch[1].toUpperCase();
  const match = s.match(PAGE_CODE_REGEX);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Parse a CSV string of systems in scope.
 * Expected columns: system_name [, vendor] [, tags/keywords]
 * Optional 4th column: code_patterns (semicolon-separated regex patterns, e.g. ^A01;^A01-)
 */
function parseScopeCsv(csvText) {
  if (!csvText || !String(csvText).trim()) return [];
  const lines = String(csvText).trim().split(/\r?\n/).filter(Boolean);
  const rows = [];
  const header = lines[0].toLowerCase();
  const hasHeader = /system|name|vendor|tag|code/.test(header);

  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = [];
    let cur = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if ((c === ',' && !inQuotes) || (c === '\t' && !inQuotes)) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    parts.push(cur.trim());
    const system_name = (parts[0] || '').trim();
    if (!system_name) continue;
    rows.push({
      system_name,
      vendor: (parts[1] || '').trim() || undefined,
      tags: (parts[2] || '').trim() || undefined,
      code_patterns: (parts[3] || '').trim() || undefined
    });
  }
  return rows;
}

/**
 * Fallback shipyard code prefix → system when no drawing list is available.
 * N50/50 = VOIP/automatic telephone (not BMS). N61/61 = SMS/computer network. N62/62 = CCTV. N39/39 = V-SAT.
 */
const KNOWN_CODE_PREFIXES = {
  'A01': 'IAS',
  'A03': 'MAIN ENGINE',
  'N39': 'V-SAT SYSTEM',
  '39': 'V-SAT SYSTEM',
  'N50': 'AUTOMATIC TELEPHONE / VOIP TELEPHONE SYSTEM',
  '50': 'AUTOMATIC TELEPHONE / VOIP TELEPHONE SYSTEM',
  'N61': 'COMPUTER NETWORK SYSTEM / SMS',
  '61': 'COMPUTER NETWORK SYSTEM / SMS',
  'N62': 'CCTV SYSTEM',
  '62': 'CCTV SYSTEM',
  'EF70100': 'IAS',
  'EF30100': 'NAUTICAL'
};

/**
 * Extract acronym from parentheses, e.g. "CLOSED CIRCUIT TELEVISION (CCTV)" -> "CCTV".
 */
function extractAcronymFromName(rawName) {
  if (!rawName || !String(rawName).trim()) return null;
  const m = String(rawName).match(/\(([A-Z0-9]{2,10})\)/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Normalize a raw system name from scope:
 * - trim, uppercase
 * - drop parentheses content (but extract acronym first for aliases)
 * - normalize '&' spacing
 * - collapse multiple spaces
 */
function normalizeSystemName(name) {
  if (!name) return '';
  let s = String(name).trim();
  if (!s) return '';
  s = s.replace(/\([^)]*\)/g, ' '); // remove parenthetical details
  s = s.replace(/&/g, ' & ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.toUpperCase();
}

/**
 * Get prefix from pageCode for lookup: "N50-001" -> "N50", "62-003" -> "62".
 */
function getPrefixFromPageCode(code) {
  if (!code || !String(code).trim()) return null;
  const s = String(code).trim().toUpperCase();
  const m = s.match(/^([AN]?\d{2})-/);
  return m ? m[1] : null;
}

function inferScopeSystemTag(normName) {
  const upper = normName;
  const hasAny = (list) => list.some((kw) => upper.includes(kw));
  let systemTag = 'unknown';
  let likelyNetworked = false;

  if (hasAny(NETWORK_KEYWORDS)) {
    systemTag = 'network';
    likelyNetworked = true;
  } else if (hasAny(MECH_POWER_KEYWORDS)) {
    systemTag = 'mechanical';
    likelyNetworked = false;
  } else if (upper.includes('SYSTEM') || upper.includes('CONTROL') || upper.includes('MONITORING')) {
    systemTag = 'network';
    likelyNetworked = true;
  } else {
    systemTag = 'unknown';
    likelyNetworked = false;
  }

  return { systemTag, likelyNetworked };
}

/**
 * Build a structured scope model from parsed CSV rows (deduplicated by normalized name).
 * Each item: { system_name, baseName, acronym, vendor, tags, code_patterns, systemTag, likelyNetworked }.
 * Acronym from parentheses (e.g. "(CCTV)") is stored for aliases and display.
 */
function buildScopeModel(scopeRows) {
  const byBase = new Map();
  for (const row of scopeRows || []) {
    const rawName = (row.system_name || '').trim();
    if (!rawName) continue;
    const baseName = normalizeSystemName(rawName);
    if (!baseName) continue;
    const acronym = extractAcronymFromName(rawName);
    const { systemTag, likelyNetworked } = inferScopeSystemTag(baseName);

    const existing = byBase.get(baseName);
    if (!existing) {
      byBase.set(baseName, {
        system_name: rawName,
        baseName,
        acronym: acronym || undefined,
        vendor: row.vendor,
        tags: row.tags,
        code_patterns: row.code_patterns,
        systemTag,
        likelyNetworked
      });
    } else {
      // Merge: prefer first name but OR the flags and merge tags/code patterns.
      existing.vendor = existing.vendor || row.vendor;
      if (row.tags) {
        existing.tags = existing.tags ? `${existing.tags};${row.tags}` : row.tags;
      }
      if (row.code_patterns) {
        existing.code_patterns = existing.code_patterns
          ? `${existing.code_patterns};${row.code_patterns}`
          : row.code_patterns;
      }
      if (likelyNetworked) existing.likelyNetworked = true;
      if (existing.systemTag === 'unknown' && systemTag !== 'unknown') {
        existing.systemTag = systemTag;
      }
      if (acronym && !existing.acronym) existing.acronym = acronym;
    }
  }
  return Array.from(byBase.values());
}

/**
 * Build system dictionary with codePatterns (regex list), strong/weak keywords.
 * Input is a scopeModel from buildScopeModel().
 */
function buildSystemDictionary(scopeModel) {
  const knownAbbrevs = {
    'integrated automation system': 'IAS',
    'ias': 'IAS',
    'ballast management system': 'BMS',
    'bridge management system': 'BMS',
    'bms': 'BMS',
    'voyage data recorder': 'VDR',
    'vdr': 'VDR',
    'shipboard management system': 'SMS',
    'sms': 'SMS',
    'main engine': 'MAIN ENGINE',
    'vsat': 'VSAT',
    'v-sat system': 'V-SAT SYSTEM',
    'cctv': 'CCTV',
    'cctv system': 'CCTV SYSTEM',
    'closed circuit television': 'CCTV SYSTEM',
    'ecdis': 'ECDIS',
    'radar': 'RADAR',
    'gmdss': 'GMDSS',
    'network': 'NETWORK',
    'computer network system / sms': 'COMPUTER NETWORK SYSTEM / SMS',
    'automatic telephone / voip telephone system': 'AUTOMATIC TELEPHONE / VOIP TELEPHONE SYSTEM',
    'voip telephone system': 'AUTOMATIC TELEPHONE / VOIP TELEPHONE SYSTEM',
    'automatic telephone': 'AUTOMATIC TELEPHONE / VOIP TELEPHONE SYSTEM'
  };

  return scopeModel.map((row) => {
    const name = (row.baseName || row.system_name || '').trim();
    const upper = name.toUpperCase();
    const lower = name.toLowerCase();
    const canonicalName = knownAbbrevs[lower] || upper;
    const aliases = [upper, name];
    if (canonicalName !== upper) aliases.push(canonicalName);
    if (row.acronym) aliases.push(row.acronym);
    const words = name.split(/\s+/).filter(Boolean);
    const strongKeywords = [upper, ...words.map((w) => w.toUpperCase())];
    if (row.tags) {
      row.tags.split(/[,;]/).forEach((t) => strongKeywords.push(t.trim().toUpperCase()));
    }
    const weakKeywords = row.vendor ? [row.vendor.toUpperCase()] : [];

    let codePatterns = [];
    if (row.code_patterns) {
      codePatterns = row.code_patterns.split(/[;]/).map((p) => p.trim()).filter(Boolean);
    }
    for (const [prefix, sys] of Object.entries(KNOWN_CODE_PREFIXES)) {
      if (sys === canonicalName && !codePatterns.some((p) => p.includes(prefix))) {
        codePatterns.push(`^${prefix}(-|$)`);
      }
    }

    return {
      canonicalName,
      aliases: [...new Set(aliases)],
      strongKeywords: [...new Set(strongKeywords)].filter(Boolean),
      weakKeywords,
      negativeKeywords: [],
      codePatterns: codePatterns.length ? codePatterns : [],
      systemTag: row.systemTag || 'unknown',
      likelyNetworked: !!row.likelyNetworked
    };
  });
}

/**
 * Map a page to a system using: 0) generated drawing list, a) codePatterns, b) strongKeywords, c) aliases/weak, d) unknown_system.
 * generatedCodeToSystem: { prefix -> systemName } from PDF DRAWING LIST; takes priority when present.
 */
function mapPageToSystem(pageTitle, pageCode, dictionary, options = {}) {
  const minConf = options.minSystemMapConfidence ?? DEFAULT_MIN_SYSTEM_MAP_CONFIDENCE;
  const generatedCodeToSystem = options.generatedCodeToSystem || {};
  const title = (pageTitle || '').trim().toUpperCase();
  let code = (pageCode || '').trim().toUpperCase();
  if (!code && title) code = extractPageCodeFromText(title) || '';

  const scoreBreakdown = { codePattern: 0, titleStrong: 0, titleWeak: 0, drawingList: 0 };
  let ruleUsed = 'unknown';
  let matchedTokens = [];
  let best = { systemId: null, confidence: 0, evidence: '', rule: 'unknown' };
  let bestByCode = null;
  let bestByTitle = null;

  if (!dictionary || dictionary.length === 0) {
    return {
      systemId: null,
      out_of_scope: true,
      mappingConfidence: 0,
      ruleUsed: 'no_dictionary',
      matchedTokens: [],
      scoreBreakdown,
      evidence: 'No system dictionary'
    };
  }

  if (!title && !code) {
    return {
      systemId: null,
      out_of_scope: true,
      mappingConfidence: 0,
      ruleUsed: 'no_data',
      matchedTokens: [],
      scoreBreakdown,
      evidence: 'No title or code'
    };
  }

  // 0) Generated mapping from PDF drawing list (highest confidence)
  const prefix = getPrefixFromPageCode(code);
  if (prefix && Object.keys(generatedCodeToSystem).length > 0) {
    const systemNameFromDrawingList = generatedCodeToSystem[prefix];
    if (systemNameFromDrawingList) {
      const drawingNorm = String(systemNameFromDrawingList).toUpperCase().trim();
      for (const sys of dictionary) {
        const canon = (sys.canonicalName || '').toUpperCase();
        const aliasMatch = (sys.aliases || []).some((a) => String(a).toUpperCase() === drawingNorm || String(a).toUpperCase().includes(drawingNorm) || drawingNorm.includes(String(a).toUpperCase()));
        const canonMatch = canon === drawingNorm || canon.includes(drawingNorm) || drawingNorm.includes(canon);
        const strongMatch = (sys.strongKeywords || []).some((k) => drawingNorm.includes(String(k).toUpperCase()) || String(k).toUpperCase().includes(drawingNorm));
        if (canonMatch || aliasMatch || strongMatch) {
          const conf = 0.98;
          if (conf > best.confidence) {
            best = { systemId: sys.canonicalName, confidence: conf, evidence: `Drawing list: "${systemNameFromDrawingList}" → ${sys.canonicalName}`, rule: 'drawingList' };
            ruleUsed = 'drawingList';
            scoreBreakdown.drawingList = conf;
            matchedTokens = [prefix, systemNameFromDrawingList];
            bestByCode = { systemId: sys.canonicalName, confidence: conf };
          }
          break;
        }
      }
    }
  }

  // a) codePatterns match (high confidence) – skip if already matched by drawing list
  if (best.rule !== 'drawingList') {
  for (const sys of dictionary) {
    for (const pattern of sys.codePatterns || []) {
      try {
        const re = new RegExp(pattern, 'i');
        if (code && re.test(code)) {
          const conf = 0.95;
          bestByCode = { systemId: sys.canonicalName, confidence: conf };
          if (conf > best.confidence) {
            best = { systemId: sys.canonicalName, confidence: conf, evidence: `codePattern "${pattern}" matched "${code}"`, rule: 'codePattern' };
            ruleUsed = 'codePattern';
            scoreBreakdown.codePattern = conf;
            matchedTokens = [code, pattern];
          }
        }
      } catch (_) {}
    }
  }
  }

  // b) strongKeywords in title/header
  if (best.rule !== 'codePattern' && best.rule !== 'drawingList') {
    for (const sys of dictionary) {
      for (const kw of sys.strongKeywords || []) {
        if (kw.length < 2) continue;
        if (title.includes(kw) || (code && code.includes(kw))) {
          const conf = title.includes(kw) ? 0.88 : 0.78;
          if (title.includes(kw)) bestByTitle = { systemId: sys.canonicalName, confidence: conf };
          if (conf > best.confidence) {
            best = { systemId: sys.canonicalName, confidence: conf, evidence: `strongKeyword "${kw}" in title/code`, rule: 'titleStrong' };
            ruleUsed = 'titleStrong';
            scoreBreakdown.titleStrong = Math.max(scoreBreakdown.titleStrong, conf);
            if (!matchedTokens.includes(kw)) matchedTokens.push(kw);
          }
        }
      }
    }
  }

  // c) aliases / weak keywords
  if (best.confidence < minConf) {
    for (const sys of dictionary) {
      for (const alias of sys.aliases || []) {
        if (alias.length < 2) continue;
        if (title.includes(alias) || (code && code === alias)) {
          const conf = code && code === alias ? 0.82 : 0.72;
          if (conf > best.confidence) {
            best = { systemId: sys.canonicalName, confidence: conf, evidence: `alias/weak "${alias}"`, rule: 'titleWeak' };
            ruleUsed = 'titleWeak';
            scoreBreakdown.titleWeak = Math.max(scoreBreakdown.titleWeak, conf);
            if (!matchedTokens.includes(alias)) matchedTokens.push(alias);
          }
        }
      }
      for (const kw of sys.weakKeywords || []) {
        if (kw.length < 2) continue;
        if (title.includes(kw)) {
          const conf = 0.68;
          if (conf > best.confidence) {
            best = { systemId: sys.canonicalName, confidence: conf, evidence: `weakKeyword "${kw}"`, rule: 'titleWeak' };
            ruleUsed = 'titleWeak';
            scoreBreakdown.titleWeak = Math.max(scoreBreakdown.titleWeak, conf);
            if (!matchedTokens.includes(kw)) matchedTokens.push(kw);
          }
        }
      }
    }
  }

  const belowThreshold = best.confidence > 0 && best.confidence < minConf;
  const useUnknown = belowThreshold || !best.systemId;
  const out_of_scope = !useUnknown && !best.systemId && title.match(OUT_OF_SCOPE_TITLE_HINTS);
  const codeSuggestedSystemId = bestByCode?.systemId || null;
  const titleSuggestedSystemId = bestByTitle?.systemId || null;

  return {
    systemId: useUnknown ? UNKNOWN_SYSTEM : best.systemId,
    out_of_scope: !!out_of_scope && !useUnknown,
    mappingConfidence: best.confidence || (useUnknown ? 0.3 : 0),
    ruleUsed: useUnknown ? 'unknown' : ruleUsed,
    matchedTokens,
    scoreBreakdown: { ...scoreBreakdown },
    evidence: useUnknown ? (best.evidence || 'Below threshold or no match') : best.evidence,
    codeSuggestedSystemId,
    titleSuggestedSystemId
  };
}

/**
 * Classify endpoint as boundary_device or internal_component.
 * Returns { class, confidence, matchedKeywords, reason }.
 * internalBlacklist match → always internal; boundary requires whitelist or strong evidence.
 */
function classifyEndpointBoundary(label, context) {
  const result = { class: 'internal_component', confidence: 0.5, matchedKeywords: [], reason: 'default' };
  if (!label || !String(label).trim()) {
    result.reason = 'empty_label';
    return result;
  }
  const upper = String(label).toUpperCase();
  const ctx = (context || '').toUpperCase();

  if (POWER_SPEC_PATTERN.test(upper)) {
    result.reason = 'power_spec';
    result.matchedKeywords = [upper];
    return result;
  }

  for (const kw of INTERNAL_BLACKLIST) {
    if (upper.includes(kw)) {
      result.class = 'internal_component';
      result.confidence = 0.95;
      result.matchedKeywords = [kw];
      result.reason = 'internal_blacklist';
      return result;
    }
  }

  for (const kw of BOUNDARY_WHITELIST) {
    if (upper.includes(kw)) {
      result.class = 'boundary_device';
      result.confidence = 0.9;
      result.matchedKeywords = [kw];
      result.reason = 'boundary_whitelist';
      return result;
    }
  }

  result.reason = 'no_whitelist_match';
  return result;
}

/**
 * Build simplified system topology: one record per unique (systemA, systemB).
 * Aggregate: cableIds (unique + counts), media types, merged pageRefs, top evidence.
 * No self-loops. Exclude unknown_system pages from edges_system unless allowUnknownSystemEdges.
 */
function buildSystemTopology(edges, review, pageSystemMap, options = {}) {
  const allowUnknown = options.allowUnknownSystemEdges === true;
  const pageToSystem = new Map();
  (pageSystemMap || []).forEach((m) => {
    const key = `${m.fileName}:${m.page}`;
    pageToSystem.set(key, m.systemId);
  });

  const pairToEdge = new Map();
  const edges_detail = [];

  function getSystemForPage(fileName, page) {
    return pageToSystem.get(`${fileName}:${page}`) || null;
  }

  function getEndpointClassification(ep) {
    if (!ep) return { class: 'internal_component', confidence: 0 };
    const label = typeof ep === 'object' ? (ep.labelRaw || ep.labelNormalized || '') : ep;
    return classifyEndpointBoundary(label, '');
  }

  (edges || []).forEach((e) => {
    const pageRefs = e.pageRefs || [];
    const sheetRefs = e.sheetRefs || [];
    const fromRef = pageRefs[0] || sheetRefs[0];
    const toRef = pageRefs[1] || sheetRefs[1];
    let systemA = fromRef ? getSystemForPage(fromRef.fileName, fromRef.page) : null;
    let systemB = toRef ? getSystemForPage(toRef.fileName, toRef.page) : null;

    const fromClass = getEndpointClassification(e.from);
    const toClass = getEndpointClassification(e.to);
    const fromBoundary = fromClass.class === 'boundary_device';
    const toBoundary = toClass.class === 'boundary_device';

    edges_detail.push({
      ...e,
      fromSystemId: systemA,
      toSystemId: systemB,
      fromBoundary,
      toBoundary,
      fromClassification: fromClass,
      toClassification: toClass
    });

    if (!systemA || !systemB) return;
    if (systemA === systemB) return;
    if (!fromBoundary || !toBoundary) return;
    if (systemA === UNKNOWN_SYSTEM || systemB === UNKNOWN_SYSTEM) {
      if (!allowUnknown) return;
    }
    if (!isEthernetEdge(e)) return;

    const pairKey = [systemA, systemB].sort().join('|');
    const cableId = e.cableIdNormalized || e.cableIdRaw || '';
    const media = e.media || 'Unknown';
    const pageRefsList = e.pageRefs || [];
    const evidenceList = e.evidence || [];

    if (!pairToEdge.has(pairKey)) {
      pairToEdge.set(pairKey, {
        fromSystemId: systemA,
        toSystemId: systemB,
        cableIds: [],
        cableIdCounts: {},
        mediaTypes: new Set(),
        pageRefs: [],
        evidence: [],
        confidenceSum: 0,
        count: 0
      });
    }
    const agg = pairToEdge.get(pairKey);
    if (cableId && !agg.cableIds.includes(cableId)) agg.cableIds.push(cableId);
    agg.cableIdCounts[cableId] = (agg.cableIdCounts[cableId] || 0) + 1;
    agg.mediaTypes.add(media);
    agg.pageRefs.push(...pageRefsList);
    agg.evidence.push(...(Array.isArray(evidenceList) ? evidenceList : [evidenceList]));
    agg.confidenceSum += e.confidence ?? 0.5;
    agg.count += 1;
  });

  const edges_system = [];
  const TOP_EVIDENCE = 15;
  const TOP_PAGEREFS = 20;
  for (const agg of pairToEdge.values()) {
    const pageRefsDedup = [];
    const seen = new Set();
    for (const r of agg.pageRefs) {
      const key = `${r.fileName}:${r.page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pageRefsDedup.push(r);
      if (pageRefsDedup.length >= TOP_PAGEREFS) break;
    }
    const evidenceDedup = [];
    const evSeen = new Set();
    for (const ev of agg.evidence) {
      const str = typeof ev === 'object' && ev.text != null ? ev.text : String(ev);
      if (evSeen.has(str)) continue;
      evSeen.add(str);
      evidenceDedup.push(ev);
      if (evidenceDedup.length >= TOP_EVIDENCE) break;
    }
    edges_system.push({
      fromSystemId: agg.fromSystemId,
      toSystemId: agg.toSystemId,
      cableIds: [...agg.cableIds],
      cableIdCounts: { ...agg.cableIdCounts },
      mediaTypes: [...agg.mediaTypes],
      media: [...agg.mediaTypes].join(', ') || 'Unknown',
      pageRefs: pageRefsDedup,
      evidence: evidenceDedup,
      confidence: agg.count > 0 ? agg.confidenceSum / agg.count : 0,
      edgeCount: agg.count
    });
  }

  return { edges_system, edges_detail, review: review || [] };
}

/**
 * Compute mapping_conflicts: pages where codePattern suggests one system but title suggests another.
 */
function computeMappingConflicts(page_system_map) {
  const conflicts = [];
  for (const p of page_system_map || []) {
    const codeSys = p.codeSuggestedSystemId || null;
    const titleSys = p.titleSuggestedSystemId || null;
    if (codeSys && titleSys && codeSys !== titleSys) {
      conflicts.push({
        fileName: p.fileName,
        page: p.page,
        pageTitle: p.pageTitle,
        pageCode: p.pageCode,
        codeSuggestedSystem: codeSys,
        titleSuggestedSystem: titleSys,
        mappingConfidence: p.mappingConfidence
      });
    }
  }
  return conflicts;
}

/**
 * Run full scope-first workflow with options.
 * Options: minSystemMapConfidence (0.75), allowUnknownSystemEdges (false).
 */
function runScopeFirstWorkflow(scopeList, extractionResult, pageMetas, options = {}) {
  const minConf = options.minSystemMapConfidence ?? DEFAULT_MIN_SYSTEM_MAP_CONFIDENCE;
  const generatedCodeToSystem = extractionResult.drawingListMapping || {};
  const scopeModel = buildScopeModel(scopeList);
  const dictionary = buildSystemDictionary(scopeModel);
  const systems = dictionary.map((d) => {
    const acronyms = (d.aliases || []).filter((a) => /^[A-Z0-9]{2,10}$/.test(String(a).trim()));
    const displayLabel = acronyms.length ? acronyms.sort((a, b) => String(a).length - String(b).length)[0] : (d.canonicalName || '');
    return {
      systemId: d.canonicalName,
      systemName: d.canonicalName,
      displayLabel: displayLabel || d.canonicalName,
      aliases: d.aliases,
      strongKeywords: d.strongKeywords,
      codePatterns: d.codePatterns,
      systemTag: d.systemTag,
      likelyNetworked: d.likelyNetworked
    };
  });

  const metas = (pageMetas || []).map((m) => {
    let pageCode = m.pageCode ?? null;
    if (!pageCode && (m.pageTitle || m.sheetTitle)) {
      pageCode = extractPageCodeFromText(m.pageTitle || m.sheetTitle);
    }
    return {
      fileName: m.fileName,
      page: m.page,
      pageTitle: m.pageTitle ?? m.sheetTitle ?? null,
      pageCode
    };
  });

  const mapOptions = { minSystemMapConfidence: minConf, generatedCodeToSystem };
  const page_system_map = metas.map((m) => {
    const mapping = mapPageToSystem(m.pageTitle, m.pageCode, dictionary, mapOptions);
    return {
      fileName: m.fileName,
      page: m.page,
      pageTitle: m.pageTitle,
      pageCode: m.pageCode,
      systemId: mapping.systemId,
      out_of_scope: mapping.out_of_scope,
      mappingConfidence: mapping.mappingConfidence,
      evidence: mapping.evidence,
      ruleUsed: mapping.ruleUsed,
      matchedTokens: mapping.matchedTokens || [],
      scoreBreakdown: mapping.scoreBreakdown || {},
      codeSuggestedSystemId: mapping.codeSuggestedSystemId || null,
      titleSuggestedSystemId: mapping.titleSuggestedSystemId || null
    };
  });

  const mapping_conflicts = computeMappingConflicts(page_system_map);

  const unknownPages = page_system_map.filter((p) => p.systemId === UNKNOWN_SYSTEM);
  const reviewWithUnknown = [...(extractionResult.review || [])];
  if (unknownPages.length > 0) {
    reviewWithUnknown.push({
      type: 'low_confidence_page_mapping',
      message: `${unknownPages.length} page(s) mapped to unknown_system (below confidence threshold)`,
      pages: unknownPages.map((p) => ({ fileName: p.fileName, page: p.page, pageTitle: p.pageTitle, mappingConfidence: p.mappingConfidence }))
    });
  }

  const { edges_system, edges_detail, review } = buildSystemTopology(
    extractionResult.edges,
    reviewWithUnknown,
    page_system_map,
    { allowUnknownSystemEdges: options.allowUnknownSystemEdges === true }
  );

  const summary = {
    ...(extractionResult.summary || {}),
    systemsInScope: systems.length,
    pagesMapped: page_system_map.filter((p) => p.systemId && p.systemId !== UNKNOWN_SYSTEM && !p.out_of_scope).length,
    pagesUnknown: page_system_map.filter((p) => p.systemId === UNKNOWN_SYSTEM).length,
    edges_system: edges_system.length,
    edges_detail: edges_detail.length,
    mapping_conflicts: mapping_conflicts.length
  };

  return {
    systems,
    system_dictionary: dictionary,
    page_system_map,
    mapping_conflicts: mapping_conflicts,
    edges_system,
    edges_detail,
    review,
    edges: extractionResult.edges,
    summary,
    unknown_system: UNKNOWN_SYSTEM,
    drawingListMapping: generatedCodeToSystem
  };
}

/**
 * Optional: AI refine page-to-system for low-confidence pages. Only picks from scoped system names or unknown_system.
 * Stub: returns unchanged when openai not provided.
 */
async function aiRefinePageToSystem(pagesWithUnknownOrLowConfidence, scopeSystems, openai, model) {
  if (!openai || !pagesWithUnknownOrLowConfidence?.length) return pagesWithUnknownOrLowConfidence;
  const systemNames = (scopeSystems || []).map((s) => s.systemId || s.systemName).concat(UNKNOWN_SYSTEM);
  // Stub: in a full impl, call openai with strict instructions to only return one of systemNames + confidence + evidence.
  return pagesWithUnknownOrLowConfidence;
}

/**
 * Optional: AI refine boundary classification for uncertain endpoints. Never invents new systems/endpoints.
 * Stub: returns unchanged when openai not provided.
 */
async function aiRefineBoundaryClassification(endpointsWithUncertainConfidence, openai, model) {
  if (!openai || !endpointsWithUncertainConfidence?.length) return endpointsWithUncertainConfidence;
  // Stub: in a full impl, call openai to return boundary_device | internal_component + confidence, no new labels.
  return endpointsWithUncertainConfidence;
}

module.exports = {
  UNKNOWN_SYSTEM,
  DEFAULT_MIN_SYSTEM_MAP_CONFIDENCE,
  parseScopeCsv,
  buildSystemDictionary,
  mapPageToSystem,
  extractPageCodeFromText,
  classifyEndpointBoundary,
  buildSystemTopology,
  computeMappingConflicts,
  runScopeFirstWorkflow,
  aiRefinePageToSystem,
  aiRefineBoundaryClassification,
  BOUNDARY_WHITELIST,
  INTERNAL_BLACKLIST
};
