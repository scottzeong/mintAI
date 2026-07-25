'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { relativeTime } from '@/lib/time'
import type { Card, Source } from '@/lib/types'

/**
 * Library — 카드 목록·검색 (docs/MVP.md §3.3)
 *
 * 검색은 `search_cards()` RPC 를 쓴다. 클라이언트에서 `ilike` 를 직접 조립하지
 * 않는 이유는 §2.1 에 있다 — 한국어 검색 규칙을 한 곳에 두어야, Write 화면의
 * 카드 검색과 여기가 영원히 같은 결과를 낸다.
 *
 * 그래프·유사 카드 추천은 없다. 카드 100장을 넘기기 전에는 무의미하다(§1.2).
 */
export default function Library() {
  const [q, setQ] = useState('')
  const [cards, setCards] = useState<Card[]>([])
  const [sources, setSources] = useState<Record<number, Source[]>>({})
  const [selected, setSelected] = useState<Card | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(async (query: string) => {
    setLoading(true)
    const { data, error } = await supabase.rpc('search_cards', {
      p_q: query || null,
      p_tag: null,
    })
    setLoading(false)

    if (error) {
      setError(error.message)
      return
    }
    setError(null)
    const list = (data ?? []) as Card[]
    setCards(list)

    // 출처는 한 번에 모아 가져온다 (카드마다 쿼리하면 N+1)
    if (list.length) {
      const { data: srcs } = await supabase
        .from('sources')
        .select('id, card_id, url, title')
        .in('card_id', list.map((c) => c.id))
      const map: Record<number, Source[]> = {}
      for (const s of (srcs ?? []) as Source[]) {
        ;(map[s.card_id!] ??= []).push(s)
      }
      setSources(map)
    } else {
      setSources({})
    }
  }, [])

  useEffect(() => {
    void load('')
  }, [load])

  function onSearch(v: string) {
    setQ(v)
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void load(v), 250)
  }

  if (selected) {
    return (
      <CardDetail
        card={selected}
        sources={sources[selected.id] ?? []}
        onClose={async (changed) => {
          setSelected(null)
          if (changed) await load(q)
        }}
      />
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-5 flex items-center gap-3">
        <input
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="🔍  카드 검색 — 두 글자도 됩니다"
          className="flex-1 rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm"
        />
        <span className="shrink-0 text-sm text-stone-400">{cards.length}장</span>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-stone-400">불러오는 중…</p>
      ) : cards.length === 0 ? (
        <p className="text-sm text-stone-400">
          {q
            ? `"${q}" 에 해당하는 카드가 없습니다.`
            : '아직 카드가 없습니다. Digest 에서 자료를 소화하면 여기에 쌓입니다.'}
        </p>
      ) : (
        <ul className="divide-y divide-stone-200">
          {cards.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setSelected(c)}
                className="w-full py-4 text-left hover:bg-stone-100/60"
              >
                <p className="font-medium text-stone-800">{c.title}</p>
                <p className="mt-1 line-clamp-2 text-sm text-stone-600">{c.summary}</p>
                <p className="mt-1.5 flex items-center gap-3 text-xs text-stone-400">
                  {c.tags && (
                    <span className="text-stone-500">
                      {c.tags
                        .split(',')
                        .map((t) => `#${t.trim()}`)
                        .join(' ')}
                    </span>
                  )}
                  {!!sources[c.id]?.length && <span>출처 {sources[c.id].length}</span>}
                  <span>{relativeTime(c.created_at)}</span>
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─────────────────────────── 상세 / 수정 ───────────────────────────

function CardDetail({
  card,
  sources,
  onClose,
}: {
  card: Card
  sources: Source[]
  onClose: (changed: boolean) => void
}) {
  const [title, setTitle] = useState(card.title)
  const [summary, setSummary] = useState(card.summary)
  const [myTake, setMyTake] = useState(card.my_take ?? '')
  const [tags, setTags] = useState(card.tags ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    title !== card.title ||
    summary !== card.summary ||
    myTake !== (card.my_take ?? '') ||
    tags !== (card.tags ?? '')

  async function save() {
    if (!title.trim() || !summary.trim()) {
      setError('제목과 요약은 비울 수 없습니다')
      return
    }
    setBusy(true)
    const { error } = await supabase
      .from('cards')
      .update({
        title: title.trim(),
        summary: summary.trim(),
        my_take: myTake.trim() || null,
        tags: tags.trim() || null,
      })
      .eq('id', card.id)
    setBusy(false)
    if (error) setError(error.message)
    else onClose(true)
  }

  async function remove() {
    // 카드 삭제는 출처까지 함께 사라진다 (ON DELETE CASCADE).
    // 착상은 남는다 — idea_id 는 SET NULL 이라 캡처 기록은 보존된다.
    if (!confirm(`"${card.title}" 카드를 삭제할까요? 출처도 함께 사라집니다.`)) return
    setBusy(true)
    const { error } = await supabase.from('cards').delete().eq('id', card.id)
    setBusy(false)
    if (error) setError(error.message)
    else onClose(true)
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <button
        onClick={() => onClose(false)}
        className="mb-4 text-xs text-stone-400 hover:text-stone-600"
      >
        ← 목록으로
      </button>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="mb-4 w-full rounded border border-stone-300 bg-white px-3 py-2 text-base font-medium"
      />

      <label className="mb-1 block text-xs text-stone-500">요약</label>
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        rows={6}
        className="mb-4 w-full resize-none rounded border border-stone-300 bg-white px-3 py-2 text-sm leading-relaxed"
      />

      <label className="mb-1 block text-xs text-stone-500">내 생각</label>
      <textarea
        value={myTake}
        onChange={(e) => setMyTake(e.target.value)}
        rows={4}
        className="mb-4 w-full resize-none rounded border border-stone-300 bg-white px-3 py-2 text-sm leading-relaxed"
      />

      <input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="태그 (쉼표 구분)"
        className="mb-5 w-full rounded border border-stone-300 bg-white px-3 py-2 text-sm"
      />

      {sources.length > 0 && (
        <div className="mb-5 rounded-lg border border-stone-200 bg-white p-4">
          <p className="mb-2 text-xs font-semibold text-stone-500">출처</p>
          <ul className="space-y-1.5">
            {sources.map((s) => (
              <li key={s.id} className="text-sm">
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-stone-600 underline decoration-stone-300 hover:text-stone-900"
                  >
                    {s.title || s.url}
                  </a>
                ) : (
                  <span className="text-stone-600">{s.title}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="flex items-center justify-between">
        <button
          onClick={() => void remove()}
          disabled={busy}
          className="text-sm text-red-600 hover:underline disabled:opacity-40"
        >
          삭제
        </button>
        <button
          onClick={() => void save()}
          disabled={!dirty || busy}
          className="rounded-lg bg-stone-800 px-5 py-2 text-sm text-white disabled:bg-stone-300"
        >
          {dirty ? '저장' : '변경 없음'}
        </button>
      </div>
    </div>
  )
}
