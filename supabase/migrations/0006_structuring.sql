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
