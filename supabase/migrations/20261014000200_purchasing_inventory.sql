-- Ordivia — Acquisti e Magazzino
-- Il magazzino è un registro di movimenti: la giacenza è sempre la somma dei movimenti, mai un numero sovrascritto.

-- ---------------------------------------------------------------------------
-- Catalogo
-- ---------------------------------------------------------------------------
create type public.base_unit as enum ('pz', 'kg', 'g', 'l', 'ml');

create table public.product_categories (
  id      uuid primary key default gen_random_uuid(),
  org_id  uuid not null references public.organizations(id) on delete cascade,
  name    text not null,
  unique (org_id, name),
  unique (id, org_id)
);

create table public.products (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 160),
  category_id uuid,
  base_unit   public.base_unit not null default 'pz',
  sku         text,
  allergens   text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (id, org_id),
  foreign key (category_id, org_id) references public.product_categories(id, org_id) on delete set null (category_id)
);
create index on public.products (org_id) where active;
create unique index products_org_name_uq on public.products (org_id, lower(name));

-- ---------------------------------------------------------------------------
-- Magazzini
-- ---------------------------------------------------------------------------
create table public.warehouses (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  facility_id   uuid not null,
  department_id uuid,
  name          text not null,
  created_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (department_id, org_id) references public.departments(id, org_id) on delete set null (department_id)
);
create index on public.warehouses (org_id, facility_id);

create table public.stock_settings (
  org_id       uuid not null references public.organizations(id) on delete cascade,
  warehouse_id uuid not null,
  product_id   uuid not null,
  min_qty      numeric(14,3) not null default 0 check (min_qty >= 0),
  par_qty      numeric(14,3) not null default 0 check (par_qty >= 0), -- livello a cui riportare dopo il riordino
  primary key (warehouse_id, product_id),
  foreign key (warehouse_id, org_id) references public.warehouses(id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products(id, org_id) on delete cascade
);

create type public.movement_kind as enum ('carico', 'scarico', 'trasferimento', 'rettifica', 'spreco', 'reso', 'scaduto');

create table public.stock_movements (
  id           bigserial primary key,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  facility_id  uuid not null,
  warehouse_id uuid not null,
  product_id   uuid not null,
  qty          numeric(14,3) not null check (qty <> 0), -- in unità base, con segno
  kind         public.movement_kind not null,
  unit_cost    numeric(14,4),                            -- costo per unità base (solo carichi)
  lot          text,
  expires_on   date,
  ref_type     text,                                     -- receipt | inventory | transfer | manual
  ref_id       uuid,
  note         text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  foreign key (warehouse_id, org_id) references public.warehouses(id, org_id),
  foreign key (product_id, org_id) references public.products(id, org_id)
);
create index on public.stock_movements (org_id, warehouse_id, product_id);
create index on public.stock_movements (org_id, created_at desc);

-- Il facility_id del movimento deve essere quello del magazzino (non fidarsi del client).
create or replace function app.movement_fill_facility() returns trigger
language plpgsql as $$
begin
  select facility_id into new.facility_id from public.warehouses where id = new.warehouse_id;
  if new.kind in ('scarico','spreco','reso','scaduto') and new.qty > 0 then new.qty := -new.qty; end if;
  if new.kind = 'carico' and new.qty < 0 then raise exception 'Un carico deve avere quantità positiva' using errcode = '22023'; end if;
  return new;
end $$;
create trigger stock_movements_fill before insert on public.stock_movements
  for each row execute function app.movement_fill_facility();

create view public.stock_on_hand with (security_invoker = true) as
select m.org_id, m.facility_id, m.warehouse_id, m.product_id, sum(m.qty)::numeric(14,3) as qty, max(m.created_at) as last_movement_at
from public.stock_movements m
group by m.org_id, m.facility_id, m.warehouse_id, m.product_id;

-- Costo medio ponderato e ultimo costo per prodotto (dato sensibile).
create table public.product_costs (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  product_id  uuid not null,
  avg_cost    numeric(14,4) not null default 0,
  last_cost   numeric(14,4),
  qty_basis   numeric(14,3) not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (product_id),
  foreign key (product_id, org_id) references public.products(id, org_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Fornitori e listini
-- ---------------------------------------------------------------------------
create table public.suppliers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 160),
  vat_number       text,
  email            text,
  phone            text,
  contact_name     text,
  order_channel    text not null default 'email' check (order_channel in ('email','whatsapp','telefono','portale')),
  delivery_weekdays smallint[] not null default '{1,2,3,4,5}', -- 1 = lunedì … 7 = domenica (ISO)
  cutoff_time      time not null default '12:00',            -- ora limite del giorno prima della consegna
  lead_days        smallint not null default 1 check (lead_days between 0 and 30),
  min_order_amount numeric(12,2) not null default 0,
  payment_terms    text,
  notes            text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (id, org_id)
);
create index on public.suppliers (org_id) where active;

create table public.supplier_products (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  supplier_id    uuid not null,
  product_id     uuid not null,
  supplier_code  text,
  pack_label     text not null default 'pz',           -- es. "cassa 24 × 33 cl", "sacco 25 kg"
  pack_qty       numeric(14,3) not null default 1 check (pack_qty > 0), -- unità base per confezione
  price          numeric(12,4) not null check (price >= 0), -- prezzo per confezione, IVA esclusa
  vat_rate       numeric(5,2) not null default 22,
  preferred      boolean not null default false,
  updated_at     timestamptz not null default now(),
  unique (supplier_id, product_id, pack_label),
  unique (id, org_id),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products(id, org_id) on delete cascade
);
create index on public.supplier_products (org_id, product_id);

create table public.supplier_price_history (
  id                  bigserial primary key,
  org_id              uuid not null references public.organizations(id) on delete cascade,
  supplier_product_id uuid not null,
  price               numeric(12,4) not null,
  source              text not null check (source in ('listino','ricezione','fattura')),
  observed_at         timestamptz not null default now(),
  foreign key (supplier_product_id, org_id) references public.supplier_products(id, org_id) on delete cascade
);
create index on public.supplier_price_history (supplier_product_id, observed_at desc);

-- Ogni prezzo di listino (nuovo o modificato) viene storicizzato.
create or replace function app.track_list_price_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.price is distinct from old.price then
    insert into public.supplier_price_history (org_id, supplier_product_id, price, source)
    values (new.org_id, new.id, new.price, 'listino');
  end if;
  return null;
end $$;
create trigger supplier_products_price_hist after insert or update of price on public.supplier_products
  for each row execute function app.track_list_price_after();

-- ---------------------------------------------------------------------------
-- Richieste d'acquisto (dai reparti)
-- ---------------------------------------------------------------------------
create type public.request_status as enum ('bozza', 'inviata', 'approvata', 'rifiutata', 'convertita');

create table public.purchase_requests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  facility_id   uuid not null,
  department_id uuid,
  status        public.request_status not null default 'bozza',
  note          text,
  needed_by     date,
  requested_by  uuid default auth.uid(),
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id),
  foreign key (department_id, org_id) references public.departments(id, org_id)
);
create index on public.purchase_requests (org_id, facility_id, status);

