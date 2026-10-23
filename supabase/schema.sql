-- 巴登客戶專區：資料庫、權限及檔案儲存設定
-- 用法：Supabase Dashboard → SQL Editor → 貼上全部內容 → Run（可重複執行）

-- ===== 管理員名單 =====
create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade
);
alter table public.admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ===== 訂單 =====
create table if not exists public.orders (
  id bigint generated always as identity primary key,
  customer_id uuid not null default auth.uid() references auth.users on delete cascade,
  customer_email text,
  contact_name text not null check (char_length(contact_name) <= 100),
  company text check (char_length(company) <= 100),
  phone text check (char_length(phone) <= 40),
  product_type text not null check (char_length(product_type) <= 50),
  size text check (char_length(size) <= 200),
  quantity integer check (quantity between 1 and 100000),
  material text check (char_length(material) <= 200),
  install_needed boolean not null default false,
  due_date date,
  details text check (char_length(details) <= 3000),
  status text not null default 'submitted'
    check (status in ('submitted','proof_sent','revision','confirmed','production','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_customer_idx on public.orders (customer_id, created_at desc);
alter table public.orders enable row level security;

-- 客戶落單時，強制寫入本人帳戶、電郵及「已提交」狀態
create or replace function public.orders_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.customer_id := auth.uid();
    new.customer_email := auth.jwt() ->> 'email';
    new.status := 'submitted';
  end if;
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists orders_before_insert on public.orders;
create trigger orders_before_insert before insert on public.orders
  for each row execute function public.orders_before_insert();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

drop policy if exists "orders read own or admin" on public.orders;
create policy "orders read own or admin" on public.orders for select to authenticated
  using (customer_id = auth.uid() or public.is_admin());
drop policy if exists "orders customer insert" on public.orders;
create policy "orders customer insert" on public.orders for insert to authenticated
  with check (customer_id = auth.uid() or public.is_admin());
drop policy if exists "orders admin update" on public.orders;
create policy "orders admin update" on public.orders for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "orders admin delete" on public.orders;
create policy "orders admin delete" on public.orders for delete to authenticated
  using (public.is_admin());

-- ===== 訂單檔案：design = 客戶設計稿；proof = 巴登確認稿；invoice = 發票 =====
create table if not exists public.order_files (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders on delete cascade,
  kind text not null check (kind in ('design','proof','invoice')),
  path text not null unique,
  file_name text not null check (char_length(file_name) <= 255),
  size bigint,
  note text check (char_length(note) <= 500),
  version integer,
  proof_status text check (proof_status in ('pending','approved','rejected','superseded')),
  customer_comment text check (char_length(customer_comment) <= 2000),
  responded_at timestamptz,
  uploaded_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists order_files_order_idx on public.order_files (order_id, created_at);
alter table public.order_files enable row level security;

drop policy if exists "files read own or admin" on public.order_files;
create policy "files read own or admin" on public.order_files for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));
drop policy if exists "files insert" on public.order_files;
create policy "files insert" on public.order_files for insert to authenticated
  with check (public.is_admin() or (
    kind = 'design' and proof_status is null and version is null
    and uploaded_by = auth.uid()
    and path like order_id::text || '/design/%'
    and exists (select 1 from public.orders o where o.id = order_id
                and o.customer_id = auth.uid() and o.status not in ('completed','cancelled'))));
drop policy if exists "files admin update" on public.order_files;
create policy "files admin update" on public.order_files for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "files admin delete" on public.order_files;
create policy "files admin delete" on public.order_files for delete to authenticated
  using (public.is_admin());

-- 客戶確認稿件或要求修改（只可回覆自己訂單中「待確認」嘅稿件）
create or replace function public.respond_proof(p_file_id bigint, p_approve boolean, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_order bigint;
begin
  select f.order_id into v_order
    from public.order_files f join public.orders o on o.id = f.order_id
   where f.id = p_file_id and f.kind = 'proof' and f.proof_status = 'pending'
     and o.customer_id = auth.uid();
  if v_order is null then
    raise exception 'proof not found or already answered';
  end if;
  if not p_approve and coalesce(btrim(p_comment), '') = '' then
    raise exception 'comment required';
  end if;
  update public.order_files
     set proof_status = case when p_approve then 'approved' else 'rejected' end,
         customer_comment = nullif(left(btrim(p_comment), 2000), ''),
         responded_at = now()
   where id = p_file_id;
  update public.orders
     set status = case when p_approve then 'confirmed' else 'revision' end
   where id = v_order;
end $$;
revoke execute on function public.respond_proof(bigint, boolean, text) from public, anon;
grant execute on function public.respond_proof(bigint, boolean, text) to authenticated;

-- ===== 檔案儲存（私人 bucket，每個檔案最大 50MB）=====
-- 檔案路徑格式：{訂單編號}/{design|proof|invoice}/{檔名}
insert into storage.buckets (id, name, public, file_size_limit)
values ('order-files', 'order-files', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "order files read" on storage.objects;
create policy "order files read" on storage.objects for select to authenticated
  using (bucket_id = 'order-files' and (public.is_admin() or exists (
    select 1 from public.orders o
     where o.id::text = (storage.foldername(name))[1] and o.customer_id = auth.uid())));
drop policy if exists "order files upload" on storage.objects;
create policy "order files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'order-files' and (public.is_admin() or (
    (storage.foldername(name))[2] = 'design' and exists (
      select 1 from public.orders o
       where o.id::text = (storage.foldername(name))[1] and o.customer_id = auth.uid()
         and o.status not in ('completed','cancelled')))));
drop policy if exists "order files admin delete" on storage.objects;
create policy "order files admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'order-files' and public.is_admin());

-- ===== 設定管理員（先用該電郵喺網站註冊，再執行下面一句）=====
-- insert into public.admins (user_id) select id from auth.users where email = 'print@e8done.com';
