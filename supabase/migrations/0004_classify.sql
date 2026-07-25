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
