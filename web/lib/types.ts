export type IdeaStatus =
  | 'inbox'
  | 'researching'
  | 'awaiting_digest'
  | 'digested'
  | 'archived'

export interface Idea {
  id: number
  raw_thought: string
  question: string | null
  status: IdeaStatus
  researching_since: string | null
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
  id?: number
  card_id?: number
  url: string | null
  title: string | null
}

export interface Collection {
  id: number
  name: string
  n?: number
}

export interface TagCount {
  tag: string
  n: number
}

// ── Structuring (docs/STRUCTURING.md) ──

export interface ProposalChapter {
  title: string
  gist?: string
  card_ids: number[]
}

export interface Proposal {
  title: string
  thesis?: string
  audience?: string
  chapters: ProposalChapter[]
  excluded?: { card_id: number; reason: string }[]
}

export interface StructuringRun {
  id: number
  status: 'running' | 'ready' | 'failed'
  output_json: { proposals: Proposal[] } | null
  card_count: number | null
  model: string | null
  error: string | null
  ran_at: string
}

export interface Work {
  id: number
  /** column | article | report | ebook | book — lib/formats.ts */
  format: string
  title: string
  thesis: string | null
  audience: string | null
  status: string
  created_at: string
}

export interface Chapter {
  id: number
  work_id: number
  seq: number
  title: string
  /** AI 원안. title 과 다르면 내가 고친 것이다 (STRUCTURING.md §0.2) */
  proposed_title: string | null
  gist: string | null
  body_md: string
  updated_at: string
}

export interface Draft {
  id: number
  title: string
  body_md: string
  updated_at: string
}

/** docs/MVP.md §8 판정 지표 — `stats()` RPC 반환값 */
export interface Stats {
  ideas: number
  cards: number
  drafts: number
  pending_digest: number
  digest_rate: number
  active_days: number
  avg_queue: number
  paste_blocked: number
  research_failed: number
  long_drafts: number
}

/** docs/RESEARCH.md §1 — 질문 유형 8종 */
export const KIND_LABELS: Record<string, string> = {
  concept: '개념',
  causal: '인과·관계',
  history: '역사·전개',
  person: '인물',
  event: '사건',
  compare: '비교·대조',
  data: '현황·데이터',
  debate: '논쟁',
}

export interface ResearchRun {
  id: number
  idea_id: number
  /** ⚠ 휘발성. 소화되면 null 이 된다 (원칙 1) */
  output_md: string | null
  sources_json: Source[]
  model: string | null
  /** 질문 유형. 파싱 실패 시 null — 분류는 부가 정보이지 자료의 조건이 아니다 */
  kind: string | null
  /** 자료 길이. output_md 가 폐기돼도 남는다 (RESEARCH.md §0.1) */
  chars: number | null
  error: string | null
  ran_at: string
  purged_at: string | null
}
