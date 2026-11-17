-- 교재 재고관리: Supabase SQL Editor에 전체를 붙여 넣고 한 번 실행합니다.
-- 새 프로젝트 기준입니다. 같은 이름의 표가 이미 있으면 오류가 나고 아무것도 바뀌지 않습니다.

begin;

-- 1) 업체
create table public.suppliers (
  id           bigint generated always as identity primary key,
  name         text not null unique,
  website      text not null default '',
  -- 담당자 여러 명: [{"name": "김 대리", "phone": "02-000-0000", "role": "수학 교재 주문"}, ...]
  contacts     jsonb not null default '[]'::jsonb check (jsonb_typeof(contacts) = 'array'),
  order_method text not null default '',
  lead_time    text not null default '',
  memo         text not null default '',
  created_at   timestamptz not null default now()
);

-- 2) 교재 (업체를 지우면 그 업체 교재는 '주문처 미지정'이 됩니다)
create table public.books (
  id          bigint generated always as identity primary key,
  title       text not null unique,
  category    text not null default '',
  min_stock   integer not null default 10 check (min_stock >= 0),
  supplier_id bigint references public.suppliers (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- 3) 입출고 기록 (재고는 따로 저장하지 않고 이 기록을 더해서 계산합니다)
create table public.transactions (
  id         bigint generated always as identity primary key,
  book_id    bigint not null references public.books (id) on delete cascade,
  type       text not null check (type in ('in', 'out')),
  quantity   integer not null check (quantity > 0),
  date       date not null default current_date,
  memo       text not null default '',
  created_at timestamptz not null default now()
);
create index transactions_book_id_idx on public.transactions (book_id);
create index transactions_date_idx on public.transactions (date desc, id desc);
create index books_supplier_id_idx on public.books (supplier_id);

-- 3-1) 주문 일정 (달력에 넣는 일정. 업체를 지우면 일정은 남고 업체만 비워집니다)
create table public.order_plans (
  id          bigint generated always as identity primary key,
  date        date not null,
  title       text not null,
  supplier_id bigint references public.suppliers (id) on delete set null,
  memo        text not null default '',
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index order_plans_date_idx on public.order_plans (date);
create index order_plans_supplier_id_idx on public.order_plans (supplier_id);

-- 4) 교재별 누적 입고, 누적 출고 (현재 재고 = total_in - total_out)
create view public.book_stock
with (security_invoker = true) as
select
  b.id as book_id,
  coalesce(sum(t.quantity) filter (where t.type = 'in'), 0)::integer  as total_in,
  coalesce(sum(t.quantity) filter (where t.type = 'out'), 0)::integer as total_out
from public.books b
left join public.transactions t on t.book_id = b.id
group by b.id;

-- 5) 재고가 0보다 작아지는 기록은 서버에서 막습니다.
--    여러 명이 동시에 출고를 기록해도 재고보다 많이 나갈 수 없습니다.
create function public.check_stock_not_negative()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ids   bigint[];
  bid   bigint;
  stock bigint;
begin
  if tg_op = 'INSERT' then
    ids := array[new.book_id];
  elsif tg_op = 'DELETE' then
    ids := array[old.book_id];
  else
    ids := array[new.book_id, old.book_id];
  end if;

  foreach bid in array ids loop
    -- 같은 교재에 대한 기록은 한 번에 하나씩 확인합니다. 교재가 지워지는 중이면 건너뜁니다.
    perform 1 from public.books where id = bid for update;
    if found then
      select coalesce(sum(case when type = 'in' then quantity else -quantity end), 0)
        into stock
        from public.transactions
       where book_id = bid;
      if stock < 0 then
        raise exception 'STOCK_NEGATIVE: 재고보다 많이 출고할 수 없습니다.';
      end if;
    end if;
  end loop;
  return null;
end;
$$;

create trigger transactions_check_stock
after insert or update or delete on public.transactions
for each row execute function public.check_stock_not_negative();

-- 6) 보안: 로그인한 계정만 읽고 쓸 수 있습니다. 로그인하지 않으면 아무것도 보이지 않습니다.
alter table public.suppliers    enable row level security;
alter table public.books        enable row level security;
alter table public.transactions enable row level security;
alter table public.order_plans  enable row level security;

create policy "로그인한 사용자만" on public.suppliers
  for all to authenticated using (true) with check (true);
create policy "로그인한 사용자만" on public.books
  for all to authenticated using (true) with check (true);
create policy "로그인한 사용자만" on public.transactions
  for all to authenticated using (true) with check (true);
create policy "로그인한 사용자만" on public.order_plans
  for all to authenticated using (true) with check (true);

revoke all on public.suppliers, public.books, public.transactions, public.order_plans, public.book_stock from anon;
grant select, insert, update, delete on public.suppliers, public.books, public.transactions, public.order_plans to authenticated;
grant select on public.book_stock to authenticated;

commit;
