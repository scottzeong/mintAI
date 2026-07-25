# mintAI — MVP 명세

**v1.0 · 2026-07-25 · 이 문서가 구현 대상이다**

> 상위 지향점은 [`PRD.md`](PRD.md) (North Star). 이 문서와 충돌하면 **이 문서가 이긴다.**

---

## 0. MVP의 유일한 질문

> **"이 도구를 4주 동안 자발적으로 계속 쓰게 되는가?"**

기능의 완성도, 학술적 엄밀성, 아키텍처의 우아함 — 전부 이 질문 다음이다.
**쓰이지 않는 도구는 아무리 정교해도 실패다.**

### 0.1 검증하려는 가설

| # | 가설 | 거짓이면 |
|---|---|---|
| **H1** | AI 자료를 읽고 **직접 요약하는 마찰**을 감수할 만한 가치가 있다 | 이 도구의 핵심 전제가 무너짐 → 재설계 |
| **H2** | 카드가 쌓이면 **글쓰기가 실제로 쉬워진다** | 그냥 노트앱과 다를 바 없음 |
| **H3** | 소화 병목(R1)이 **감당 가능한 수준**이다 | 큐 관리 방식 전면 재검토 |

> H1이 이 프로젝트의 사활이다. 나머지는 H1이 참일 때만 의미가 있다.

---

## 1. MVP 범위 (D9)

### 1.1 만드는 것 — 4개 화면

| # | 화면 | 목적 |
|---|---|---|
| 1 | **Capture** | 아이디어 즉시 입력 |
| 2 | **Digest Workbench** | AI 자료 읽고 → 내 언어로 요약 ★핵심 |
| 3 | **Library** | 카드 목록·검색 |
| 4 | **Write** | 카드 보면서 글쓰기 |

### 1.2 만들지 않는 것 (전부 유예)

```
✗ 학술 검증 계층 전체
  G1~G6 게이트 · Toulmin 논증 필드 · rebuttal_conditions
  tier / access_level / oa_status · peer_reviewed
  DOI·CrossRef 서지 자동완성 · Unpaywall OA 확보
  인용구 원문 대조 · 재인용 추적 · 참고문헌 자동생성
  논리 오류 스캔 · OA 편향 경고

✗ 구조 기능
  Outline Board (목차 트리) · 카드 배치 · 커버리지 진단
  관계 그래프 시각화 · 임베딩 유사 카드 추천
  Dashboard · 경고 시스템 · 문체 프로파일

✗ 부가 기능
  텔레그램 캡처 · DOCX/EPUB export · 카드 재소화
  다중 저작물 관리 · 출처 스냅샷 아카이빙
```

> **왜 이렇게까지 덜어내는가:** 위 기능들은 전부 "카드가 100장 넘게 쌓였을 때" 가치가 생긴다.
> 카드 10장에서는 목차 트리도 그래프도 무의미하다. **먼저 카드가 쌓이는지부터 확인한다.**

### 1.3 절대 타협하지 않는 것

MVP에서도 **§2 원칙 1~5는 그대로 유지**한다. 특히:

| 원칙 | MVP 구현 |
|---|---|
| **AI 산문은 DB에 남지 않는다** | 소화 완료 시 `output_md = NULL` (원자적 트랜잭션) |
| **붙여넣기 차단** | 요약 입력란에 paste 이벤트 차단 + 경고 문구 |
| **출처는 승계한다** | URL·제목만 저장 (tier·DOI 등급화는 유예) |
| **AI는 카드 밖 지식 금지** | MVP에서는 초고 생성 자체를 빼므로 자동 충족 |

> 이걸 빼면 그냥 평범한 노트앱이다. **검증할 대상 자체가 사라진다.**

---

## 2. 데이터 모델 (최소)