create table public.purchase_request_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  request_id  uuid not null,
  product_id  uuid not null,
  qty         numeric(14,3) not null check (qty > 0), -- unità base
  note        text,
  foreign key (request_id, org_id) references public.purchase_requests(id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products(id, org_id)
);
create index on public.purchase_request_lines (request_id);

-- ---------------------------------------------------------------------------
-- Ordini ai fornitori
-- ---------------------------------------------------------------------------
create type public.po_status as enum ('bozza', 'approvato', 'inviato', 'parziale', 'ricevuto', 'annullato');

create sequence public.po_number_seq;

create table public.purchase_orders (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  facility_id       uuid not null,
  supplier_id       uuid not null,
  number            text not null default ('ORD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.po_number_seq')::text, 5, '0')),
  status            public.po_status not null default 'bozza',
  expected_delivery date,
  delivery_warehouse_id uuid,
  note              text,
  created_by        uuid default auth.uid(),
  approved_by       uuid,
  approved_at       timestamptz,
  sent_by           uuid,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id),
  foreign key (delivery_warehouse_id, org_id) references public.warehouses(id, org_id)
);
create index on public.purchase_orders (org_id, facility_id, status);
create index on public.purchase_orders (org_id, expected_delivery);

create table public.purchase_order_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  order_id            uuid not null,
  product_id          uuid not null,
  supplier_product_id uuid,
  pack_label          text not null default 'pz',
  pack_qty            numeric(14,3) not null default 1 check (pack_qty > 0),
  qty_packs           numeric(12,3) not null check (qty_packs > 0),
  unit_price          numeric(12,4) not null default 0, -- per confezione
  qty_received_base   numeric(14,3) not null default 0,
  request_line_id     uuid,
  foreign key (order_id, org_id) references public.purchase_orders(id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products(id, org_id),
  foreign key (supplier_product_id, org_id) references public.supplier_products(id, org_id)
);
create index on public.purchase_order_lines (order_id);

create view public.purchase_order_totals with (security_invoker = true) as
select o.id as order_id, o.org_id, coalesce(sum(l.qty_packs * l.unit_price), 0)::numeric(12,2) as total, count(l.id) as lines
from public.purchase_orders o left join public.purchase_order_lines l on l.order_id = o.id
group by o.id, o.org_id;

-- ---------------------------------------------------------------------------
-- Ricezione merce
-- ---------------------------------------------------------------------------
create type public.receipt_status as enum ('bozza', 'confermata');

create table public.receipts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  facility_id   uuid not null,
  order_id      uuid,
  supplier_id   uuid not null,
  warehouse_id  uuid not null,
  doc_type      text not null default 'ddt' check (doc_type in ('ddt','fattura','nessuno')),
  doc_number    text,
  doc_date      date,
  doc_photo_path text,
  status        public.receipt_status not null default 'bozza',
  note          text,
  received_by   uuid default auth.uid(),
  confirmed_by  uuid,
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id),
  foreign key (order_id, org_id) references public.purchase_orders(id, org_id),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id),
  foreign key (warehouse_id, org_id) references public.warehouses(id, org_id)
);
create index on public.receipts (org_id, facility_id, created_at desc);

