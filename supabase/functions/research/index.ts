// 리서치 파이프라인 — Supabase Edge Function (docs/MVP.md §4, §4.1)
//
// Vercel 함수가 아니라 여기서 도는 이유: 검색 + LLM 이 30~60초 걸리는데
// Vercel Hobby 플랜의 함수 실행 제한이 그보다 짧다. Edge Function 은 여유가 있다.
//
// 이 함수가 만드는 것은 **곧 폐기될 휘발성 자료**다 (원칙 1).
//
// 출력 형식은 docs/RESEARCH.md 가 정한다 — 질문을 8종으로 분류하고 유형별 구조로
// 3,000자 내외를 쓴다. 1,200자 상한을 뒤집은 근거는 RESEARCH.md §0.1:
// **뭉텅이 산문 1,200자는 다 읽어야 하지만 구획된 3,000자는 골라 읽을 수 있다.**
//
// 인증: 호출자의 JWT 를 그대로 물려 클라이언트를 만든다. 즉 RLS 가 그대로 적용되어
// **남의 착상에는 리서치를 걸 수 없다.** service_role 을 쓰면 이 보호가 사라진다.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// docs/RESEARCH.md §0.1 — 1,200 → 3,000자.
// 걸고 있는 것은 분량이 아니라 "구조가 선택적 읽기를 가능하게 하는가"다.
// 상한을 3,600 으로 둔 이유: 목표는 3,000 이지만 섹션 중간에서 잘리면
// 마지막 섹션(대개 '확실하지 않은 것')이 통째로 사라진다. 여유를 준다.
const MAX_OUTPUT_CHARS = 3600
const MAX_SOURCES = 8

interface ResearchResult {
  output_md: string
  sources: { url: string; title: string }[]
  model: string
  kind?: string | null
}

/** RESEARCH.md §1 — 질문 유형 8종 */
const KINDS = [
  'concept',
  'causal',
  'history',
  'person',
  'event',
  'compare',
  'data',
  'debate',
] as const

const KIND_LABELS: Record<string, string> = {
  concept: '개념',
  causal: '인과·관계',
  history: '역사·전개',
  person: '인물',
  event: '사건',
  compare: '비교·대조',
  data: '현황·데이터',
  debate: '논쟁',
}

/**
 * 출력 첫 줄의 유형 선언을 읽는다 (RESEARCH.md §4.1).
 *
 * 파싱에 실패하면 null 을 돌려주고 자료는 그대로 쓴다 —
 * **분류는 부가 정보이지 자료의 조건이 아니다.**
 */
