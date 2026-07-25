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