create table public.receipt_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  receipt_id     uuid not null,
  order_line_id  uuid references public.purchase_order_lines(id) on delete set null,
  product_id     uuid not null,
  pack_qty       numeric(14,3) not null default 1 check (pack_qty > 0),
  qty_packs      numeric(12,3) not null check (qty_packs >= 0),
  unit_price     numeric(12,4),   -- per confezione, se presente sul documento
  lot            text,
  expires_on     date,
  issue          text check (issue in ('mancante','danneggiato','errato','in_eccesso')),
  note           text,
  foreign key (receipt_id, org_id) references public.receipts(id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products(id, org_id)
);
create index on public.receipt_lines (receipt_id);

-- ---------------------------------------------------------------------------
-- Attività (assegnazione tracciata)
-- ---------------------------------------------------------------------------
create type public.task_status as enum ('assegnata', 'vista', 'iniziata', 'completata', 'verificata', 'annullata');

create table public.tasks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  facility_id    uuid not null,
  department_id  uuid,
  title          text not null check (length(trim(title)) between 2 and 200),
  description    text,
  assignee_id    uuid references auth.users(id),
  due_at         timestamptz,
  requires_photo boolean not null default false,
  requires_verification boolean not null default false,
  status         public.task_status not null default 'assegnata',
  created_by     uuid default auth.uid(),
  seen_at        timestamptz,
  started_at     timestamptz,
  completed_at   timestamptz,
  completed_by   uuid,
  completion_note text,
  photo_path     text,
  verified_at    timestamptz,
  verified_by    uuid,
  created_at     timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id),
  foreign key (department_id, org_id) references public.departments(id, org_id)
);
create index on public.tasks (org_id, facility_id, status, due_at);
create index on public.tasks (assignee_id, status);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
select app.enable_audit('public.products');
select app.enable_audit('public.warehouses');
select app.enable_audit('public.stock_settings');
select app.enable_audit('public.suppliers');
select app.enable_audit('public.supplier_products');
select app.enable_audit('public.purchase_requests');
select app.enable_audit('public.purchase_orders');
select app.enable_audit('public.purchase_order_lines');
select app.enable_audit('public.receipts');
select app.enable_audit('public.tasks');
-- stock_movements è già un registro immutabile: niente update/delete, quindi niente trigger di audit ridondante.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.product_categories     enable row level security;
alter table public.products               enable row level security;
alter table public.warehouses             enable row level security;
alter table public.stock_settings         enable row level security;
alter table public.stock_movements        enable row level security;
alter table public.product_costs          enable row level security;
alter table public.suppliers              enable row level security;
alter table public.supplier_products      enable row level security;
alter table public.supplier_price_history enable row level security;
alter table public.purchase_requests      enable row level security;
alter table public.purchase_request_lines enable row level security;
alter table public.purchase_orders        enable row level security;
alter table public.purchase_order_lines   enable row level security;
alter table public.receipts               enable row level security;
alter table public.receipt_lines          enable row level security;
alter table public.tasks                  enable row level security;

-- Catalogo: visibile a tutti i membri; scrivibile da chi gestisce fornitori o inventario.
create policy cat_select on public.product_categories for select to authenticated using (app.is_member(org_id));
create policy cat_write  on public.product_categories for all to authenticated
  using (app.has_perm(org_id, 'suppliers.manage') or app.has_perm(org_id, 'inventory.count'))
  with check (app.has_perm(org_id, 'suppliers.manage') or app.has_perm(org_id, 'inventory.count'));

create policy prod_select on public.products for select to authenticated using (app.is_member(org_id));
create policy prod_write  on public.products for all to authenticated
  using (app.has_perm(org_id, 'suppliers.manage') or app.has_perm(org_id, 'inventory.count'))
  with check (app.has_perm(org_id, 'suppliers.manage') or app.has_perm(org_id, 'inventory.count'));

create policy wh_select on public.warehouses for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy wh_write  on public.warehouses for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'org.manage') or app.has_facility_perm(org_id, facility_id, 'inventory.count'))
  with check (app.has_facility_perm(org_id, facility_id, 'org.manage') or app.has_facility_perm(org_id, facility_id, 'inventory.count'));

create policy ss_select on public.stock_settings for select to authenticated using (app.has_perm(org_id, 'inventory.view'));
create policy ss_write  on public.stock_settings for all to authenticated
  using (app.has_perm(org_id, 'inventory.count')) with check (app.has_perm(org_id, 'inventory.count'));

create policy sm_select on public.stock_movements for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'inventory.view'));
create policy sm_insert on public.stock_movements for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (select 1 from public.warehouses w where w.id = warehouse_id and w.org_id = stock_movements.org_id
                and app.has_facility_perm(w.org_id, w.facility_id, 'inventory.move'))
    and kind in ('scarico','spreco','reso','scaduto')
  );
-- Il costo unitario dei movimenti è un dato economico: escluso dalle colonne leggibili.
revoke select on public.stock_movements from authenticated, anon;
grant select (id, org_id, facility_id, warehouse_id, product_id, qty, kind, lot, expires_on, ref_type, ref_id, note, created_by, created_at)
  on public.stock_movements to authenticated;
revoke update, delete on public.stock_movements from authenticated, anon;

