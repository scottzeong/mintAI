'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { relativeTime } from '@/lib/time'
import type { Card, Collection, Source, TagCount } from '@/lib/types'

/**
 * Library — 카드 목록·검색·분류 (docs/MVP.md §3.3, §3.6)
 *
 * 분류는 **다차원**이다. 카드 하나가 여러 컬렉션에 동시에 속하고 태그도 여럿 가진다.
 * 폴더처럼 한 곳에만 넣게 하면 "이건 조직론인가 경제학인가"를 매번 결정해야 하고,
 * 그건 §2가 경계한 "입력 시점에 판단을 강요하는 마찰"과 같은 문제다.
 *
 * 캔버스·드래그앤드롭은 유예했다 — 카드 10장짜리 캔버스는 목록보다 비어 보인다.
 * 여기서 만드는 건 그때 그릴 **데이터**다.
 */
export default function Library() {
  const [q, setQ] = useState('')
  const [cards, setCards] = useState<Card[]>([])
  const [sources, setSources] = useState<Record<number, Source[]>>({})
  const [selected, setSelected] = useState<Card | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [collections, setCollections] = useState<Collection[]>([])
  const [tags, setTags] = useState<TagCount[]>([])
  const [activeCollection, setActiveCollection] = useState<number | null>(null)
  const [activeTags, setActiveTags] = useState<string[]>([])

  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadFacets = useCallback(async () => {
    const [{ data: cols }, { data: tg }] = await Promise.all([
      supabase.rpc('collection_counts'),
      supabase.rpc('tag_counts'),
    ])
    setCollections((cols ?? []) as Collection[])
    setTags((tg ?? []) as TagCount[])
  }, [])

  const load = useCallback(
    async (query: string, collectionId: number | null, tagList: string[]) => {
      setLoading(true)
      const { data, error } = await supabase.rpc('search_cards', {
        p_q: query || null,
        p_tag: null,
        p_tags: tagList.length ? tagList : null,
        p_collection_id: collectionId,
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
    },
    [],
  )

  useEffect(() => {
    void loadFacets()
  }, [loadFacets])

  useEffect(() => {
    void load(q, activeCollection, activeTags)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCollection, activeTags, load])

  function onSearch(v: string) {
    setQ(v)
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void load(v, activeCollection, activeTags), 250)
  }

  function toggleTag(tag: string) {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    )
  }

  async function createCollection() {
    const name = prompt('새 컬렉션 이름')?.trim()
    if (!name) return
    const { error } = await supabase.from('collections').insert({ name })
    if (error) setError(error.message)
    else await loadFacets()
  }

  async function deleteCollection(id: number, name: string) {
    // 컬렉션을 지워도 카드는 남는다 (card_collections 만 CASCADE).
    // 분류는 카드에 대한 견해일 뿐, 카드 자체가 아니다.
    if (!confirm(`컬렉션 "${name}" 을 삭제할까요? 카드는 그대로 남습니다.`)) return
    const { error } = await supabase.from('collections').delete().eq('id', id)
    if (error) {
      setError(error.message)
      return
    }
    if (activeCollection === id) setActiveCollection(null)
    await loadFacets()
  }

  if (selected) {
    return (
      <CardDetail
        card={selected}
        sources={sources[selected.id] ?? []}
        collections={collections}
        onClose={async (changed) => {
          setSelected(null)
          if (changed) {
            await loadFacets()
            await load(q, activeCollection, activeTags)
          }
        }}
      />
    )
  }

  const filtered = activeCollection !== null || activeTags.length > 0

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        {/* ── 분류 사이드바 ── */}
        <aside className="space-y-6 text-sm">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-wider text-stone-400">컬렉션</h3>
              <button
                onClick={() => void createCollection()}
                className="text-xs text-stone-400 hover:text-stone-700"
              >
                + 새로
              </button>
            </div>
            <ul className="space-y-0.5">
              <li>
                <button
                  onClick={() => setActiveCollection(null)}
                  className={
                    'w-full rounded px-2 py-1 text-left ' +
                    (activeCollection === null
                      ? 'bg-stone-200 text-stone-900'
                      : 'text-stone-600 hover:bg-stone-100')
                  }
                >
                  전체
                </button>
              </li>
              {collections.map((c) => (
                <li key={c.id} className="group flex items-center gap-1">
                  <button
                    onClick={() => setActiveCollection(c.id)}
                    className={
                      'flex-1 rounded px-2 py-1 text-left ' +
                      (activeCollection === c.id
                        ? 'bg-stone-200 text-stone-900'
                        : 'text-stone-600 hover:bg-stone-100')
                    }
                  >
                    {c.name}
                    <span className="ml-1.5 text-xs text-stone-400">{c.n}</span>
                  </button>
                  <button
                    onClick={() => void deleteCollection(c.id, c.name)}
                    className="invisible px-1 text-xs text-stone-300 hover:text-red-600
                               group-hover:visible"
                    title="컬렉션 삭제"
                  >
                    ×
                  </button>
                </li>
              ))}
              {collections.length === 0 && (
                <li className="px-2 py-1 text-xs text-stone-400">아직 없습니다</li>
              )}
            </ul>
          </div>

          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-stone-400">
              태그
              {activeTags.length > 0 && (
                <button
                  onClick={() => setActiveTags([])}
                  className="ml-2 normal-case text-stone-400 hover:text-stone-700"
                >
                  해제
                </button>
              )}
            </h3>
            {tags.length === 0 ? (
              <p className="px-2 text-xs text-stone-400">아직 없습니다</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <button
                    key={t.tag}
                    onClick={() => toggleTag(t.tag)}
                    className={
                      'rounded-full px-2 py-0.5 text-xs ' +
                      (activeTags.includes(t.tag)
                        ? 'bg-stone-800 text-white'
                        : 'bg-stone-100 text-stone-600 hover:bg-stone-200')
                    }
                  >
                    {t.tag}
                    <span className="ml-1 opacity-60">{t.n}</span>
                  </button>
                ))}
              </div>
            )}
            {activeTags.length > 1 && (
              <p className="mt-2 px-1 text-xs text-stone-400">
                태그를 여러 개 고르면 <strong>전부 만족</strong>하는 카드만 남습니다
              </p>
            )}
          </div>
        </aside>

        {/* ── 카드 목록 ── */}
        <main>
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
              {q || filtered
                ? '조건에 맞는 카드가 없습니다.'
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
        </main>
      </div>
    </div>
  )
}

