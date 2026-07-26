-- ══════════════════════════════════════════════════════════════
-- mintAI — 전체 스키마 (0001~0007 합본)
--
-- ⚠ 이 파일은 개별 마이그레이션을 **번호 순서대로 이어붙인 것**이다.
--   Supabase SQL Editor 에 이것 하나만 붙여넣으면 된다.
--
--   전부 멱등하다 (if not exists / create or replace / drop 선행).
--   이미 적용된 상태에서 다시 실행해도 안전하고, 데이터도 지워지지 않는다.
--
--   실행 후 반드시:  notify pgrst, 'reload schema';
--   (PostgREST 가 함수 목록을 캐시하므로, 안 하면 새 함수가 안 보인다)
-- ══════════════════════════════════════════════════════════════


-- ═══════════════ 0001_init.sql ═══════════════
-- mintAI — Supabase 초기 스키마
-- 검증: PostgreSQL 16.2 / 2026-07-25
--
-- 설계 문서: docs/MVP.md §2
-- SQLite 판(schema.sql)에서 옮겨오며 바뀐 점은 §2.1, §3.2 주석 참조.

create extension if not exists pg_trgm;

-- ════════════════════════════════════════════════════════════
-- 착상
-- ════════════════════════════════════════════════════════════
create table if not exists ideas (
  id                bigint generated always as identity primary key,
  user_id           uuid   not null default auth.uid()
                           references auth.users(id) on delete cascade,
  raw_thought       text   not null check (length(btrim(raw_thought)) > 0),
  question          text,
  status            text   not null default 'inbox'
                           check (status in ('inbox','researching',
                                             'awaiting_digest','digested','archived')),
  -- ★ 고아 복구용 (docs/MVP.md §4.1)
  -- 서버리스에는 '기동 시점'이 없다. 프로세스가 죽어도 아무도 복구를 못 하므로
  -- 시각을 남겨두고 "너무 오래된 researching"을 만료로 간주한다.
  researching_since timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists idx_ideas_status on ideas(user_id, status, created_at desc);

-- ════════════════════════════════════════════════════════════
-- AI 리서치 결과  ⚠ 휘발성 — 소화 시 output_md 를 NULL 로 덮어쓴다
-- ════════════════════════════════════════════════════════════
create table if not exists research_runs (
  id            bigint generated always as identity primary key,
  user_id       uuid   not null default auth.uid()
                       references auth.users(id) on delete cascade,
  idea_id       bigint not null references ideas(id) on delete cascade,
  output_md     text,
  sources_json  jsonb  not null default '[]'::jsonb,
  model         text,
  error         text,
  ran_at        timestamptz not null default now(),
  purged_at     timestamptz
);
create index if not exists idx_runs_idea on research_runs(idea_id, id desc);

-- ════════════════════════════════════════════════════════════
-- ★ 카드 — 인간이 쓴 것만 영구 저장
-- ════════════════════════════════════════════════════════════
create table if not exists cards (
  id          bigint generated always as identity primary key,
  user_id     uuid   not null default auth.uid()
                     references auth.users(id) on delete cascade,
  idea_id     bigint references ideas(id) on delete set null,
  title       text   not null check (length(btrim(title)) > 0),
  summary     text   not null check (length(btrim(summary)) > 0),
  my_take     text,
  tags        text,
  created_at  timestamptz not null default now(),

  -- ★ 검색용 결합 컬럼 (docs/MVP.md §2.1)
  -- SQLite 에서는 external-content FTS5 라 동기화 트리거 3종이 필수였다.
  -- 생성 컬럼은 DB 가 알아서 갱신하므로 트리거가 통째로 사라진다.
  search_blob text generated always as (
    coalesce(title,'')   || ' ' || coalesce(summary,'') || ' ' ||
    coalesce(my_take,'') || ' ' || coalesce(tags,'')
  ) stored
);
create index if not exists idx_cards_created on cards(user_id, created_at desc);
create index if not exists idx_cards_trgm on cards using gin (search_blob gin_trgm_ops);

-- ════════════════════════════════════════════════════════════
-- 출처 (사실 데이터, 영구)
-- ════════════════════════════════════════════════════════════
create table if not exists sources (
  id       bigint generated always as identity primary key,
  user_id  uuid   not null default auth.uid()
                  references auth.users(id) on delete cascade,
  card_id  bigint not null references cards(id) on delete cascade,
  url      text,
  title    text
);
create index if not exists idx_sources_card on sources(card_id);

-- ════════════════════════════════════════════════════════════
-- 글
-- ════════════════════════════════════════════════════════════
create table if not exists drafts (
  id         bigint generated always as identity primary key,
  user_id    uuid   not null default auth.uid()
                    references auth.users(id) on delete cascade,
  title      text   not null,
  body_md    text   not null default '',
  updated_at timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════
-- ★ 계측 — §8 판정의 유일한 증거 (docs/MVP.md §2.2)
-- ════════════════════════════════════════════════════════════
create table if not exists events (
  id      bigint generated always as identity primary key,
  user_id uuid not null default auth.uid()
               references auth.users(id) on delete cascade,
  kind    text not null,   -- app_open | paste_blocked | digest_done | research_failed
  meta    text,
  at      timestamptz not null default now()
);
create index if not exists idx_events_kind_at on events(user_id, kind, at);


-- ════════════════════════════════════════════════════════════
-- ★★ 소화 — 이 함수가 이 도구의 정체성이다 (원칙 1·2)
-- ════════════════════════════════════════════════════════════
--
-- 왜 애플리케이션이 아니라 DB 함수인가:
--
--   1. 원자성. 카드 생성 · 출처 승계 · AI 산문 폐기 · 상태 전이가 한 트랜잭션이어야
--      한다. Supabase 클라이언트는 다중 문장 트랜잭션을 만들 수 없다. 네 번 나눠
--      호출하면 중간에 끊겼을 때 "카드는 생겼는데 산문이 남음"(원칙 1 위반) 또는
--      "산문은 지웠는데 카드가 없음"(복구 불가)이 된다.
--
--   2. 우회 불가능. 폐기가 클라이언트 코드에 있으면, 클라이언트를 바꾸면 건너뛸 수
--      있다. DB 함수 안에 있으면 **어떤 경로로 소화하든 폐기가 함께 일어난다.**
--      Python 판보다 오히려 강한 보장이다.
--
-- security invoker 인 이유: RLS 를 그대로 태워야 남의 카드를 소화할 수 없다.
create or replace function digest(
  p_idea_id    bigint,
  p_title      text,
  p_summary    text,
  p_my_take    text default null,
  p_tags       text default null,
  p_source_ids int[] default '{}'::int[]   -- sources_json 배열의 0-based 인덱스
) returns cards
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run   research_runs;
  v_card  cards;
  v_src   jsonb;
  v_i     int;
begin
  if length(btrim(coalesce(p_title,''))) = 0
     or length(btrim(coalesce(p_summary,''))) = 0 then
    raise exception '제목과 요약은 필수입니다' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from ideas where id = p_idea_id) then
    raise exception '해당 착상이 없습니다' using errcode = 'no_data_found';
  end if;

  -- 아직 폐기되지 않은 가장 최근 run
  select * into v_run
    from research_runs
   where idea_id = p_idea_id and output_md is not null
   order by id desc
   limit 1;

  insert into cards (idea_id, title, summary, my_take, tags)
  values (p_idea_id, btrim(p_title), btrim(p_summary),
          nullif(btrim(coalesce(p_my_take,'')), ''),
          nullif(btrim(coalesce(p_tags,'')),    ''))
  returning * into v_card;

  -- 원칙 2 — 체크한 출처만 승계
  if v_run.id is not null then
    foreach v_i in array p_source_ids loop
      v_src := v_run.sources_json -> v_i;
      if v_src is not null then
        insert into sources (card_id, url, title)
        values (v_card.id, v_src ->> 'url', v_src ->> 'title');
      end if;
    end loop;

    -- ★ 폐기. 원칙 1이 집행되는 유일한 지점.
    update research_runs
       set output_md = null, purged_at = now()
     where id = v_run.id;
  end if;

  update ideas set status = 'digested' where id = p_idea_id;

  insert into events (kind, meta) values ('digest_done', 'idea:' || p_idea_id);

  return v_card;
end;
$$;


-- ════════════════════════════════════════════════════════════
-- 검색 (docs/MVP.md §2.1)
-- ════════════════════════════════════════════════════════════
--
-- ⚠ SQLite 에서 얻은 교훈이 여기서는 형태가 달라진다.
--
--   FTS5 는 tokenizer 를 골라야 했고, unicode61 은 '거래비용' 같은 어절 내부
--   검색이 0건, trigram 은 '신뢰' 같은 2자 검색이 0건이었다. **정답이 없어서**
--   길이로 분기하는 하이브리드를 써야 했다.
--
--   Postgres 의 ILIKE '%q%' 는 길이와 무관하게 **항상 정확하다.** 분기가 필요 없다.
--   pg_trgm GIN 인덱스는 정확성이 아니라 속도만 담당하고, 3자 이상일 때 작동한다.
--   2자 검색은 순차 스캔으로 떨어지지만 카드 수천 장까지 체감 지연이 없다.
--
--   즉 §2.1의 **판단(2자 검색은 한국어에서 가장 흔하므로 반드시 지원해야 한다)**은
--   그대로 살아남고, 그걸 위해 짜야 했던 분기 코드만 사라진다.
create or replace function search_cards(
  p_q   text default null,
  p_tag text default null
) returns setof cards
language sql
stable
security invoker
set search_path = public
as $$
  select *
    from cards
   where (p_q   is null or btrim(p_q) = '' or search_blob ilike '%' || btrim(p_q) || '%')
     and (p_tag is null or btrim(p_tag) = '' or coalesce(tags,'') ilike '%' || btrim(p_tag) || '%')
   order by created_at desc;
$$;


-- ════════════════════════════════════════════════════════════
-- 앱 진입 (계측 + 고아 복구를 한 번에)  §2.2 · §4.1
-- ════════════════════════════════════════════════════════════
--
-- 두 가지를 한 함수에 넣은 이유: 둘 다 "앱을 열 때 정확히 한 번" 일어나야 하고,
-- 호출을 나누면 하나만 빠뜨리기 쉽다. 특히 고아 복구는 빠뜨려도 당장 아무 증상이
-- 없다가, 몇 주 뒤 "조사 버튼이 안 눌리는 착상"으로 나타난다.
create or replace function app_open(
  p_stale_minutes int default 10
) returns int   -- 소화 대기 큐 길이
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pending int;
begin
  -- 고아 복구: 너무 오래 researching 인 것은 실패로 간주하고 되돌린다 (§4.1)
  update ideas
     set status = 'inbox', researching_since = null
   where status = 'researching'
     and coalesce(researching_since, created_at) < now() - make_interval(mins => p_stale_minutes);

  select count(*) into v_pending from ideas where status = 'awaiting_digest';

  -- meta 에 큐 길이를 넣어야 §8의 '대기 큐 평균'을 사후 계산할 수 있다
  insert into events (kind, meta) values ('app_open', v_pending::text);

  return v_pending;
end;
$$;


-- ════════════════════════════════════════════════════════════
-- RLS — 개인 도구지만 공개 URL 이므로 반드시 켠다
-- ════════════════════════════════════════════════════════════
-- 인증 없이 접근하면 auth.uid() 가 null 이고, null = null 은 참이 아니므로
-- 모든 행이 걸러진다. 즉 기본값이 '아무것도 안 보임'이다.
alter table ideas         enable row level security;
alter table research_runs enable row level security;
alter table cards         enable row level security;
alter table sources       enable row level security;
alter table drafts        enable row level security;
alter table events        enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ideas','research_runs','cards','sources','drafts','events'] loop
    execute format($f$
      drop policy if exists own_rows on %I;
      create policy own_rows on %I
        for all
        using (user_id = auth.uid())
        with check (user_id = auth.uid());
    $f$, t, t);
  end loop;
end $$;


-- ═══════════════ 0002_stats.sql ═══════════════
-- mintAI — §8 판정 지표 함수
-- 검증: PostgreSQL 16.2 / 2026-07-25
--
-- ⚠ 이 함수는 스택 이전 중에 사라졌던 것을 되살린 것이다.
--
-- 로컬판에는 `GET /api/stats` 가 있었는데, Supabase 로 옮기면서 PostgREST 가
-- 테이블을 직접 노출하니 엔드포인트가 필요 없다고 판단해 옮기지 않았다.
-- 그런데 §8의 판정은 **6개 지표를 한 번에** 봐야 하고, 그중 셋은 events 를
-- 집계해야 나온다. 클라이언트에서 쿼리 6개를 날려 조합하는 건
-- "4주 뒤에 따로 집계 작업이 필요 없어야 한다"(§8)는 요구에 어긋난다.

create or replace function stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    -- ── 저술 데이터 ──
    'ideas',         (select count(*) from ideas),
    'cards',         (select count(*) from cards),
    'drafts',        (select count(*) from drafts),
    'pending_digest',(select count(*) from ideas where status = 'awaiting_digest'),

    -- 캡처 → 소화 전환율 (목표 ≥ 0.40)
    'digest_rate',   coalesce(round(
                       (select count(*) from ideas where status = 'digested')::numeric
                       / nullif((select count(*) from ideas), 0), 3), 0),

    -- ── §2.2 계측 기반 ──
    -- 사용 일수 (목표 ≥ 12 / 28일)
    'active_days',   (select count(distinct date(at)) from events where kind = 'app_open'),
    -- 소화 대기 큐 평균 (목표 ≤ 5)
    'avg_queue',     coalesce((select round(avg(meta::numeric), 2) from events
                                where kind = 'app_open' and meta ~ '^[0-9]+$'), 0),
    -- 붙여넣기 시도 — H1이 무너지는 순간을 가장 먼저 보여주는 지표
    'paste_blocked', (select count(*) from events where kind = 'paste_blocked'),
    'research_failed',(select count(*) from events where kind = 'research_failed'),

    -- 완성한 글 (목표 ≥ 1편, 800자 이상)
    'long_drafts',   (select count(*) from drafts where char_length(body_md) >= 800)
  );