```sql
-- 착상
CREATE TABLE ideas (
  id            INTEGER PRIMARY KEY,
  raw_thought   TEXT NOT NULL,
  question      TEXT,              -- 무엇을 더 알아야 하나 (nullable)
  status        TEXT NOT NULL DEFAULT 'inbox',
                                   -- inbox | researching | awaiting_digest | digested | archived
  created_at    TEXT NOT NULL
);

-- AI 리서치 결과 ⚠ 휘발성
CREATE TABLE research_runs (
  id            INTEGER PRIMARY KEY,
  idea_id       INTEGER NOT NULL REFERENCES ideas(id),
  output_md     TEXT,              -- ★ 소화 시 NULL로 덮어씀
  sources_json  TEXT NOT NULL,     -- [{url, title}] — 폐기하지 않음
  model         TEXT,
  ran_at        TEXT NOT NULL,
  purged_at     TEXT
);

-- ★ 카드 — 인간이 쓴 것만
CREATE TABLE cards (
  id            INTEGER PRIMARY KEY,
  idea_id       INTEGER REFERENCES ideas(id),
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,     -- 객관적 이해 (인간 작성)
  my_take       TEXT,              -- 내 해석 (인간 작성)
  tags          TEXT,              -- 쉼표 구분 (정규화는 나중에)
  created_at    TEXT NOT NULL
);

-- 출처 (사실 데이터, 영구)
CREATE TABLE sources (
  id            INTEGER PRIMARY KEY,
  card_id       INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  url           TEXT,
  title         TEXT
);

-- 글
CREATE TABLE drafts (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  body_md       TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL
);

-- 전문 검색 ★ 한국어 대응 (아래 §2.1 참조)
CREATE VIRTUAL TABLE cards_fts USING fts5(
  title, summary, my_take, tags,
  content=cards, content_rowid=id,
  tokenize="trigram"                 -- ★ 기본 unicode61은 한국어에서 작동 안 함
);

-- 인덱스 동기화 트리거 (external content FTS는 자동 동기화되지 않음)
CREATE TRIGGER cards_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid,title,summary,my_take,tags)
  VALUES (new.id,new.title,new.summary,new.my_take,new.tags);
END;
CREATE TRIGGER cards_ad AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts,rowid,title,summary,my_take,tags)
  VALUES ('delete',old.id,old.title,old.summary,old.my_take,old.tags);
END;
CREATE TRIGGER cards_au AFTER UPDATE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts,rowid,title,summary,my_take,tags)
  VALUES ('delete',old.id,old.title,old.summary,old.my_take,old.tags);
  INSERT INTO cards_fts(rowid,title,summary,my_take,tags)
  VALUES (new.id,new.title,new.summary,new.my_take,new.tags);
END;
```

**5개 테이블.** PRD의 12개에서 줄였다.

**의도적으로 뺀 것:** `works`, `outline_nodes`, `card_links`, `card_assignments`,
`excerpts`, `section_drafts`, `research_requests`(→`ideas`에 흡수),
`embedding`, `confidence`, `card_type`, `status`(카드), 논증 5필드, 출처 메타 12필드.

> **`confidence`와 `card_type`을 뺀 이유:** 입력 시점에 판단을 강요하는 필드는
> 전부 마찰이다. MVP는 마찰을 최소화해서 **H1(요약 마찰 감내)만 순수하게 측정**해야 한다.
> 다른 마찰이 섞이면 실패 원인을 특정할 수 없다.

### 2.1 ⚠ 한국어 전문 검색 — 실측으로 확인된 함정

**SQLite FTS5 기본 설정은 한국어에서 사실상 작동하지 않는다.** 실측 결과:

| tokenizer | `"신뢰"` (2자) | `"거래비용"` (어절 일부) | 문제 |
|---|---|---|---|
| `unicode61` (기본) | ✅ | **❌ 0건** | 공백 단위로만 분절 → `"거래비용이"`가 통째로 한 토큰 |
| `trigram` | **❌ 0건** | ✅ | 3자 미만 검색어를 아예 처리 못 함 |

> `"신뢰"`, `"조직"`, `"권력"` 같은 **2글자 검색어는 한국어에서 가장 흔한 형태**다.
> trigram 단독으로는 이게 전부 실패한다. 둘 다 단독으로는 쓸 수 없다.

**해결: 길이 기반 하이브리드**

```python
def fts_quote(q: str) -> str:
    """FTS5 구문 안전 처리 — 큰따옴표 이스케이프 후 phrase로 감싼다.
    이걸 빼면 공백 포함 검색어('회계 항목')가 깨지고, 따옴표 입력 시 SQL 오류."""
    return '"' + q.replace('"', '""') + '"'

def search_cards(con, q: str):
    q = q.strip()
    if len(q) >= 3:
        # FTS5 trigram — 부분어 매칭 가능, 인덱스 사용
        return con.execute(
            "SELECT c.* FROM cards_fts f JOIN cards c ON c.id = f.rowid "
            "WHERE cards_fts MATCH ? ORDER BY rank", (fts_quote(q),)
        ).fetchall()
    # 2자 이하 — LIKE 폴백 (풀스캔이지만 카드 수천 장까지 체감 지연 없음)
    like = f"%{q}%"
    return con.execute(
        "SELECT * FROM cards WHERE title LIKE ? OR summary LIKE ? "
        "OR ifnull(my_take,'') LIKE ? OR ifnull(tags,'') LIKE ?",
        (like, like, like, like)
    ).fetchall()
```