// ─────────────────────────── 상세 / 수정 / 분류 ───────────────────────────

function CardDetail({
  card,
  sources,
  collections,
  onClose,
}: {
  card: Card
  sources: Source[]
  collections: Collection[]
  onClose: (changed: boolean) => void
}) {
  const [title, setTitle] = useState(card.title)
  const [summary, setSummary] = useState(card.summary)
  const [myTake, setMyTake] = useState(card.my_take ?? '')
  const [tags, setTags] = useState(card.tags ?? '')
  const [member, setMember] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('card_collections')
      .select('collection_id')
      .eq('card_id', card.id)
      .then(({ data }) => {
        setMember(new Set(((data ?? []) as { collection_id: number }[]).map((r) => r.collection_id)))
      })
  }, [card.id])

  const dirty =
    title !== card.title ||
    summary !== card.summary ||
    myTake !== (card.my_take ?? '') ||
    tags !== (card.tags ?? '')

  /** 컬렉션 소속은 즉시 반영한다 — 분류는 "저장" 버튼을 누를 만한 무게가 아니다. */
  async function toggleCollection(id: number, on: boolean) {
    const next = new Set(member)
    if (on) next.add(id)
    else next.delete(id)
    setMember(next)

    const { error } = on
      ? await supabase.from('card_collections').insert({ card_id: card.id, collection_id: id })
      : await supabase
          .from('card_collections')
          .delete()
          .eq('card_id', card.id)
          .eq('collection_id', id)
    if (error) setError(error.message)
  }

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

      {/* 컬렉션 — 여러 곳에 동시에 속할 수 있다 */}
      <div className="mb-5 rounded-lg border border-stone-200 bg-white p-4">
        <p className="mb-2 text-xs font-semibold text-stone-500">
          컬렉션 <span className="font-normal text-stone-400">— 여러 곳에 넣어도 됩니다</span>
        </p>
        {collections.length === 0 ? (
          <p className="text-xs text-stone-400">
            아직 컬렉션이 없습니다. 목록 화면 좌측에서 만들 수 있습니다.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {collections.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border
                           border-stone-200 px-2.5 py-1 text-sm text-stone-600
                           hover:border-stone-400"
              >
                <input
                  type="checkbox"
                  checked={member.has(c.id)}
                  onChange={(e) => void toggleCollection(c.id, e.target.checked)}
                  className="h-3.5 w-3.5 accent-stone-600"
                />
                {c.name}
              </label>
            ))}
          </div>
        )}
      </div>

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
                    rel="noreferrer noopener"
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