$$;

comment on function stats() is
  'docs/MVP.md §8 판정 지표. 4주 뒤 별도 집계 없이 이 함수 하나로 판정한다.';


-- ═══════════════ 0003_discard.sql ═══════════════
-- mintAI — 자료 폐기 (docs/MVP.md §3.5)
-- 검증: PostgreSQL 16.2 / 2026-07-25
--
-- 지금까지 Digest 에서 나가는 길은 "소화 완료" 하나뿐이었다. 자료가 쓸모없어도
-- 카드를 만들어야 큐에서 빠졌다. 그건 두 가지를 망친다:
--
--   1. 쓸모없는 자료로 억지 카드를 만들게 된다 → Library 가 오염된다
--   2. 큐에 그대로 두면 대기 큐 평균(§8)이 리서치 품질 문제 때문에 나빠지는데,
--      그게 소화 병목(H3)처럼 보인다
--
-- ★ 그래서 폐기에도 계측을 남긴다.
--
--   캡처→소화 전환율이 낮게 나왔을 때, 그게 "요약이 귀찮아서"(H1 거짓)인지
--   "자료가 쓸모없어서"(리서치 품질 문제)인지 **구분할 수 있는 유일한 신호**다.
--   이 둘을 혼동하면 멀쩡한 전제를 폐기하거나, 고칠 수 있는 문제를 방치한다.