create policy pc_select on public.product_costs for select to authenticated
  using (app.has_perm(org_id, 'finance.view') or app.has_perm(org_id, 'purchasing.approve'));

create policy sup_select on public.suppliers for select to authenticated
  using (app.has_perm(org_id, 'suppliers.manage') or app.has_perm(org_id, 'purchasing.request') or app.has_perm(org_id, 'receiving.perform'));
create policy sup_write  on public.suppliers for all to authenticated
  using (app.has_perm(org_id, 'suppliers.manage')) with check (app.has_perm(org_id, 'suppliers.manage'));

create policy sp_select on public.supplier_products for select to authenticated
  using (app.has_perm(org_id, 'suppliers.manage') or app.has_perm(org_id, 'purchasing.approve') or app.has_perm(org_id, 'finance.view'));
create policy sp_write  on public.supplier_products for all to authenticated
  using (app.has_perm(org_id, 'suppliers.manage')) with check (app.has_perm(org_id, 'suppliers.manage'));

create policy sph_select on public.supplier_price_history for select to authenticated
  using (app.has_perm(org_id, 'suppliers.manage') or app.has_perm(org_id, 'finance.view'));

create policy pr_select on public.purchase_requests for select to authenticated
  using (requested_by = auth.uid() or app.has_facility_perm(org_id, facility_id, 'purchasing.approve')
         or app.has_facility_perm(org_id, facility_id, 'purchasing.request'));
create policy pr_insert on public.purchase_requests for insert to authenticated
  with check (requested_by = auth.uid() and status in ('bozza','inviata')
              and app.has_facility_perm(org_id, facility_id, 'purchasing.request'));
create policy pr_update on public.purchase_requests for update to authenticated
  using ((requested_by = auth.uid() and status = 'bozza') or app.has_facility_perm(org_id, facility_id, 'purchasing.approve'))
  with check ((requested_by = auth.uid() and status in ('bozza','inviata')) or app.has_facility_perm(org_id, facility_id, 'purchasing.approve'));
create policy pr_delete on public.purchase_requests for delete to authenticated
  using (requested_by = auth.uid() and status = 'bozza');

create policy prl_all on public.purchase_request_lines for all to authenticated
  using (exists (select 1 from public.purchase_requests r where r.id = request_id
         and (r.requested_by = auth.uid() or app.has_facility_perm(r.org_id, r.facility_id, 'purchasing.approve')
              or app.has_facility_perm(r.org_id, r.facility_id, 'purchasing.request'))))
  with check (exists (select 1 from public.purchase_requests r where r.id = request_id and r.org_id = purchase_request_lines.org_id
         and ((r.requested_by = auth.uid() and r.status = 'bozza') or app.has_facility_perm(r.org_id, r.facility_id, 'purchasing.approve'))));

create policy po_select on public.purchase_orders for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'purchasing.approve')
      or app.has_facility_perm(org_id, facility_id, 'purchasing.send')
      or (status in ('inviato','parziale') and app.has_facility_perm(org_id, facility_id, 'receiving.perform')));
create policy po_insert on public.purchase_orders for insert to authenticated
  with check (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'purchasing.approve'));
create policy po_update on public.purchase_orders for update to authenticated
  using (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'purchasing.approve'))
  with check (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'purchasing.approve'));
create policy po_delete on public.purchase_orders for delete to authenticated
  using (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'purchasing.approve'));

create policy pol_select on public.purchase_order_lines for select to authenticated
  using (exists (select 1 from public.purchase_orders o where o.id = order_id));  -- eredita la visibilità dell'ordine
create policy pol_write on public.purchase_order_lines for all to authenticated
  using (exists (select 1 from public.purchase_orders o where o.id = order_id and o.status = 'bozza'
                 and app.has_facility_perm(o.org_id, o.facility_id, 'purchasing.approve')))
  with check (exists (select 1 from public.purchase_orders o where o.id = order_id and o.org_id = purchase_order_lines.org_id
                 and o.status = 'bozza' and app.has_facility_perm(o.org_id, o.facility_id, 'purchasing.approve')));

create policy rc_select on public.receipts for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'receiving.perform') or app.has_facility_perm(org_id, facility_id, 'purchasing.approve'));
create policy rc_insert on public.receipts for insert to authenticated
  with check (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'receiving.perform'));
create policy rc_update on public.receipts for update to authenticated
  using (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'receiving.perform'))
  with check (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'receiving.perform'));
create policy rc_delete on public.receipts for delete to authenticated
  using (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'receiving.perform'));

create policy rcl_select on public.receipt_lines for select to authenticated
  using (exists (select 1 from public.receipts r where r.id = receipt_id));
create policy rcl_write on public.receipt_lines for all to authenticated
  using (exists (select 1 from public.receipts r where r.id = receipt_id and r.status = 'bozza'
                 and app.has_facility_perm(r.org_id, r.facility_id, 'receiving.perform')))
  with check (exists (select 1 from public.receipts r where r.id = receipt_id and r.org_id = receipt_lines.org_id and r.status = 'bozza'
                 and app.has_facility_perm(r.org_id, r.facility_id, 'receiving.perform')));

create policy task_select on public.tasks for select to authenticated
  using (assignee_id = auth.uid() or app.has_facility_perm(org_id, facility_id, 'tasks.manage'));
