/**
 * 백엔드 API 클라이언트.
 *
 * dev 에서는 vite proxy 가 /api → 127.0.0.1:8787 로 넘긴다 (vite.config.ts).
 * 빌드 후에는 FastAPI 가 정적 파일을 같은 오리진에서 서빙하므로 경로가 그대로 맞는다.
 */

export interface Idea {
  id: number
  raw_thought: string
  question: string | null
  status: string
  created_at: string
}

export interface Card {
  id: number
  idea_id: number | null
  title: string
  summary: string
  my_take: string | null
  tags: string | null
  created_at: string
}

export interface Source {
  url: string | null
  title: string | null
}

export interface ResearchRun {
  id: number
  idea_id: number
  /** ⚠ 휘발성. 소화되면 null 이 된다 (원칙 1) */
  output_md: string | null
  sources: Source[]
  model: string | null
  ran_at: string
  error: string | null
  purged_at: string | null
}

export interface Stats {
  ideas: number
  cards: number
  drafts: number
  pending_digest: number
  digest_rate: number
  active_days: number
  avg_queue: number
  paste_blocked: number
  long_drafts: number
}

class ApiError extends Error {
  // 생성자 파라미터 프로퍼티(`readonly status: number`)는 tsconfig 의
  // erasableSyntaxOnly 때문에 쓸 수 없다 — 타입만 지우면 사라지는 문법이 아니어서다.
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    // FastAPI 검증 오류는 detail 이 배열이라 그대로 쓰면 [object Object] 가 된다
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* 본문 없음 — statusText 사용 */
    }
    throw new ApiError(detail, res.status)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const listIdeas = (status?: string, limit = 20) =>
  request<Idea[]>(
    `/ideas?limit=${limit}` + (status ? `&status=${encodeURIComponent(status)}` : ''),
  )

export const createIdea = (raw_thought: string, question?: string | null) =>
  request<Idea>('/ideas', {
    method: 'POST',
    body: JSON.stringify({ raw_thought, question: question || null }),
  })

export const deleteIdea = (id: number) =>
  request<void>(`/ideas/${id}`, { method: 'DELETE' })

export const listCards = (q?: string) =>
  request<Card[]>('/cards' + (q ? `?q=${encodeURIComponent(q)}` : ''))

export const startResearch = (id: number) =>
  request<{ status: string }>(`/ideas/${id}/research`, { method: 'POST' })

export const getRun = (id: number) => request<ResearchRun>(`/ideas/${id}/run`)

export interface DigestPayload {
  title: string
  summary: string
  my_take?: string | null
  tags?: string | null
  /** run.sources 배열의 인덱스 (DB id 가 아니다) */
  source_ids: number[]
}

export const digest = (id: number, payload: DigestPayload) =>
  request<Card>(`/ideas/${id}/digest`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const getStats = () => request<Stats>('/stats')

/**
 * 계측 기록 (docs/MVP.md §2.2).
 *
 * 실패해도 절대 throw 하지 않는다 — 측정 장치가 측정 대상 행동을 막으면 본말전도다.
 */
export async function logEvent(kind: string, meta?: string): Promise<void> {
  try {
    await request<void>('/events', {
      method: 'POST',
      body: JSON.stringify({ kind, meta: meta ?? null }),
    })
  } catch {
    /* 계측 실패는 무시 */
  }
}
