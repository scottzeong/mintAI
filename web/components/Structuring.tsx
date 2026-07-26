'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { FORMATS, formatOf, MIN_CARDS_ANY } from '@/lib/formats'
import type { Card, Proposal, StructuringRun } from '@/lib/types'

export { MIN_CARDS_ANY }

/**
 * Structuring — 카드에서 책 구조를 제안받는다 (docs/STRUCTURING.md)
 *
 * 제안은 **3개**다. 하나면 그럴듯하다는 이유로 그냥 받아들이게 된다 — 앵커링이다.
 * 셋을 나란히 놓으면 비교가 강제되고, 그때 "내가 쓰고 싶은 책"을 스스로 판단한다.
 *
 * 확정하면 채택된 제안만 works/chapters 로 승계되고 **나머지 둘은 폐기된다.**
 * Digest 와 같은 패턴이다 — 쓰이지 않은 AI 산문은 남기지 않는다.
 */
export default function Structuring({
  cards,
  onConfirmed,
  onClose,
}: {
  cards: Card[]
  onConfirmed: (workId: number) => void
  onClose: () => void
}) {
  const [run, setRun] = useState<StructuringRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [showExcluded, setShowExcluded] = useState<number | null>(null)
  // 쓸 수 있는 것 중 가장 큰 형식을 기본값으로 — 카드를 많이 모았으면 큰 글을
  // 노리는 게 자연스럽고, 줄이는 건 클릭 한 번이다.
  const [fmtKey, setFmtKey] = useState<string>(
    () =>
      [...FORMATS].reverse().find((f) => cards.length >= f.minCards)?.key ??
      FORMATS[0].key,
  )
  const fmt = formatOf(fmtKey)

  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(pollTimer.current), [])

  const cardById = new Map(cards.map((c) => [c.id, c]))

  async function start() {
    setBusy(true)
    setError(null)
    setRun(null)
    setPicked(null)

    // research 와 같은 패턴: 행을 먼저 만들고 던져놓은 뒤 폴링한다.
    const { data, error: insErr } = await supabase
      .from('structuring_runs')
      .insert({ status: 'running', format: fmtKey })
      .select()
      .single()
    if (insErr) {
      setBusy(false)
      setError(insErr.message)
      return
    }
    const runId = (data as StructuringRun).id
    setRun(data as StructuringRun)

    void supabase.functions
      .invoke('structure', { body: { run_id: runId } })
      .catch(() => {
        /* 실패는 폴링이 status='failed' 로 확인한다 */
      })

    const started = Date.now()
    const poll = async () => {
      const { data: row } = await supabase
        .from('structuring_runs')
        .select('*')
        .eq('id', runId)
        .single()
      const r = row as StructuringRun | null

      if (r?.status === 'ready') {
        setRun(r)
        setBusy(false)
        return
      }
      if (r?.status === 'failed') {
        setRun(r)
        setBusy(false)
        setError(r.error ?? '구조 제안에 실패했습니다')
        return
      }
      if (Date.now() - started > 240_000) {
        setBusy(false)
        setError('제안이 너무 오래 걸립니다. 잠시 후 다시 시도하세요.')
        return
      }
      pollTimer.current = setTimeout(() => void poll(), 2500)
    }
    pollTimer.current = setTimeout(() => void poll(), 3000)
  }

  async function confirmProposal(index: number) {
    if (!run) return
    const p = run.output_json?.proposals?.[index]
    if (!p) return
    if (
      !window.confirm(
        `"${p.title}" (${fmt.label}) 로 확정할까요?\n나머지 두 제안은 폐기됩니다.`,
      )
    )
      return

    setBusy(true)
    const { data, error } = await supabase.rpc('confirm_structure', {
      p_run_id: run.id,
      p_index: index,
    })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    onConfirmed((data as { id: number }).id)
  }

  const proposals = run?.output_json?.proposals ?? []

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <button
        onClick={onClose}
        className="mb-4 text-xs text-stone-400 hover:text-stone-600"
      >
        ← Library 로
      </button>

      {proposals.length === 0 && (
        <div className="rounded-lg border border-stone-200 bg-white p-8">
          <h2 className="text-lg font-semibold text-stone-800">무엇을 쓸까요</h2>
          <p className="mt-2 text-sm text-stone-500">
            카드 {cards.length}장 전체를 읽고 서로 다른 구조 3개를 제안합니다.
            논지에 맞지 않는 카드는 이유와 함께 제외됩니다.
          </p>

          {/* 종류마다 최소 카드 수·구성 단위·분량이 다르다 (STRUCTURING.md §8) */}
          <div className="mt-6 space-y-2">
            {FORMATS.map((f) => {
              const ok = cards.length >= f.minCards
              const active = fmtKey === f.key
              return (
                <button
                  key={f.key}
                  onClick={() => ok && setFmtKey(f.key)}
                  disabled={!ok || busy}
                  className={
                    'flex w-full items-baseline gap-3 rounded-lg border px-4 py-3 text-left ' +
                    (active
                      ? 'border-stone-800 bg-stone-50'
                      : ok
                        ? 'border-stone-200 hover:border-stone-400'
                        : 'border-stone-100 opacity-50')
                  }
                >
                  <span
                    className={
                      'text-sm font-medium ' + (ok ? 'text-stone-900' : 'text-stone-400')
                    }
                  >
                    {f.label}
                  </span>
                  <span className="flex-1 text-xs text-stone-400">{f.hint}</span>
                  <span className="shrink-0 text-xs text-stone-400">
                    {f.unit} {f.units[0]}~{f.units[1]} · {f.length}
                  </span>
                  <span
                    className={
                      'shrink-0 text-xs ' + (ok ? 'text-stone-400' : 'text-amber-700')
                    }
                  >
                    {ok ? `카드 ${f.minCards}+` : `${f.minCards - cards.length}장 더`}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="mt-6 flex items-center justify-between">
            <p className="text-xs text-stone-400">
              {fmt.unit} {fmt.units[0]}~{fmt.units[1]}개로 구성됩니다
            </p>
            <button
              onClick={() => void start()}
              disabled={busy || cards.length < fmt.minCards}
              className="rounded-lg bg-stone-800 px-6 py-2.5 text-sm text-white
                         disabled:bg-stone-300"
            >
              {busy ? '읽는 중… (1~3분)' : `${fmt.label} 구조 제안 받기`}
            </button>
          </div>
          {busy && (
            <p className="mt-3 text-right text-xs text-stone-400">
              카드를 전부 읽고 세 가지 구성을 만드는 중입니다. 창을 닫지 마세요.
            </p>
          )}
          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        </div>
      )}

      {proposals.length > 0 && (
        <>
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-stone-800">
              {fmt.label} — 세 가지 구조 중 하나를 고르세요
            </h2>
            <p className="mt-1 text-sm text-stone-500">
              확정하면 나머지 둘은 폐기됩니다. 챕터 제목은 나중에 언제든 고칠 수 있습니다.
            </p>
          </div>

          <div className="space-y-5">
            {proposals.map((p: Proposal, i) => {
              const used = p.chapters.reduce((n, c) => n + (c.card_ids?.length ?? 0), 0)
              const exRate = cards.length ? (p.excluded?.length ?? 0) / cards.length : 0
              return (
                <section
                  key={i}
                  className={
                    'rounded-lg border bg-white p-5 transition-colors ' +
                    (picked === i ? 'border-stone-800' : 'border-stone-200')
                  }
                >
                  <button
                    onClick={() => setPicked(picked === i ? null : i)}
                    className="w-full text-left"
                  >
                    <h3 className="text-base font-semibold text-stone-900">{p.title}</h3>
                    {p.thesis && (
                      <p className="mt-1 text-sm text-stone-600">{p.thesis}</p>
                    )}
                    <p className="mt-2 flex flex-wrap gap-3 text-xs text-stone-400">
                      {p.audience && <span>{p.audience}</span>}
                      <span>{fmt.unit} {p.chapters.length}개</span>
                      <span>카드 {used}장 사용</span>
                      {!!p.excluded?.length && (
                        <span className={exRate > 0.5 ? 'text-amber-700' : ''}>
                          {p.excluded.length}장 제외
                        </span>
                      )}
                    </p>
                  </button>

                  {/* ★ 제외율이 높으면 그건 AI가 까다로운 게 아니라
                      카드가 책 하나로 안 묶인다는 신호다 (STRUCTURING.md §1.2) */}
                  {exRate > 0.5 && (
                    <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      카드의 절반 이상이 제외됐습니다. 이 카드들이 책 한 권으로 묶이지
                      않는다는 뜻일 수 있습니다 — 확정 전에 Collection 으로 갈라내는 걸
                      고려해 보세요.
                    </p>
                  )}

                  {picked === i && (
                    <div className="mt-4 border-t border-stone-200 pt-4">
                      <ol className="space-y-2.5">
                        {p.chapters.map((ch, j) => (
                          <li key={j} className="text-sm">
                            <span className="mr-2 text-stone-400">{j + 1}</span>
                            <span className="font-medium text-stone-800">{ch.title}</span>
                            {ch.gist && (
                              <p className="ml-6 mt-0.5 text-xs text-stone-500">{ch.gist}</p>
                            )}
                            <p className="ml-6 mt-1 flex flex-wrap gap-1">
                              {(ch.card_ids ?? []).map((id) => (
                                <span
                                  key={id}
                                  title={cardById.get(id)?.summary}
                                  className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600"
                                >
                                  {cardById.get(id)?.title ?? `#${id}`}
                                </span>
                              ))}
                            </p>
                          </li>
                        ))}
                      </ol>

                      {!!p.excluded?.length && (
                        <div className="mt-4">
                          <button
                            onClick={() =>
                              setShowExcluded(showExcluded === i ? null : i)
                            }
                            className="text-xs text-stone-400 hover:text-stone-700"
                          >
                            제외된 카드 {p.excluded.length}장 {showExcluded === i ? '▲' : '▼'}
                          </button>
                          {showExcluded === i && (
                            <ul className="mt-2 space-y-1.5">
                              {p.excluded.map((e) => (
                                <li key={e.card_id} className="text-xs text-stone-500">
                                  <span className="text-stone-700">
                                    {cardById.get(e.card_id)?.title ?? `#${e.card_id}`}
                                  </span>
                                  {' — '}
                                  {e.reason}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      <button
                        onClick={() => void confirmProposal(i)}
                        disabled={busy}
                        className="mt-5 w-full rounded-lg bg-stone-800 py-2.5 text-sm
                                   text-white disabled:bg-stone-300"
                      >
                        Confirm — 이 구조로 시작
                      </button>
                    </div>
                  )}
                </section>
              )
            })}
          </div>
          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        </>
      )}
    </div>
  )
}
