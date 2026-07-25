// 리서치 파이프라인 — Supabase Edge Function (docs/MVP.md §4, §4.1)
//
// Vercel 함수가 아니라 여기서 도는 이유: 검색 + LLM 이 30~60초 걸리는데
// Vercel Hobby 플랜의 함수 실행 제한이 그보다 짧다. Edge Function 은 여유가 있다.
//
// 이 함수가 만드는 것은 **곧 폐기될 휘발성 자료**다 (원칙 1). 그래서 품질보다
// 중요한 게 두 가지다:
//   1. 1,200자 이내 — 길면 소화가 부담스러워지고 그게 곧 R1 병목이다
//   2. "다른 관점" 필수 — 학술 기능이 아니라 사고 습관이다
//
// 인증: 호출자의 JWT 를 그대로 물려 클라이언트를 만든다. 즉 RLS 가 그대로 적용되어
// **남의 착상에는 리서치를 걸 수 없다.** service_role 을 쓰면 이 보호가 사라진다.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MAX_OUTPUT_CHARS = 1200
const MAX_SOURCES = 5

interface ResearchResult {
  output_md: string
  sources: { url: string; title: string }[]
  model: string
}

/**
 * 오프라인 공급자.
 *
 * 실제 검색을 하지 않으므로 내용이 비어 있다 — **일부러 그렇게 둔다.**
 * 그럴듯한 가짜 문장을 넣으면 그걸 요약하게 되고, 그 요약이 카드로 영구 저장된다.
 * 거짓을 재료로 만든 카드는 나중에 구분할 방법이 없다.
 */
function mockProvider(question: string): ResearchResult {
  return {
    output_md:
      `**Q. ${question}**\n\n` +
      '> ⚠ mock 공급자입니다. 실제 검색이 수행되지 않았습니다.\n' +
      '> Edge Function 시크릿에 MINTAI_RESEARCH_PROVIDER 를 설정하면 바뀝니다.\n\n' +
      '이 화면의 좌측은 **곧 폐기될 자료**입니다. 우측에 직접 요약을 쓰면\n' +
      '이 텍스트는 사라지고 당신이 쓴 문장만 카드로 남습니다.\n',
    sources: [],
    model: 'mock',
  }
}

// ─────────────────────────── Claude 공급자 ───────────────────────────
//
// 검색 벤더를 따로 두지 않는다. Claude API 의 내장 web_search 도구가
// 검색·종합·인용을 한 번에 처리하고, 인용이 { url, title } 구조로 돌아와
// 원칙 2(출처 승계)에 그대로 맞는다. 키가 하나면 고장날 곳도 하나다.
//
// 비용: 검색 $10 / 1,000회 + 토큰. max_uses 5 이므로 리서치 1건당 최대 $0.05 수준.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-sonnet-5'
const MAX_SEARCHES = 5
const MAX_PAUSE_TURNS = 4

const SYSTEM_PROMPT = `당신은 대중서를 쓰는 저술가의 리서치 조수입니다.
사용자의 질문에 답하기 위해 **반드시 웹 검색을 사용**하고, 찾은 내용을 한국어로 정리하세요.

출력 규칙 — 엄격히 지키세요:
1. **1,100자 이내.** 이 자료는 사람이 읽고 직접 요약할 재료입니다. 길면 읽히지 않습니다.
2. 핵심 요점 3~5개를 마크다운 불릿으로.
3. 마지막에 **"## 다른 관점"** 섹션을 두고, 위 요점과 충돌하거나 단서를 다는 견해를 1~2개.
4. 각 요점 끝에 근거가 된 출처의 이름을 괄호로 표시하세요. 예: (OECD 보고서)
5. 인사말·서론·"검색해보겠습니다" 같은 말은 쓰지 마세요. 곧바로 요점부터.
6. 확실하지 않은 것은 확실하지 않다고 쓰세요. 추측을 사실처럼 쓰지 마세요.

"다른 관점" 섹션은 생략하지 마세요. 반대 견해가 정말 없다면 그렇게 적으세요.`

interface Block {
  type: string
  text?: string
  citations?: { url?: string; title?: string }[]
}

