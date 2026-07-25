'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { logEvent } from '@/lib/events'
import Markdown from '@/components/Markdown'
import type { Idea, ResearchRun } from '@/lib/types'

/**
 * Digest Workbench — 이 도구의 핵심 화면 (docs/MVP.md §3.2)
 *
 * 좌: 곧 폐기될 AI 자료 / 우: 영구 저장될 내 문장.
 * 이 좌우 비대칭이 눈에 보여야 한다. 좌측은 점선·흐린 배경, 우측은 흰 배경.
 *
 * 검증 대상은 H1 — "AI 자료를 읽고 직접 요약하는 마찰을 감수할 만한가."
 * 붙여넣기 차단이 불편해서 이 화면을 안 쓰게 된다면, 그 자체가 H1의 답이다.
 */
const POLL_MS = 2000
/** 3분. 이걸 넘으면 폴링을 멈춘다 — 무한 폴링은 조용히 요청을 낭비한다. */
const POLL_TIMEOUT_MS = 180_000

export default function Digest() {
  const [queue, setQueue] = useState<Idea[]>([])
  const [current, setCurrent] = useState<Idea | null>(null)
  const [run, setRun] = useState<ResearchRun | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [purging, setPurging] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [myTake, setMyTake] = useState('')
  const [tags, setTags] = useState('')

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const refreshQueue = useCallback(async () => {
    const { data } = await supabase
      .from('ideas')
      .select('*')
      .in('status', ['awaiting_digest', 'inbox', 'researching'])
      .order('status', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(100)
    setQueue((data ?? []) as Idea[])
  }, [])

  useEffect(() => {
    void refreshQueue()
    return () => {
      clearTimeout(toastTimer.current)
      clearTimeout(pollTimer.current)
    }
  }, [refreshQueue])

  function flash(msg: string) {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  function resetForm() {
    setTitle('')
    setSummary('')
    setMyTake('')
    setTags('')
    setChecked(new Set())
    setError(null)
  }

  const fetchRun = useCallback(async (ideaId: number) => {
    const { data } = await supabase
      .from('research_runs')
      .select('*')
      .eq('idea_id', ideaId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as ResearchRun | null) ?? null
  }, [])

  async function open(idea: Idea) {
    setCurrent(idea)
    setRun(null)
    resetForm()
    if (idea.status !== 'awaiting_digest') return
    const r = await fetchRun(idea.id)
    if (!r) setError('자료를 불러오지 못했습니다')
    else setRun(r)
  }

  /**
   * 리서치 실행 — Edge Function 호출 (§4.1).
   *
   * 진행 상황은 ideas.status 하나로 표현한다. 별도 job 테이블도 큐도 없다.
   * 함수가 죽어 researching 에 갇히면, 다음 앱 진입 때 app_open() 이 되돌린다.
   *
   * ⚠ invoke 를 await 하지 않는다.
   *
   *   리서치는 30~60초가 걸린다. 여기서 기다리면 (a) 폴링이 리서치가 끝난 뒤에야
   *   시작되어 존재 이유를 잃고, (b) 게이트웨이 타임아웃이 나면 실제로는 성공한
   *   작업을 "실패"로 표시한다. 사용자는 버튼을 다시 누르고 중복 run 이 쌓인다.
   *   mock 공급자는 즉시 끝나서 이 버그가 보이지 않는다 — 실제 공급자를 붙이는
   *   순간 드러난다.
   */
  async function research(idea: Idea) {
    setBusy(true)
    setError(null)

    // 클라이언트가 먼저 researching 으로 바꾼다.
    // Edge Function 도 같은 일을 하지만, 그걸 기다리면 첫 폴링이 아직 inbox 인
    // 상태를 보고 실패로 오판한다. 먼저 바꿔두면 그 경합이 사라진다.
    await supabase
      .from('ideas')
      .update({ status: 'researching', researching_since: new Date().toISOString() })
      .eq('id', idea.id)
    await refreshQueue()

    const startedAt = Date.now()
    let done = false

    const finish = async (msg: string | null) => {
      if (done) return
      done = true
      clearTimeout(pollTimer.current)
      setBusy(false)
      if (msg) setError(msg)
      await refreshQueue()
    }

    const failToInbox = async (msg: string) => {
      await supabase
        .from('ideas')
        .update({ status: 'inbox', researching_since: null })
        .eq('id', idea.id)
      await finish(msg)
    }

    // ★ 던져놓고 기다리지 않는다. 실패 사유는 그대로 화면에 노출한다 —
    //   "조사에 실패했습니다" 만으로는 함수 미배포인지 키 누락인지 알 수 없다.
    void supabase.functions
      .invoke('research', { body: { idea_id: idea.id } })
      .then(({ error }) => {
        if (error) void failToInbox(`조사를 시작하지 못했습니다 — ${error.message}`)
      })
      .catch((e: unknown) =>
        failToInbox(
          `조사를 시작하지 못했습니다 — ${e instanceof Error ? e.message : String(e)}`,
        ),
      )

    const poll = async () => {
      if (done) return

      const { data } = await supabase
        .from('ideas')
        .select('*')
        .eq('id', idea.id)
        .single()
      const fresh = data as Idea | null

      if (fresh?.status === 'awaiting_digest') {
        await finish(null)
        await open(fresh)
        return
      }
      if (fresh?.status === 'inbox') {
        // Edge Function 이 실패해서 되돌려 놓은 경우 — 사유가 run 에 남아 있다
        const r = await fetchRun(idea.id)
        await finish(r?.error ? `조사 실패: ${r.error}` : '조사에 실패했습니다')
        return
      }
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        // 여기서 상태를 건드리지 않는 이유: 함수가 아직 살아 있을 수 있다.
        // 정말 죽었다면 다음 앱 진입 때 app_open() 이 되돌린다 (§4.1).
        await finish('조사가 너무 오래 걸립니다. 잠시 후 큐에서 다시 확인하세요.')
        return
      }
      pollTimer.current = setTimeout(() => void poll(), POLL_MS)
    }

    pollTimer.current = setTimeout(() => void poll(), POLL_MS)
  }

  /**
   * ★ 붙여넣기 차단 (§1.3, §3.2)
   *
   * 이걸 빼면 그냥 평범한 노트앱이다. 검증할 대상 자체가 사라진다.
   * 차단만 하지 않고 paste_blocked 를 남기는 이유는 §2.2 참조 —
   * 이 숫자가 H1이 무너지는 순간을 가장 먼저 보여준다.
   */
  function blockPaste(e: React.ClipboardEvent) {
    e.preventDefault()
    flash('읽고 당신의 언어로 쓰세요. 그게 이 도구의 전부입니다.')
    void logEvent('paste_blocked', current ? `idea:${current.id}` : undefined)
  }

  /**
   * 소화 — DB 함수 하나를 호출한다.
   *
   * 카드 생성·출처 승계·산문 폐기·상태 전이가 Postgres 안에서 한 트랜잭션으로
   * 일어난다. 클라이언트에서 네 번 나눠 부르면 중간에 끊겼을 때 원칙 1이 깨진다.
   */
  async function submit() {
    if (!current || !summary.trim() || !title.trim()) return
    setBusy(true)
    setError(null)

    const { error } = await supabase.rpc('digest', {
      p_idea_id: current.id,
      p_title: title.trim(),
      p_summary: summary.trim(),
      p_my_take: myTake.trim() || null,
      p_tags: tags.trim() || null,
      p_source_ids: [...checked],
    })
    setBusy(false)

    if (error) {
      setError(error.message)
      return
    }

    // 좌측 소멸 애니메이션 — 폐기를 눈으로 체감시킨다 (§3.2)
    setPurging(true)
    setTimeout(async () => {
      setPurging(false)
      setCurrent(null)
      setRun(null)
      resetForm()
      await refreshQueue()
    }, 300)
  }

  /**
   * 자료 폐기 — 카드를 만들지 않고 버린다 (§3.5).
   *
   * 쓸모없는 자료로 억지 카드를 만들면 Library 가 오염된다. 나가는 길이
   * "소화 완료" 하나뿐이면 그렇게 된다.
   *
   * 폐기도 계측한다. 전환율이 낮을 때 "요약이 귀찮아서"인지 "자료가 쓸모없어서"인지
   * 구분할 수 있는 유일한 신호다 (§8).
   */
  async function discard(archiveIdea: boolean) {
    if (!current) return
    const msg = archiveIdea
      ? '자료를 버리고 착상도 보관 처리할까요?'
      : '자료를 버릴까요? 착상은 큐에 남아 다시 조사할 수 있습니다.'
    if (!confirm(msg)) return

    setBusy(true)
    const { error } = await supabase.rpc('discard_research', {
      p_idea_id: current.id,
      p_archive_idea: archiveIdea,
    })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setPurging(true)
    setTimeout(async () => {
      setPurging(false)
      setCurrent(null)
      setRun(null)
      resetForm()
      await refreshQueue()
    }, 300)
  }

  const canSubmit = !!title.trim() && !!summary.trim() && !busy
  const sources = run?.sources_json ?? []

  // ── 큐 화면 ──
  if (!current) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h2 className="mb-1 text-sm font-semibold text-stone-700">Digest Queue</h2>
        <p className="mb-5 text-xs text-stone-400">
          대기 큐가 길어지면 그게 R1 병목이다 (§8: 평균 5 이하)
        </p>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        {queue.length === 0 ? (
          <p className="text-sm text-stone-400">
            대기 중인 착상이 없습니다. Capture 에서 먼저 기록하세요.
          </p>
        ) : (
          <ul className="divide-y divide-stone-200">
            {queue.map((idea) => (
              <li key={idea.id} className="flex items-center gap-3 py-3">
                <span className="flex-1 text-stone-700">{idea.raw_thought}</span>
                {idea.status === 'awaiting_digest' ? (
                  <button
                    onClick={() => void open(idea)}
                    className="shrink-0 rounded bg-stone-800 px-3 py-1.5 text-xs text-white"
                  >
                    Digest
                  </button>
                ) : (
                  <button
                    onClick={() => void research(idea)}
                    disabled={busy || idea.status === 'researching'}
                    className="shrink-0 rounded border border-stone-300 px-3 py-1.5 text-xs
                               text-stone-600 disabled:opacity-40"
                  >
                    {idea.status === 'researching' ? '조사 중…' : '자료 조사'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  // ── 작업대 ──
  return (
    <div className="relative mx-auto max-w-6xl px-6 py-6">
      <button
        onClick={() => {
          setCurrent(null)
          setRun(null)
          resetForm()
        }}
        className="mb-3 text-xs text-stone-400 hover:text-stone-600"
      >
        ← 큐로
      </button>

      <div className="grid gap-5 md:grid-cols-2">
        {/* 좌: 휘발성 */}
        <section
          className={
            'rounded-lg border border-dashed border-stone-300 bg-stone-100/70 p-5 ' +
            'transition-opacity duration-300 ' +
            (purging ? 'opacity-0' : 'opacity-100')
          }
        >
          <header className="mb-3 flex items-center justify-between text-xs">
            <span className="font-semibold text-stone-500">AI 자료</span>
            <div className="flex items-center gap-3">
              <span className="text-amber-700">⏳ 소화하면 삭제됩니다</span>
              {run?.output_md && (
                <button
                  onClick={() => void discard(false)}
                  disabled={busy}
                  title="카드를 만들지 않고 자료만 버립니다. 착상은 큐에 남습니다."
                  className="rounded border border-stone-300 px-2 py-0.5 text-stone-500
                             hover:border-red-300 hover:text-red-600 disabled:opacity-40"
                >
                  버리기
                </button>
              )}
            </div>
          </header>

          <p className="mb-3 text-sm font-medium text-stone-700">
            Q. {current.question || current.raw_thought}
          </p>

          {/* 마크다운으로 렌더링한다. 날것으로 두면 `**`·`>` 가 그대로 보여
              읽기가 불편해지고, 그 마찰이 H1 측정에 섞인다 (§0.1). */}
          <div className="prose prose-sm prose-stone max-w-none text-stone-600">
            {run?.output_md ? <Markdown>{run.output_md}</Markdown> : <p>자료 없음</p>}
          </div>

          {sources.length > 0 && (
            <div className="mt-5 border-t border-stone-300 pt-3">
              <p className="mb-2 text-xs font-semibold text-stone-500">
                출처 — 체크한 것만 카드에 승계됩니다 (원칙 2)
              </p>
              <ul className="space-y-1.5">
                {sources.map((s, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked.has(i)}
                      onChange={(e) => {
                        const next = new Set(checked)
                        if (e.target.checked) next.add(i)
                        else next.delete(i)
                        setChecked(next)
                      }}
                      className="h-4 w-4 accent-stone-600"
                    />
                    <span className="flex-1 truncate text-stone-600">
                      {s.title || s.url}
                    </span>
                    {s.url && (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-stone-400 hover:text-stone-600"
                      >
                        ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* 우: 영구 */}
        <section className="rounded-lg border border-stone-300 bg-white p-5">
          <header className="mb-3 flex items-center justify-between text-xs">
            <span className="font-semibold text-stone-700">내 요약</span>
            <span className="text-stone-500">✍ 영구 저장</span>
          </header>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onPaste={blockPaste}
            placeholder="제목"
            className="mb-3 w-full rounded border border-stone-300 px-3 py-2 text-sm"
          />

          <label className="mb-1 block text-xs text-stone-500">
            요약 — 무엇을 이해했나
          </label>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onPaste={blockPaste}
            rows={7}
            className="mb-3 w-full resize-none rounded border border-stone-300 px-3 py-2
                       text-sm leading-relaxed"
          />

          <label className="mb-1 block text-xs text-stone-500">
            내 생각 — 이걸로 뭘 할까
          </label>
          <textarea
            value={myTake}
            onChange={(e) => setMyTake(e.target.value)}
            onPaste={blockPaste}
            rows={4}
            className="mb-3 w-full resize-none rounded border border-stone-300 px-3 py-2
                       text-sm leading-relaxed"
          />

          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onPaste={blockPaste}
            placeholder="Tag (쉼표 구분)"
            className="mb-4 w-full rounded border border-stone-300 px-3 py-2 text-sm"
          />

          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

          <button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="w-full rounded-lg bg-stone-800 py-2.5 text-sm text-white
                       disabled:bg-stone-300"
          >
            소화 완료 — 왼쪽 삭제
          </button>

          <button
            onClick={() => void discard(true)}
            disabled={busy}
            className="mt-2 w-full py-1.5 text-xs text-stone-400 hover:text-red-600
                       disabled:opacity-40"
          >
            이 착상은 접는다 — 자료 폐기 + 보관
          </button>
        </section>
      </div>

      {toast && (
        <div
          role="status"
          className="fixed bottom-8 left-1/2 -translate-x-1/2 rounded-lg bg-stone-900
                     px-5 py-3 text-sm text-white shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  )
}
