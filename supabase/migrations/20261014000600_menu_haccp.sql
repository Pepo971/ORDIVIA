-- Ordivia v2 — Menu, ricette, food cost e HACCP.
-- Si appoggia alle tabelle comuni di 20261014000500 (prep_stations, menu_categories, menu_items, recipe_lines)
-- e aggiunge: coerenza tra struttura e riferimenti, food cost completo, effetto aumenti fornitori,
-- attrezzature e registro temperature, etichette di preparazione/apertura con lotto interno e QR.

-- ---------------------------------------------------------------------------
-- Allergeni UE (Reg. 1169/2011, allegato II): chiavi stabili usate da app e database
-- ---------------------------------------------------------------------------
create or replace function app.eu_allergens() returns text[]
language sql immutable set search_path = pg_catalog as $$
  select array['glutine','crostacei','uova','pesce','arachidi','soia','latte','frutta_a_guscio',
               'sedano','senape','sesamo','solfiti','lupini','molluschi']::text[]
$$;

-- ---------------------------------------------------------------------------
-- Coerenza: categoria, centro di produzione e magazzino devono stare nella stessa struttura
-- (le FK composite garantiscono già la stessa organizzazione)
-- ---------------------------------------------------------------------------
create or replace function app.menu_item_check_refs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.category_id is not null and not exists (
       select 1 from public.menu_categories c where c.id = new.category_id and c.facility_id = new.facility_id) then
    raise exception 'La categoria appartiene a un''altra struttura' using errcode = '22023';
  end if;
  if new.prep_station_id is not null and not exists (
       select 1 from public.prep_stations p where p.id = new.prep_station_id and p.facility_id = new.facility_id) then
    raise exception 'Il centro di produzione appartiene a un''altra struttura' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger menu_items_check_refs before insert or update of facility_id, category_id, prep_station_id on public.menu_items
  for each row execute function app.menu_item_check_refs();

create or replace function app.prep_station_check_refs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.warehouse_id is not null and not exists (
       select 1 from public.warehouses w where w.id = new.warehouse_id and w.facility_id = new.facility_id) then
    raise exception 'Il magazzino appartiene a un''altra struttura' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger prep_stations_check_refs before insert or update of facility_id, warehouse_id on public.prep_stations
  for each row execute function app.prep_station_check_refs();

create index if not exists recipe_lines_product_idx on public.recipe_lines (product_id);