create policy task_insert on public.tasks for insert to authenticated
  with check (app.has_facility_perm(org_id, facility_id, 'tasks.manage'));
create policy task_update on public.tasks for update to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'tasks.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'tasks.manage'));
-- Gli esecutori cambiano stato solo tramite task_transition().

-- ---------------------------------------------------------------------------
-- RPC: transizioni degli ordini
-- ---------------------------------------------------------------------------
create or replace function public.po_transition(p_order uuid, p_to public.po_status) returns public.purchase_orders
language plpgsql security definer set search_path = public as $$
declare
  v_po public.purchase_orders;
  v_lines int;
begin
  select * into v_po from public.purchase_orders where id = p_order for update;
  if not found then raise exception 'Ordine non trovato' using errcode = 'P0002'; end if;

  if p_to = 'approvato' then
    if v_po.status <> 'bozza' then raise exception 'Solo un ordine in bozza può essere approvato' using errcode = 'P0001'; end if;
    if not app.has_facility_perm(v_po.org_id, v_po.facility_id, 'purchasing.approve') then raise exception 'Permesso negato' using errcode = '42501'; end if;
    select count(*) into v_lines from public.purchase_order_lines where order_id = p_order;
    if v_lines = 0 then raise exception 'L''ordine non ha righe' using errcode = 'P0001'; end if;
    update public.purchase_orders set status = 'approvato', approved_by = auth.uid(), approved_at = now() where id = p_order returning * into v_po;
  elsif p_to = 'inviato' then
    if v_po.status <> 'approvato' then raise exception 'Solo un ordine approvato può essere inviato' using errcode = 'P0001'; end if;
    if not app.has_facility_perm(v_po.org_id, v_po.facility_id, 'purchasing.send') then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.purchase_orders set status = 'inviato', sent_by = auth.uid(), sent_at = now() where id = p_order returning * into v_po;
  elsif p_to = 'bozza' then
    if v_po.status <> 'approvato' then raise exception 'Solo un ordine approvato e non inviato può tornare in bozza' using errcode = 'P0001'; end if;
    if not app.has_facility_perm(v_po.org_id, v_po.facility_id, 'purchasing.approve') then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.purchase_orders set status = 'bozza', approved_by = null, approved_at = null where id = p_order returning * into v_po;
  elsif p_to = 'annullato' then
    if v_po.status in ('ricevuto','parziale','annullato') then raise exception 'Questo ordine non può essere annullato' using errcode = 'P0001'; end if;
    if not app.has_facility_perm(v_po.org_id, v_po.facility_id, 'purchasing.approve') then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.purchase_orders set status = 'annullato' where id = p_order returning * into v_po;
  else
    raise exception 'Transizione non consentita' using errcode = 'P0001';
  end if;
  return v_po;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: unificare richieste approvate in ordini in bozza, uno per fornitore
-- (fornitore preferito, altrimenti il più economico per unità base)
-- ---------------------------------------------------------------------------
create or replace function public.orders_from_requests(p_requests uuid[]) returns setof uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_fac uuid;
  v_line record;
  v_order uuid;
  v_orders jsonb := '{}';
  v_missing text[] := '{}';