function parseKind(md: string): string | null {
  const m = md.match(/유형:\s*\**\s*([^\n*<]+)/)
  if (!m) return null
  const label = m[1].trim()
  const hit = Object.entries(KIND_LABELS).find(([, v]) => v === label)
  if (hit) return hit[0]
  return (KINDS as readonly string[]).includes(label) ? label : null
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
      '> **유형:** 개념\n\n' +
      `**Q. ${question}**\n\n` +
      '> ⚠ mock 공급자입니다. 실제 검색이 수행되지 않았습니다.\n' +
      '> Edge Function 시크릿에 MINTAI_RESEARCH_PROVIDER 를 설정하면 바뀝니다.\n\n' +
      '## 정의\n\n실제 공급자를 붙이면 여기에 내용이 채워집니다.\n\n' +
      '## 무엇이 아닌가\n\n유형별 구조는 docs/RESEARCH.md §2 를 따릅니다.\n\n' +
      '## 확실하지 않은 것\n\n이 화면의 좌측은 **곧 폐기될 자료**입니다. ' +
      '우측에 직접 요약을 쓰면 이 텍스트는 사라지고 당신이 쓴 문장만 카드로 남습니다.\n',
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

// ── 유형별 섹션 구조 (docs/RESEARCH.md §2) ──────────────────
//
// ★ 표시는 그 유형에서 "이게 없으면 대중서에서 사고가 나는" 섹션이다.
//   막으려는 사고를 프롬프트에 같이 적는다 — 이유를 아는 모델이 더 잘 쓴다.
const KIND_STRUCTURES = `
### 개념 — "X란 무엇인가"
## 정의
## 구성 요소 — 무엇이 있어야 X 인가
## 무엇이 아닌가 ★ — 혼동되는 인접 개념과의 경계. 개념 오용은 정의가 아니라 경계를 몰라서 생긴다
## 쓰이는 자리 — 실제 용례 2~3
## 정의가 갈리는 지점 — 학파·분야별 차이

### 인과·관계 — "X가 Y에 영향을 주는가"
## 주장되는 관계 — 한 문장으로
## 메커니즘 ★ — 어떤 경로로 작동하는가, 단계별로
## 근거의 강도 ★ — 상관인가 실험인가 사례인가. 표본과 맥락. **메커니즘과 반드시 분리한다**
## 교란 요인·반례
## 성립 조건 — 언제 성립하고 언제 깨지는가

### 역사·전개 — "X는 어떻게 변해왔나"
## 시기 구분 — 3~5 국면, 각 국면에 이름을 붙인다
## 전환점 ★ — 무엇이 언제 왜 바뀌었나. **연표 나열은 정보이지 이해가 아니다. 계기를 쓴다**
## 지속된 것 — 바뀌지 않은 것. 종종 이게 더 중요하다
## 현재 상태
## 통설과 수정주의 — 교과서 서술과 최근 연구의 차이

### 인물 — "X는 누구인가"
## 한 줄 규정
## 좌표 — 시대·지역·소속. 최소한만
## 핵심 기여 2~3 — 무엇을 바꿨나
## 무엇에 반대했나 ★ — 그가 싸운 상대. **사상은 반대 속에서 선명해진다. 위인전이 되지 않게**
## 평가의 변천 — 당대 → 현재
## 비판과 논쟁

### 사건 — "X 사건이란"
## 사실 골격 — 언제·어디서·누가·무엇을. 건조하게
## 직전 배경 — 왜 그 시점이었나
## 전개
## 결과와 파급
## 해석의 대립 ★ — 같은 사실을 두고 갈리는 설명
## 사실이 불확실한 지점 ★ — **사실과 해석이 섞이면 독자가 해석을 사실로 읽는다**

### 비교·대조 — "X와 Y의 차이"
## 비교 축 ★ — 3~4개를 먼저 세운다. **축이 없으면 사과와 오렌지를 비교하게 된다**
## 축별 대조 — 표로
## 공통 오해 — 흔히 잘못 알려진 차이
## 어느 쪽이 언제 — 상황별 우열
## 이분법이 깨지는 지점 ★ — 사실은 둘로 나뉘지 않는 부분

### 현황·데이터 — "지금 X는 얼마나"
## 핵심 수치 ★ — **반드시 기준 시점을 명시한다**
## 측정 방법과 한계 ★ — 무엇을 어떻게 셌는가. **"실업률 3%"는 세는 방법에 따라 두 배 달라진다**
## 추세
## 집단·국가 간 차이
## 수치가 오도할 수 있는 지점

### 논쟁 — "X에 대한 찬반"
## 쟁점 정식화 — 정확히 무엇을 두고 다투는가
## 합의된 사실 ★ — 양측이 동의하는 부분을 **먼저** 밝힌다
## 입장 A — 핵심 주장 + 근거
## 입장 B
## 실제 갈라지는 지점 ★ — 사실 판단인가 가치 판단인가. **대개 사실은 합의돼 있고 가치에서 갈린다**
## 제3의 입장
`

const SYSTEM_PROMPT = `당신은 대중서를 쓰는 저술가의 리서치 조수입니다.
**반드시 웹 검색을 사용**하고, 찾은 내용을 한국어로 정리하세요.

## 1단계 — 질문 유형을 하나 고른다

개념 / 인과·관계 / 역사·전개 / 인물 / 사건 / 비교·대조 / 현황·데이터 / 논쟁

경계가 애매하면 **더 구체적인 쪽**을 고르세요.
(예: "마키아벨리의 권력관" → 인물, "권력이란 무엇인가" → 개념)

## 2단계 — 그 유형의 구조로 쓴다

출력 **첫 줄**에 반드시 이렇게 씁니다:

> **유형:** 인과·관계

그 다음 아래 구조를 그대로 따릅니다. 섹션 제목(\`## \`)을 바꾸지 마세요.
${KIND_STRUCTURES}

## 3단계 — 모든 유형에 아래 두 섹션을 마지막에 붙인다

## 다른 관점
위 내용과 충돌하거나 단서를 다는 견해 1~2개. 정말 없다면 없다고 쓰세요.

## 확실하지 않은 것
자료가 부족하거나 당신이 자신 없는 지점을 명시하세요.
**이 섹션을 비우지 마세요.** 저술가가 어디를 더 확인해야 하는지 알아야 합니다.

## 전체 규칙

1. **3,000자 내외.** 섹션당 400~600자. 짧으면 재료가 부족하고 길면 읽히지 않습니다.
2. 각 서술 끝에 근거가 된 출처 이름을 괄호로. 예: (OECD 보고서)
3. 인사말·서론·"검색해보겠습니다" 같은 말 금지. 유형 선언 후 곧바로 첫 섹션부터.
4. 확실하지 않은 것을 확실한 것처럼 쓰지 마세요.
5. **"이걸 카드로 만든다면" 같은 요약 제안을 하지 마세요.** 당신은 재료까지만 줍니다.
   무엇을 뽑을지는 사람이 정합니다.`

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
        max_tokens: 8192,
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
      max_output_tokens: 8192,
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
  return {
    ...r,
    output_md: out,
    sources: r.sources.slice(0, MAX_SOURCES),
    kind: r.kind ?? parseKind(out),
  }
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
      kind: result.kind ?? null,
      // ★ 폐기되면 output_md 가 사라지므로 길이를 지금 남긴다 (RESEARCH.md §0.1)
      chars: result.output_md.length,
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
