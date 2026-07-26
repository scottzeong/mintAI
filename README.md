# mintAI — Scriptorium

> 자신의 생각들을 키워나갈 수 있는 글쓰기 도구

## 한 줄 정의

흩어진 생각을 AI 리서치와 **인간의 요약**을 거쳐 지식 카드로 정제하고,
그 카드만을 재료로 **글을 쓰는** 개인용 저술 시스템.

## 핵심 원칙

1. **AI가 쓴 문장은 DB에 남지 않는다** — 영구 저장되는 산문은 100% 인간이 타이핑한 것
2. **단, 사실 데이터(출처)는 승계한다**
3. **집필은 종착점이 아니라 조사의 트리거다** — 파이프라인은 루프
4. **생성 AI는 Library 밖의 지식을 사용할 수 없다**
5. **한 권의 책 = 하나의 목차 = 하나의 목소리**

## 파이프라인

```
착상 → 리서치 요청 → AI 자료 수집 → 인간이 요약 → 카드 저장 → 글쓰기
 인간      인간           AI          인간 ⚠AI산문폐기    영구      인간
                                                            └──── 루프 ────┘
```

## 문서

| 문서 | 역할 |
|---|---|
| **[MVP.md](docs/MVP.md)** | **← 현재 구현 대상** |
| [RESEARCH.md](docs/RESEARCH.md) | 리서치 자료 구조 — 질문 유형 8종별 형식 |
| [PRD.md](docs/PRD.md) | 최종 지향점 / North Star |
| [IDEA.md](IDEA.md) | 최초 원안 |

> PRD와 MVP가 충돌하면 **MVP가 이긴다.** PRD는 나중에 돌아올 지도다.

## 현재 상태

**4개 화면 전부 구현 완료 — 실사용 검증 단계(Week 4)**

| 화면 | 상태 |
|---|---|
| **Capture** | ✅ autofocus · 연속 입력 · ⌘Enter · 낙관적 저장 |
| **Digest** ★ | ✅ 좌우 분할 · 붙여넣기 차단 · 원자적 폐기 · **자료 버리기** |
| **Library** | ✅ 한국어 검색 · 상세 · 수정 · 삭제 · **분류(태그·컬렉션)** |
| **Write** | ✅ 자동저장 · 카드 인용 삽입 · 마크다운 미리보기 |

2026-07-25, 로컬 FastAPI + SQLite 에서 **Vercel + Supabase** 로 옮겼다.
이유와 대가는 [MVP.md §6.1 · §6.2](docs/MVP.md) 참조.

### 리서치 공급자

| 값 | 동작 |
|---|---|
| `mock` (기본) | 검색 없음. 내용이 비어 있다 — **일부러** 그렇다. 그럴듯한 가짜를 요약하면 거짓을 재료로 한 카드가 영구 저장된다 |
| `openai` | OpenAI Responses API 내장 웹 검색 (`gpt-5.5`) |
| `claude` | Claude Messages API 내장 웹 검색 (`claude-sonnet-5`) |

```powershell
supabase.cmd secrets set OPENAI_API_KEY=sk-...
supabase.cmd secrets set MINTAI_RESEARCH_PROVIDER=openai
supabase.cmd functions deploy research
```

모델만 바꾸려면 `MINTAI_RESEARCH_MODEL` 을 설정한다 (예: 속도가 급하면 `gpt-4.1`).

인용은 **실제로 인용된 것만** 카드에 승계된다. 모델이 훑어본 URL 전체가 아니다 —
자세한 이유는 [MVP.md §4.2](docs/MVP.md).

## 구조

```
web/                      Next.js (Vercel)
  app/                    App Router
  components/             Capture · Digest · Library · Write · AuthGate
  lib/                    supabase 클라이언트 · 계측 · 타입
supabase/
  migrations/0001_init.sql   ★ 스키마 정본 — 테이블 6개 + 함수 3개 + RLS
  migrations/0002_stats.sql  §8 판정 지표 함수
  migrations/0003_discard.sql  자료 폐기 (§3.5)
  migrations/0004_classify.sql 카드 분류 — 컬렉션·태그 (§3.6)
  migrations/0005_research_kind.sql  자료 유형·길이 (RESEARCH.md)
  functions/research/        Edge Function (리서치)
  tests/run_tests.py         실제 Postgres 로 돌리는 검증 69종
docs/                     MVP.md · PRD.md
```