begin
  select distinct org_id, facility_id into v_org, v_fac from public.purchase_requests where id = any(p_requests);
  if v_org is null then raise exception 'Nessuna richiesta valida' using errcode = 'P0002'; end if;
  if (select count(distinct (org_id, facility_id)) from public.purchase_requests where id = any(p_requests)) > 1 then
    raise exception 'Le richieste devono appartenere alla stessa struttura' using errcode = 'P0001';
  end if;
  if not app.has_facility_perm(v_org, v_fac, 'purchasing.approve') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if exists (select 1 from public.purchase_requests where id = any(p_requests) and status not in ('inviata','approvata')) then
    raise exception 'Solo richieste inviate o approvate possono essere convertite' using errcode = 'P0001';
  end if;

  for v_line in
    select l.product_id, sum(l.qty) as qty, p.name as product_name,
      (select sp.id from public.supplier_products sp join public.suppliers s on s.id = sp.supplier_id
        where sp.product_id = l.product_id and sp.org_id = v_org and s.active
        order by sp.preferred desc, sp.price / sp.pack_qty asc limit 1) as sp_id
    from public.purchase_request_lines l join public.products p on p.id = l.product_id
    where l.request_id = any(p_requests)
    group by l.product_id, p.name
  loop
    if v_line.sp_id is null then
      v_missing := v_missing || v_line.product_name;
      continue;
    end if;
    declare v_sp public.supplier_products;
    begin
      select * into v_sp from public.supplier_products where id = v_line.sp_id;
      v_order := (v_orders ->> v_sp.supplier_id::text)::uuid;
      if v_order is null then
        insert into public.purchase_orders (org_id, facility_id, supplier_id, status, created_by)
        values (v_org, v_fac, v_sp.supplier_id, 'bozza', auth.uid()) returning id into v_order;
        v_orders := v_orders || jsonb_build_object(v_sp.supplier_id::text, v_order);
      end if;
      insert into public.purchase_order_lines (org_id, order_id, product_id, supplier_product_id, pack_label, pack_qty, qty_packs, unit_price)
      values (v_org, v_order, v_line.product_id, v_sp.id, v_sp.pack_label, v_sp.pack_qty, ceil(v_line.qty / v_sp.pack_qty), v_sp.price);
    end;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'Nessun fornitore a listino per: %', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  update public.purchase_requests set status = 'convertita', decided_by = auth.uid(), decided_at = now() where id = any(p_requests);
  return query select (value #>> '{}')::uuid from jsonb_each(v_orders);
end $$;

-- ---------------------------------------------------------------------------
-- RPC: conferma ricezione (atomica): carico a magazzino, costo medio, storico prezzi, stato ordine
-- ---------------------------------------------------------------------------
create or replace function public.confirm_receipt(p_receipt uuid) returns public.receipts
language plpgsql security definer set search_path = public as $$
declare
  v_rc public.receipts;
  v_line record;
  v_qty_base numeric;
  v_unit_cost numeric;
  v_open int;
begin
  select * into v_rc from public.receipts where id = p_receipt for update;
  if not found then raise exception 'Ricezione non trovata' using errcode = 'P0002'; end if;
  if v_rc.status <> 'bozza' then raise exception 'Ricezione già confermata' using errcode = 'P0001'; end if;
  if not app.has_facility_perm(v_rc.org_id, v_rc.facility_id, 'receiving.perform') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if not exists (select 1 from public.receipt_lines where receipt_id = p_receipt and qty_packs > 0) then
    raise exception 'Nessuna quantità ricevuta da registrare' using errcode = 'P0001';
  end if;

  for v_line in select rl.*, ol.unit_price as order_price, ol.supplier_product_id
                from public.receipt_lines rl left join public.purchase_order_lines ol on ol.id = rl.order_line_id
                where rl.receipt_id = p_receipt and rl.qty_packs > 0
  loop
    v_qty_base := v_line.qty_packs * v_line.pack_qty;
    v_unit_cost := coalesce(v_line.unit_price, v_line.order_price) / v_line.pack_qty;

    insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, unit_cost, lot, expires_on, ref_type, ref_id, created_by)
    values (v_rc.org_id, v_rc.facility_id, v_rc.warehouse_id, v_line.product_id, v_qty_base, 'carico', v_unit_cost, v_line.lot, v_line.expires_on, 'receipt', v_rc.id, auth.uid());

    if v_unit_cost is not null then
      insert into public.product_costs (org_id, product_id, avg_cost, last_cost, qty_basis, updated_at)
      values (v_rc.org_id, v_line.product_id, v_unit_cost, v_unit_cost, v_qty_base, now())
      on conflict (product_id) do update set
        avg_cost = case
          when greatest(product_costs.qty_basis, 0) + excluded.qty_basis = 0 then excluded.avg_cost
          else (product_costs.avg_cost * greatest(product_costs.qty_basis, 0) + excluded.avg_cost * excluded.qty_basis)
               / (greatest(product_costs.qty_basis, 0) + excluded.qty_basis) end,
        last_cost = excluded.last_cost,
        qty_basis = greatest(product_costs.qty_basis, 0) + excluded.qty_basis,
        updated_at = now();
    end if;

    if v_line.unit_price is not null and v_line.supplier_product_id is not null then
      insert into public.supplier_price_history (org_id, supplier_product_id, price, source)
      values (v_rc.org_id, v_line.supplier_product_id, v_line.unit_price, 'ricezione');
    end if;

    if v_line.order_line_id is not null then
      update public.purchase_order_lines set qty_received_base = qty_received_base + v_qty_base where id = v_line.order_line_id;
    end if;
  end loop;

  if v_rc.order_id is not null then
    select count(*) into v_open from public.purchase_order_lines
      where order_id = v_rc.order_id and qty_received_base < qty_packs * pack_qty;
    update public.purchase_orders set status = case when v_open = 0 then 'ricevuto'::public.po_status else 'parziale'::public.po_status end
      where id = v_rc.order_id;
  end if;

  update public.receipts set status = 'confermata', confirmed_by = auth.uid(), confirmed_at = now() where id = p_receipt returning * into v_rc;
  return v_rc;
end $$;