**검증 완료 (SQLite 3.53.1)**

| 케이스 | 결과 |
|---|---|
| `신뢰` / `조직` (2자, LIKE 경로) | ✅ |
| `거래비용` (어절 내부 부분어) | ✅ |
| `회계 항목` (공백 포함 구문) | ✅ — `fts_quote` 필수 |
| `따옴"표` (따옴표 이스케이프) | ✅ — 없으면 SQL 오류 |
| UPDATE·DELETE 후 인덱스 동기화 | ✅ — 트리거 3종 필수 |
| `integrity-check` | ✅ |

> **왜 임베딩 검색을 안 쓰나:** MVP 유예 항목이다. 카드 20~50장 규모에서는
> 키워드 검색으로 충분하고, 임베딩은 API 의존성·비용·지연을 추가한다.
> 카드 100장을 넘기면 그때 붙인다(§9).

---

## 3. 화면 명세

### 3.1 Capture

```
┌──────────────────────────────────────────┐
│  [                                    ]  │ ← autofocus
│                                          │
│  ☐ 자료 조사가 필요하다                    │
│    └ [무엇을 알아야 하나?            ]    │ ← 체크 시에만
│                                          │
│                          [저장 ⌘Enter]   │
│                                          │
│  ── 최근 ──────────────────              │
│  · 조직에서 신뢰는 왜 비용인가    2분 전   │
│  · 리모트 근무와 응집력          1시간 전  │
└──────────────────────────────────────────┘
```

- 저장 즉시 입력란 비우고 재포커스 (연속 입력)
- 태그·분류 **없음**
- 조사 불필요한 착상은 그냥 기록만 (카드로 안 가도 됨)

### 3.2 Digest Workbench ★

```
┌────────────────────────────┬───────────────────────────┐
│ AI 자료          ⏳ 곧 삭제 │ 내 요약        ✍ 영구 저장 │
│────────────────────────────│───────────────────────────│
│ Q. 조직 신뢰가 거래비용을   │ 제목                      │
│    줄이는 메커니즘은?       │ [                       ] │
│                            │                           │
│ ■ 요점 1 ...          [1]  │ 요약 — 무엇을 이해했나     │
│ ■ 요점 2 ...          [2]  │ [                       ] │
│ ■ 요점 3 ...          [1]  │ [                       ] │
│                            │ [                       ] │
│ ── 다른 관점 ──            │                           │
│ ■ 반대 견해 ...       [3]  │ 내 생각 — 이걸로 뭘 할까   │
│                            │ [                       ] │
│ ── 출처 ──                 │                           │
│ ☑ [1] Zak 2017        ↗   │ 태그 [          ]         │
│ ☑ [2] OECD 보고서      ↗   │                           │
│ ☐ [3] blog.example    ↗   │                           │
│                            │ [ 소화 완료 — 왼쪽 삭제 ] │
└────────────────────────────┴───────────────────────────┘
```

**필수 동작**

1. **붙여넣기 차단** — 우측 입력란 `onPaste` → `preventDefault()` + 토스트
   > *"읽고 당신의 언어로 쓰세요. 그게 이 도구의 전부입니다."*
2. **소화 완료** = 원자적 트랜잭션
   ```
   BEGIN
     INSERT cards(...)                    -- 인간 텍스트
     INSERT sources(...)                  -- 체크된 것만
     UPDATE research_runs
        SET output_md=NULL, purged_at=now()
     UPDATE ideas SET status='digested'
   COMMIT
   ```
3. **좌측 소멸 애니메이션** — 폐기를 체감시킨다 (300ms fade-out)
4. 요약이 비어 있으면 저장 불가. 제목·요약만 필수, 나머지 선택

### 3.3 Library

```
┌────────────────────────────────────────────┐
│ 🔍 [                              ]  42장  │
│────────────────────────────────────────────│
│ 신뢰의 거래비용 절감 효과                    │
│ 신뢰가 높으면 계약·감시 비용이 줄어든다...   │
│ #조직 #신뢰          출처 2  ·  3일 전      │
│────────────────────────────────────────────│
│ 리모트 근무의 응집력 문제                    │
│ ...                                        │
└────────────────────────────────────────────┘
```

