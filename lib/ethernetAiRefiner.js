const { ETHERNET_HINTS, ENDPOINT_KEYWORDS } = require('./ethernetExtractor');

/**
 * Stage 2 – AI refinement / critic.
 *
 * This implementation focuses on the critic/auditor role:
 *  - It examines deterministic edges and candidate evidence.
 *  - It asks the model to flag edges that look like watermarks/specs/noise.
 *  - Only edges that pass the critic are kept; others are moved into review[] with reasons.
 *
 * The heavier pairing logic (Stage 1) remains deterministic; this keeps cost predictable.
 *
 * @param {OpenAI} openai - Initialized OpenAI client
 * @param {object} candidateBundle - Output of extractEthernetCandidates(...)
 * @param {object} deterministic - Output of extractEthernetConnections(...)
 * @param {object} options - { model?: string }
 * @returns {Promise<{ systems: any[], nodes: any[], edges: any[], review: any[], summary: any }>}
 */
async function aiRefineEthernet(openai, candidateBundle, deterministic, options = {}) {
  if (!openai) {
    // Fallback: just echo deterministic output and mark AI as unused.
    return {
      systems: [],
      nodes: [],
      edges: deterministic.edges || [],
      review: deterministic.review || [],
      summary: {
        ...(deterministic.summary || {}),
        ai: { used: false, passesRun: 0 }
      }
    };
  }

  const model =
    options.model ||
    process.env.ETHERNET_MODEL ||
    process.env.REWRITE_MODEL ||
    'gpt-5.2-2025-12-11';

  const edges = deterministic.edges || [];
  const review = Array.isArray(deterministic.review) ? [...deterministic.review] : [];

  if (!edges.length) {
    return {
      systems: [],
      nodes: [],
      edges,
      review,
      summary: {
        ...(deterministic.summary || {}),
        ai: { used: false, passesRun: 0 }
      }
    };
  }

  // Build a compact critic payload – we only send what the model needs to spot bad edges.
  const criticEdges = edges.slice(0, 500).map((e, index) => {
    const fromLabel =
      e.from && typeof e.from === 'object'
        ? e.from.labelRaw || e.from.labelNormalized
        : e.from;
    const toLabel =
      e.to && typeof e.to === 'object'
        ? e.to.labelRaw || e.to.labelNormalized
        : e.to;
    const snippets = Array.isArray(e.evidence)
      ? e.evidence
          .slice(0, 3)
          .map((ev) =>
            typeof ev === 'object' && ev.text != null
              ? `${ev.fileName || ''} p.${ev.page ?? ''}: ${ev.text}`
              : String(ev)
          )
      : [];
    return {
      index,
      cableId: e.cableIdNormalized || e.cableIdRaw || e.cableId,
      fromLabel: fromLabel || '',
      toLabel: toLabel || '',
      media: e.media || '',
      tag: e.tag || 'unknown',
      confidence: e.confidence ?? 0,
      evidence: snippets
    };
  });

  const systemNames = (candidateBundle.systems || []).map((s) => s.systemName);

  const systemPrompt = `
You are an auditor for an Ethernet connection extractor on shipyard cable diagrams.

You are given:
- A list of deterministic edges (cable connections) with endpoint labels, media, and short evidence snippets.
- A list of known Ethernet hints: ${ETHERNET_HINTS.join(', ')}.
- A sense of system names: ${systemNames.join(', ') || '(none)'}.

Your job:
- APPROVE only edges that look like real device-to-device Ethernet connections.
- REJECT edges when:
  - An endpoint label looks like a watermark or title-block term (CONFIDENTIAL, REV, PAGE, OWNER, PROJECT, HULL, etc.).
  - An endpoint is clearly a power/spec/rating (e.g. AC220V, E3-0.6/1-, 63/16A, 25W, conductor sizes).
  - The cableId or endpoints look like repeated symbol/component codes rather than unique cables.
  - There is no clear Ethernet context (no RJ-45/CAT5/CAT6/LAN/ETHERNET/UTP/FTP/PoE nearby in the evidence).

Output STRICT JSON only in this format:
{
  "approvedEdges": [
    { "index": number, "reason": string }
  ],
  "rejectedEdges": [
    { "index": number, "reason": string }
  ]
}

Do not invent new edges or endpoints. Only classify the provided edges. Be conservative: when unsure, REJECT and explain why.`;

  let criticResult;
  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify({
            edges: criticEdges
          })
        }
      ],
      max_completion_tokens: 1024,
      temperature: 0
    });

    const raw = (completion.choices[0]?.message?.content || '').trim();
    criticResult = JSON.parse(raw);
  } catch (err) {
    console.warn('Ethernet AI critic failed, falling back to deterministic edges:', err.message);
    return {
      systems: [],
      nodes: [],
      edges,
      review,
      summary: {
        ...(deterministic.summary || {}),
        ai: { used: false, passesRun: 0 }
      }
    };
  }

  const approvedSet = new Set(
    Array.isArray(criticResult.approvedEdges)
      ? criticResult.approvedEdges.map((e) => e.index).filter((i) => typeof i === 'number')
      : []
  );
  const rejectedEntries = Array.isArray(criticResult.rejectedEdges)
    ? criticResult.rejectedEdges
    : [];

  const refinedEdges = edges.filter((_, idx) => approvedSet.has(idx));

  // Push rejected edges into review with reasons so the UI can show them.
  for (const rej of rejectedEntries) {
    if (typeof rej.index !== 'number' || rej.index < 0 || rej.index >= edges.length) continue;
    const e = edges[rej.index];
    const cableId = e.cableIdNormalized || e.cableIdRaw || e.cableId;
    review.push({
      type: 'rejected',
      cableIdRaw: e.cableIdRaw,
      cableIdNormalized: e.cableIdNormalized,
      media: e.media,
      confidence: e.confidence ?? 0,
      pageRefs: e.pageRefs || [],
      sheetRefs: e.sheetRefs || [],
      occurrences: e.occurrences || [],
      evidence: e.evidence || [],
      reason: rej.reason || 'Rejected by AI critic'
    });
  }

  const summary = {
    ...(deterministic.summary || {}),
    totalEdges: refinedEdges.length,
    totalReview: review.length,
    ai: { used: true, passesRun: 1 }
  };

  // Nodes/systems are still derived deterministically for now; AI only audits edges.
  return {
    systems: candidateBundle.systems || [],
    nodes: [],
    edges: refinedEdges,
    review,
    summary
  };
}

module.exports = {
  aiRefineEthernet
};

