-- mintAI MVP schema
-- 검증: SQLite 3.53.1 / 2026-07-25
-- 주의: cards_fts 는 trigram tokenizer + 동기화 트리거가 반드시 함께 있어야 한다 (docs/MVP.md §2.1)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 착상
CREATE TABLE IF NOT EXISTS ideas (
  id            INTEGER PRIMARY KEY,
  raw_thought   TEXT NOT NULL,
  question      TEXT,
  status        TEXT NOT NULL DEFAULT 'inbox',
                -- inbox | researching | awaiting_digest | digested | archived
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status, created_at DESC);

-- AI 리서치 결과 ⚠ 휘발성: 소화 시 output_md 를 NULL 로 덮어쓴다
CREATE TABLE IF NOT EXISTS research_runs (
  id            INTEGER PRIMARY KEY,
  idea_id       INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  output_md     TEXT,
  sources_json  TEXT NOT NULL DEFAULT '[]',
  model         TEXT,
  ran_at        TEXT NOT NULL DEFAULT (datetime('now')),
  purged_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_idea ON research_runs(idea_id);

-- ★ 카드 — 인간이 쓴 것만 영구 저장
CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY,
  idea_id       INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  my_take       TEXT,
  tags          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cards_created ON cards(created_at DESC);

-- 출처 (사실 데이터, 영구)
CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY,
  card_id       INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  url           TEXT,
  title         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sources_card ON sources(card_id);

-- 글
CREATE TABLE IF NOT EXISTS drafts (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  body_md       TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 전문 검색 (한국어 대응) ──────────────────────────────
-- 기본 unicode61 tokenizer 는 한국어를 공백 단위로만 분절해 '거래비용' 같은
-- 어절 내부 검색이 전부 실패한다. trigram 을 쓰되, 2자 이하 검색어는
-- 애플리케이션에서 LIKE 로 폴백한다. 상세: docs/MVP.md §2.1
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  title, summary, my_take, tags,
  content=cards,
  content_rowid=id,
  tokenize="trigram"
);

-- external content FTS 는 자동 동기화되지 않으므로 트리거가 필수다
CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid, title, summary, my_take, tags)
  VALUES (new.id, new.title, new.summary, new.my_take, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, title, summary, my_take, tags)
  VALUES ('delete', old.id, old.title, old.summary, old.my_take, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS cards_au AFTER UPDATE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, title, summary, my_take, tags)
  VALUES ('delete', old.id, old.title, old.summary, old.my_take, old.tags);
  INSERT INTO cards_fts(rowid, title, summary, my_take, tags)
  VALUES (new.id, new.title, new.summary, new.my_take, new.tags);
END;
