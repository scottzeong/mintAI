// Structuring — 카드에서 책 구조를 제안한다 (docs/STRUCTURING.md)
//
// research 함수와 같은 구조다: 호출자 JWT 로 RLS 를 태우고, 던져놓고 폴링한다.
// 다른 점은 **검색을 하지 않는다**는 것 —
//
//   원칙 4: 생성 AI 는 Library 밖의 지식을 사용할 수 없다.
//
//   여기서 모델에게 주는 것은 내 카드뿐이다. 웹 검색 도구를 붙이지 않는 것이
//   그 원칙의 구현이다. 카드 밖에서 재료를 끌어오면 그건 내 책이 아니다.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PROPOSAL_COUNT = 3

// ⚠ web/lib/formats.ts 와 **같은 값을 유지해야 한다.**
//   Deno 라 import 를 공유할 수 없다. 한쪽만 바꾸면 화면에 보이는 조건과
//   실제로 생성되는 구조가 어긋난다. (docs/STRUCTURING.md §8)
interface Fmt {
  label: string
  minCards: number
  unit: string
  units: [number, number]
  length: string
}
const FORMATS: Record<string, Fmt> = {
  column:  { label: 'Column / Essay',     minCards: 3,  unit: '단락', units: [3, 5],  length: '800~2,000자' },
  article: { label: 'Article / Post',     minCards: 7,  unit: '섹션', units: [3, 6],  length: '2,000~5,000자' },
  report:  { label: 'Report / Paper',     minCards: 15, unit: '절',   units: [4, 8],  length: '5,000~15,000자' },
  ebook:   { label: 'eBook / Monograph',  minCards: 25, unit: '장',   units: [5, 9],  length: '20,000~50,000자' },
  book:    { label: 'Book',               minCards: 50, unit: '장',   units: [8, 14], length: '60,000자 이상' },
}

const OPENAI_URL = 'https://api.openai.com/v1/responses'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

const buildSystemPrompt = (f: Fmt, cardCount: number) => `당신은 편집자입니다.
저자가 모아온 지식 카드를 읽고, **이 카드들로 쓸 수 있는 「${f.label}」의 구조**를 제안합니다.

## 이 글의 규격

- 종류: **${f.label}**
- 구성: **${f.unit} ${f.units[0]}~${f.units[1]}개**
- 완성 시 분량: ${f.length}
- 가진 카드: ${cardCount}장

**규격을 지키세요.** 칼럼에 12개 장을 만들거나 단행본에 3개 단락만 두면
저자가 쓸 수 없는 구조가 됩니다.

## 규칙

1. **서로 다른 ${PROPOSAL_COUNT}개의 구조**를 제안하세요.
   제목만 다른 같은 글이 아니라, **논지와 구성이 실제로 다른** 셋이어야 합니다.
   (예: 하나는 시간 순, 하나는 개념 축, 하나는 특정 질문에 답하는 구성)

2. **모든 카드를 다 쓰지 마세요.** 논지에 맞지 않는 카드는 빼고,
   **뺀 이유를 반드시 적으세요.** 이유 없이 빠지면 저자가 제안을 신뢰하지 못합니다.

3. 각 ${f.unit}에 카드를 배치하세요. 카드가 하나뿐인 ${f.unit}은 아직 ${f.unit}이 아닙니다
   — 다만 짧은 글에서는 ${f.unit}당 1~2장이 정상입니다.

4. **본문을 쓰지 마세요.** 당신이 주는 것은 구조(제목·요지·배치)까지입니다.
   본문은 저자가 씁니다.

5. 제목과 요지는 한국어로.

## 출력 형식 — 반드시 이 JSON 만 출력하세요. 앞뒤에 설명을 붙이지 마세요.

{
  "proposals": [
    {
      "title": "글 제목",
      "thesis": "이 글이 주장하는 것 한 문장",
      "audience": "누구를 위한 글인가",
      "chapters": [
        { "title": "첫 ${f.unit} 제목", "gist": "여기서 다루는 것 한 줄", "card_ids": [3, 7, 12] }
      ],
      "excluded": [
        { "card_id": 9, "reason": "이 글의 논지와 층위가 다름" }
      ]
    }
  ]
}

"chapters" 배열에 ${f.unit} ${f.units[0]}~${f.units[1]}개를 담으세요.`

interface Card {
  id: number
  title: string
  summary: string
  my_take: string | null
  tags: string | null
}

