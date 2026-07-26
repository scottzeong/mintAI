'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { formatOf } from '@/lib/formats'
import type { Card, Chapter, Work } from '@/lib/types'

const AUTOSAVE_MS = 800

/**
 * BookWriter — 확정된 구조 위에서 챕터별로 쓴다 (docs/STRUCTURING.md)
 *
 * 좌: 이 챕터에 배치된 카드 / 우: 챕터 제목 + 본문
 *
 * ⚠ 요구사항에는 `Save` 버튼이 있었지만 **자동저장으로 통일했다** (§6.1).
 *   같은 앱에서 낱글은 자동 저장되는데 챕터는 버튼을 눌러야 한다면, 언젠가
 *   반드시 누르지 않고 탭을 닫는다. 대신 저장 상태를 항상 보이게 한다.
 *
 * ★ 제목이 AI 원안과 다르면 표시한다. 원칙 1의 완화형(§0.2) —
 *   폐기 대신 **구분**으로 지킨다.
 */
export default function BookWriter({ work, onExit }: { work: Work; onExit: () => void }) {
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [current, setCurrent] = useState<Chapter | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saved, setSaved] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fmt = formatOf(work.format)

  const loadChapters = useCallback(async () => {
    const { data } = await supabase
      .from('chapters')
      .select('*')
      .eq('work_id', work.id)
      .order('seq')
    return (data ?? []) as Chapter[]
  }, [work.id])

  useEffect(() => {
    void loadChapters().then((list) => {
      setChapters(list)
      if (list.length) void select(list[0])
    })
    return () => clearTimeout(saveTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadChapters])

  async function select(ch: Chapter) {
    clearTimeout(saveTimer.current)
    setCurrent(ch)
    setTitle(ch.title)
    setBody(ch.body_md)
    setSaved(true)

    const { data } = await supabase
      .from('chapter_cards')
      .select('seq, cards(id, title, summary, my_take, tags, created_at, idea_id)')
      .eq('chapter_id', ch.id)
      .order('seq')
    setCards(
      ((data ?? []) as unknown as { cards: Card }[]).map((r) => r.cards).filter(Boolean),
    )
  }

  function scheduleSave(nextTitle: string, nextBody: string) {
    if (!current) return
    setSaved(false)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const { error } = await supabase
        .from('chapters')
        .update({
          title: nextTitle.trim() || `${current.seq}${fmt.unit}`,
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
      setChapters((prev) =>
        prev.map((c) =>
          c.id === current.id ? { ...c, title: nextTitle, body_md: nextBody } : c,
        ),
      )
    }, AUTOSAVE_MS)
  }

  /** 카드 요약을 인용 블록으로 삽입 — Write 화면과 같은 형식 */
  function insertCard(card: Card) {
    const block = `\n> ${card.summary.replace(/\n/g, '\n> ')}\n> \n> — ${card.title}\n\n`
    const next = body + block
    setBody(next)
    scheduleSave(title, next)
  }

  const edited = !!current?.proposed_title && title.trim() !== current.proposed_title
  const totalChars = chapters.reduce((n, c) => n + c.body_md.length, 0)
  const editedCount = chapters.filter(
    (c) => c.proposed_title && c.title !== c.proposed_title,
  ).length

  if (!current) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20 text-center text-sm text-mint-500">
        챕터가 없습니다.
        <button onClick={onExit} className="ml-2 underline">
          돌아가기
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      {/* 책 머리 */}
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <button
            onClick={onExit}
            className="mr-3 text-xs text-mint-400 hover:text-mint-600"
          >
            ←
          </button>
          <span className="text-base font-semibold text-mint-900">{work.title}</span>
          <span className="ml-2 rounded bg-mint-200 px-1.5 py-0.5 text-xs text-mint-600">
            {fmt.label}
          </span>
          {work.thesis && (
            <span className="ml-3 text-xs text-mint-400">{work.thesis}</span>
          )}
        </div>
        <span className="text-xs text-mint-400">
          {totalChars.toLocaleString()}자 / 목표 {fmt.length} · 제목 수정 {editedCount}/
          {chapters.length}
        </span>
      </div>

      {/* 챕터 탭 */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {chapters.map((c) => (
          <button
            key={c.id}
            onClick={() => void select(c)}
            className={
              'rounded px-2.5 py-1 text-xs ' +
              (c.id === current.id
                ? 'bg-mint-800 text-white'
                : 'border border-mint-300 text-mint-500 hover:text-mint-700')
            }
          >
            {c.seq}. {c.title}
            {!!c.body_md.length && <span className="ml-1 opacity-60">✓</span>}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-5 md:grid-cols-[1fr_1.4fr]">
        {/* 좌: 이 챕터의 카드 */}
        <section className="max-h-[calc(100vh-12rem)] overflow-y-auto rounded-lg border
                            border-mint-200 bg-mint-50 p-4">
          <p className="mb-3 text-xs font-semibold text-mint-500">
            이 {fmt.unit}의 카드 {cards.length}장
          </p>
          {cards.length === 0 ? (
            <p className="text-xs text-mint-400">배치된 카드가 없습니다.</p>
          ) : (
            <ul className="space-y-2.5">
              {cards.map((c) => (
                <li key={c.id} className="rounded border border-mint-200 bg-white p-3">
                  <p className="text-sm font-medium text-mint-800">{c.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-mint-600">{c.summary}</p>
                  {c.my_take && (
                    <p className="mt-1.5 text-xs italic text-mint-500">{c.my_take}</p>
                  )}
                  <button
                    onClick={() => insertCard(c)}
                    className="mt-2 text-xs text-mint-500 hover:text-mint-900"
                  >
                    본문에 삽입 →
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 우: 집필 */}
        <section className="rounded-lg border border-mint-300 bg-white p-5 md:sticky md:top-6">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              scheduleSave(e.target.value, body)
            }}
            className="w-full border-0 p-0 text-lg font-semibold focus:ring-0"
          />

          {/* ★ AI 원안과 다르면 표시한다 (STRUCTURING.md §0.2) */}
          {current.proposed_title && (
            <p className="mb-3 mt-1 text-xs text-mint-400">
              {edited ? (
                <>
                  <span className="text-mint-600">내가 고친 제목</span> · AI 원안:{' '}
                  {current.proposed_title}
                </>
              ) : (
                <span className="text-amber-700">AI 제안 제목 그대로</span>
              )}
            </p>
          )}
          {current.gist && (
            <p className="mb-3 text-xs text-mint-400">{current.gist}</p>
          )}

          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              scheduleSave(title, e.target.value)
            }}
            placeholder={`왼쪽 카드를 보면서 이 ${fmt.unit}을 씁니다.`}
            className="min-h-[26rem] w-full resize-none border-0 p-0 text-sm leading-7 focus:ring-0"
          />

          <div className="mt-4 flex items-center justify-between border-t border-mint-200
                          pt-3 text-xs">
            <span className="text-mint-400">{body.length.toLocaleString()}자</span>
            <span className={saved ? 'text-mint-400' : 'text-amber-600'}>
              {saved ? '자동저장 ✓' : '저장 중…'}
            </span>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </section>
      </div>
    </div>
  )
}