- FTS5 전문 검색 (제목·요약·내생각·태그)
- 카드 클릭 → 상세 보기 / 수정
- 태그 필터 정도만. 그래프·추천 없음

### 3.4 Write

```
┌──────────────────────────┬─────────────────────┐
│ # 신뢰라는 비용            │ 🔍 [           ]    │
│                          │─────────────────────│
│ 우리는 신뢰를 감정이라     │ ☐ 신뢰의 거래비용   │
│ 부르지만, 조직에서 그것은  │   신뢰가 높으면...  │
│ 회계 항목에 가깝다.       │   [본문에 삽입]     │
│                          │                     │
│ ...                      │ ☐ 리모트 응집력     │
│                          │   ...               │
│                          │                     │
│ 1,240자      자동저장 ✓   │ 사용한 카드: 3      │
└──────────────────────────┴─────────────────────┘
```

- 좌: 마크다운 에디터 (자동저장)
- 우: 카드 검색 + 목록. **읽으면서 쓴다**
- `[본문에 삽입]` → 카드 요약을 인용 블록으로 삽입 (출처 주석 포함)
- **AI 초고 생성 없음.** 사람이 직접 쓴다

> **왜 AI 초고를 뺐나:** H2(카드가 쌓이면 글쓰기가 쉬워지는가)를 검증하려면
> **카드 자체의 효용**을 측정해야 한다. AI가 대신 써버리면 무엇 덕분에 쉬워졌는지 알 수 없다.
> 초고 생성은 H2가 참으로 확인된 뒤에 붙인다.

---

## 4. 리서치 파이프라인 (단순화)

```
질문 → 웹 검색 (5~8건) → 본문 추출 → LLM 정리 → 화면 표시
```

**규격**
- 출력 **1,200자 이내** (소화 병목 방지 — R1)
- 요점 3~5개 + **"다른 관점" 1~2개** (반론 습관은 MVP에서도 유지)
- 각 요점에 출처 번호
- 출처 5개 이내

**뺀 것:** 학술 DB 우선순위, tier 등급, OA 확보, PDF 파싱.
일반 웹 검색으로 시작한다. 대중서 집필에는 대체로 충분하다.

> 다만 **"다른 관점" 섹션은 남겼다.** 이건 학술 기능이 아니라 사고 습관이고,
> 비용이 거의 안 드는데 글의 깊이를 크게 바꾼다.

---

## 5. API

```
POST   /api/ideas                 { raw_thought, question? }
GET    /api/ideas?status=inbox
POST   /api/ideas/{id}/research   → 비동기 리서치 실행
GET    /api/ideas/{id}/run        → 휘발 자료 조회
POST   /api/ideas/{id}/digest     ★ { title, summary, my_take, tags, source_ids[] }
                                    → 카드 생성 + 자료 폐기 (원자적)
GET    /api/cards?q=&tag=
GET    /api/cards/{id}
PUT    /api/cards/{id}
DELETE /api/cards/{id}

GET    /api/drafts
POST   /api/drafts
PUT    /api/drafts/{id}
```

**13개 엔드포인트.** PRD의 25개에서 축소.

---

## 6. 기술 스택 (MVP)

| 영역 | 선택 |
|---|---|
| 백엔드 | Python 3.11 + FastAPI |
| DB | **SQLite (표준 라이브러리)** — `sqlite-vec` 불필요 (임베딩 유예) |
| 마이그레이션 | **없음** — 스키마 확정 전까지 [`schema.sql`](../schema.sql) 재생성 |
| 프론트 | **React + TS + Vite + Tailwind** |
| 에디터 | **`<textarea>` + marked.js** — TipTap 유예 (각주 기능 없으므로) |
| LLM | Claude / GPT 어댑터 |
| 검색 | 웹 검색 API |
| 배포 | 로컬 `localhost:8787` |

**뺀 것:** sqlite-vec, Alembic, APScheduler, TipTap, Cytoscape, Pandoc, 임베딩 API.

> 의존성이 줄면 **설치 실패로 시작조차 못 하는 리스크**가 준다.
> 개인 도구에서 이게 의외로 흔한 사망 원인이다.

---

## 7. 개발 계획 (4주)