async function claudeProvider(question: string): Promise<ResearchResult> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY 시크릿이 없습니다. ' +
        '`supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` 로 설정하세요.',
    )
  }
  const model = Deno.env.get('MINTAI_RESEARCH_MODEL') ?? DEFAULT_MODEL

  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{ role: 'user', content: question }]
  // deno-lint-ignore no-explicit-any
  let data: any = null

  // 검색이 길어지면 API 가 stop_reason='pause_turn' 으로 턴을 끊는다.
  // 받은 assistant 메시지를 그대로 되돌려 보내면 이어서 진행한다.
  for (let turn = 0; turn < MAX_PAUSE_TURNS; turn++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
        tools: [
          {
            // 20250305 는 기본이 direct 호출이라 dynamic filtering 을 쓰지 않는다.
            // 리서치 1건 규모에서는 필터링 이득보다 복잡도가 크다.
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: MAX_SEARCHES,
            user_location: {
              type: 'approximate',
              country: 'KR',
              timezone: 'Asia/Seoul',
            },
          },
        ],
      }),
    })

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new Error(`Claude API ${res.status} — ${body}`)
    }
    data = await res.json()
    if (data.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: data.content })
  }

  const blocks: Block[] = data?.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('')
    .trim()

  if (!text) throw new Error('Claude 가 빈 응답을 반환했습니다')

  // 출처는 **실제로 인용된 것만** 모은다.
  // 검색 결과 전체를 넣으면 읽지도 않은 페이지가 카드에 승계된다 (원칙 2 취지 위반).
  const sources: { url: string; title: string }[] = []
  const seen = new Set<string>()
  for (const b of blocks) {
    for (const c of b.citations ?? []) {
      if (c.url && !seen.has(c.url)) {
        seen.add(c.url)
        sources.push({ url: c.url, title: c.title || c.url })
      }
    }
  }

  const searches = data?.usage?.server_tool_use?.web_search_requests ?? 0
  const body =
    searches === 0
      ? `> ⚠ 웹 검색이 수행되지 않았습니다. 아래는 모델의 기존 지식이며 출처가 없습니다.\n\n${text}`
      : text

  return { output_md: body, sources, model: `${model} (검색 ${searches}회)` }
}

// ─────────────────────────── OpenAI 공급자 ───────────────────────────
//
// Responses API 의 내장 `web_search` 도구를 쓴다. Claude 판과 목적은 같지만
// 응답 구조가 달라 파싱을 공유할 수 없다:
//
//   Claude : content[] 안의 text 블록에 citations[] 가 붙는다
//   OpenAI : output[] 안의 message → content[] → output_text 의
//            annotations[] 에 type='url_citation' 로 붙는다
//
// ⚠ `sources` 필드가 아니라 `annotations` 를 쓴다.
//    sources 는 모델이 **훑어본** URL 전체 목록이고, annotations 는 **실제로
//    인용한** 것이다. sources 를 쓰면 읽지도 않은 페이지가 카드에 승계된다.
//    원칙 2는 "사실 데이터를 승계한다"이지 "검색 로그를 승계한다"가 아니다.

const OPENAI_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_OPENAI_MODEL = 'gpt-5.5'

interface OpenAIAnnotation {
  type?: string
  url?: string
  title?: string
}
interface OpenAIContent {
  type?: string
  text?: string
  annotations?: OpenAIAnnotation[]
}
interface OpenAIOutputItem {
  type?: string
  content?: OpenAIContent[]
}