create or replace function discard_research(
  p_idea_id      bigint,
  p_archive_idea boolean default false
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run research_runs;
begin
  if not exists (select 1 from ideas where id = p_idea_id) then
    raise exception '해당 착상이 없습니다' using errcode = 'no_data_found';
  end if;

  select * into v_run
    from research_runs
   where idea_id = p_idea_id and output_md is not null
   order by id desc
   limit 1;

  -- 폐기 경로가 달라도 원칙 1은 같다 — AI 산문은 남지 않는다.
  -- sources_json 은 지우지 않는다. 카드로 승계되진 않지만 "무엇을 찾아봤는지"는
  -- 사실 기록이고, 같은 질문을 다시 조사할 때 중복을 알아볼 근거가 된다.
  if v_run.id is not null then
    update research_runs
       set output_md = null, purged_at = now()
     where id = v_run.id;
  end if;

  -- 기본은 inbox 복귀 — 질문을 고쳐서 다시 조사할 수 있어야 한다.
  -- 착상 자체가 틀렸다면 archived 로 보낸다.
  update ideas
     set status = case when p_archive_idea then 'archived' else 'inbox' end,
         researching_since = null
   where id = p_idea_id;

  insert into events (kind, meta)
  values ('research_discarded', 'idea:' || p_idea_id);
end;
$$;

comment on function discard_research(bigint, boolean) is
  '자료를 카드로 만들지 않고 폐기한다. 폐기 비율은 H1과 리서치 품질을 구분하는 신호다.';


-- ── §8 지표에 폐기 추가 ──────────────────────────────────────
create or replace function stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'ideas',         (select count(*) from ideas),
    'cards',         (select count(*) from cards),
    'drafts',        (select count(*) from drafts),
    'pending_digest',(select count(*) from ideas where status = 'awaiting_digest'),

    'digest_rate',   coalesce(round(
                       (select count(*) from ideas where status = 'digested')::numeric
                       / nullif((select count(*) from ideas), 0), 3), 0),

    'active_days',   (select count(distinct date(at)) from events where kind = 'app_open'),
    'avg_queue',     coalesce((select round(avg(meta::numeric), 2) from events
                                where kind = 'app_open' and meta ~ '^[0-9]+$'), 0),
    'paste_blocked', (select count(*) from events where kind = 'paste_blocked'),
    'research_failed',(select count(*) from events where kind = 'research_failed'),

    -- ★ 폐기 건수와 비율. 비율이 높으면 H1이 아니라 리서치 품질을 의심해야 한다.
    'discarded',     (select count(*) from events where kind = 'research_discarded'),
    'discard_rate',  coalesce(round(
                       (select count(*) from events where kind = 'research_discarded')::numeric
                       / nullif((select count(*) from events
                                  where kind in ('research_discarded','digest_done')), 0), 3), 0),

    'long_drafts',   (select count(*) from drafts where char_length(body_md) >= 800)
  );
