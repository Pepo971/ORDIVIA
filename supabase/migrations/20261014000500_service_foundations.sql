-- Ordivia v2 — basi comuni per Menu/Ricette, Sala e Cassa, Spiaggia, Turni.
-- Questo file definisce SOLO ciò che più moduli condividono: permessi, ruoli operativi,
-- catalogo di vendita (menu + ricette) e punti di servizio (tavoli, ombrelloni, camere…).

-- ---------------------------------------------------------------------------
-- Permessi nuovi
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description, sensitive) values
  ('menu.manage',    'Gestire menu, prezzi di vendita e ricette', false),
  ('pos.operate',    'Prendere comande e incassare', false),
  ('pos.kitchen',    'Lavorare le comande in cucina, bar e pass', false),
  ('pos.supervise',  'Sconti, annullamenti, chiusura cassa', false),
  ('beach.operate',  'Gestire la spiaggia in servizio (check-in, spostamenti)', false),
  ('beach.manage',   'Configurare mappa, listino e prenotazioni stagionali della spiaggia', false),
  ('shifts.manage',  'Pianificare turni, approvare ferie e cambi turno', false),
  ('shifts.view',    'Vedere i propri turni e chiedere ferie o cambi', false),
  ('haccp.record',   'Registrare lotti, temperature ed etichette HACCP', false)
on conflict (key) do nothing;