async function openaiProvider(question: string): Promise<ResearchResult> {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY 시크릿이 없습니다. ' +
        '`supabase secrets set OPENAI_API_KEY=sk-...` 로 설정하세요.',
    )
  }
  const model = Deno.env.get('MINTAI_RESEARCH_MODEL') ?? DEFAULT_OPENAI_MODEL

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: SYSTEM_PROMPT,
      input: question,
      max_output_tokens: 4096,
      // tool_choice 를 auto 로 두면 모델이 검색을 건너뛰고 기존 지식으로 답할 수
      // 있다. 그러면 출처 없는 자료가 나온다 — §4 규격 위반.
      tool_choice: 'required',
      tools: [
        {
          type: 'web_search',
          search_context_size: 'medium',
          user_location: {
            type: 'approximate',
            country: 'KR',
            timezone: 'Asia/Seoul',
          },
        },
      ],
    }),
  })

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    throw new Error(`OpenAI API ${res.status} — ${body}`)
  }

  const data = await res.json()
  const output: OpenAIOutputItem[] = data?.output ?? []

  let text = ''
  let searches = 0
  const sources: { url: string; title: string }[] = []
  const seen = new Set<string>()

  for (const item of output) {
    if (item.type === 'web_search_call') {
      searches++
      continue
    }
    if (item.type !== 'message') continue

    for (const c of item.content ?? []) {
      if (c.type !== 'output_text') continue
      text += c.text ?? ''
      for (const a of c.annotations ?? []) {
        if (a.type === 'url_citation' && a.url && !seen.has(a.url)) {
          seen.add(a.url)
          sources.push({ url: a.url, title: a.title || a.url })
        }
      }
    }
  }

  text = text.trim()
  if (!text) {
    const reason = data?.incomplete_details?.reason
    throw new Error(
      `OpenAI 가 빈 응답을 반환했습니다${reason ? ` (${reason})` : ''}`,
    )
  }

  const body =
    searches === 0
      ? `> ⚠ 웹 검색이 수행되지 않았습니다. 아래는 모델의 기존 지식이며 출처가 없습니다.\n\n${text}`
      : text

  return { output_md: body, sources, model: `${model} (검색 ${searches}회)` }
}

const PROVIDERS: Record<string, (q: string) => Promise<ResearchResult> | ResearchResult> = {
  mock: mockProvider,
  openai: openaiProvider,
  // Claude 판도 남겨둔다. 어댑터가 실제로 교체 가능한지 보여주는 증거이고,
  // 나중에 키가 생기면 시크릿 한 줄로 바꿔 끼울 수 있다.
  claude: claudeProvider,
}

function normalize(r: ResearchResult): ResearchResult {
  let out = r.output_md.trim()
  if (out.length > MAX_OUTPUT_CHARS) {
    out = out.slice(0, MAX_OUTPUT_CHARS - 1).trimEnd() + '…'
  }
  return { ...r, output_md: out, sources: r.sources.slice(0, MAX_SOURCES) }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: '인증이 필요합니다' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ★ 호출자 권한으로 동작한다 — RLS 유지
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )

  const { idea_id } = await req.json().catch(() => ({ idea_id: null }))
  if (!idea_id) {
    return new Response(JSON.stringify({ error: 'idea_id 가 필요합니다' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: idea } = await supabase
    .from('ideas')
    .select('*')
    .eq('id', idea_id)
    .maybeSingle()

  if (!idea) {
    return new Response(JSON.stringify({ error: '해당 착상이 없습니다' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  await supabase
    .from('ideas')
    .update({ status: 'researching', researching_since: new Date().toISOString() })
    .eq('id', idea_id)

  const question = (idea.question || idea.raw_thought).trim()
  const name = Deno.env.get('MINTAI_RESEARCH_PROVIDER') ?? 'mock'
  const provider = PROVIDERS[name]

  try {
    if (!provider) throw new Error(`알 수 없는 리서치 공급자: ${name}`)
    const result = normalize(await provider(question))

    await supabase.from('research_runs').insert({
      idea_id,
      output_md: result.output_md,
      sources_json: result.sources,
      model: result.model,
    })
    await supabase
      .from('ideas')
      .update({ status: 'awaiting_digest', researching_since: null })
      .eq('id', idea_id)

    return new Response(JSON.stringify({ status: 'awaiting_digest' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    // §4.1 — 실패는 inbox 로 되돌린다. **재시도는 사용자가 버튼을 다시 누르는 것이다.**
    // 자동 재시도를 넣지 않는 이유: 실패 원인이 대개 키 누락이나 쿼터라서,
    // 자동으로 다시 걸어봐야 같은 이유로 또 실패하고 비용만 든다.
    const msg = e instanceof Error ? e.message : String(e)
    await supabase.from('research_runs').insert({
      idea_id,
      output_md: null,
      sources_json: [],
      error: msg.slice(0, 500),
    })
    await supabase
      .from('ideas')
      .update({ status: 'inbox', researching_since: null })
      .eq('id', idea_id)
    await supabase.from('events').insert({ kind: 'research_failed', meta: `idea:${idea_id}` })

    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
