import { useCallback, useEffect, useRef, useState } from 'react'
import { createIdea, listIdeas, type Idea } from '../api'
import { relativeTime } from '../time'

/**
 * Capture — 착상 즉시 입력 (docs/MVP.md §3.1)
 *
 * 이 화면의 유일한 목표는 **마찰 제로**다. 태그도 분류도 없다.
 * Week 1 검증 기준: "아이디어 10개를 3초 내로 각각 저장".
 *
 * 그래서 저장을 낙관적으로 처리한다 — 서버 응답을 기다리면 3초 안에 10개를
 * 넣을 수 없고, 무엇보다 생각의 흐름이 끊긴다. 실패하면 그때 되돌린다.
 */
export default function Capture() {
  const [thought, setThought] = useState('')
  const [needsResearch, setNeedsResearch] = useState(false)
  const [question, setQuestion] = useState('')
  const [recent, setRecent] = useState<Idea[]>([])
  const [error, setError] = useState<string | null>(null)

  const thoughtRef = useRef<HTMLTextAreaElement>(null)
  // 낙관적 항목에 부여할 임시 음수 id (서버 id 와 충돌하지 않게)
  const tempId = useRef(-1)

  useEffect(() => {
    listIdeas(undefined, 20).then(setRecent).catch(() => {
      setError('최근 목록을 불러오지 못했습니다. 백엔드가 켜져 있나요?')
    })
  }, [])

  const save = useCallback(async () => {
    const text = thought.trim()
    if (!text) return

    const q = needsResearch ? question.trim() : ''
    const optimistic: Idea = {
      id: tempId.current--,
      raw_thought: text,
      question: q || null,
      status: 'inbox',
      created_at: new Date().toISOString(),
    }

    // ★ 입력란을 먼저 비운다. 서버를 기다리지 않는다.
    setThought('')
    setQuestion('')
    setNeedsResearch(false)
    setError(null)
    setRecent((prev) => [optimistic, ...prev])
    thoughtRef.current?.focus()

    try {
      const saved = await createIdea(text, q || null)
      setRecent((prev) => prev.map((i) => (i.id === optimistic.id ? saved : i)))
    } catch {
      setRecent((prev) => prev.filter((i) => i.id !== optimistic.id))
      setError(`저장 실패: "${text.slice(0, 30)}${text.length > 30 ? '…' : ''}"`)
      // 입력 내용을 잃지 않게 되돌린다 — 착상을 날리는 건 이 도구에서 최악의 실패다
      setThought(text)
    }
  }, [thought, needsResearch, question])

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void save()
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <textarea
        ref={thoughtRef}
        autoFocus
        value={thought}
        onChange={(e) => setThought(e.target.value)}
        onKeyDown={onKeyDown}
        rows={4}
        placeholder="지금 떠오른 생각을 그대로…"
        className="w-full resize-none rounded-lg border border-stone-300 bg-white p-4
                   text-lg leading-relaxed placeholder:text-stone-400"
      />

      <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-stone-600">
        <input
          type="checkbox"
          checked={needsResearch}
          onChange={(e) => setNeedsResearch(e.target.checked)}
          className="h-4 w-4 accent-stone-600"
        />
        자료 조사가 필요하다
      </label>

      {needsResearch && (
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="무엇을 알아야 하나?"
          className="mt-2 w-full rounded-lg border border-stone-300 bg-white px-4 py-2
                     text-sm placeholder:text-stone-400"
        />
      )}

      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm text-red-600">{error}</span>
        <button
          onClick={() => void save()}
          disabled={!thought.trim()}
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm text-white
                     disabled:bg-stone-300"
        >
          저장 <span className="ml-1 opacity-60">⌘↵</span>
        </button>
      </div>

      <div className="mt-10">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-stone-400">최근</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-stone-400">아직 없습니다.</p>
        ) : (
          <ul className="divide-y divide-stone-200">
            {recent.map((idea) => (
              <li key={idea.id} className="flex items-baseline gap-3 py-2.5">
                <span className="flex-1 text-stone-700">{idea.raw_thought}</span>
                {idea.question && (
                  <span
                    title={idea.question}
                    className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                  >
                    조사 대기
                  </span>
                )}
                <time className="shrink-0 text-xs text-stone-400">
                  {relativeTime(idea.created_at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
