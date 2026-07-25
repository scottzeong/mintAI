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
  url: string | null
  title: string | null
}

export interface ResearchRun {
  id: number
  idea_id: number
  /** ⚠ 휘발성. 소화되면 null 이 된다 (원칙 1) */
  output_md: string | null
  sources_json: Source[]
  model: string | null
  error: string | null
  ran_at: string
  purged_at: string | null
}
