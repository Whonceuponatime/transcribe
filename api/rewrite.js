const { OpenAI } = require('openai');

const REWRITE_GLOBAL_INSTRUCTIONS = `You are a professional bilingual rewriting assistant for business emails and announcements.
Task: rewrite the user's draft to be clear, correct, and natural, while preserving the original meaning.

Important — drafts are often written like notes: points may be out of order, fragmented, or listed without flow. Your job is to:
1. Read and understand the full message (purpose, context, key points, requests, and closing).
2. Rearrange the content into a logical, easy-to-follow order (e.g. greeting → context/reason → main points → action items or next steps → closing). Add smooth transitions so the email flows; do not leave it as a disconnected list.
3. Fix grammar, word choice, and clarity while keeping every fact and intent.

Output rules (must follow):
- Output plain text only. Do not use Markdown formatting. Do not add asterisks for emphasis.
- Do not add commentary, explanations, headings, or analysis. Output only the rewritten message.
- Preserve all factual content: names, roles/titles, dates, times, numbers, part numbers, file names, URLs, email addresses, and any technical terms.
- Keep the original intent and tone. Do not introduce new claims, promises, or commitments.
- If the draft contains placeholders like [Attachment], [Name], TBD, keep them as-is.
- Vocabulary placeholder: If the draft contains <??TEXT??> (or <??...??> with any hint inside), replace it with a single suitable word or correct phrase that fits the context. TEXT may be a rough idea, a near-synonym, a wrong word, or a short description—choose the most natural, professional vocabulary for the sentence, tone, and channel. Output only the replacement word/phrase in place; do not keep the angle brackets or add explanations.
- If the draft includes a subject line, keep it as a subject line. Do not invent a subject if none is provided.

Now apply the language + channel style rules provided below.`;

const REWRITE_ENGLISH_INSTRUCTIONS = `Language: English only.
Goal: smooth business English with correct grammar, clear flow, and easy-to-understand order.

The draft may be note-like or out of order. First understand the message, then rearrange sentences and paragraphs into a logical flow (e.g. context first, then key points, then requests or next steps, then closing). Use smooth transitions so the reader can follow easily.

Style constraints:
- Keep the same level of formality the user wrote, unless "Professional" is selected.
- Avoid overly fancy vocabulary. Aim for simple, precise, and professional wording.
- Preserve any polite opening/closing style already present.

Channel formatting:
- If Channel = Email: greeting, then short paragraphs in logical order, and a clear closing line.
- If Channel = Messenger/Announcement: shorter sentences, fewer formalities, but still respectful and clear, with ideas in a sensible order.

Rewrite strength:
- Light: fix grammar and small clarity edits; still reorder if the draft is clearly out of flow.
- Standard: reorder for readability and add transitions; keep wording mostly faithful.
- Strong: reorder more proactively and smooth flow; never change meaning.`;

const REWRITE_KOREAN_INSTRUCTIONS = `Language: Korean only.
Goal: 자연스러운 비즈니스 한국어로 문장을 매끄럽게 다듬고, 읽기 쉬운 순서로 재배열하여 의미가 바뀌지 않게 유지.

원문이 메모처럼 순서가 뒤섞이거나 조각나 있을 수 있음. 먼저 전체 메시지를 이해한 뒤, 논리적 흐름(맥락 → 핵심 내용 → 요청/다음 단계 → 마무리)으로 문장과 단락을 재배열하라. 문장 사이에 자연스러운 연결을 넣어 한 편의 글로 읽히게 할 것.

Style constraints:
- 어색한 직역투/번역체 표현을 피하고, 자연스러운 업무 이메일 문장으로 정리.
- 맞춤법/띄어쓰기/조사/존댓말 높임을 일관되게 정리.
- "~드립니다/~바랍니다/~부탁드립니다" 등 공손 표현은 과하지 않게, 상황에 맞게 조절.
- 원문 정보(인명, 직함, 날짜, 숫자, 첨부물, 장비명/규격)는 절대 변경하지 말 것.

Channel formatting:
- Email: "안녕하십니까/안녕하세요" + 논리적 순서의 본문 단락 + "감사합니다" 마무리.
- Messenger/Announcement: 문장을 더 짧게, 핵심 위주로 순서 정리하되 공손함 유지.

Rewrite strength:
- Light: 맞춤법/문장 다듬기 + 흐름이 어긋나 있으면 순서만 정리
- Standard: 가독성 위해 재배열 및 연결 구절 추가
- Strong: 전달력 중심으로 더 적극적으로 재배열·다듬되 의미는 보존

Important: Markdown 금지 (별표 강조 등 사용 금지). 출력은 결과 본문만.`;

function stripMarkdownArtifacts(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^#+\s+/gm, '')
    .trim();
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
    if (!apiKey) {
      res.status(503).json({ error: 'OpenAI API key not configured. Set OPENAI_API_KEY for the rewriter.' });
      return;
    }

    const openai = new OpenAI({ apiKey });
    const body = req.body || {};
    const {
      draft = '',
      language = 'en',
      channel = 'email',
      formality = 'neutral',
      strength = 'light'
    } = body;

    const draftTrimmed = (draft && typeof draft === 'string') ? draft.trim() : '';
    if (!draftTrimmed) {
      res.status(400).json({ error: 'Draft text is required.' });
      return;
    }

    const langLabel = language === 'ko' ? 'Korean' : 'English';
    const channelLabel = channel === 'messenger' ? 'Messenger/Announcement' : 'Email';
    const inputHeader = `Mode: ${langLabel}, Channel: ${channelLabel}, Formality: ${formality}, Strength: ${strength}\n\nDraft:\n`;
    const userInput = inputHeader + draftTrimmed;

    const instructions = REWRITE_GLOBAL_INSTRUCTIONS + '\n\n' +
      (language === 'ko' ? REWRITE_KOREAN_INSTRUCTIONS : REWRITE_ENGLISH_INSTRUCTIONS);

    const rewriteModel = process.env.REWRITE_MODEL || 'gpt-5.2-2025-12-11';
    const completion = await openai.chat.completions.create({
      model: rewriteModel,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: userInput }
      ],
      max_tokens: Math.max(2048, Math.ceil(draftTrimmed.length * 2.5)),
      temperature: 0.3
    });

    let rewritten = (completion.choices[0]?.message?.content || '').trim();
    rewritten = stripMarkdownArtifacts(rewritten);

    res.status(200).json({ success: true, rewritten });
  } catch (error) {
    console.error('Rewrite API error:', error);
    res.status(500).json({
      error: 'Rewrite failed',
      details: error.message
    });
  }
}