-- Ricezione precompilata dall'ordine (righe = quantità ordinate, da correggere in spunta).
create or replace function public.start_receipt(p_order uuid, p_warehouse uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_po public.purchase_orders; v_rc uuid; v_wh public.warehouses;
begin
  select * into v_po from public.purchase_orders where id = p_order;
  if not found then raise exception 'Ordine non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_po.org_id, v_po.facility_id, 'receiving.perform') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_po.status not in ('inviato','parziale') then raise exception 'L''ordine non è in attesa di consegna' using errcode = 'P0001'; end if;
  select * into v_wh from public.warehouses where id = coalesce(p_warehouse, v_po.delivery_warehouse_id) and org_id = v_po.org_id and facility_id = v_po.facility_id;
  if not found then raise exception 'Seleziona un magazzino della struttura' using errcode = 'P0001'; end if;

  select id into v_rc from public.receipts where order_id = p_order and status = 'bozza' limit 1;
  if v_rc is not null then return v_rc; end if;

  insert into public.receipts (org_id, facility_id, order_id, supplier_id, warehouse_id, received_by)
  values (v_po.org_id, v_po.facility_id, p_order, v_po.supplier_id, v_wh.id, auth.uid()) returning id into v_rc;

  insert into public.receipt_lines (org_id, receipt_id, order_line_id, product_id, pack_qty, qty_packs, unit_price)
  select org_id, v_rc, id, product_id, pack_qty, greatest(qty_packs - qty_received_base / pack_qty, 0), unit_price
  from public.purchase_order_lines where order_id = p_order and qty_received_base < qty_packs * pack_qty;

  return v_rc;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: inventario — conta fisica → rettifiche sulla differenza
-- ---------------------------------------------------------------------------
create or replace function public.apply_inventory_count(p_warehouse uuid, p_counts jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_wh public.warehouses; v_item jsonb; v_current numeric; v_counted numeric; v_n int := 0; v_ref uuid := gen_random_uuid();
begin
  select * into v_wh from public.warehouses where id = p_warehouse;
  if not found then raise exception 'Magazzino non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_wh.org_id, v_wh.facility_id, 'inventory.count') then raise exception 'Permesso negato' using errcode = '42501'; end if;

  for v_item in select * from jsonb_array_elements(p_counts) loop
    v_counted := (v_item ->> 'qty')::numeric;
    if v_counted is null or v_counted < 0 then raise exception 'Quantità contata non valida' using errcode = '22023'; end if;
    if not exists (select 1 from public.products where id = (v_item ->> 'product_id')::uuid and org_id = v_wh.org_id) then
      raise exception 'Prodotto non valido' using errcode = '22023';
    end if;
    select coalesce(sum(qty), 0) into v_current from public.stock_movements
      where warehouse_id = p_warehouse and product_id = (v_item ->> 'product_id')::uuid;
    if v_counted <> v_current then
      insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, ref_type, ref_id, note, created_by)
      values (v_wh.org_id, v_wh.facility_id, p_warehouse, (v_item ->> 'product_id')::uuid, v_counted - v_current, 'rettifica', 'inventory', v_ref,
              'Inventario: contati ' || v_counted || ', a sistema ' || v_current, auth.uid());
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- Carico manuale senza ordine (es. acquisto al cash & carry) con costo opzionale.
create or replace function public.manual_load(p_warehouse uuid, p_product uuid, p_qty numeric, p_unit_cost numeric, p_note text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_wh public.warehouses; v_id bigint;
begin
  select * into v_wh from public.warehouses where id = p_warehouse;
  if not found then raise exception 'Magazzino non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_wh.org_id, v_wh.facility_id, 'receiving.perform') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantità non valida' using errcode = '22023'; end if;
  if not exists (select 1 from public.products where id = p_product and org_id = v_wh.org_id) then raise exception 'Prodotto non valido' using errcode = '22023'; end if;

  insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, unit_cost, ref_type, note, created_by)
  values (v_wh.org_id, v_wh.facility_id, p_warehouse, p_product, p_qty, 'carico', p_unit_cost, 'manual', p_note, auth.uid())
  returning id into v_id;

  if p_unit_cost is not null then
    insert into public.product_costs (org_id, product_id, avg_cost, last_cost, qty_basis)
    values (v_wh.org_id, p_product, p_unit_cost, p_unit_cost, p_qty)
    on conflict (product_id) do update set
      avg_cost = (product_costs.avg_cost * greatest(product_costs.qty_basis, 0) + excluded.avg_cost * excluded.qty_basis)
                 / nullif(greatest(product_costs.qty_basis, 0) + excluded.qty_basis, 0),
      last_cost = excluded.last_cost, qty_basis = greatest(product_costs.qty_basis, 0) + excluded.qty_basis, updated_at = now();
  end if;
  return v_id;
end $$;

-- Trasferimento tra magazzini della stessa organizzazione: due movimenti atomici di segno opposto.
create or replace function public.transfer_stock(p_from uuid, p_to uuid, p_product uuid, p_qty numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_from public.warehouses; v_to public.warehouses; v_ref uuid := gen_random_uuid(); v_cost numeric;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Quantità non valida' using errcode = '22023'; end if;
  if p_from = p_to then raise exception 'Scegli due magazzini diversi' using errcode = '22023'; end if;
  select * into v_from from public.warehouses where id = p_from;
  select * into v_to from public.warehouses where id = p_to;
  if v_from.id is null or v_to.id is null or v_from.org_id <> v_to.org_id then raise exception 'Magazzino non valido' using errcode = 'P0002'; end if;
  if not (app.has_facility_perm(v_from.org_id, v_from.facility_id, 'inventory.move') and app.has_facility_perm(v_to.org_id, v_to.facility_id, 'inventory.move')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if not exists (select 1 from public.products where id = p_product and org_id = v_from.org_id) then raise exception 'Prodotto non valido' using errcode = '22023'; end if;

  insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, ref_type, ref_id, note, created_by)
  values (v_from.org_id, v_from.facility_id, p_from, p_product, -p_qty, 'trasferimento', 'transfer', v_ref, coalesce(p_note, 'Verso ' || v_to.name), auth.uid()),
         (v_to.org_id, v_to.facility_id, p_to, p_product, p_qty, 'trasferimento', 'transfer', v_ref, coalesce(p_note, 'Da ' || v_from.name), auth.uid());
  return v_ref;
end $$;

-- Valore del magazzino (solo finance.view).
create or replace function public.inventory_valuation(p_facility uuid)
returns table (warehouse_id uuid, product_id uuid, qty numeric, avg_cost numeric, value numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not app.has_facility_perm(v_org, p_facility, 'finance.view') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  return query
    select s.warehouse_id, s.product_id, s.qty, coalesce(c.avg_cost, 0), (s.qty * coalesce(c.avg_cost, 0))::numeric(14,2)
    from public.stock_on_hand s left join public.product_costs c on c.product_id = s.product_id
    where s.facility_id = p_facility;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: avanzamento attività da parte dell'esecutore o del responsabile
-- ---------------------------------------------------------------------------
create or replace function public.task_transition(p_task uuid, p_to public.task_status, p_note text default null, p_photo text default null)
returns public.tasks
language plpgsql security definer set search_path = public as $$
declare v_t public.tasks; v_is_assignee boolean; v_is_manager boolean;
begin
  select * into v_t from public.tasks where id = p_task for update;
  if not found then raise exception 'Attività non trovata' using errcode = 'P0002'; end if;
  v_is_assignee := v_t.assignee_id = auth.uid() and app.has_facility_perm(v_t.org_id, v_t.facility_id, 'tasks.perform');
  v_is_manager := app.has_facility_perm(v_t.org_id, v_t.facility_id, 'tasks.manage');
  if not (v_is_assignee or v_is_manager) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_photo is not null and p_photo not like v_t.org_id::text || '/tasks/' || v_t.id::text || '/%' then
    raise exception 'Percorso foto non valido' using errcode = '22023';
  end if;

  if p_to = 'vista' and v_t.status = 'assegnata' then
    update public.tasks set status = 'vista', seen_at = now() where id = p_task returning * into v_t;
  elsif p_to = 'iniziata' and v_t.status in ('assegnata','vista') then
    update public.tasks set status = 'iniziata', seen_at = coalesce(seen_at, now()), started_at = now() where id = p_task returning * into v_t;
  elsif p_to = 'completata' and v_t.status in ('assegnata','vista','iniziata') then
    if v_t.requires_photo and coalesce(p_photo, v_t.photo_path) is null then
      raise exception 'Questa attività richiede una foto' using errcode = 'P0001';
    end if;
    update public.tasks set status = 'completata', seen_at = coalesce(seen_at, now()), started_at = coalesce(started_at, now()),
      completed_at = now(), completed_by = auth.uid(), completion_note = coalesce(p_note, completion_note), photo_path = coalesce(p_photo, photo_path)
      where id = p_task returning * into v_t;
  elsif p_to = 'verificata' and v_t.status = 'completata' and v_is_manager then
    update public.tasks set status = 'verificata', verified_at = now(), verified_by = auth.uid() where id = p_task returning * into v_t;
  elsif p_to = 'iniziata' and v_t.status = 'completata' and v_is_manager then
    -- respinta in verifica: torna in lavorazione
    update public.tasks set status = 'iniziata', completed_at = null, completed_by = null,
      completion_note = coalesce(p_note, completion_note) where id = p_task returning * into v_t;
  elsif p_to = 'annullata' and v_is_manager and v_t.status not in ('verificata','annullata') then
    update public.tasks set status = 'annullata' where id = p_task returning * into v_t;
  else
    raise exception 'Passaggio di stato non consentito (% → %)', v_t.status, p_to using errcode = 'P0001';
  end if;
  return v_t;
end $$;

grant execute on function public.po_transition(uuid, public.po_status) to authenticated;
grant execute on function public.orders_from_requests(uuid[]) to authenticated;
grant execute on function public.confirm_receipt(uuid) to authenticated;
grant execute on function public.start_receipt(uuid, uuid) to authenticated;
grant execute on function public.apply_inventory_count(uuid, jsonb) to authenticated;
grant execute on function public.manual_load(uuid, uuid, numeric, numeric, text) to authenticated;
grant execute on function public.inventory_valuation(uuid) to authenticated;
grant execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text) to authenticated;
grant execute on function public.task_transition(uuid, public.task_status, text, text) to authenticated;

-- Le funzioni security definer sono pubbliche per default in Postgres: le chiudiamo ad anon.
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- Magazzini di default per i reparti che gestiscono scorte
-- ---------------------------------------------------------------------------
create or replace function app.default_warehouse_for_department() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('cucina','bar','magazzino','market','housekeeping','manutenzione') then
    insert into public.warehouses (org_id, facility_id, department_id, name)
    values (new.org_id, new.facility_id, new.id, case when new.kind = 'magazzino' then 'Magazzino centrale' else 'Magazzino ' || new.name end);
  end if;
  return null;
end $$;
create trigger departments_default_warehouse after insert on public.departments
  for each row execute function app.default_warehouse_for_department();

-- Realtime: le tabelle operative pubblicano le modifiche ai client (RLS applicata da Supabase Realtime).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.tasks, public.purchase_requests, public.purchase_orders, public.receipts;
  end if;
end $$;
