'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import { supabase } from '@/lib/supabase'
import type { Card, Draft, Source } from '@/lib/types'

/**
 * Write — 카드를 보면서 글을 쓴다 (docs/MVP.md §3.4)
 *
 * 검증 대상은 H2 — **"카드가 쌓이면 글쓰기가 실제로 쉬워지는가."**
 *
 * 그래서 **AI 초고 생성이 없다.** AI가 대신 써버리면 글이 쉬워진 이유가
 * 카드 덕분인지 AI 덕분인지 구분할 수 없다. 초고 생성은 H2가 참으로 확인된
 * 뒤에 붙인다(§9).
 *
 * 에디터가 textarea 인 것도 의도적이다. TipTap 은 각주 기능이 필요해질 때
 * 붙인다 — MVP 에는 각주가 없다(§6).
 */
const AUTOSAVE_MS = 800

export default function Write() {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [current, setCurrent] = useState<Draft | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saved, setSaved] = useState(true)
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [q, setQ] = useState('')
  const [cards, setCards] = useState<Card[]>([])
  const [used, setUsed] = useState<Set<number>>(new Set())

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // ── 초기 로드 ──
  useEffect(() => {
    supabase
      .from('drafts')
      .select('*')
      .order('updated_at', { ascending: false })
      .then(({ data }) => {
        const list = (data ?? []) as Draft[]
        setDrafts(list)
        if (list.length) select(list[0])
      })
    return () => {
      clearTimeout(saveTimer.current)
      clearTimeout(searchTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const searchCards = useCallback(async (query: string) => {
    const { data } = await supabase.rpc('search_cards', {
      p_q: query || null,
      p_tag: null,
    })
    setCards(((data ?? []) as Card[]).slice(0, 30))
  }, [])

  useEffect(() => {
    void searchCards('')
  }, [searchCards])

  function select(d: Draft) {
    clearTimeout(saveTimer.current)
    setCurrent(d)
    setTitle(d.title)
    setBody(d.body_md)
    setSaved(true)
    setUsed(new Set())
  }

  async function newDraft() {
    const { data, error } = await supabase
      .from('drafts')
      .insert({ title: '제목 없음', body_md: '' })
      .select()
      .single()
    if (error) {
      setError(error.message)
      return
    }
    const d = data as Draft
    setDrafts((prev) => [d, ...prev])
    select(d)
  }

  /**
   * 자동저장. 타이핑이 멈추고 800ms 뒤에 한 번만 쓴다.
   *
   * 매 글자마다 쓰면 글 한 편에 수천 번의 왕복이 생긴다. 반대로 간격이 길면
   * 탭을 닫았을 때 잃는 분량이 커진다 — 저술 도구에서 문장을 잃는 건
   * 착상을 잃는 것 다음으로 나쁘다.
   */
  function scheduleSave(nextTitle: string, nextBody: string) {
    if (!current) return
    setSaved(false)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const { error } = await supabase
        .from('drafts')
        .update({
          title: nextTitle.trim() || '제목 없음',
          body_md: nextBody,
          updated_at: new Date().toISOString(),
        })
        .eq('id', current.id)
      if (error) {
        setError(error.message)
        return
      }
      setSaved(true)
      setError(null)
      setDrafts((prev) =>
        prev.map((d) =>
          d.id === current.id ? { ...d, title: nextTitle || '제목 없음', body_md: nextBody } : d,
        ),
      )
    }, AUTOSAVE_MS)
  }

  /**
   * 카드를 본문에 삽입.
   *
   * 인용 블록 + 출처 주석으로 넣는다. **요약 원문을 그대로 넣는 게 핵심**이다 —
   * 그 문장은 이미 내가 쓴 것이므로(원칙 1), 붙여넣어도 AI 산문이 섞이지 않는다.
   * Digest 화면에서 붙여넣기를 막는 것과 모순되지 않는 이유가 이것이다.
   */
  async function insertCard(card: Card) {
    const { data } = await supabase
      .from('sources')
      .select('url, title')
      .eq('card_id', card.id)
    const srcs = (data ?? []) as Source[]

    const cite = srcs.length
      ? '\n> \n> ' +
        srcs.map((s) => (s.url ? `[${s.title || s.url}](${s.url})` : s.title)).join(' · ')
      : ''
    const block = `\n> ${card.summary.replace(/\n/g, '\n> ')}\n> \n> — ${card.title}${cite}\n\n`

    const el = bodyRef.current
    const pos = el?.selectionStart ?? body.length
    const next = body.slice(0, pos) + block + body.slice(pos)

    setBody(next)
    setUsed((prev) => new Set(prev).add(card.id))
    scheduleSave(title, next)

    // 커서를 삽입한 블록 뒤로 옮겨 흐름이 끊기지 않게 한다
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos + block.length, pos + block.length)
    })
  }

  const chars = body.length

  if (!current) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20 text-center">
        <p className="mb-5 text-sm text-stone-500">아직 쓰기 시작한 글이 없습니다.</p>
        <button
          onClick={() => void newDraft()}
          className="rounded-lg bg-stone-800 px-5 py-2.5 text-sm text-white"
        >
          새 글 시작
        </button>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      {/* 원고 전환 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {drafts.map((d) => (
          <button
            key={d.id}
            onClick={() => select(d)}
            className={
              'rounded px-2.5 py-1 text-xs ' +
              (d.id === current.id
                ? 'bg-stone-800 text-white'
                : 'border border-stone-300 text-stone-500 hover:text-stone-700')
            }
          >
            {d.title}
          </button>
        ))}
        <button
          onClick={() => void newDraft()}
          className="rounded px-2 py-1 text-xs text-stone-400 hover:text-stone-600"
        >
          + 새 글
        </button>
      </div>

      <div className="grid gap-5 md:grid-cols-[1.6fr_1fr]">
        {/* 좌: 에디터 */}
        <section className="rounded-lg border border-stone-300 bg-white p-5">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              scheduleSave(e.target.value, body)
            }}
            placeholder="제목"
            className="mb-3 w-full border-0 p-0 text-lg font-semibold focus:ring-0"
          />

          {preview ? (
            <div
              className="prose prose-sm prose-stone min-h-[28rem] max-w-none leading-7"
              dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }}
            />
          ) : (
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => {
                setBody(e.target.value)
                scheduleSave(title, e.target.value)
              }}
              placeholder="여기에 씁니다. 오른쪽 카드를 보면서."
              className="min-h-[28rem] w-full resize-none border-0 p-0 text-sm leading-7 focus:ring-0"
            />
          )}

          <div className="mt-4 flex items-center justify-between border-t border-stone-200 pt-3 text-xs">
            <span className={chars >= 800 ? 'text-stone-600' : 'text-stone-400'}>
              {chars.toLocaleString()}자
              {chars >= 800 && ' ✓ 800자'}
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPreview((p) => !p)}
                className="text-stone-400 hover:text-stone-600"
              >
                {preview ? '편집' : '미리보기'}
              </button>
              <span className={saved ? 'text-stone-400' : 'text-amber-600'}>
                {saved ? '자동저장 ✓' : '저장 중…'}
              </span>
            </div>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </section>

        {/* 우: 카드 */}
        <section>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              clearTimeout(searchTimer.current)
              searchTimer.current = setTimeout(() => void searchCards(e.target.value), 250)
            }}
            placeholder="🔍  카드 검색"
            className="mb-3 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
          />

          <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
            {cards.length === 0 ? (
              <p className="text-sm text-stone-400">카드가 없습니다.</p>
            ) : (
              cards.map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg border border-stone-200 bg-white p-3"
                >
                  <p className="text-sm font-medium text-stone-800">{c.title}</p>
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-stone-500">
                    {c.summary}
                  </p>
                  <button
                    onClick={() => void insertCard(c)}
                    className="mt-2 text-xs text-stone-500 hover:text-stone-900"
                  >
                    {used.has(c.id) ? '다시 삽입' : '본문에 삽입'} →
                  </button>
                </div>
              ))
            )}
          </div>

          <p className="mt-3 text-xs text-stone-400">사용한 카드: {used.size}</p>
        </section>
      </div>
    </div>
  )
}
