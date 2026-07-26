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