/** 카드를 프롬프트용 텍스트로. 카드 50~300장이면 그대로 다 넣어도 된다 — RAG 불필요. */
function renderCards(cards: Card[]): string {
  return cards
    .map(
      (c) =>
        `### [${c.id}] ${c.title}\n` +
        `${c.summary}\n` +
        (c.my_take ? `내 생각: ${c.my_take}\n` : '') +
        (c.tags ? `태그: ${c.tags}\n` : ''),
    )
    .join('\n')
}

/** ```json 펜스나 앞뒤 설명이 섞여도 JSON 을 건져낸다. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('JSON 을 찾을 수 없습니다')
  return JSON.parse(raw.slice(start, end + 1))
}

async function callOpenAI(system: string, prompt: string): Promise<{ text: string; model: string }> {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key) throw new Error('OPENAI_API_KEY 시크릿이 없습니다')
  const model = Deno.env.get('MINTAI_STRUCTURE_MODEL') ??
    Deno.env.get('MINTAI_RESEARCH_MODEL') ?? 'gpt-5.5'

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: system,
      input: prompt,
      max_output_tokens: 16000,
      // ★ 도구를 주지 않는다 — 원칙 4
    }),
  })
  if (!res.ok) throw new Error(`OpenAI API ${res.status} — ${(await res.text()).slice(0, 300)}`)

  const data = await res.json()
  let text = ''
  for (const item of data?.output ?? []) {
    if (item.type !== 'message') continue
    for (const c of item.content ?? []) if (c.type === 'output_text') text += c.text ?? ''
  }
  return { text: text.trim(), model }
}

async function callClaude(system: string, prompt: string): Promise<{ text: string; model: string }> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) throw new Error('ANTHROPIC_API_KEY 시크릿이 없습니다')
  const model = Deno.env.get('MINTAI_STRUCTURE_MODEL') ??
    Deno.env.get('MINTAI_RESEARCH_MODEL') ?? 'claude-sonnet-5'

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Claude API ${res.status} — ${(await res.text()).slice(0, 300)}`)

  const data = await res.json()
  const text = (data?.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')
    .trim()
  return { text, model }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: '인증이 필요합니다' }, 401)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )

  const { run_id } = await req.json().catch(() => ({ run_id: null }))
  if (!run_id) return json({ error: 'run_id 가 필요합니다' }, 400)

  const fail = async (msg: string, status = 500) => {
    await supabase
      .from('structuring_runs')
      .update({ status: 'failed', error: msg.slice(0, 500) })
      .eq('id', run_id)
    return json({ error: msg }, status)
  }

  try {
    // RLS 덕분에 내 카드만 온다
    const { data: cardData, error } = await supabase
      .from('cards')
      .select('id, title, summary, my_take, tags')
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)

    const cards = (cardData ?? []) as Card[]

    const { data: runRow } = await supabase
      .from('structuring_runs')
      .select('format')
      .eq('id', run_id)
      .single()
    const fmtKey = (runRow as { format?: string } | null)?.format ?? 'book'
    const fmt = FORMATS[fmtKey] ?? FORMATS.book

    if (cards.length < fmt.minCards) {
      return await fail(
        `${fmt.label} 구조를 제안하려면 카드가 ${fmt.minCards}장 이상 필요합니다 ` +
          `(현재 ${cards.length}장)`,
        400,
      )
    }

    const provider = Deno.env.get('MINTAI_RESEARCH_PROVIDER') ?? 'mock'
    const system = buildSystemPrompt(fmt, cards.length)
    const prompt =
      `카드 ${cards.length}장입니다. 이 카드들로 쓸 수 있는 ` +
      `${fmt.label} ${PROPOSAL_COUNT}개를 제안하세요.\n\n` +
      renderCards(cards)

    let text: string, model: string
    if (provider === 'claude') ({ text, model } = await callClaude(system, prompt))
    else if (provider === 'openai') ({ text, model } = await callOpenAI(system, prompt))
    else {
      return await fail(
        `구조 제안은 mock 공급자를 지원하지 않습니다. ` +
          `MINTAI_RESEARCH_PROVIDER 를 openai 또는 claude 로 설정하세요.`,
        400,
      )
    }

    const parsed = extractJson(text) as { proposals?: unknown[] }
    if (!Array.isArray(parsed.proposals) || parsed.proposals.length === 0) {
      throw new Error('제안을 파싱하지 못했습니다')
    }

    await supabase
      .from('structuring_runs')
      .update({
        status: 'ready',
        output_json: parsed,
        card_count: cards.length,
        model,
        chars: text.length,
        error: null,
      })
      .eq('id', run_id)

    return json({ status: 'ready', proposals: parsed.proposals.length })
  } catch (e) {
    return await fail(e instanceof Error ? e.message : String(e))
  }
})