### Week 1 — 뼈대 + Capture
- [ ] FastAPI + SQLite 스키마 + React 셋업
- [ ] `POST /api/ideas`, 목록 조회
- [ ] Capture 화면 (autofocus, 연속 입력)
- ✅ **검증:** 아이디어 10개를 3초 내로 각각 저장

### Week 2 — 리서치 + Digest ★
- [ ] 웹검색 + LLM 정리 파이프라인
- [ ] Digest Workbench 좌우 분할
- [ ] **붙여넣기 차단**
- [ ] **`/digest` 원자적 트랜잭션 + 폐기**
- ✅ **검증:** 카드 3장 생성 후 `SELECT output_md` → 전부 `NULL`

### Week 3 — Library + Write
- [ ] FTS5 검색 (**trigram + LIKE 하이브리드, §2.1**), 카드 목록·상세·수정
- [ ] Write 화면, 자동저장, 카드 삽입
- ✅ **검증:** 카드 5장 참조해 800자 글 1편 완성
- ✅ **검증:** `"신뢰"`(2자) · `"거래비용"`(부분어) · `"회계 항목"`(공백) 전부 검색됨

### Week 4 — 실사용
- [ ] 버그 수정만. **신규 기능 금지**
- [ ] 사용 로그 수집 (아래 지표)
- ✅ **검증:** §8 판정

> **Week 4에 기능을 추가하고 싶어지면 그게 바로 실패 신호다.**
> 도구가 아니라 개발이 재미있어진 것이다.

---

## 8. 판정 기준 (4주 후)

| 지표 | 목표 | 측정 |
|---|---|---|
| 카드 수 | **≥ 20장** | `SELECT COUNT(*) FROM cards` |
| 사용 일수 | **≥ 12일 / 28일** | 접속 로그 |
| 캡처 → 소화 전환율 | **≥ 40%** | digested / ideas |
| 소화 대기 큐 | **평균 ≤ 5** | 일별 스냅샷 |
| 완성한 글 | **≥ 1편** (800자+) | drafts |
| 붙여넣기 시도 | **기록만** | H1의 직접 증거 |

### 판정

| 결과 | 해석 | 다음 |
|---|---|---|
| 전부 충족 | H1·H2·H3 참 | Phase 2 (목차·관계) 착수 |
| 카드는 쌓이나 글이 안 나옴 | H2 거짓 | Write 화면 재설계 |
| 카드가 안 쌓임 | **H1 거짓** | 요약 마찰 완화 — 음성 입력? 템플릿? |
| 아예 안 씀 | 전제 붕괴 | 컨셉 재검토 |

> **"카드가 안 쌓임"이 가장 중요한 실패 모드다.**
> 이 경우 학술 검증을 아무리 정교하게 만들었어도 전부 헛수고였다는 뜻이다.
> **MVP를 이렇게 깎아낸 이유가 정확히 이것이다.**

---

## 9. 유예 항목 복귀 순서

MVP 성공 시 아래 순서로 되돌린다.

```
1. 목차(Outline) + 카드 배치        ← 글이 길어지면 즉시 필요
2. 카드 관계 링크                    ← 카드 50장 넘으면 필요
3. AI 초고 생성 + gap 루프           ← H2 확인 후
4. 임베딩 유사 카드 추천             ← 카드 100장 넘으면
5. 학술 검증 계층 (G1~G6, 논증 필드) ← 학술서 착수 시
6. DOI·OA·인용 자동화               ← 5번과 동시
7. Export (DOCX/EPUB)               ← 출간 단계
```

> **5·6번은 "학술서를 쓰기로 결정한 시점"에 되살린다.**
> PRD에 전부 설계되어 있으므로 재설계 비용은 없다. 구현만 하면 된다.

---

## 부록. MVP에서 의도적으로 감수하는 부채

| 부채 | 나중에 |
|---|---|
| 태그가 쉼표 문자열 | 정규화 테이블 |
| 마이그레이션 없음 | Alembic 도입 (스키마 확정 후) |
| 출처 메타 2개(url·title)뿐 | 12개 필드로 확장 |
| 검색이 FTS5 키워드만 | 임베딩 의미 검색 |
| 에디터가 textarea | TipTap + 각주 |
| 인증 없음 | 로컬 전용이므로 계속 불필요 |

> 전부 **되돌리기 쉬운** 부채다. 데이터만 안 잃으면 된다.
> 그래서 `cards`·`sources` 스키마만은 나중에 확장 가능하게 설계했다.
