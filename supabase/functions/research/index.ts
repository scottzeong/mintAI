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

const PROVIDERS: Record<string, (q: string) => Promise<ResearchResult> | ResearchResult> = {
  mock: mockProvider,
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