-- Titolare e amministratore hanno sempre tutto; aggiorniamo i ruoli di sistema esistenti
-- e quelli che verranno creati.
create or replace function app.seed_system_roles(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.roles (org_id, key, name, is_system, permissions) values
    (p_org, 'owner',     'Titolare',                true, (select array_agg(key) from public.permissions)),
    (p_org, 'admin',     'Amministratore',          true, (select array_agg(key) from public.permissions)),
    (p_org, 'manager',   'Manager',                 true, array['tasks.manage','tasks.perform','suppliers.manage','purchasing.request','purchasing.approve','purchasing.send','receiving.perform','inventory.view','inventory.move','inventory.count','finance.view','audit.view','menu.manage','pos.operate','pos.kitchen','pos.supervise','beach.operate','beach.manage','shifts.manage','shifts.view','haccp.record','stations.manage']),
    (p_org, 'dept_lead', 'Responsabile di reparto', true, array['tasks.manage','tasks.perform','purchasing.request','receiving.perform','inventory.view','inventory.move','inventory.count','pos.operate','pos.kitchen','shifts.view','haccp.record']),
    (p_org, 'warehouse', 'Magazziniere',            true, array['tasks.perform','receiving.perform','inventory.view','inventory.move','inventory.count','shifts.view','haccp.record']),
    (p_org, 'cashier',   'Cassiere',                true, array['tasks.perform','pos.operate','pos.supervise','shifts.view']),
    (p_org, 'waiter',    'Cameriere',               true, array['tasks.perform','pos.operate','shifts.view']),
    (p_org, 'cook',      'Cuoco / Pizzaiolo',       true, array['tasks.perform','pos.kitchen','inventory.view','haccp.record','shifts.view']),
    (p_org, 'bartender', 'Bartender',               true, array['tasks.perform','pos.operate','pos.kitchen','inventory.view','shifts.view']),
    (p_org, 'beach',     'Spiaggino',               true, array['tasks.perform','beach.operate','pos.operate','shifts.view']),
    (p_org, 'staff',     'Collaboratore',           true, array['tasks.perform','inventory.view','shifts.view'])
  on conflict (org_id, key) do update set permissions = excluded.permissions, name = excluded.name;
end $$;

do $$ declare r record; begin
  for r in select id from public.organizations loop
    perform app.seed_system_roles(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Centri di produzione: dove va una comanda (cucina, pizzeria, bar, dessert…)
-- ---------------------------------------------------------------------------
create table public.prep_stations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  facility_id   uuid not null,
  department_id uuid,
  name          text not null check (length(trim(name)) between 1 and 60),
  kind          text not null default 'cucina' check (kind in ('cucina','pizzeria','bar','dessert','griglia','altro')),
  sort          int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (department_id, org_id) references public.departments(id, org_id) on delete set null (department_id)
);
create index on public.prep_stations (org_id, facility_id);

-- ---------------------------------------------------------------------------
-- Menu: ciò che si vende
-- ---------------------------------------------------------------------------
create table public.menu_categories (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  facility_id uuid not null,
  name        text not null check (length(trim(name)) between 1 and 60),
  sort        int not null default 0,
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);

create table public.menu_items (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  category_id      uuid,
  prep_station_id  uuid,                 -- dove si prepara (null = nessuna preparazione, es. acqua al banco)
  name             text not null check (length(trim(name)) between 1 and 120),
  description      text,
  price            numeric(10,2) not null check (price >= 0),  -- prezzo di vendita IVA inclusa
  vat_rate         numeric(5,2) not null default 10,
  allergens        text[] not null default '{}',
  course           smallint not null default 1, -- ordine di uscita (1 antipasti … 9 dessert/bar)
  -- disponibilità in servizio
  available        boolean not null default true,
  portions_left    int check (portions_left is null or portions_left >= 0),
  -- ricetta: quante porzioni produce la distinta base (di solito 1)
  yield_portions   numeric(10,3) not null default 1 check (yield_portions > 0),
  target_food_cost_pct numeric(5,2) not null default 30,
  sort             int not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (category_id, org_id) references public.menu_categories(id, org_id) on delete set null (category_id),
  foreign key (prep_station_id, org_id) references public.prep_stations(id, org_id) on delete set null (prep_station_id)
);
create index on public.menu_items (org_id, facility_id) where active;

-- Distinta base: ingredienti per la resa indicata (yield_portions)
create table public.recipe_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  menu_item_id  uuid not null,
  product_id    uuid not null,
  qty           numeric(14,4) not null check (qty > 0), -- unità base del prodotto
  waste_pct     numeric(5,2) not null default 0 check (waste_pct >= 0 and waste_pct < 100),
  foreign key (menu_item_id, org_id) references public.menu_items(id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products(id, org_id)
);
create index on public.recipe_lines (menu_item_id);

-- Magazzino da cui scaricare gli ingredienti per centro di produzione
alter table public.prep_stations add column warehouse_id uuid;
alter table public.prep_stations add foreign key (warehouse_id, org_id) references public.warehouses(id, org_id) on delete set null (warehouse_id);

-- ---------------------------------------------------------------------------
-- Punti di servizio: tavoli, ombrelloni, lettini, camere, aree, punti di ritiro
-- ---------------------------------------------------------------------------
create table public.service_points (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  facility_id  uuid not null,
  kind         text not null check (kind in ('tavolo','ombrellone','lettino','cabina','gazebo','camera','piazzola','piscina','ritiro','altro')),
  label        text not null check (length(trim(label)) between 1 and 40),
  zone         text,           -- sala, terrazza, settore A…
  row_label    text,           -- fila (spiaggia)
  pos_x        numeric(8,2),   -- coordinate per la mappa
  pos_y        numeric(8,2),
  seats        smallint,       -- coperti o posti (lettini inclusi)
  -- token pubblico per il QR: non rivela id interni
  public_token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (id, org_id),
  unique (facility_id, kind, label),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);
create index on public.service_points (org_id, facility_id, kind);

-- ---------------------------------------------------------------------------
-- Audit, RLS
-- ---------------------------------------------------------------------------
select app.enable_audit('public.prep_stations');
select app.enable_audit('public.menu_categories');
select app.enable_audit('public.menu_items');
select app.enable_audit('public.recipe_lines');
select app.enable_audit('public.service_points');

alter table public.prep_stations   enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items      enable row level security;
alter table public.recipe_lines    enable row level security;
alter table public.service_points  enable row level security;

create policy ps_select on public.prep_stations for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy ps_write  on public.prep_stations for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'menu.manage')) with check (app.has_facility_perm(org_id, facility_id, 'menu.manage'));