-- ---------------------------------------------------------------------------
-- Costo porzione (sostituisce la versione base mantenendo la firma):
-- costo = Σ qty / (1 − scarto) × costo unitario / resa. Costo unitario = medio ponderato, altrimenti ultimo.
-- I costi sono visibili solo con menu.manage o finance.view sulla struttura.
-- ---------------------------------------------------------------------------
create or replace function public.menu_item_costs(p_facility uuid)
returns table (menu_item_id uuid, portion_cost numeric, missing_costs int)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not (app.has_facility_perm(v_org, p_facility, 'menu.manage') or app.has_facility_perm(v_org, p_facility, 'finance.view')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  return query
    select m.id,
           coalesce(sum(r.qty / (1 - r.waste_pct / 100) * coalesce(nullif(c.avg_cost, 0), c.last_cost, 0)), 0) / m.yield_portions,
           (count(r.id) filter (where coalesce(nullif(c.avg_cost, 0), c.last_cost) is null))::int
    from public.menu_items m
    left join public.recipe_lines r on r.menu_item_id = m.id
    left join public.product_costs c on c.product_id = r.product_id
    where m.facility_id = p_facility
    group by m.id, m.yield_portions;
end $$;

-- Food cost completo per voce di menu.
--   prezzo netto   = prezzo IVA inclusa / (1 + IVA)
--   food cost %    = costo porzione / prezzo netto
--   margine        = prezzo netto − costo porzione (margine di contribuzione unitario)
--   prezzo consigliato (IVA inclusa, arrotondato per eccesso a 0,10 €) = costo / target × (1 + IVA)
create or replace function public.menu_food_cost(p_facility uuid)
returns table (
  menu_item_id uuid, price numeric, vat_rate numeric, net_price numeric,
  portion_cost numeric, portion_cost_last numeric, food_cost_pct numeric,
  margin numeric, margin_pct numeric, target_food_cost_pct numeric, recommended_price numeric,
  over_target boolean, ingredients int, missing_costs int
)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not (app.has_facility_perm(v_org, p_facility, 'menu.manage') or app.has_facility_perm(v_org, p_facility, 'finance.view')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  return query
  with l as (
    select m.id as item_id, r.id as line_id,
           r.qty / (1 - r.waste_pct / 100) / m.yield_portions as qty_portion,
           coalesce(nullif(c.avg_cost, 0), c.last_cost) as unit_cost,
           coalesce(c.last_cost, nullif(c.avg_cost, 0)) as unit_last
    from public.menu_items m
    left join public.recipe_lines r on r.menu_item_id = m.id
    left join public.product_costs c on c.product_id = r.product_id
    where m.facility_id = p_facility
  ), a as (
    select item_id,
           coalesce(sum(qty_portion * coalesce(unit_cost, 0)), 0) as cost,
           coalesce(sum(qty_portion * coalesce(unit_last, 0)), 0) as cost_last,
           count(line_id)::int as n,
           (count(line_id) filter (where unit_cost is null))::int as miss
    from l group by item_id
  ), x as (
    select m.id, m.price, m.vat_rate, m.price / (1 + m.vat_rate / 100) as net, a.cost, a.cost_last, a.n, a.miss, m.target_food_cost_pct as target
    from public.menu_items m join a on a.item_id = m.id
  )
  select x.id, x.price, x.vat_rate, round(x.net, 2), round(x.cost, 4), round(x.cost_last, 4),
         case when x.net > 0 then round(x.cost / x.net * 100, 1) end,
         round(x.net - x.cost, 2),
         case when x.net > 0 then round((x.net - x.cost) / x.net * 100, 1) end,
         x.target,
         case when x.cost > 0 and x.target > 0 then ceil(round(x.cost / (x.target / 100) * (1 + x.vat_rate / 100) * 10, 6)) / 10 end,
         (x.net > 0 and x.cost / x.net * 100 > x.target) or (x.net = 0 and x.cost > 0),
         x.n, x.miss
  from x;
end $$;

-- Costo delle singole righe di una ricetta (per porzione), per l'editor della distinta base.
create or replace function public.menu_recipe_costs(p_item uuid)
returns table (recipe_line_id uuid, product_id uuid, unit_cost numeric, last_cost numeric, line_cost numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_m public.menu_items;
begin
  select * into v_m from public.menu_items where id = p_item;
  if not found or not (app.has_facility_perm(v_m.org_id, v_m.facility_id, 'menu.manage') or app.has_facility_perm(v_m.org_id, v_m.facility_id, 'finance.view')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  return query
    select r.id, r.product_id, coalesce(nullif(c.avg_cost, 0), c.last_cost), c.last_cost,
           case when coalesce(nullif(c.avg_cost, 0), c.last_cost) is not null
                then round(r.qty / (1 - r.waste_pct / 100) * coalesce(nullif(c.avg_cost, 0), c.last_cost) / v_m.yield_portions, 4) end
    from public.recipe_lines r left join public.product_costs c on c.product_id = r.product_id
    where r.menu_item_id = p_item;
end $$;

-- Effetto aumenti fornitori: per ogni ingrediente con un aumento recente (ultimo costo > costo medio,
-- oppure listino/ricezione più cari dell'ultimo prezzo diverso nello storico) stima l'impatto € per porzione.
create or replace function public.menu_supplier_impact(p_facility uuid, p_days int default 90)
returns table (
  menu_item_id uuid, product_id uuid, product_name text, base_unit text, qty_per_portion numeric,
  old_unit_cost numeric, new_unit_cost numeric, increase_pct numeric, impact_per_portion numeric,
  source text, observed_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not (app.has_facility_perm(v_org, p_facility, 'menu.manage') or app.has_facility_perm(v_org, p_facility, 'finance.view')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 730 then raise exception 'Periodo non valido' using errcode = '22023'; end if;

  return query
  with used as (
    select distinct r.product_id from public.recipe_lines r
    join public.menu_items m on m.id = r.menu_item_id
    where m.facility_id = p_facility and m.active
  ), sp_changes as (
    select sp.product_id, h0.price / sp.pack_qty as old_u, h1.price / sp.pack_qty as new_u,
           'Listino ' || s.name as src, h1.observed_at as obs
    from public.supplier_products sp
    join used u on u.product_id = sp.product_id
    join public.suppliers s on s.id = sp.supplier_id
    cross join lateral (
      select h.id, h.price, h.observed_at from public.supplier_price_history h
      where h.supplier_product_id = sp.id order by h.observed_at desc, h.id desc limit 1) h1
    cross join lateral (
      select h.price from public.supplier_price_history h
      where h.supplier_product_id = sp.id and h.id < h1.id and h.price <> h1.price
      order by h.observed_at desc, h.id desc limit 1) h0
    where sp.org_id = v_org and s.active
      and h1.observed_at >= now() - make_interval(days => p_days)
      and h1.price > h0.price and h0.price > 0
      and (sp.preferred or not exists (select 1 from public.supplier_products p2 where p2.product_id = sp.product_id and p2.preferred))
  ), cost_changes as (
    select c.product_id, c.avg_cost as old_u, c.last_cost as new_u, 'Ultimo carico'::text as src, c.updated_at as obs
    from public.product_costs c join used u on u.product_id = c.product_id
    where c.org_id = v_org and c.avg_cost > 0 and c.last_cost > c.avg_cost
      and c.updated_at >= now() - make_interval(days => p_days)
  ), best as (
    select distinct on (z.product_id) z.* from (select * from sp_changes union all select * from cost_changes) z
    order by z.product_id, (z.new_u - z.old_u) desc
  )
  select m.id, p.id, p.name, p.base_unit::text,
         round(r.qty / (1 - r.waste_pct / 100) / m.yield_portions, 4),
         round(b.old_u, 4), round(b.new_u, 4), round((b.new_u - b.old_u) / b.old_u * 100, 1),
         round(r.qty / (1 - r.waste_pct / 100) / m.yield_portions * (b.new_u - b.old_u), 4),
         b.src, b.obs
  from best b
  join public.recipe_lines r on r.product_id = b.product_id
  join public.menu_items m on m.id = r.menu_item_id and m.facility_id = p_facility and m.active
  join public.products p on p.id = b.product_id
  order by 9 desc;
end $$;

-- ---------------------------------------------------------------------------
-- HACCP: permessi di lettura
-- ---------------------------------------------------------------------------
create or replace function app.haccp_can_read(p_org uuid, p_facility uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_facility_perm(p_org, p_facility, 'haccp.record')
      or app.has_facility_perm(p_org, p_facility, 'menu.manage')
      or app.has_facility_perm(p_org, p_facility, 'pos.kitchen')
$$;

-- ---------------------------------------------------------------------------
-- Attrezzature e registro temperature
-- ---------------------------------------------------------------------------
create table public.haccp_equipment (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  facility_id   uuid not null,
  department_id uuid,
  name          text not null check (length(trim(name)) between 1 and 80),
  kind          text not null default 'frigorifero' check (kind in ('frigorifero','congelatore','abbattitore','cella','vetrina','altro')),
  min_temp      numeric(5,1) not null,
  max_temp      numeric(5,1) not null,
  sort          int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  check (min_temp < max_temp),
  check (min_temp between -60 and 100 and max_temp between -60 and 100),
  unique (id, org_id),
  unique (facility_id, name),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (department_id, org_id) references public.departments(id, org_id) on delete set null (department_id)
);
create index on public.haccp_equipment (org_id, facility_id);

create table public.haccp_temperature_logs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  facility_id       uuid not null,
  equipment_id      uuid not null,
  value             numeric(5,1) not null check (value between -60 and 120),
  min_temp          numeric(5,1) not null,   -- limiti al momento della rilevazione
  max_temp          numeric(5,1) not null,
  out_of_range      boolean not null,
  corrective_action text check (corrective_action is null or length(corrective_action) <= 500),
  corrective_at     timestamptz,
  corrective_by     uuid,
  note              text check (note is null or length(note) <= 500),
  recorded_by       uuid not null,
  recorded_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (equipment_id, org_id) references public.haccp_equipment(id, org_id) on delete cascade
);
create index on public.haccp_temperature_logs (equipment_id, recorded_at desc);
create index on public.haccp_temperature_logs (org_id, facility_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- Etichette di preparazione / apertura con lotto interno e tracciabilità dei lotti di origine
-- ---------------------------------------------------------------------------
create table public.haccp_lot_counters (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  facility_id uuid not null,
  day         date not null,
  last_seq    int not null default 0,
  primary key (facility_id, day),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);

create table public.haccp_labels (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  facility_id     uuid not null,
  kind            text not null default 'preparazione' check (kind in ('preparazione','apertura')),
  menu_item_id    uuid,
  product_id      uuid,
  name            text not null check (length(trim(name)) between 1 and 120),
  quantity        text check (quantity is null or length(quantity) <= 60),
  lot_code        text not null,
  token           text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  prepared_at     timestamptz not null,
  opened_at       timestamptz,
  shelf_life_days numeric(6,2) not null check (shelf_life_days >= 0 and shelf_life_days <= 730),
  expires_at      timestamptz not null,
  expiry_capped   boolean not null default false, -- limitata dalla scadenza di un lotto di origine
  storage         text check (storage is null or length(storage) <= 80),
  allergens       text[] not null default '{}' check (allergens <@ app.eu_allergens()),
  source_lots     jsonb not null default '[]' check (jsonb_typeof(source_lots) = 'array'),
  note            text check (note is null or length(note) <= 500),
  operator_id     uuid not null,
  operator_name   text,
  status          text not null default 'attiva' check (status in ('attiva','consumata','scartata')),
  closed_at       timestamptz,
  closed_by       uuid,
  created_at      timestamptz not null default now(),
  unique (id, org_id),
  unique (facility_id, lot_code),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (menu_item_id, org_id) references public.menu_items(id, org_id) on delete set null (menu_item_id),
  foreign key (product_id, org_id) references public.products(id, org_id) on delete set null (product_id)
);
create index on public.haccp_labels (org_id, facility_id, status, expires_at);
create index on public.haccp_labels using gin (source_lots jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- Audit, RLS
-- ---------------------------------------------------------------------------
select app.enable_audit('public.haccp_equipment');
select app.enable_audit('public.haccp_temperature_logs');
select app.enable_audit('public.haccp_labels');

alter table public.haccp_equipment        enable row level security;
alter table public.haccp_temperature_logs enable row level security;
alter table public.haccp_lot_counters     enable row level security;
alter table public.haccp_labels           enable row level security;

create policy he_select on public.haccp_equipment for select to authenticated using (app.haccp_can_read(org_id, facility_id));
create policy he_write  on public.haccp_equipment for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'menu.manage') or app.has_facility_perm(org_id, facility_id, 'org.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'menu.manage') or app.has_facility_perm(org_id, facility_id, 'org.manage'));

-- Registro e etichette: lettura per chi lavora in cucina/HACCP; scritture solo tramite RPC.
create policy htl_select on public.haccp_temperature_logs for select to authenticated using (app.haccp_can_read(org_id, facility_id));
create policy hl_select  on public.haccp_labels for select to authenticated using (app.haccp_can_read(org_id, facility_id));
-- haccp_lot_counters: nessuna policy (solo RPC).
revoke insert, update, delete on public.haccp_temperature_logs from authenticated, anon;
revoke insert, update, delete on public.haccp_labels from authenticated, anon;
revoke all on public.haccp_lot_counters from authenticated, anon;

-- ---------------------------------------------------------------------------
-- RPC: temperature
-- ---------------------------------------------------------------------------
create or replace function public.haccp_record_temperature(p_equipment uuid, p_value numeric, p_corrective_action text default null, p_note text default null)
returns public.haccp_temperature_logs
language plpgsql security definer set search_path = public as $$
declare v_eq public.haccp_equipment; v_log public.haccp_temperature_logs; v_out boolean; v_action text := nullif(trim(p_corrective_action), '');
begin
  select * into v_eq from public.haccp_equipment where id = p_equipment;
  if not found or not app.can_access_facility(v_eq.org_id, v_eq.facility_id) then
    raise exception 'Attrezzatura non trovata' using errcode = 'P0002';
  end if;
  if not app.has_facility_perm(v_eq.org_id, v_eq.facility_id, 'haccp.record') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if not v_eq.active then raise exception 'Attrezzatura non attiva' using errcode = 'P0001'; end if;
  if p_value is null or p_value < -60 or p_value > 120 then raise exception 'Temperatura non valida' using errcode = '22023'; end if;
  v_out := p_value < v_eq.min_temp or p_value > v_eq.max_temp;
  insert into public.haccp_temperature_logs (org_id, facility_id, equipment_id, value, min_temp, max_temp, out_of_range,
                                             corrective_action, corrective_at, corrective_by, note, recorded_by)
  values (v_eq.org_id, v_eq.facility_id, v_eq.id, round(p_value, 1), v_eq.min_temp, v_eq.max_temp, v_out,
          v_action, case when v_action is not null then now() end, case when v_action is not null then auth.uid() end,
          nullif(trim(p_note), ''), auth.uid())
  returning * into v_log;
  return v_log;
end $$;

-- Azione correttiva aggiunta dopo la rilevazione (una sola volta: il registro resta immutabile).
create or replace function public.haccp_set_corrective_action(p_log uuid, p_action text)
returns public.haccp_temperature_logs
language plpgsql security definer set search_path = public as $$
declare v_log public.haccp_temperature_logs;
begin
  select * into v_log from public.haccp_temperature_logs where id = p_log for update;
  if not found or not app.can_access_facility(v_log.org_id, v_log.facility_id) then raise exception 'Rilevazione non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_log.org_id, v_log.facility_id, 'haccp.record') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if nullif(trim(p_action), '') is null then raise exception 'Descrivi l''azione correttiva' using errcode = '22023'; end if;
  if v_log.corrective_action is not null then raise exception 'Azione correttiva già registrata' using errcode = 'P0001'; end if;
  update public.haccp_temperature_logs set corrective_action = left(trim(p_action), 500), corrective_at = now(), corrective_by = auth.uid()
    where id = p_log returning * into v_log;
  return v_log;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: lotti disponibili per la tracciabilità (carichi con lotto della struttura)
-- ---------------------------------------------------------------------------
create or replace function public.haccp_available_lots(p_facility uuid, p_days int default 120)
returns table (product_id uuid, product_name text, lot text, expires_on date, received_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not (app.has_facility_perm(v_org, p_facility, 'haccp.record') or app.has_facility_perm(v_org, p_facility, 'menu.manage')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  return query
    select m.product_id, p.name, m.lot, max(m.expires_on), max(m.created_at)
    from public.stock_movements m join public.products p on p.id = m.product_id
    where m.facility_id = p_facility and m.org_id = v_org and m.kind = 'carico' and m.lot is not null and length(trim(m.lot)) > 0
      and m.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 120), 730)))
    group by m.product_id, p.name, m.lot
    order by max(m.created_at) desc
    limit 300;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: etichette
-- ---------------------------------------------------------------------------
create or replace function public.haccp_create_label(
  p_facility uuid,
  p_kind text,
  p_shelf_life_days numeric,
  p_menu_item uuid default null,
  p_product uuid default null,
  p_name text default null,
  p_prepared_at timestamptz default null,
  p_opened_at timestamptz default null,
  p_storage text default null,
  p_allergens text[] default null,
  p_source_lots jsonb default '[]',
  p_quantity text default null,
  p_note text default null
) returns public.haccp_labels
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid; v_tz text; v_name text; v_allergens text[]; v_base timestamptz; v_exp timestamptz; v_cap timestamptz;
  v_day date; v_seq int; v_lot text; v_lbl public.haccp_labels; v_src jsonb := coalesce(p_source_lots, '[]'::jsonb); v_item jsonb;
  v_prepared timestamptz := coalesce(p_prepared_at, now());
begin
  select org_id, timezone into v_org, v_tz from public.facilities where id = p_facility;
  if v_org is null or not app.has_facility_perm(v_org, p_facility, 'haccp.record') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_kind not in ('preparazione','apertura') then raise exception 'Tipo di etichetta non valido' using errcode = '22023'; end if;
  if p_shelf_life_days is null or p_shelf_life_days < 0 or p_shelf_life_days > 730 then
    raise exception 'Durata di conservazione non valida' using errcode = '22023';
  end if;
  if p_prepared_at is not null and p_prepared_at > now() + interval '1 hour' then
    raise exception 'La data di preparazione non può essere nel futuro' using errcode = '22023';
  end if;
  if p_opened_at is not null and p_opened_at > now() + interval '1 hour' then
    raise exception 'La data di apertura non può essere nel futuro' using errcode = '22023';
  end if;

  if p_menu_item is not null then
    select name, allergens into v_name, v_allergens from public.menu_items where id = p_menu_item and org_id = v_org and facility_id = p_facility;
    if v_name is null then raise exception 'Voce di menu non valida' using errcode = '22023'; end if;
  elsif p_product is not null then
    select name, allergens into v_name, v_allergens from public.products where id = p_product and org_id = v_org;
    if v_name is null then raise exception 'Prodotto non valido' using errcode = '22023'; end if;
  end if;
  v_name := coalesce(nullif(trim(p_name), ''), v_name);
  if v_name is null then raise exception 'Indica cosa stai etichettando' using errcode = '22023'; end if;
  v_allergens := coalesce(p_allergens, v_allergens, '{}');
  if not v_allergens <@ app.eu_allergens() then raise exception 'Allergene non riconosciuto' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct a order by a), '{}') into v_allergens from unnest(v_allergens) a;

  if jsonb_typeof(v_src) <> 'array' or jsonb_array_length(v_src) > 30 then raise exception 'Lotti di origine non validi' using errcode = '22023'; end if;
  for v_item in select * from jsonb_array_elements(v_src) loop
    if jsonb_typeof(v_item) <> 'object' or nullif(trim(v_item ->> 'lot'), '') is null then
      raise exception 'Ogni lotto di origine deve avere un codice' using errcode = '22023';
    end if;
    if v_item ? 'expires_on' and v_item ->> 'expires_on' is not null and (v_item ->> 'expires_on') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Scadenza del lotto di origine non valida' using errcode = '22023';
    end if;
  end loop;

  -- Scadenza: dall'apertura (etichetta di apertura) o dalla preparazione, mai oltre la scadenza di un lotto di origine.
  v_base := case when p_kind = 'apertura' then coalesce(p_opened_at, now()) else v_prepared end;
  v_exp := v_base + make_interval(secs => p_shelf_life_days * 86400);
  select min(((x ->> 'expires_on')::date + 1)::timestamp at time zone v_tz) into v_cap
    from jsonb_array_elements(v_src) x where x ->> 'expires_on' is not null;

  -- Lotto interno: L + AAMMGG + progressivo del giorno per struttura
  v_day := (now() at time zone v_tz)::date;
  insert into public.haccp_lot_counters (org_id, facility_id, day, last_seq) values (v_org, p_facility, v_day, 1)
  on conflict (facility_id, day) do update set last_seq = haccp_lot_counters.last_seq + 1
  returning last_seq into v_seq;
  v_lot := 'L' || to_char(v_day, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');

  insert into public.haccp_labels (org_id, facility_id, kind, menu_item_id, product_id, name, quantity, lot_code, prepared_at, opened_at,
                                   shelf_life_days, expires_at, expiry_capped, storage, allergens, source_lots, note, operator_id, operator_name)
  values (v_org, p_facility, p_kind, p_menu_item, case when p_menu_item is null then p_product end, left(v_name, 120),
          nullif(trim(p_quantity), ''), v_lot, v_prepared,
          case when p_kind = 'apertura' then coalesce(p_opened_at, now()) else p_opened_at end,
          p_shelf_life_days, least(v_exp, coalesce(v_cap, v_exp)), v_cap is not null and v_cap < v_exp,
          nullif(trim(p_storage), ''), v_allergens, v_src, nullif(trim(p_note), ''),
          auth.uid(), (select coalesce(full_name, email) from public.profiles where id = auth.uid()))
  returning * into v_lbl;
  return v_lbl;
end $$;

create or replace function public.haccp_close_label(p_label uuid, p_status text)
returns public.haccp_labels
language plpgsql security definer set search_path = public as $$
declare v_lbl public.haccp_labels;
begin
  select * into v_lbl from public.haccp_labels where id = p_label for update;
  if not found or not app.can_access_facility(v_lbl.org_id, v_lbl.facility_id) then raise exception 'Etichetta non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_lbl.org_id, v_lbl.facility_id, 'haccp.record') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_status not in ('consumata','scartata') then raise exception 'Stato non valido' using errcode = '22023'; end if;
  if v_lbl.status <> 'attiva' then raise exception 'Etichetta già chiusa' using errcode = 'P0001'; end if;
  update public.haccp_labels set status = p_status, closed_at = now(), closed_by = auth.uid() where id = p_label returning * into v_lbl;
  return v_lbl;
end $$;

-- Lettura del QR: dal token all'etichetta, solo per chi può leggere l'HACCP della struttura.
create or replace function public.haccp_label_by_token(p_token text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_lbl public.haccp_labels;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then raise exception 'Etichetta non trovata' using errcode = 'P0002'; end if;
  select * into v_lbl from public.haccp_labels where token = p_token;
  if not found or not app.haccp_can_read(v_lbl.org_id, v_lbl.facility_id) then
    raise exception 'Etichetta non trovata' using errcode = 'P0002';
  end if;
  return v_lbl.id;
end $$;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
