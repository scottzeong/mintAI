'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { relativeTime } from '@/lib/time'
import Structuring from '@/components/Structuring'
import { MIN_CARDS_ANY } from '@/lib/formats'
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
  /** 조회 자체가 실패했는가 — "카드 0장"과 구분해야 한다 */
  const [loadFailed, setLoadFailed] = useState(false)

  const [collections, setCollections] = useState<Collection[]>([])
  const [tags, setTags] = useState<TagCount[]>([])
  const [activeCollection, setActiveCollection] = useState<number | null>(null)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [structuring, setStructuring] = useState(false)
  const [allCards, setAllCards] = useState<Card[]>([])

  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // ★ Structuring 은 필터 결과가 아니라 **전체 카드**를 대상으로 한다 (§6 결정 3).
  //   화면에서 보고 있는 것과 제안 대상이 다르면 혼란스럽지만, 필터로 좁힌 상태에서
  //   누른 제안이 "내 카드 전부"가 아니라는 건 더 혼란스럽다.
  const loadAllCards = useCallback(async () => {
    const { data } = await supabase
      .from('cards')
      .select('*')
      .order('created_at', { ascending: true })
    setAllCards((data ?? []) as Card[])
  }, [])

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
        // ⚠ 조회 실패를 "카드 없음"처럼 보여주면 안 된다.
        //   실제로 겪은 사고: search_cards 시그니처가 안 맞아 RPC 가 실패했는데
        //   화면에는 "아직 카드가 없습니다"가 떠서, 데이터가 사라진 줄 알았다.
        //   빈 상태와 오류 상태는 원인도 대처도 완전히 다르다.
        setError(error.message)
        setCards([])
        setLoadFailed(true)
        return
      }
      setError(null)
      setLoadFailed(false)
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
    void loadAllCards()
  }, [loadFacets, loadAllCards])

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
    const name = prompt('새 Collection 이름')?.trim()
    if (!name) return
    const { error } = await supabase.from('collections').insert({ name })
    if (error) setError(error.message)
    else await loadFacets()
  }

  async function deleteCollection(id: number, name: string) {
    // 컬렉션을 지워도 카드는 남는다 (card_collections 만 CASCADE).
    // 분류는 카드에 대한 견해일 뿐, 카드 자체가 아니다.
    if (!confirm(`Collection "${name}" 을 삭제할까요? 카드는 그대로 남습니다.`)) return
    const { error } = await supabase.from('collections').delete().eq('id', id)
    if (error) {
      setError(error.message)
      return
    }
    if (activeCollection === id) setActiveCollection(null)
    await loadFacets()
  }

  if (structuring) {
    return (
      <Structuring
        cards={allCards}
        onClose={() => setStructuring(false)}
        onConfirmed={() => {
          setStructuring(false)
          alert('책 구조가 확정되었습니다. Write 화면에서 이어서 쓰세요.')
        }}
      />
    )
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
              <h3 className="text-xs uppercase tracking-wider text-mint-400">Collection</h3>
              <button
                onClick={() => void createCollection()}
                className="text-xs text-mint-400 hover:text-mint-700"
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
                      ? 'bg-mint-200 text-mint-900'
                      : 'text-mint-600 hover:bg-mint-100')
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
                        ? 'bg-mint-200 text-mint-900'
                        : 'text-mint-600 hover:bg-mint-100')
                    }
                  >
                    {c.name}
                    <span className="ml-1.5 text-xs text-mint-400">{c.n}</span>
                  </button>
                  <button
                    onClick={() => void deleteCollection(c.id, c.name)}
                    className="invisible px-1 text-xs text-mint-300 hover:text-red-600
                               group-hover:visible"
                    title="Collection 삭제"
                  >
                    ×
                  </button>
                </li>
              ))}
              {collections.length === 0 && (
                <li className="px-2 py-1 text-xs text-mint-400">아직 없습니다</li>
              )}
            </ul>
          </div>

          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-mint-400">
              Tag
              {activeTags.length > 0 && (
                <button
                  onClick={() => setActiveTags([])}
                  className="ml-2 normal-case text-mint-400 hover:text-mint-700"
                >
                  해제
                </button>
              )}
            </h3>
            {tags.length === 0 ? (
              <p className="px-2 text-xs text-mint-400">아직 없습니다</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <button
                    key={t.tag}
                    onClick={() => toggleTag(t.tag)}
                    className={
                      'rounded-full px-2 py-0.5 text-xs ' +
                      (activeTags.includes(t.tag)
                        ? 'bg-mint-800 text-white'
                        : 'bg-mint-100 text-mint-600 hover:bg-mint-200')
                    }
                  >
                    {t.tag}
                    <span className="ml-1 opacity-60">{t.n}</span>
                  </button>
                ))}
              </div>
            )}
            {activeTags.length > 1 && (
              <p className="mt-2 px-1 text-xs text-mint-400">
                Tag 를 여러 개 고르면 <strong>전부 만족</strong>하는 카드만 남습니다
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
              className="flex-1 rounded-lg border border-mint-300 bg-white px-4 py-2.5 text-sm"
            />
            <span className="shrink-0 text-sm text-mint-400">{cards.length}장</span>
            {/* 카드 수가 부족하면 비활성 — 카드 5장으로 만든 책 구조는 우스운
                결과가 나오고, 그 인상이 "이 기능은 쓸모없다"가 된다 (§1.3) */}
            <button
              onClick={() => setStructuring(true)}
              disabled={allCards.length < MIN_CARDS_ANY}
              title={
                allCards.length < MIN_CARDS_ANY
                  ? `구조 제안은 카드 ${MIN_CARDS_ANY}장부터 (현재 ${allCards.length}장)`
                  : `전체 카드 ${allCards.length}장으로 글의 구조를 제안받습니다`
              }
              className="shrink-0 rounded-lg bg-mint-800 px-3 py-2 text-sm text-white
                         disabled:bg-mint-200 disabled:text-mint-400"
            >
              Structuring
            </button>
          </div>

          {allCards.length < MIN_CARDS_ANY && (
            <p className="mb-4 text-xs text-mint-400">
              구조 제안은 카드 {MIN_CARDS_ANY}장부터 — 현재 {allCards.length}장
            </p>
          )}

          {loading ? (
            <p className="text-sm text-mint-400">불러오는 중…</p>
          ) : loadFailed ? (
            // 오류일 때는 빈 상태 문구를 아예 띄우지 않는다
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-medium text-red-800">
                카드를 불러오지 못했습니다 — 데이터가 없는 것이 아닙니다
              </p>
              <p className="mt-1.5 break-words text-xs text-red-700">{error}</p>
              {error?.includes('schema cache') && (
                <p className="mt-2 text-xs text-red-700">
                  DB 함수가 최신이 아닐 수 있습니다. Supabase SQL Editor 에서
                  마이그레이션을 번호 순서대로 실행한 뒤{' '}
                  <code className="rounded bg-red-100 px-1">
                    notify pgrst, &apos;reload schema&apos;;
                  </code>{' '}
                  를 실행하세요.
                </p>
              )}
              <button
                onClick={() => void load(q, activeCollection, activeTags)}
                className="mt-3 rounded border border-red-300 px-3 py-1 text-xs text-red-800"
              >
                다시 시도
              </button>
            </div>
          ) : cards.length === 0 ? (
            <p className="text-sm text-mint-400">
              {q || filtered
                ? '조건에 맞는 카드가 없습니다.'
                : '아직 카드가 없습니다. Digest 에서 자료를 소화하면 여기에 쌓입니다.'}
            </p>
          ) : (
            <ul className="divide-y divide-mint-200">
              {cards.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelected(c)}
                    className="w-full py-4 text-left hover:bg-mint-100/60"
                  >
                    <p className="font-medium text-mint-800">{c.title}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-mint-600">{c.summary}</p>
                    <p className="mt-1.5 flex items-center gap-3 text-xs text-mint-400">
                      {c.tags && (
                        <span className="text-mint-500">
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
        className="mb-4 text-xs text-mint-400 hover:text-mint-600"
      >
        ← 목록으로
      </button>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="mb-4 w-full rounded border border-mint-300 bg-white px-3 py-2 text-base font-medium"
      />

      <label className="mb-1 block text-xs text-mint-500">요약</label>
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        rows={6}
        className="mb-4 w-full resize-none rounded border border-mint-300 bg-white px-3 py-2 text-sm leading-relaxed"
      />

      <label className="mb-1 block text-xs text-mint-500">내 생각</label>
      <textarea
        value={myTake}
        onChange={(e) => setMyTake(e.target.value)}
        rows={4}
        className="mb-4 w-full resize-none rounded border border-mint-300 bg-white px-3 py-2 text-sm leading-relaxed"
      />

      <input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="Tag (쉼표 구분)"
        className="mb-5 w-full rounded border border-mint-300 bg-white px-3 py-2 text-sm"
      />

      {/* 컬렉션 — 여러 곳에 동시에 속할 수 있다 */}
      <div className="mb-5 rounded-lg border border-mint-200 bg-white p-4">
        <p className="mb-2 text-xs font-semibold text-mint-500">
          Collection <span className="font-normal text-mint-400">— 여러 곳에 넣어도 됩니다</span>
        </p>
        {collections.length === 0 ? (
          <p className="text-xs text-mint-400">
            아직 Collection 이 없습니다. 목록 화면 좌측에서 만들 수 있습니다.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {collections.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border
                           border-mint-200 px-2.5 py-1 text-sm text-mint-600
                           hover:border-mint-400"
              >
                <input
                  type="checkbox"
                  checked={member.has(c.id)}
                  onChange={(e) => void toggleCollection(c.id, e.target.checked)}
                  className="h-3.5 w-3.5 accent-mint-600"
                />
                {c.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {sources.length > 0 && (
        <div className="mb-5 rounded-lg border border-mint-200 bg-white p-4">
          <p className="mb-2 text-xs font-semibold text-mint-500">출처</p>
          <ul className="space-y-1.5">
            {sources.map((s) => (
              <li key={s.id} className="text-sm">
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-mint-600 underline decoration-mint-300 hover:text-mint-900"
                  >
                    {s.title || s.url}
                  </a>
                ) : (
                  <span className="text-mint-600">{s.title}</span>
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
          className="rounded-lg bg-mint-800 px-5 py-2 text-sm text-white disabled:bg-mint-200 disabled:text-mint-500"
        >
          {dirty ? 'Save' : '변경 없음'}
        </button>
      </div>
    </div>
  )
}