create policy mc_select on public.menu_categories for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy mc_write  on public.menu_categories for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'menu.manage')) with check (app.has_facility_perm(org_id, facility_id, 'menu.manage'));

create policy mi_select on public.menu_items for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy mi_write  on public.menu_items for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'menu.manage')) with check (app.has_facility_perm(org_id, facility_id, 'menu.manage'));
-- La disponibilità (esaurito / porzioni) la aggiorna anche la cucina: tramite RPC set_item_availability (modulo Sala).

-- Le ricette rivelano quantità e quindi costi: le vede chi gestisce il menu, la cucina o la finanza.
create policy rl_select on public.recipe_lines for select to authenticated using (
  exists (select 1 from public.menu_items m where m.id = menu_item_id
          and (app.has_facility_perm(m.org_id, m.facility_id, 'menu.manage')
               or app.has_facility_perm(m.org_id, m.facility_id, 'pos.kitchen')
               or app.has_perm(m.org_id, 'finance.view'))));
create policy rl_write on public.recipe_lines for all to authenticated
  using (exists (select 1 from public.menu_items m where m.id = menu_item_id and app.has_facility_perm(m.org_id, m.facility_id, 'menu.manage')))
  with check (exists (select 1 from public.menu_items m where m.id = menu_item_id and m.org_id = recipe_lines.org_id
                      and app.has_facility_perm(m.org_id, m.facility_id, 'menu.manage')));

create policy sp2_select on public.service_points for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy sp2_write  on public.service_points for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'org.manage') or app.has_facility_perm(org_id, facility_id, 'beach.manage') or app.has_facility_perm(org_id, facility_id, 'menu.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'org.manage') or app.has_facility_perm(org_id, facility_id, 'beach.manage') or app.has_facility_perm(org_id, facility_id, 'menu.manage'));

-- Costo teorico di una porzione dalla ricetta (costo medio ponderato degli ingredienti).
create or replace function public.menu_item_costs(p_facility uuid)
returns table (menu_item_id uuid, portion_cost numeric, missing_costs int)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not (app.has_facility_perm(v_org, p_facility, 'menu.manage') or app.has_perm(v_org, 'finance.view')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  return query
    select m.id,
           coalesce(sum(r.qty / (1 - r.waste_pct / 100) * coalesce(c.avg_cost, c.last_cost, 0)), 0) / m.yield_portions,
           count(r.id) filter (where c.product_id is null)::int
    from public.menu_items m
    left join public.recipe_lines r on r.menu_item_id = m.id
    left join public.product_costs c on c.product_id = r.product_id
    where m.facility_id = p_facility
    group by m.id, m.yield_portions;
end $$;
grant execute on function public.menu_item_costs(uuid) to authenticated;

-- Centri di produzione di default per i reparti di produzione esistenti e futuri
create or replace function app.default_prep_station_for_department() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('cucina','bar') then
    insert into public.prep_stations (org_id, facility_id, department_id, name, kind, warehouse_id)
    values (new.org_id, new.facility_id, new.id, new.name, new.kind,
            (select id from public.warehouses w where w.department_id = new.id limit 1));
  end if;
  return null;
end $$;
-- dopo il trigger del magazzino (ordine alfabetico dei trigger: "departments_default_warehouse" < "departments_prep_station")
create trigger departments_prep_station after insert on public.departments
  for each row execute function app.default_prep_station_for_department();

insert into public.prep_stations (org_id, facility_id, department_id, name, kind, warehouse_id)
select d.org_id, d.facility_id, d.id, d.name, d.kind, (select id from public.warehouses w where w.department_id = d.id limit 1)
from public.departments d
where d.kind in ('cucina','bar') and not exists (select 1 from public.prep_stations p where p.department_id = d.id);

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