$$;


-- ═══════════════ 0004_classify.sql ═══════════════
-- mintAI — 카드 분류 (docs/MVP.md §3.6)
-- 검증: PostgreSQL 16.2 / 2026-07-25
--
-- 캔버스·드래그앤드롭은 **일부러 뒤로 미룬다.** 카드 10장짜리 캔버스는 목록보다
-- 비어 보이고, 구현 비용은 나머지를 합친 것보다 크다.
--
-- 대신 **데이터 모델을 먼저 만든다.** 비싼 건 뷰가 아니라 데이터다.
-- 분류가 쌓이기 시작하면 캔버스는 그때 그릴 게 있는 상태로 붙일 수 있다.
-- 지금 만들면 빈 캔버스를 보게 된다.
--
-- '다차원'인 이유: 카드 하나가 여러 컬렉션에 동시에 속하고, 태그도 여럿 가진다.
-- 폴더처럼 한 곳에만 넣게 하면 "이건 조직론인가 경제학인가" 같은 결정을 매번
-- 강요하게 되고, 그건 §2의 "입력 시점에 판단을 강요하는 필드는 마찰"과 같은 문제다.

create table if not exists collections (
  id         bigint generated always as identity primary key,
  user_id    uuid   not null default auth.uid()
                    references auth.users(id) on delete cascade,
  name       text   not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists card_collections (
  card_id       bigint not null references cards(id)       on delete cascade,
  collection_id bigint not null references collections(id) on delete cascade,
  user_id       uuid   not null default auth.uid()
                       references auth.users(id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (card_id, collection_id)
);
create index if not exists idx_card_collections_col on card_collections(collection_id);

alter table collections      enable row level security;
alter table card_collections enable row level security;

do $$
declare t text;
begin
  foreach t in array array['collections','card_collections'] loop
    execute format($f$
      drop policy if exists own_rows on %I;
      create policy own_rows on %I
        for all using (user_id = auth.uid()) with check (user_id = auth.uid());
    $f$, t, t);
  end loop;
end $$;


-- ── 태그 집계 ────────────────────────────────────────────────
-- 태그는 쉼표 문자열이다 (§부록의 의도적 부채). 정규화 대신 조회 시점에 쪼갠다.
-- 카드 수천 장까지는 이걸로 충분하고, 정규화는 되돌리기 쉬운 부채로 남겨둔다.
create or replace function tag_counts()
returns table (tag text, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select btrim(t) as tag, count(*) as n
    from cards, unnest(string_to_array(coalesce(tags, ''), ',')) as t
   where btrim(t) <> ''
   group by 1
   order by 2 desc, 1;
$$;

create or replace function collection_counts()
returns table (id bigint, name text, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id, c.name, count(cc.card_id)
    from collections c
    left join card_collections cc on cc.collection_id = c.id
   group by c.id, c.name
   order by c.name;
$$;


-- ── 검색 확장 ────────────────────────────────────────────────
-- 기존 시그니처를 지우고 다시 만든다. 기본값을 가진 오버로드를 추가하면
-- search_cards(p_q, p_tag) 호출이 어느 쪽인지 모호해져 오류가 난다.
-- 인자 이름(p_q, p_tag)을 유지하므로 기존 호출부는 그대로 동작한다.
drop function if exists search_cards(text, text);

create or replace function search_cards(
  p_q            text     default null,
  p_tag          text     default null,
  p_tags         text[]   default null,   -- 전부 만족해야 함 (AND)
  p_collection_id bigint  default null
) returns setof cards
language sql
stable
security invoker
set search_path = public
as $$
  select c.*
    from cards c
   where (p_q is null or btrim(p_q) = ''
          or c.search_blob ilike '%' || btrim(p_q) || '%')
     and (p_tag is null or btrim(p_tag) = ''
          or coalesce(c.tags, '') ilike '%' || btrim(p_tag) || '%')
     -- ★ AND 조건인 이유: 태그는 좁히는 도구다. OR 로 하면 태그를 더할수록
     --   결과가 늘어나서, 찾으려던 카드가 더 안 보이게 된다.
     and (p_tags is null or cardinality(p_tags) = 0
          or (select bool_and(coalesce(c.tags, '') ilike '%' || btrim(x) || '%')
                from unnest(p_tags) as x))
     and (p_collection_id is null
          or exists (select 1 from card_collections cc
                      where cc.card_id = c.id
                        and cc.collection_id = p_collection_id))
   order by c.created_at desc;
$$;


-- ═══════════════ 0005_research_kind.sql ═══════════════
-- mintAI — 리서치 자료 유형·길이 (docs/RESEARCH.md)
-- 검증: PostgreSQL 16.2 / 2026-07-25

alter table research_runs add column if not exists kind  text;
alter table research_runs add column if not exists chars int;

comment on column research_runs.kind is
  'concept|causal|history|person|event|compare|data|debate — 파싱 실패 시 null (RESEARCH.md §4.1)';

-- ★ chars 를 따로 두는 이유 (RESEARCH.md §0.1)
--
--   소화·폐기 시 output_md 는 NULL 이 된다. 그러면 "3,000자로 늘린 것이
--   대기 큐를 나쁘게 했는가"를 **사후에 잴 방법이 사라진다.**
--   §2.2에서 배운 것과 같은 교훈이다 — 나중에 알고 싶어질 수는 지금 남겨야 한다.
comment on column research_runs.chars is
  '자료 길이. output_md 가 폐기돼도 남는다 — 분량이 소화 병목에 미친 영향 측정용';

create index if not exists idx_runs_kind on research_runs(kind);


-- ── 유형별 진단 ──────────────────────────────────────────────
-- 특정 유형에서만 자료가 버려진다면 그건 H1 문제가 아니라
-- **그 유형의 프롬프트 문제**다. 섞어서 보면 구분되지 않는다.
create or replace function research_by_kind()
returns table (
  kind       text,
  runs       bigint,
  avg_chars  numeric,
  digested   bigint,
  discarded  bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(r.kind, '(미분류)')                                   as kind,
    count(*)                                                        as runs,
    round(avg(r.chars), 0)                                          as avg_chars,
    count(*) filter (where i.status = 'digested')                    as digested,
    count(*) filter (where e.id is not null)                         as discarded
  from research_runs r
  join ideas i on i.id = r.idea_id
  left join lateral (
    select e.id from events e
     where e.kind = 'research_discarded'
       and e.meta = 'idea:' || r.idea_id
     limit 1
  ) e on true
  group by 1
  order by 2 desc;
$$;

comment on function research_by_kind() is
  '유형별 자료 길이와 소화/폐기 분포. RESEARCH.md §5 판정용.';


-- ── §8 지표에 평균 자료 길이 추가 ────────────────────────────
create or replace function stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'ideas',         (select count(*) from ideas),
    'cards',         (select count(*) from cards),
    'drafts',        (select count(*) from drafts),
    'pending_digest',(select count(*) from ideas where status = 'awaiting_digest'),

    'digest_rate',   coalesce(round(
                       (select count(*) from ideas where status = 'digested')::numeric
                       / nullif((select count(*) from ideas), 0), 3), 0),

    'active_days',   (select count(distinct date(at)) from events where kind = 'app_open'),
    'avg_queue',     coalesce((select round(avg(meta::numeric), 2) from events
                                where kind = 'app_open' and meta ~ '^[0-9]+$'), 0),
    'paste_blocked', (select count(*) from events where kind = 'paste_blocked'),
    'research_failed',(select count(*) from events where kind = 'research_failed'),

    'discarded',     (select count(*) from events where kind = 'research_discarded'),
    'discard_rate',  coalesce(round(
                       (select count(*) from events where kind = 'research_discarded')::numeric
                       / nullif((select count(*) from events
                                  where kind in ('research_discarded','digest_done')), 0), 3), 0),

    -- ★ 3,000자 전환이 옳았는지 읽는 축. avg_queue 와 함께 본다.
    'avg_chars',     coalesce((select round(avg(chars), 0) from research_runs
                                where chars is not null), 0),

    'long_drafts',   (select count(*) from drafts where char_length(body_md) >= 800)
  );
$$;


-- ═══════════════ 0006_structuring.sql ═══════════════
-- mintAI — Structuring: 카드에서 책으로 (docs/STRUCTURING.md)
-- 검증: PostgreSQL 16.2 / 2026-07-25

-- ════════════════════════════════════════════════════════════
-- 책
-- ════════════════════════════════════════════════════════════
create table if not exists works (
  id         bigint generated always as identity primary key,
  user_id    uuid   not null default auth.uid()
                    references auth.users(id) on delete cascade,
  title      text   not null check (length(btrim(title)) > 0),
  thesis     text,
  audience   text,
  status     text   not null default 'writing'
                    check (status in ('writing','done','abandoned')),
  created_at timestamptz not null default now()
);
create index if not exists idx_works_user on works(user_id, created_at desc);

-- ════════════════════════════════════════════════════════════
-- 챕터
-- ════════════════════════════════════════════════════════════
--
-- ★ title 과 proposed_title 을 나란히 두는 이유 (STRUCTURING.md §0.2)
--
--   원칙 1은 "영구 저장되는 산문은 100% 인간이 타이핑한 것"이었다. 목차는
--   그 원칙에 걸리는 첫 사례다 — AI 없이는 이 기능이 성립하지 않기 때문이다.
--
--   폐기 대신 **표시**로 지킨다. 원칙 1이 진짜로 지키려던 것은 *AI 문장을
--   내 것으로 착각하지 않는 것*이고, 그건 원안을 나란히 두는 것으로도 지켜진다.
--
--   덤으로 계측이 된다: title <> proposed_title 비율 = 구조를 얼마나 내 것으로
--   만들었는가. 이게 0에 가까우면 **AI가 짠 책을 받아쓰고 있는 것**이다.
create table if not exists chapters (
  id             bigint generated always as identity primary key,
  user_id        uuid   not null default auth.uid()
                        references auth.users(id) on delete cascade,
  work_id        bigint not null references works(id) on delete cascade,
  seq            int    not null,
  title          text   not null,     -- 내가 쓰는 제목
  proposed_title text,                -- ★ AI 원안. 절대 덮어쓰지 않는다
  gist           text,                -- 한 줄 요지 (AI 원안, 참고용)
  body_md        text   not null default '',   -- ★ 100% 사람이 쓴다
  updated_at     timestamptz not null default now(),
  unique (work_id, seq)
);
create index if not exists idx_chapters_work on chapters(work_id, seq);

-- 카드는 여러 책에 동시에 쓰일 수 있다 — §3.6의 다차원 분류와 같은 원칙.
-- 책은 카드에 대한 **하나의 배치**일 뿐, 카드의 소유자가 아니다.
create table if not exists chapter_cards (
  chapter_id bigint not null references chapters(id) on delete cascade,
  card_id    bigint not null references cards(id)    on delete cascade,
  user_id    uuid   not null default auth.uid()
                    references auth.users(id) on delete cascade,
  seq        int    not null default 0,
  primary key (chapter_id, card_id)
);
create index if not exists idx_chapter_cards_card on chapter_cards(card_id);

-- ════════════════════════════════════════════════════════════
-- AI 구조 제안  ⚠ 휘발성 — Digest 와 같은 패턴
-- ════════════════════════════════════════════════════════════
create table if not exists structuring_runs (
  id          bigint generated always as identity primary key,
  user_id     uuid   not null default auth.uid()
                     references auth.users(id) on delete cascade,
  status      text   not null default 'running'
                     check (status in ('running','ready','failed')),
  output_json jsonb,               -- ⚠ confirm 시 NULL 로 폐기
  card_count  int,
  model       text,
  chars       int,                 -- 폐기 후에도 남는다 (RESEARCH.md §0.1과 같은 이유)
  error       text,
  ran_at      timestamptz not null default now(),
  purged_at   timestamptz
);
create index if not exists idx_struct_runs on structuring_runs(user_id, id desc);

alter table works            enable row level security;
alter table chapters         enable row level security;
alter table chapter_cards    enable row level security;
alter table structuring_runs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['works','chapters','chapter_cards','structuring_runs'] loop
    execute format($f$
      drop policy if exists own_rows on %I;
      create policy own_rows on %I
        for all using (user_id = auth.uid()) with check (user_id = auth.uid());
    $f$, t, t);
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════
-- ★★ confirm_structure — 제안 하나를 책으로 확정한다
-- ════════════════════════════════════════════════════════════
--
-- digest() 와 같은 이유로 DB 함수다:
--   책 생성 · 챕터 생성 · 카드 배치 · **나머지 제안 폐기** 가 한 트랜잭션이어야 한다.
--   쪼개지면 "책은 생겼는데 제안이 남음" 또는 "제안은 지웠는데 책이 없음"이 된다.
create or replace function confirm_structure(
  p_run_id bigint,
  p_index  int                      -- 0-based. 채택할 제안
) returns works
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run     structuring_runs;
  v_prop    jsonb;
  v_work    works;
  v_ch      jsonb;
  v_chap_id bigint;
  v_seq     int := 0;
  v_card    jsonb;
  v_cseq    int;
begin
  select * into v_run from structuring_runs where id = p_run_id;
  if v_run.id is null then
    raise exception '해당 제안이 없습니다' using errcode = 'no_data_found';
  end if;
  if v_run.output_json is null then
    raise exception '이미 확정되었거나 폐기된 제안입니다' using errcode = 'check_violation';
  end if;

  v_prop := v_run.output_json -> 'proposals' -> p_index;
  if v_prop is null then
    raise exception '해당 번호의 제안이 없습니다' using errcode = 'no_data_found';
  end if;

  insert into works (title, thesis, audience)
  values (
    btrim(coalesce(v_prop ->> 'title', '제목 없음')),
    nullif(btrim(coalesce(v_prop ->> 'thesis', '')), ''),
    nullif(btrim(coalesce(v_prop ->> 'audience', '')), '')
  )
  returning * into v_work;

  for v_ch in select * from jsonb_array_elements(coalesce(v_prop -> 'chapters', '[]'::jsonb))
  loop
    v_seq := v_seq + 1;

    -- ★ title 과 proposed_title 에 같은 값을 넣는다.
    --   이후 사람이 title 만 고치면 둘이 갈라지고, 그 차이가 곧 계측이 된다.
    insert into chapters (work_id, seq, title, proposed_title, gist)
    values (
      v_work.id,
      v_seq,
      btrim(coalesce(v_ch ->> 'title', v_seq || '장')),
      btrim(coalesce(v_ch ->> 'title', '')),
      nullif(btrim(coalesce(v_ch ->> 'gist', '')), '')
    )
    returning id into v_chap_id;

    v_cseq := 0;
    for v_card in select * from jsonb_array_elements(coalesce(v_ch -> 'card_ids', '[]'::jsonb))
    loop
      v_cseq := v_cseq + 1;
      -- ⚠ 존재하는 내 카드만 배치한다.
      --   FK 검사는 RLS 를 타지 않으므로, 제안에 남의 카드 id 가 섞여 있으면
      --   그대로 들어갈 수 있다. 여기서 걸러야 한다.
      insert into chapter_cards (chapter_id, card_id, seq)
      select v_chap_id, c.id, v_cseq
        from cards c
       where c.id = (v_card #>> '{}')::bigint
      on conflict do nothing;
    end loop;
  end loop;

  -- ★ 폐기. 채택되지 않은 제안 2개는 쓰이지 않은 AI 산문이다.
  update structuring_runs
     set output_json = null, purged_at = now()
   where id = p_run_id;

  insert into events (kind, meta)
  values ('structure_confirmed', 'work:' || v_work.id);

  return v_work;
end;
$$;

comment on function confirm_structure(bigint, int) is
  '제안 하나를 책으로 확정하고 나머지를 폐기한다 (STRUCTURING.md §2).';


-- ════════════════════════════════════════════════════════════
-- 책 진단 — 구조를 얼마나 내 것으로 만들었나 (STRUCTURING.md §5)
-- ════════════════════════════════════════════════════════════
--
-- ⚠ create or replace 는 OUT 파라미터(반환 행 타입)를 바꿀 수 없다.
--   0007 이 여기에 format 컬럼을 더한다. 그래서 이 파일을 **나중에 다시 돌리면**
--   0007 판과 형태가 달라 42P13 으로 죽는다. 먼저 지우고 만든다.
--
--   같은 함수를 두 마이그레이션이 건드리는 것 자체가 냄새다. 다만 이력을
--   보존하는 쪽을 택했다 — 0006 을 고쳐 쓰면 "언제 무엇이 추가됐는지"가 사라진다.
--   대신 **양쪽 모두 drop 을 앞에 둬서 순서와 무관하게 적용되게** 한다.
drop function if exists work_progress();

create or replace function work_progress()
returns table (
  work_id       bigint,
  title         text,
  chapters      bigint,
  edited_titles bigint,   -- ★ 제목을 고친 챕터 수
  written       bigint,   -- 본문이 있는 챕터 수
  chars         bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    w.id,
    w.title,
    count(c.id),
    count(*) filter (where c.title is distinct from c.proposed_title),
    count(*) filter (where length(btrim(c.body_md)) > 0),
    coalesce(sum(char_length(c.body_md)), 0)
  from works w
  left join chapters c on c.work_id = w.id
  group by w.id, w.title
  order by w.created_at desc;
$$;

comment on function work_progress() is
  'edited_titles 가 0 에 가까우면 AI가 짠 책을 받아쓰고 있는 것이다 (STRUCTURING.md §5).';


-- ── §8 지표 확장 ────────────────────────────────────────────
create or replace function stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'ideas',         (select count(*) from ideas),
    'cards',         (select count(*) from cards),
    'drafts',        (select count(*) from drafts),
    'pending_digest',(select count(*) from ideas where status = 'awaiting_digest'),

    'digest_rate',   coalesce(round(
                       (select count(*) from ideas where status = 'digested')::numeric
                       / nullif((select count(*) from ideas), 0), 3), 0),

    'active_days',   (select count(distinct date(at)) from events where kind = 'app_open'),
    'avg_queue',     coalesce((select round(avg(meta::numeric), 2) from events
                                where kind = 'app_open' and meta ~ '^[0-9]+$'), 0),
    'paste_blocked', (select count(*) from events where kind = 'paste_blocked'),
    'research_failed',(select count(*) from events where kind = 'research_failed'),

    'discarded',     (select count(*) from events where kind = 'research_discarded'),
    'discard_rate',  coalesce(round(
                       (select count(*) from events where kind = 'research_discarded')::numeric
                       / nullif((select count(*) from events
                                  where kind in ('research_discarded','digest_done')), 0), 3), 0),

    'avg_chars',     coalesce((select round(avg(chars), 0) from research_runs
                                where chars is not null), 0),

    -- ── Structuring (STRUCTURING.md §5) ──
    'works',         (select count(*) from works),
    'chapters',      (select count(*) from chapters),
    'book_chars',    coalesce((select sum(char_length(body_md)) from chapters), 0),
    -- ★ 구조를 얼마나 내 것으로 만들었나. 0 에 가까우면 받아쓰기다.
    'title_edit_rate', coalesce(round(
                       (select count(*) from chapters
                         where title is distinct from proposed_title)::numeric
                       / nullif((select count(*) from chapters), 0), 3), 0),

    'long_drafts',   (select count(*) from drafts where char_length(body_md) >= 800)
  );
$$;


-- ═══════════════ 0007_work_format.sql ═══════════════
-- mintAI — 글의 종류 (docs/STRUCTURING.md §8)
-- 검증: PostgreSQL 16.2 / 2026-07-25
--
-- 칼럼 한 편과 책 한 권은 같은 파이프라인을 쓰지만 구조가 다르다.
-- 최소 카드 수만 다른 게 아니라 **구성 단위의 개수·이름·분량이 전부 다르다.**
--
--   column  3장  단락 3~5   800~2,000자
--   article 7장  섹션 3~6   2,000~5,000자
--   report  15장 절   4~8   5,000~15,000자
--   ebook   25장 장   5~9   20,000~50,000자
--   book    50장 장   8~14  60,000자+

alter table works add column if not exists format text not null default 'book';
alter table structuring_runs add column if not exists format text not null default 'book';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'works_format_check') then
    alter table works add constraint works_format_check
      check (format in ('column','article','report','ebook','book'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'structuring_runs_format_check') then
    alter table structuring_runs add constraint structuring_runs_format_check
      check (format in ('column','article','report','ebook','book'));
  end if;
end $$;

comment on column works.format is
  'column|article|report|ebook|book — 최소 카드 수와 구성 단위가 다르다 (STRUCTURING.md §8)';


-- ── confirm 시 format 을 승계한다 ────────────────────────────
--
-- 제안은 특정 format 을 **위해** 만들어졌다. 확정 시 다른 format 으로 바뀌면
-- 챕터 수와 분량 전제가 어긋난다. 그래서 run 의 format 을 그대로 가져온다.
create or replace function confirm_structure(
  p_run_id bigint,
  p_index  int
) returns works
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run     structuring_runs;
  v_prop    jsonb;
  v_work    works;
  v_ch      jsonb;
  v_chap_id bigint;
  v_seq     int := 0;
  v_card    jsonb;
  v_cseq    int;
begin
  select * into v_run from structuring_runs where id = p_run_id;
  if v_run.id is null then
    raise exception '해당 제안이 없습니다' using errcode = 'no_data_found';
  end if;
  if v_run.output_json is null then
    raise exception '이미 확정되었거나 폐기된 제안입니다' using errcode = 'check_violation';
  end if;

  v_prop := v_run.output_json -> 'proposals' -> p_index;
  if v_prop is null then
    raise exception '해당 번호의 제안이 없습니다' using errcode = 'no_data_found';
  end if;

  insert into works (title, thesis, audience, format)
  values (
    btrim(coalesce(v_prop ->> 'title', '제목 없음')),
    nullif(btrim(coalesce(v_prop ->> 'thesis', '')), ''),
    nullif(btrim(coalesce(v_prop ->> 'audience', '')), ''),
    coalesce(v_run.format, 'book')          -- ★ 제안이 만들어진 형식을 승계
  )
  returning * into v_work;

  for v_ch in select * from jsonb_array_elements(coalesce(v_prop -> 'chapters', '[]'::jsonb))
  loop
    v_seq := v_seq + 1;
    insert into chapters (work_id, seq, title, proposed_title, gist)
    values (
      v_work.id,
      v_seq,
      btrim(coalesce(v_ch ->> 'title', v_seq || '.')),
      btrim(coalesce(v_ch ->> 'title', '')),
      nullif(btrim(coalesce(v_ch ->> 'gist', '')), '')
    )
    returning id into v_chap_id;

    v_cseq := 0;
    for v_card in select * from jsonb_array_elements(coalesce(v_ch -> 'card_ids', '[]'::jsonb))
    loop
      v_cseq := v_cseq + 1;
      -- 존재하는 내 카드만 (FK 는 RLS 를 타지 않는다)
      insert into chapter_cards (chapter_id, card_id, seq)
      select v_chap_id, c.id, v_cseq
        from cards c
       where c.id = (v_card #>> '{}')::bigint
      on conflict do nothing;
    end loop;
  end loop;

  update structuring_runs
     set output_json = null, purged_at = now()
   where id = p_run_id;

  insert into events (kind, meta)
  values ('structure_confirmed', 'work:' || v_work.id || ' format:' || v_work.format);

  return v_work;
end;
$$;


-- ── 형식별 진행 ─────────────────────────────────────────────
-- ⚠ create or replace 는 OUT 파라미터(반환 행 타입)를 바꿀 수 없다.
--   format 컬럼을 추가하므로 먼저 지워야 한다.
drop function if exists work_progress();

create or replace function work_progress()
returns table (
  work_id       bigint,
  title         text,
  format        text,
  chapters      bigint,
  edited_titles bigint,
  written       bigint,
  chars         bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    w.id,
    w.title,
    w.format,
    count(c.id),
    count(*) filter (where c.title is distinct from c.proposed_title),
    count(*) filter (where length(btrim(c.body_md)) > 0),
    coalesce(sum(char_length(c.body_md)), 0)
  from works w
  left join chapters c on c.work_id = w.id
  group by w.id, w.title, w.format
  order by w.created_at desc;
$$;


-- ══════════════════════════════════════════════════════════════
-- PostgREST 스키마 캐시 갱신 — 이걸 안 하면 새 함수가 "not found" 로 뜬다
-- ══════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';