**서버 로직은 Postgres 함수 8개가 전부다.**

| 함수 | 역할 |
|---|---|
| `digest()` | ★ 카드 생성 + 출처 승계 + **AI 산문 폐기** + 상태 전이 (원자적) |
| `search_cards()` | 한국어 검색 (MVP.md §2.1) |
| `app_open()` | 계측 기록 + 리서치 고아 복구 (§2.2 · §4.1) |
| `stats()` | §8 판정 지표 13종 — 4주 뒤 이 함수 하나로 판정 |
| `discard_research()` | 카드 없이 자료 폐기 — 폐기 경로에서도 원칙 1 집행 (§3.5) |
| `tag_counts()` · `collection_counts()` | 분류 집계 (§3.6) |
| `research_by_kind()` | 유형별 자료 길이·소화/폐기 (RESEARCH.md §5) |

> `digest()` 가 DB 안에 있는 이유: 폐기가 클라이언트 코드에 있으면 클라이언트를
> 바꿔서 건너뛸 수 있다. DB 함수 안에 있으면 **어떤 경로로 소화하든 폐기가 함께
> 일어난다.** 원칙 1이 코드가 아니라 스키마의 성질이 된다.

## 셋업

### 1. Supabase

1. [supabase.com](https://supabase.com) 에서 프로젝트 생성
2. SQL Editor 에 `supabase/migrations/` 의 SQL 을 **번호 순서대로** 실행
   (`0001` → `0002` → `0003` → `0004` → `0005`)
3. Authentication → Providers → **Email** 활성화, Confirm email 켜기
4. Project Settings → API 에서 **Project URL** 과 **anon key** 복사

### 2. 웹 앱

```powershell
cd web
Copy-Item .env.example .env.local    # URL / anon key 채우기
npm.cmd install
npm.cmd run dev                      # http://localhost:3000
```

### 3. Edge Function

```powershell
npm.cmd i -g supabase
supabase login
supabase link --project-ref <프로젝트-ref>
supabase functions deploy research
```

### 4. Vercel

Root Directory 를 **`web`** 으로 지정하고, 환경변수 두 개
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`)를 넣으면 끝.

Supabase Authentication → URL Configuration 에 Vercel 도메인을
**Redirect URLs** 로 추가해야 매직 링크가 돌아온다.

## 검증

```bash
pip install pgserver "psycopg[binary]"
python supabase/tests/run_tests.py     # 69/69 — PostgreSQL 16.2 실측
cd web && npm.cmd run build
```

`run_tests.py` 는 실제 Postgres 를 띄워 마이그레이션을 적용하고, **비소유자 롤로**
전체를 돌린다. 소유자 권한으로 돌리면 RLS 가 우회되어 정책이 없어도 통과하기 때문이다.

가장 중요한 검사는 `digest()` 원자성 — 요약이 비어 저장이 실패했을 때
**AI 산문이 폐기되지 않고 남아 있는지**를 확인한다.

## 4주 뒤 판정

```sql
select stats();
```

| 지표 | 목표 |
|---|---|
| `cards` | ≥ 20 |
| `active_days` | ≥ 12 / 28일 |
| `digest_rate` | ≥ 0.40 |
| `avg_queue` | ≤ 5 |
| `long_drafts` | ≥ 1 |
| `paste_blocked` | 기록만 — H1이 무너지는 순간을 가장 먼저 보여준다 |
| `discard_rate` | 기록만 — 높으면 H1이 아니라 리서치 품질 문제 |
| `avg_chars` | 기록만 — `avg_queue` 와 함께 봐야 3,000자 전환을 판정할 수 있다 |

판정 해석은 [MVP.md §8](docs/MVP.md) 참조. **"카드가 안 쌓임"이 가장 중요한 실패
모드다** — 그 경우 나머지를 아무리 정교하게 만들었어도 전제가 틀린 것이다.

## 로컬판 이력

초기 구현(FastAPI + SQLite, Week 1~2)은 첫 커밋에 보존한 뒤 제거했다.
FastAPI 리서치 파이프라인이나 FTS5 하이브리드 구현을 다시 볼 일이 있으면:

```powershell
git log --oneline --diff-filter=D -- backend/   # 제거 커밋 찾기
git show <제거커밋>~1:backend/main.py
```

옮긴 이유와 대가는 [MVP.md §6.1 · §6.2](docs/MVP.md) 에 적혀 있다.
