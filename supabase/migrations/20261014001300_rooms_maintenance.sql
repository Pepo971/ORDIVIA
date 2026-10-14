-- Ordivia v3 — Camere, housekeeping, manutenzione e richieste ospiti.
--
-- Ordivia NON sostituisce il PMS: arrivi e partenze arriveranno dal PMS; per ora si inseriscono a mano o da CSV.
--
-- Modello
-- * Le unità sono i punti di servizio condivisi (public.service_points, kind 'camera' o 'piazzola');
--   room_units aggiunge piano, tipologia, capienza, stato camera e stato housekeeping.
-- * Soggiorni (room_stays): nessuna sovrapposizione sulla stessa unità (vincolo di esclusione su [arrivo, partenza)).
-- * Check-in / check-out / pulizia / ispezione sono RPC che aggiornano lo stato della camera in modo atomico;
--   il check-out mette la camera «libera sporca» e crea un'attività di pulizia (public.tasks).
-- * Addebiti in camera (stay_charges) senza importi; gli importi stanno in stay_charge_prices, leggibile
--   solo con rooms.manage o finance.view. Il minibar scarica il magazzino (ref_type 'minibar').
-- * Manutenzione: interventi con stati tracciati, cespiti, manutenzione programmata idempotente.
-- * Le scritture passano da RPC security definer che ricontrollano i permessi; i client hanno solo SELECT
--   (tranne cespiti, piani e prezzi minibar, scritti direttamente sotto RLS).

-- ---------------------------------------------------------------------------
-- Impostazioni per struttura
-- ---------------------------------------------------------------------------
create table public.room_settings (
  facility_id    uuid primary key,
  org_id         uuid not null references public.organizations(id) on delete cascade,
  checkin_time   time not null default '14:00',
  checkout_time  time not null default '10:00',
  updated_at     timestamptz not null default now(),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Unità (camere e piazzole)
-- ---------------------------------------------------------------------------
create table public.room_units (
  service_point_id uuid primary key,
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  floor            text check (floor is null or length(trim(floor)) between 1 and 20),
  room_type        text check (room_type is null or length(trim(room_type)) between 1 and 60),
  capacity         smallint check (capacity is null or capacity between 0 and 50),
  notes            text check (notes is null or length(notes) <= 500),
  -- stato della camera: in_arrivo / in_partenza sono normalmente calcolati dai soggiorni del giorno,
  -- ma restano valori ammessi (sincronizzazione futura con il PMS).
  status           text not null default 'libera_pulita' check (status in
                     ('libera_pulita','libera_sporca','occupata','in_partenza','in_arrivo','da_controllare','fuori_servizio')),
  status_note      text check (status_note is null or length(status_note) <= 300),
  hk_status        text not null default 'ispezionata' check (hk_status in ('pulita','sporca','in_pulizia','ispezionata')),
  hk_assignee      uuid references auth.users(id),
  hk_assigned_on   date,
  hk_cleaning_id   uuid,         -- pulizia in corso / ultima pulizia
  hk_task_id       uuid,         -- attività di pulizia aperta (dal check-out o da una richiesta)
  last_cleaned_at  timestamptz,
  updated_at       timestamptz not null default now(),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete cascade,
  foreign key (hk_task_id, org_id) references public.tasks(id, org_id) on delete set null (hk_task_id)
);
create index on public.room_units (org_id, facility_id);
create index on public.room_units (hk_assignee, hk_assigned_on);

-- ---------------------------------------------------------------------------
-- Soggiorni
-- ---------------------------------------------------------------------------
create table public.room_stays (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  service_point_id uuid not null,
  customer_id      uuid,
  guest_name       text not null check (length(trim(guest_name)) between 1 and 160),
  adults           smallint not null default 1 check (adults between 0 and 50),
  children         smallint not null default 0 check (children between 0 and 50),
  arrival_date     date not null,
  departure_date   date not null,
  eta              time,                -- orario di arrivo previsto
  status           text not null default 'prevista' check (status in ('prevista','in_casa','partita','annullata')),
  notes            text check (notes is null or length(notes) <= 1000),
  external_ref     text check (external_ref is null or length(external_ref) <= 80), -- riferimento PMS
  source           text not null default 'manuale' check (source in ('manuale','csv','pms')),
  checked_in_at    timestamptz,
  checked_in_by    uuid,
  checked_out_at   timestamptz,
  checked_out_by   uuid,
  cancelled_at     timestamptz,
  cancel_reason    text check (cancel_reason is null or length(cancel_reason) <= 300),
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (departure_date > arrival_date and departure_date - arrival_date <= 366),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id),
  foreign key (customer_id, org_id) references public.customers(id, org_id) on delete set null (customer_id),
  constraint room_stays_no_overlap exclude using gist (
    service_point_id with =,
    daterange(arrival_date, departure_date, '[)') with &&
  ) where (status in ('prevista','in_casa'))
);
create index on public.room_stays (facility_id, arrival_date);
create index on public.room_stays (facility_id, departure_date);
create index on public.room_stays (service_point_id, status);
create unique index room_stays_external_ref_uq on public.room_stays (facility_id, external_ref) where external_ref is not null;

-- ---------------------------------------------------------------------------
-- Pulizie (storico con orari)
-- ---------------------------------------------------------------------------
create table public.room_cleanings (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  service_point_id uuid not null,
  cleaning_date    date not null,
  kind             text not null check (kind in ('partenza','arrivo','fermata','extra')),
  cleaned_by       uuid references auth.users(id),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  note             text check (note is null or length(note) <= 500),
  inspected_at     timestamptz,
  inspected_by     uuid references auth.users(id),
  inspection_ok    boolean,
  inspection_note  text check (inspection_note is null or length(inspection_note) <= 500),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete cascade
);
create index on public.room_cleanings (facility_id, cleaning_date);
create index on public.room_cleanings (service_point_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Addebiti in camera (senza importi) + importi separati
-- ---------------------------------------------------------------------------
create table public.stay_charges (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  stay_id          uuid not null,
  service_point_id uuid not null,
  description      text not null check (length(trim(description)) between 1 and 160),
  qty              numeric(10,3) not null check (qty > 0),
  source           text not null default 'altro' check (source in ('minibar','room_service','altro')),
  product_id       uuid,
  warehouse_id     uuid,
  posted_by        uuid references auth.users(id),
  posted_at        timestamptz not null default now(),
  voided_at        timestamptz,
  voided_by        uuid,
  void_reason      text check (void_reason is null or length(void_reason) <= 300),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (stay_id, org_id) references public.room_stays(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id),
  foreign key (product_id, org_id) references public.products(id, org_id),
  foreign key (warehouse_id, org_id) references public.warehouses(id, org_id)
);
create index on public.stay_charges (stay_id);
create index on public.stay_charges (facility_id, posted_at desc);

create table public.stay_charge_prices (
  charge_id    uuid primary key,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  facility_id  uuid not null,
  unit_price   numeric(10,2) check (unit_price is null or unit_price >= 0), -- null = da prezzare
  amount       numeric(12,2) generated always as (round(coalesce(unit_price, 0) * qty, 2)) stored,
  qty          numeric(10,3) not null,
  foreign key (charge_id, org_id) references public.stay_charges(id, org_id) on delete cascade,
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);

-- Prezzi di vendita del minibar per prodotto (dato economico)
create table public.minibar_prices (
  facility_id  uuid not null,
  product_id   uuid not null,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  price        numeric(10,2) not null check (price >= 0),
  updated_at   timestamptz not null default now(),
  primary key (facility_id, product_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products(id, org_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Manutenzione
-- ---------------------------------------------------------------------------
create table public.assets (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  facility_id    uuid not null,
  name           text not null check (length(trim(name)) between 1 and 120),
  location       text check (location is null or length(trim(location)) between 1 and 120),
  category       text check (category is null or length(trim(category)) between 1 and 60),
  purchase_date  date,
  warranty_until date,
  notes          text check (notes is null or length(notes) <= 1000),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);
create index on public.assets (org_id, facility_id) where active;

create table public.maintenance_plans (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  facility_id   uuid not null,
  asset_id      uuid not null,
  title         text not null check (length(trim(title)) between 2 and 160),
  description   text check (description is null or length(description) <= 1000),
  category      text not null default 'altro',
  priority      text not null default 'media' check (priority in ('bassa','media','alta','urgente')),
  every_days    int not null check (every_days between 1 and 3660),
  next_due      date not null,
  assigned_to   uuid references auth.users(id),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (asset_id, org_id) references public.assets(id, org_id) on delete cascade
);
create index on public.maintenance_plans (facility_id, next_due) where active;

create table public.maintenance_tickets (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  facility_id       uuid not null,
  number            int not null,
  service_point_id  uuid,
  location_text     text check (location_text is null or length(trim(location_text)) between 1 and 120),
  asset_id          uuid,
  category          text not null default 'altro' check (category in
                      ('elettrico','idraulico','climatizzazione','arredi','elettrodomestici','informatica','struttura','piscina','giardino','pulizia','altro')),
  priority          text not null default 'media' check (priority in ('bassa','media','alta','urgente')),
  description       text not null check (length(trim(description)) between 3 and 2000),
  photo_path        text,
  status            text not null default 'aperto' check (status in
                      ('aperto','assegnato','in_corso','in_attesa_ricambi','risolto','verificato','annullato')),
  source            text not null default 'segnalazione' check (source in ('segnalazione','housekeeping','richiesta_ospite','pianificata')),
  guest_request_id  uuid,
  plan_id           uuid,
  planned_for       date,
  reported_by       uuid references auth.users(id),
  assigned_to       uuid references auth.users(id),
  assigned_at       timestamptz,
  started_at        timestamptz,
  waiting_parts_at  timestamptz,
  resolved_at       timestamptz,
  resolved_by       uuid,
  resolution_note   text check (resolution_note is null or length(resolution_note) <= 2000),
  verified_at       timestamptz,
  verified_by       uuid,
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, org_id),
  unique (facility_id, number),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete set null (service_point_id),
  foreign key (asset_id, org_id) references public.assets(id, org_id) on delete set null (asset_id),
  foreign key (guest_request_id, org_id) references public.guest_requests(id, org_id) on delete set null (guest_request_id),
  foreign key (plan_id, org_id) references public.maintenance_plans(id, org_id) on delete set null (plan_id)
);
create index on public.maintenance_tickets (org_id, facility_id, status);
create index on public.maintenance_tickets (reported_by);
create index on public.maintenance_tickets (assigned_to) where status not in ('verificato','annullato');
-- Idempotenza della manutenzione programmata: un intervento per piano e scadenza.
create unique index maintenance_tickets_plan_due_uq on public.maintenance_tickets (plan_id, planned_for) where plan_id is not null;

-- ---------------------------------------------------------------------------
-- Funzioni di supporto
-- ---------------------------------------------------------------------------
create or replace function app.rooms_staff(p_org uuid, p_facility uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_facility_perm(p_org, p_facility, 'rooms.operate') or app.has_facility_perm(p_org, p_facility, 'rooms.manage')
$$;

create or replace function app.rooms_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger room_units_touch before update on public.room_units for each row execute function app.rooms_touch();
create trigger room_stays_touch before update on public.room_stays for each row execute function app.rooms_touch();
create trigger maintenance_tickets_touch before update on public.maintenance_tickets for each row execute function app.rooms_touch();

-- I piani ereditano la struttura dal cespite (non fidarsi del client).
create or replace function app.maintenance_plan_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select facility_id into new.facility_id from public.assets where id = new.asset_id and org_id = new.org_id;
  if new.facility_id is null then raise exception 'Cespite non valido' using errcode = '22023'; end if;
  if new.assigned_to is not null and not app.has_perm_for_user(new.org_id, new.assigned_to, new.facility_id, 'maintenance.manage') then
    raise exception 'La persona scelta non gestisce la manutenzione in questa struttura' using errcode = '22023';
  end if;
  return new;
end $$;

-- La persona indicata (non l'utente corrente) ha il permesso nella struttura?
create or replace function app.has_perm_for_user(p_org uuid, p_user uuid, p_facility uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = p_org and m.user_id = p_user and m.active
      and (p_perm = any(r.permissions) or r.key = 'owner')
      and (m.all_facilities or r.key = 'owner' or p_facility = any(m.facility_ids))
  )
$$;

create trigger maintenance_plans_fill before insert or update on public.maintenance_plans
  for each row execute function app.maintenance_plan_fill();

-- Data di oggi nel fuso della struttura.
create or replace function app.rooms_today(p_facility uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select timezone from public.facilities where id = p_facility), 'Europe/Rome'))::date
$$;

-- Unità con blocco; crea la riga room_units se manca (camere create da altri moduli).
create or replace function app.room_lock(p_point uuid) returns public.room_units
language plpgsql security definer set search_path = public as $$
declare v_sp public.service_points; v_ru public.room_units;
begin
  select * into v_sp from public.service_points where id = p_point;
  if not found or v_sp.kind not in ('camera','piazzola') or not app.can_access_facility(v_sp.org_id, v_sp.facility_id) then
    raise exception 'Camera non trovata' using errcode = 'P0002';
  end if;
  insert into public.room_units (service_point_id, org_id, facility_id) values (v_sp.id, v_sp.org_id, v_sp.facility_id)
  on conflict (service_point_id) do nothing;
  select * into v_ru from public.room_units where service_point_id = p_point for update;
  return v_ru;
end $$;

create or replace function app.room_label(p_point uuid) returns text
language sql stable security definer set search_path = public as $$
  select case kind when 'piazzola' then 'Piazzola ' else 'Camera ' end || label from public.service_points where id = p_point
$$;

-- Reparto housekeeping della struttura (per le attività), se esiste.
create or replace function app.hk_department(p_facility uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.departments where facility_id = p_facility and kind = 'housekeeping' order by created_at limit 1
$$;

-- Crea un'attività di pulizia per la camera (assegnata a chi ha la camera oggi, se c'è) e la collega.
create or replace function app.hk_create_task(p_ru public.room_units, p_title text, p_description text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_task uuid; v_tz text; v_today date; v_checkin time; v_assignee uuid;
begin
  v_tz := coalesce((select timezone from public.facilities where id = p_ru.facility_id), 'Europe/Rome');
  v_today := app.rooms_today(p_ru.facility_id);
  v_checkin := coalesce((select checkin_time from public.room_settings where facility_id = p_ru.facility_id), '14:00');
  v_assignee := case when p_ru.hk_assigned_on = v_today then p_ru.hk_assignee end;
  insert into public.tasks (org_id, facility_id, department_id, title, description, assignee_id, due_at, created_by)
  values (p_ru.org_id, p_ru.facility_id, app.hk_department(p_ru.facility_id), left(p_title, 200), p_description, v_assignee,
          ((v_today + v_checkin)::timestamp at time zone v_tz), auth.uid())
  returning id into v_task;
  update public.room_units set hk_task_id = v_task where service_point_id = p_ru.service_point_id;
  return v_task;
end $$;

-- Chiude l'attività di pulizia collegata (se aperta).
create or replace function app.hk_close_task(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_task is null then return; end if;
  update public.tasks set status = 'completata', seen_at = coalesce(seen_at, now()), started_at = coalesce(started_at, now()),
    completed_at = now(), completed_by = auth.uid()
  where id = p_task and status in ('assegnata','vista','iniziata');
end $$;

create or replace function app.next_ticket_number(p_facility uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform pg_advisory_xact_lock(hashtext('maintenance_ticket_' || p_facility::text));
  select coalesce(max(number), 0) + 1 into v_n from public.maintenance_tickets where facility_id = p_facility;
  return v_n;
end $$;

-- Prima scadenza successiva a p_date (stessa regola di nextDueAfter() in packages/domain/src/rooms.ts).
create or replace function app.next_due_after(p_due date, p_every int, p_date date) returns date
language sql immutable set search_path = public as $$
  select case when p_due > p_date then p_due
              else p_due + p_every * ((p_date - p_due) / p_every + 1) end
$$;

-- ---------------------------------------------------------------------------
-- Audit, RLS
-- ---------------------------------------------------------------------------
select app.enable_audit('public.room_settings');
select app.enable_audit('public.room_units');
select app.enable_audit('public.room_stays');
select app.enable_audit('public.room_cleanings');
select app.enable_audit('public.stay_charges');
select app.enable_audit('public.assets');
select app.enable_audit('public.maintenance_plans');
select app.enable_audit('public.maintenance_tickets');
-- stay_charge_prices e minibar_prices sono dati economici: non finiscono nel registro (leggibile con audit.view).

alter table public.room_settings      enable row level security;
alter table public.room_units         enable row level security;
alter table public.room_stays         enable row level security;
alter table public.room_cleanings     enable row level security;
alter table public.stay_charges       enable row level security;
alter table public.stay_charge_prices enable row level security;
alter table public.minibar_prices     enable row level security;
alter table public.assets             enable row level security;
alter table public.maintenance_plans  enable row level security;
alter table public.maintenance_tickets enable row level security;

create policy rset_select on public.room_settings for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy rset_write on public.room_settings for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'rooms.manage')) with check (app.has_facility_perm(org_id, facility_id, 'rooms.manage'));

-- Stato camere: housekeeping, reception e manutenzione. Scritture solo via RPC.
create policy ru_select on public.room_units for select to authenticated
  using (app.rooms_staff(org_id, facility_id) or app.has_facility_perm(org_id, facility_id, 'maintenance.manage'));
create policy rst_select on public.room_stays for select to authenticated using (app.rooms_staff(org_id, facility_id));
create policy rcl2_select on public.room_cleanings for select to authenticated using (app.rooms_staff(org_id, facility_id));

-- Righe di addebito: chi lavora in camera e la finanza; importi solo responsabili e finanza.
create policy sc_select on public.stay_charges for select to authenticated
  using (app.rooms_staff(org_id, facility_id) or app.has_facility_perm(org_id, facility_id, 'finance.view'));
create policy scp_select on public.stay_charge_prices for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'rooms.manage') or app.has_facility_perm(org_id, facility_id, 'finance.view'));
create policy mbp_select on public.minibar_prices for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'rooms.manage') or app.has_facility_perm(org_id, facility_id, 'finance.view'));
create policy mbp_write on public.minibar_prices for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'rooms.manage')) with check (app.has_facility_perm(org_id, facility_id, 'rooms.manage'));

-- Cespiti: li vede chi segnala (per sceglierli), li gestisce la manutenzione.
create policy as_select on public.assets for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'maintenance.report') or app.has_facility_perm(org_id, facility_id, 'maintenance.manage'));
create policy as_write on public.assets for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'maintenance.manage')) with check (app.has_facility_perm(org_id, facility_id, 'maintenance.manage'));

create policy mp_select on public.maintenance_plans for select to authenticated using (app.has_facility_perm(org_id, facility_id, 'maintenance.manage'));
create policy mp_write on public.maintenance_plans for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'maintenance.manage'))
  with check (exists (select 1 from public.assets a where a.id = asset_id and a.org_id = maintenance_plans.org_id
                      and app.has_facility_perm(a.org_id, a.facility_id, 'maintenance.manage')));

-- Interventi: la manutenzione vede tutto; chi segnala vede i propri; chi è assegnato vede i suoi.
create policy mt_select on public.maintenance_tickets for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'maintenance.manage') or reported_by = auth.uid() or assigned_to = auth.uid());

-- ---------------------------------------------------------------------------
-- RPC: camere
-- ---------------------------------------------------------------------------
create or replace function public.rooms_create_units(p_facility uuid, p_kind text, p_labels text[], p_floor text default null,
  p_room_type text default null, p_capacity int default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_n int;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not app.can_access_facility(v_org, p_facility) then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_org, p_facility, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_kind not in ('camera','piazzola') then raise exception 'Tipo non valido: camera o piazzola' using errcode = '22023'; end if;
  if coalesce(array_length(p_labels, 1), 0) = 0 or array_length(p_labels, 1) > 300 then
    raise exception 'Indica da 1 a 300 unità' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_labels) l where length(trim(l)) not between 1 and 40) then
    raise exception 'Etichetta non valida' using errcode = '22023';
  end if;
  if p_capacity is not null and (p_capacity < 0 or p_capacity > 50) then raise exception 'Capienza non valida' using errcode = '22023'; end if;
  if p_floor is not null and length(trim(p_floor)) > 20 then raise exception 'Piano non valido' using errcode = '22023'; end if;

  with ins as (
    insert into public.service_points (org_id, facility_id, kind, label, zone, seats)
    select v_org, p_facility, p_kind, trim(l), nullif(trim(p_floor), ''), p_capacity
    from (select distinct trim(l) as l from unnest(p_labels) l) s
    on conflict (facility_id, kind, label) do nothing
    returning id
  )
  insert into public.room_units (service_point_id, org_id, facility_id, floor, room_type, capacity)
  select id, v_org, p_facility, nullif(trim(p_floor), ''), nullif(trim(p_room_type), ''), p_capacity from ins;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.room_update_unit(p_point uuid, p_floor text, p_room_type text, p_capacity int, p_notes text, p_active boolean default true)
returns void
language plpgsql security definer set search_path = public as $$
declare v_ru public.room_units;
begin
  v_ru := app.room_lock(p_point);
  if not app.has_facility_perm(v_ru.org_id, v_ru.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_capacity is not null and (p_capacity < 0 or p_capacity > 50) then raise exception 'Capienza non valida' using errcode = '22023'; end if;
  if not coalesce(p_active, true) and exists (select 1 from public.room_stays where service_point_id = p_point and status in ('prevista','in_casa')) then
    raise exception 'Ci sono soggiorni attivi o previsti su questa unità' using errcode = 'P0001';
  end if;
  update public.room_units set floor = nullif(trim(p_floor), ''), room_type = nullif(trim(p_room_type), ''), capacity = p_capacity,
    notes = nullif(trim(p_notes), '') where service_point_id = p_point;
  update public.service_points set zone = nullif(trim(p_floor), ''), seats = p_capacity, active = coalesce(p_active, true) where id = p_point;
end $$;

-- Stato impostato a mano dal responsabile (gli stati legati ai soggiorni li gestiscono check-in e check-out).
create or replace function public.room_set_status(p_point uuid, p_status text, p_note text default null) returns public.room_units
language plpgsql security definer set search_path = public as $$
declare v_ru public.room_units; v_occupied boolean;
begin
  v_ru := app.room_lock(p_point);
  if not app.has_facility_perm(v_ru.org_id, v_ru.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_status not in ('libera_pulita','libera_sporca','da_controllare','fuori_servizio') then
    raise exception 'Stato non impostabile a mano: usa check-in e check-out' using errcode = '22023';
  end if;
  if p_status = 'fuori_servizio' and length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Indica il motivo del fuori servizio' using errcode = '22023'; end if;
  v_occupied := exists (select 1 from public.room_stays where service_point_id = p_point and status = 'in_casa');
  if v_occupied and p_status <> 'fuori_servizio' then
    raise exception 'La camera è occupata: lo stato cambierà al check-out' using errcode = 'P0001';
  end if;
  update public.room_units set
    status = p_status,
    status_note = case when p_status = 'fuori_servizio' then trim(p_note) else nullif(trim(p_note), '') end,
    hk_status = case p_status when 'libera_sporca' then 'sporca' when 'libera_pulita' then 'ispezionata' when 'da_controllare' then 'pulita' else hk_status end
  where service_point_id = p_point returning * into v_ru;
  return v_ru;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: soggiorni
-- ---------------------------------------------------------------------------
create or replace function public.room_stay_save(
  p_stay uuid, p_point uuid, p_guest_name text, p_customer uuid, p_adults int, p_children int,
  p_arrival date, p_departure date, p_eta time default null, p_notes text default null, p_external_ref text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_sp public.service_points; v_old public.room_stays; v_id uuid;
begin
  select * into v_sp from public.service_points where id = p_point;
  if not found or v_sp.kind not in ('camera','piazzola') or not app.can_access_facility(v_sp.org_id, v_sp.facility_id) then
    raise exception 'Camera non trovata' using errcode = 'P0002';
  end if;
  if not app.has_facility_perm(v_sp.org_id, v_sp.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if length(trim(coalesce(p_guest_name, ''))) = 0 then raise exception 'Inserisci il nome dell''ospite' using errcode = '22023'; end if;
  if p_arrival is null or p_departure is null or p_departure <= p_arrival then
    raise exception 'La partenza deve essere successiva all''arrivo' using errcode = '22023';
  end if;
  if p_departure - p_arrival > 366 then raise exception 'Soggiorno troppo lungo' using errcode = '22023'; end if;
  if coalesce(p_adults, 0) < 0 or coalesce(p_adults, 0) > 50 or coalesce(p_children, 0) < 0 or coalesce(p_children, 0) > 50 then
    raise exception 'Numero di ospiti non valido' using errcode = '22023';
  end if;
  if p_customer is not null and not exists (select 1 from public.customers where id = p_customer and org_id = v_sp.org_id) then
    raise exception 'Cliente non trovato' using errcode = '22023';
  end if;

  begin
    if p_stay is null then
      insert into public.room_stays (org_id, facility_id, service_point_id, customer_id, guest_name, adults, children,
        arrival_date, departure_date, eta, notes, external_ref, created_by)
      values (v_sp.org_id, v_sp.facility_id, p_point, p_customer, trim(p_guest_name), coalesce(p_adults, 1), coalesce(p_children, 0),
        p_arrival, p_departure, p_eta, nullif(trim(p_notes), ''), nullif(trim(p_external_ref), ''), auth.uid())
      returning id into v_id;
    else
      select * into v_old from public.room_stays where id = p_stay for update;
      if not found or v_old.org_id <> v_sp.org_id then raise exception 'Soggiorno non trovato' using errcode = 'P0002'; end if;
      if not app.has_facility_perm(v_old.org_id, v_old.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
      if v_old.status not in ('prevista','in_casa') then raise exception 'Il soggiorno è chiuso e non si modifica' using errcode = 'P0001'; end if;
      if v_old.status = 'in_casa' and (p_point <> v_old.service_point_id or p_arrival <> v_old.arrival_date) then
        raise exception 'Ospite già in casa: si può cambiare solo la data di partenza e i dati dell''ospite' using errcode = 'P0001';
      end if;
      update public.room_stays set service_point_id = p_point, facility_id = v_sp.facility_id, customer_id = p_customer,
        guest_name = trim(p_guest_name), adults = coalesce(p_adults, 1), children = coalesce(p_children, 0),
        arrival_date = p_arrival, departure_date = p_departure, eta = p_eta, notes = nullif(trim(p_notes), ''),
        external_ref = nullif(trim(p_external_ref), '')
      where id = p_stay returning id into v_id;
    end if;
  exception when exclusion_violation then
    raise exception '% è già occupata in quelle date', app.room_label(p_point) using errcode = 'P0001';
  when unique_violation then
    raise exception 'Esiste già un soggiorno con questo riferimento PMS' using errcode = 'P0001';
  end;
  return v_id;
end $$;

-- Import da CSV (righe già validate dall'interfaccia, ricontrollate qui). Tutto o niente.
-- p_rows: [{ "room": "101", "guest_name": "...", "arrival": "2026-10-14", "departure": "2026-10-16", "adults": 2, "children": 0, "external_ref": null }]
-- Le righe identiche già presenti (stessa camera, nome e arrivo) vengono saltate.
create or replace function public.room_stays_import(p_facility uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid; v_row jsonb; v_point uuid; v_i int := 0; v_ins int := 0; v_skip int := 0;
  v_name text; v_arr date; v_dep date;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not app.can_access_facility(v_org, p_facility) then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_org, p_facility, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Nessuna riga da importare' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'Massimo 500 righe per importazione' using errcode = '22023'; end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    select id into v_point from public.service_points
      where facility_id = p_facility and kind in ('camera','piazzola') and label = trim(v_row ->> 'room') and active
      order by kind limit 1;
    if v_point is null then raise exception 'Riga %: camera «%» inesistente', v_i, v_row ->> 'room' using errcode = '22023'; end if;
    v_name := trim(coalesce(v_row ->> 'guest_name', ''));
    if length(v_name) = 0 then raise exception 'Riga %: manca il nome', v_i using errcode = '22023'; end if;
    begin
      v_arr := (v_row ->> 'arrival')::date;
      v_dep := (v_row ->> 'departure')::date;
    exception when others then
      raise exception 'Riga %: data non valida', v_i using errcode = '22023';
    end;
    if v_arr is null or v_dep is null or v_dep <= v_arr then raise exception 'Riga %: la partenza deve seguire l''arrivo', v_i using errcode = '22023'; end if;

    if exists (select 1 from public.room_stays where service_point_id = v_point and lower(guest_name) = lower(v_name)
               and arrival_date = v_arr and status <> 'annullata') then
      v_skip := v_skip + 1;
      continue;
    end if;
    begin
      insert into public.room_stays (org_id, facility_id, service_point_id, guest_name, adults, children, arrival_date, departure_date,
        external_ref, source, created_by)
      values (v_org, p_facility, v_point, v_name, coalesce((v_row ->> 'adults')::int, 1), coalesce((v_row ->> 'children')::int, 0),
        v_arr, v_dep, nullif(trim(v_row ->> 'external_ref'), ''), 'csv', auth.uid());
      v_ins := v_ins + 1;
    exception when exclusion_violation then
      raise exception 'Riga %: % è già occupata in quelle date', v_i, app.room_label(v_point) using errcode = 'P0001';
    when check_violation then
      raise exception 'Riga %: valori non validi (ospiti o date)', v_i using errcode = '22023';
    when unique_violation then
      raise exception 'Riga %: riferimento PMS già presente', v_i using errcode = 'P0001';
    end;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'skipped', v_skip);
end $$;

create or replace function public.room_checkin(p_stay uuid) returns public.room_stays
language plpgsql security definer set search_path = public as $$
declare v_s public.room_stays; v_ru public.room_units; v_today date;
begin
  select * into v_s from public.room_stays where id = p_stay for update;
  if not found or not app.rooms_staff(v_s.org_id, v_s.facility_id) then raise exception 'Soggiorno non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_s.status <> 'prevista' then raise exception 'Il soggiorno non è in attesa di arrivo' using errcode = 'P0001'; end if;
  v_today := app.rooms_today(v_s.facility_id);
  if v_s.arrival_date > v_today then raise exception 'L''arrivo è previsto per il %', to_char(v_s.arrival_date, 'DD/MM/YYYY') using errcode = 'P0001'; end if;
  if v_s.departure_date < v_today then raise exception 'La data di partenza è già passata: correggi il soggiorno' using errcode = 'P0001'; end if;
  v_ru := app.room_lock(v_s.service_point_id);
  if v_ru.status = 'fuori_servizio' then raise exception 'La camera è fuori servizio' using errcode = 'P0001'; end if;
  if exists (select 1 from public.room_stays where service_point_id = v_s.service_point_id and status = 'in_casa' and id <> p_stay) then
    raise exception 'In camera c''è ancora un ospite: fai prima il check-out' using errcode = 'P0001';
  end if;
  update public.room_stays set status = 'in_casa', checked_in_at = now(), checked_in_by = auth.uid() where id = p_stay returning * into v_s;
  update public.room_units set status = 'occupata', status_note = null where service_point_id = v_s.service_point_id;
  return v_s;
end $$;

create or replace function public.room_checkout(p_stay uuid) returns public.room_stays
language plpgsql security definer set search_path = public as $$
declare v_s public.room_stays; v_ru public.room_units; v_today date;
begin
  select * into v_s from public.room_stays where id = p_stay for update;
  if not found or not app.rooms_staff(v_s.org_id, v_s.facility_id) then raise exception 'Soggiorno non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_s.status <> 'in_casa' then raise exception 'L''ospite non risulta in casa' using errcode = 'P0001'; end if;
  v_today := app.rooms_today(v_s.facility_id);
  v_ru := app.room_lock(v_s.service_point_id);
  update public.room_stays set status = 'partita', checked_out_at = now(), checked_out_by = auth.uid(),
    departure_date = case when v_today > arrival_date and v_today < departure_date then v_today else departure_date end
  where id = p_stay returning * into v_s;
  update public.room_units set
    status = case when status = 'fuori_servizio' then status else 'libera_sporca' end,
    hk_status = 'sporca'
  where service_point_id = v_s.service_point_id returning * into v_ru;
  if v_ru.hk_task_id is null or not exists (select 1 from public.tasks where id = v_ru.hk_task_id and status in ('assegnata','vista','iniziata')) then
    perform app.hk_create_task(v_ru, 'Pulizia ' || app.room_label(v_s.service_point_id) || ' (partenza)',
      'Check-out di ' || v_s.guest_name || '. Rifare la camera e controllare il minibar.');
  end if;
  return v_s;
end $$;

create or replace function public.room_stay_cancel(p_stay uuid, p_reason text default null) returns public.room_stays
language plpgsql security definer set search_path = public as $$
declare v_s public.room_stays;
begin
  select * into v_s from public.room_stays where id = p_stay for update;
  if not found or not app.rooms_staff(v_s.org_id, v_s.facility_id) then raise exception 'Soggiorno non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_s.status <> 'prevista' then raise exception 'Si annullano solo soggiorni non ancora arrivati' using errcode = 'P0001'; end if;
  update public.room_stays set status = 'annullata', cancelled_at = now(), cancel_reason = nullif(trim(p_reason), '')
  where id = p_stay returning * into v_s;
  return v_s;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: housekeeping
-- ---------------------------------------------------------------------------
-- Assegna (o toglie, con p_user null) le camere a una persona per la giornata.
create or replace function public.hk_assign(p_points uuid[], p_user uuid, p_date date default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_p uuid; v_ru public.room_units; v_n int := 0; v_date date;
begin
  if coalesce(array_length(p_points, 1), 0) = 0 then raise exception 'Seleziona almeno una camera' using errcode = '22023'; end if;
  foreach v_p in array p_points loop
    v_ru := app.room_lock(v_p);
    if not app.has_facility_perm(v_ru.org_id, v_ru.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
    if p_user is not null and not app.has_perm_for_user(v_ru.org_id, p_user, v_ru.facility_id, 'rooms.operate') then
      raise exception 'La persona scelta non fa housekeeping in questa struttura' using errcode = '22023';
    end if;
    v_date := coalesce(p_date, app.rooms_today(v_ru.facility_id));
    update public.room_units set hk_assignee = p_user, hk_assigned_on = case when p_user is null then null else v_date end
    where service_point_id = v_p;
    -- l'attività di pulizia aperta segue l'assegnazione
    if v_ru.hk_task_id is not null and p_user is not null then
      update public.tasks set assignee_id = p_user where id = v_ru.hk_task_id and status in ('assegnata','vista');
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.hk_start(p_point uuid) returns public.room_units
language plpgsql security definer set search_path = public as $$
declare v_ru public.room_units; v_today date; v_kind text; v_cl uuid;
begin
  v_ru := app.room_lock(p_point);
  if not app.rooms_staff(v_ru.org_id, v_ru.facility_id) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_ru.hk_status = 'in_pulizia' then raise exception 'Pulizia già iniziata' using errcode = 'P0001'; end if;
  v_today := app.rooms_today(v_ru.facility_id);
  v_kind := case
    when exists (select 1 from public.room_stays where service_point_id = p_point and status = 'partita' and departure_date = v_today) then 'partenza'
    when exists (select 1 from public.room_stays where service_point_id = p_point and status = 'in_casa' and departure_date = v_today) then 'partenza'
    when exists (select 1 from public.room_stays where service_point_id = p_point and status = 'in_casa') then 'fermata'
    when exists (select 1 from public.room_stays where service_point_id = p_point and status = 'prevista' and arrival_date = v_today) then 'arrivo'
    else 'extra' end;
  insert into public.room_cleanings (org_id, facility_id, service_point_id, cleaning_date, kind, cleaned_by)
  values (v_ru.org_id, v_ru.facility_id, p_point, v_today, v_kind, auth.uid()) returning id into v_cl;
  update public.room_units set hk_status = 'in_pulizia', hk_cleaning_id = v_cl where service_point_id = p_point returning * into v_ru;
  if v_ru.hk_task_id is not null then
    update public.tasks set status = 'iniziata', seen_at = coalesce(seen_at, now()), started_at = now()
    where id = v_ru.hk_task_id and status in ('assegnata','vista');
  end if;
  return v_ru;
end $$;

create or replace function public.hk_finish(p_point uuid, p_note text default null) returns public.room_units
language plpgsql security definer set search_path = public as $$
declare v_ru public.room_units; v_occupied boolean;
begin
  v_ru := app.room_lock(p_point);
  if not app.rooms_staff(v_ru.org_id, v_ru.facility_id) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_ru.hk_status <> 'in_pulizia' then raise exception 'La pulizia non è stata iniziata' using errcode = 'P0001'; end if;
  v_occupied := exists (select 1 from public.room_stays where service_point_id = p_point and status = 'in_casa');
  update public.room_cleanings set finished_at = now(), note = nullif(trim(p_note), '') where id = v_ru.hk_cleaning_id;
  perform app.hk_close_task(v_ru.hk_task_id);
  update public.room_units set
    hk_status = 'pulita',
    last_cleaned_at = now(),
    hk_task_id = null,
    status = case when status = 'fuori_servizio' then status when v_occupied then 'occupata' else 'da_controllare' end
  where service_point_id = p_point returning * into v_ru;
  return v_ru;
end $$;

-- Ispezione del responsabile: ok → camera pronta; non ok → torna da rifare.
create or replace function public.hk_inspect(p_point uuid, p_ok boolean, p_note text default null) returns public.room_units
language plpgsql security definer set search_path = public as $$
declare v_ru public.room_units; v_occupied boolean;
begin
  v_ru := app.room_lock(p_point);
  if not app.has_facility_perm(v_ru.org_id, v_ru.facility_id, 'rooms.manage') then raise exception 'Solo il responsabile ispeziona le camere' using errcode = '42501'; end if;
  if v_ru.hk_status <> 'pulita' then raise exception 'Si ispeziona solo una camera appena pulita' using errcode = 'P0001'; end if;
  if not coalesce(p_ok, false) and length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Scrivi cosa va rifatto' using errcode = '22023'; end if;
  v_occupied := exists (select 1 from public.room_stays where service_point_id = p_point and status = 'in_casa');
  if v_ru.hk_cleaning_id is not null then
    update public.room_cleanings set inspected_at = now(), inspected_by = auth.uid(), inspection_ok = coalesce(p_ok, false),
      inspection_note = nullif(trim(p_note), '') where id = v_ru.hk_cleaning_id;
  end if;
  if coalesce(p_ok, false) then
    update public.room_units set hk_status = 'ispezionata',
      status = case when status = 'fuori_servizio' then status when v_occupied then 'occupata' else 'libera_pulita' end
    where service_point_id = p_point returning * into v_ru;
  else
    update public.room_units set hk_status = 'sporca', status_note = trim(p_note),
      status = case when status = 'fuori_servizio' then status when v_occupied then 'occupata' else 'libera_sporca' end
    where service_point_id = p_point returning * into v_ru;
    perform app.hk_create_task(v_ru, 'Da rifare: ' || app.room_label(p_point), 'Ispezione non superata: ' || trim(p_note));
  end if;
  return v_ru;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: minibar e addebiti
-- ---------------------------------------------------------------------------
-- Prodotti vendibili dal minibar: dal magazzino scelto o, se non indicato, da quello che si chiama «minibar».
-- Il prezzo è restituito solo a chi può vedere gli importi.
create or replace function public.minibar_products(p_facility uuid, p_warehouse uuid default null)
returns table (warehouse_id uuid, product_id uuid, name text, base_unit text, qty numeric, price numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid; v_wh uuid; v_money boolean;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not app.rooms_staff(v_org, p_facility) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  v_money := app.has_facility_perm(v_org, p_facility, 'rooms.manage') or app.has_facility_perm(v_org, p_facility, 'finance.view');
  if p_warehouse is not null then
    select id into v_wh from public.warehouses w where w.id = p_warehouse and w.facility_id = p_facility;
    if v_wh is null then raise exception 'Magazzino non trovato' using errcode = 'P0002'; end if;
  else
    select id into v_wh from public.warehouses w where w.facility_id = p_facility and w.name ilike '%minibar%' order by w.created_at limit 1;
    if v_wh is null then return; end if;
  end if;
  return query
    select v_wh, p.id, p.name, p.base_unit::text, coalesce(s.qty, 0)::numeric,
           case when v_money then mp.price end
    from public.products p
    left join (select m.product_id, sum(m.qty) as qty from public.stock_movements m where m.warehouse_id = v_wh group by m.product_id) s
      on s.product_id = p.id
    left join public.minibar_prices mp on mp.facility_id = p_facility and mp.product_id = p.id
    where p.org_id = v_org and p.active and (s.qty is not null or mp.product_id is not null)
    order by p.name;
end $$;

-- Consumo minibar: scarico di magazzino + riga di addebito sul soggiorno in corso (o partito oggi).
-- p_items: [{ "product_id": "...", "qty": 2 }]
create or replace function public.post_minibar(p_point uuid, p_warehouse uuid, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_ru public.room_units; v_stay public.room_stays; v_wh public.warehouses; v_item jsonb; v_qty numeric;
  v_prod public.products; v_price numeric; v_charge uuid; v_n int := 0; v_today date;
begin
  v_ru := app.room_lock(p_point);
  if not app.rooms_staff(v_ru.org_id, v_ru.facility_id) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Indica almeno un prodotto' using errcode = '22023'; end if;
  if p_warehouse is null then
    select * into v_wh from public.warehouses where facility_id = v_ru.facility_id and name ilike '%minibar%' order by created_at limit 1;
  else
    select * into v_wh from public.warehouses where id = p_warehouse and facility_id = v_ru.facility_id;
  end if;
  if v_wh.id is null then raise exception 'Scegli il magazzino da cui scaricare' using errcode = '22023'; end if;
  v_today := app.rooms_today(v_ru.facility_id);
  select * into v_stay from public.room_stays where service_point_id = p_point and status = 'in_casa' limit 1;
  if v_stay.id is null then
    select * into v_stay from public.room_stays where service_point_id = p_point and status = 'partita'
      and (checked_out_at at time zone coalesce((select timezone from public.facilities where id = v_ru.facility_id), 'Europe/Rome'))::date = v_today
      order by checked_out_at desc limit 1;
  end if;
  if v_stay.id is null then raise exception 'Nessun ospite in camera a cui addebitare' using errcode = 'P0001'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_qty := (v_item ->> 'qty')::numeric;
    exception when others then v_qty := null;
    end;
    if v_qty is null or v_qty <= 0 or v_qty > 99 then raise exception 'Quantità non valida' using errcode = '22023'; end if;
    select * into v_prod from public.products where id = (v_item ->> 'product_id')::uuid and org_id = v_ru.org_id;
    if v_prod.id is null then raise exception 'Prodotto non valido' using errcode = '22023'; end if;
    select price into v_price from public.minibar_prices where facility_id = v_ru.facility_id and product_id = v_prod.id;

    insert into public.stay_charges (org_id, facility_id, stay_id, service_point_id, description, qty, source, product_id, warehouse_id, posted_by)
    values (v_ru.org_id, v_ru.facility_id, v_stay.id, p_point, 'Minibar: ' || v_prod.name, v_qty, 'minibar', v_prod.id, v_wh.id, auth.uid())
    returning id into v_charge;
    insert into public.stay_charge_prices (charge_id, org_id, facility_id, unit_price, qty)
    values (v_charge, v_ru.org_id, v_ru.facility_id, v_price, v_qty);
    insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, ref_type, ref_id, note, created_by)
    values (v_ru.org_id, v_wh.facility_id, v_wh.id, v_prod.id, -v_qty, 'scarico', 'minibar', v_charge,
            'Minibar ' || app.room_label(p_point), auth.uid());
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Addebito manuale (room service, altro) dal responsabile.
create or replace function public.post_room_charge(p_stay uuid, p_description text, p_qty numeric, p_unit_price numeric, p_source text default 'altro')
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_s public.room_stays; v_id uuid;
begin
  select * into v_s from public.room_stays where id = p_stay;
  if not found or not app.rooms_staff(v_s.org_id, v_s.facility_id) then raise exception 'Soggiorno non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_s.status not in ('in_casa','partita') then raise exception 'Si addebita solo a un ospite arrivato' using errcode = 'P0001'; end if;
  if p_source not in ('minibar','room_service','altro') then raise exception 'Origine non valida' using errcode = '22023'; end if;
  if length(trim(coalesce(p_description, ''))) = 0 then raise exception 'Descrivi l''addebito' using errcode = '22023'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 999 then raise exception 'Quantità non valida' using errcode = '22023'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception 'Prezzo non valido' using errcode = '22023'; end if;
  insert into public.stay_charges (org_id, facility_id, stay_id, service_point_id, description, qty, source, posted_by)
  values (v_s.org_id, v_s.facility_id, p_stay, v_s.service_point_id, trim(p_description), p_qty, p_source, auth.uid()) returning id into v_id;
  insert into public.stay_charge_prices (charge_id, org_id, facility_id, unit_price, qty)
  values (v_id, v_s.org_id, v_s.facility_id, round(p_unit_price, 2), p_qty);
  return v_id;
end $$;

-- Prezzo di una riga «da prezzare» (es. minibar senza prezzo di listino).
create or replace function public.set_stay_charge_price(p_charge uuid, p_unit_price numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v_c public.stay_charges;
begin
  select * into v_c from public.stay_charges where id = p_charge;
  if not found or not app.rooms_staff(v_c.org_id, v_c.facility_id) then raise exception 'Addebito non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_c.org_id, v_c.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_c.voided_at is not null then raise exception 'Addebito stornato' using errcode = 'P0001'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception 'Prezzo non valido' using errcode = '22023'; end if;
  update public.stay_charge_prices set unit_price = round(p_unit_price, 2) where charge_id = p_charge;
end $$;

-- Storno: la riga resta (registro) ma non conta; il minibar torna a magazzino.
create or replace function public.void_stay_charge(p_charge uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_c public.stay_charges;
begin
  select * into v_c from public.stay_charges where id = p_charge for update;
  if not found or not app.rooms_staff(v_c.org_id, v_c.facility_id) then raise exception 'Addebito non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_c.org_id, v_c.facility_id, 'rooms.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_c.voided_at is not null then raise exception 'Addebito già stornato' using errcode = 'P0001'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Indica il motivo dello storno' using errcode = '22023'; end if;
  update public.stay_charges set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason) where id = p_charge;
  if v_c.source = 'minibar' and v_c.product_id is not null and v_c.warehouse_id is not null then
    insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, ref_type, ref_id, note, created_by)
    values (v_c.org_id, v_c.facility_id, v_c.warehouse_id, v_c.product_id, v_c.qty, 'rettifica', 'minibar', v_c.id,
            'Storno minibar: ' || trim(p_reason), auth.uid());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: manutenzione
-- ---------------------------------------------------------------------------
create or replace function public.open_maintenance_ticket(
  p_facility uuid, p_point uuid, p_location text, p_asset uuid, p_category text, p_priority text, p_description text,
  p_source text default 'segnalazione'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_id uuid; v_sp public.service_points;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not app.can_access_facility(v_org, p_facility) then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not (app.has_facility_perm(v_org, p_facility, 'maintenance.report') or app.has_facility_perm(v_org, p_facility, 'maintenance.manage')
          or (p_source = 'housekeeping' and app.rooms_staff(v_org, p_facility))) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if p_source not in ('segnalazione','housekeeping') then raise exception 'Origine non valida' using errcode = '22023'; end if;
  if length(trim(coalesce(p_description, ''))) < 3 then raise exception 'Descrivi il problema' using errcode = '22023'; end if;
  if p_point is null and length(trim(coalesce(p_location, ''))) = 0 then raise exception 'Indica dove si trova il problema' using errcode = '22023'; end if;
  if p_point is not null then
    select * into v_sp from public.service_points where id = p_point and facility_id = p_facility;
    if not found then raise exception 'Luogo non valido' using errcode = '22023'; end if;
  end if;
  if p_asset is not null and not exists (select 1 from public.assets where id = p_asset and facility_id = p_facility) then
    raise exception 'Cespite non valido' using errcode = '22023';
  end if;
  insert into public.maintenance_tickets (org_id, facility_id, number, service_point_id, location_text, asset_id, category, priority, description, source, reported_by)
  values (v_org, p_facility, app.next_ticket_number(p_facility), p_point, nullif(trim(p_location), ''), p_asset,
          coalesce(nullif(p_category, ''), 'altro'), coalesce(nullif(p_priority, ''), 'media'), trim(p_description), p_source, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.maintenance_set_photo(p_ticket uuid, p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare v_t public.maintenance_tickets;
begin
  select * into v_t from public.maintenance_tickets where id = p_ticket for update;
  if not found or not (v_t.reported_by = auth.uid() or v_t.assigned_to = auth.uid()
                       or app.has_facility_perm(v_t.org_id, v_t.facility_id, 'maintenance.manage')) then
    raise exception 'Intervento non trovato' using errcode = 'P0002';
  end if;
  if p_path is null or p_path not like v_t.org_id::text || '/maintenance/' || v_t.id::text || '/%' or p_path like '%..%' then
    raise exception 'Percorso foto non valido' using errcode = '22023';
  end if;
  update public.maintenance_tickets set photo_path = p_path where id = p_ticket;
end $$;

-- Avanzamento: aperto → assegnato → in_corso ⇄ in_attesa_ricambi → risolto → verificato (+ annullato, riapertura).
create or replace function public.maintenance_transition(p_ticket uuid, p_to text, p_note text default null, p_assignee uuid default null)
returns public.maintenance_tickets
language plpgsql security definer set search_path = public as $$
declare v_t public.maintenance_tickets; v_manage boolean; v_assignee boolean; v_reporter boolean;
begin
  select * into v_t from public.maintenance_tickets where id = p_ticket for update;
  if not found then raise exception 'Intervento non trovato' using errcode = 'P0002'; end if;
  v_manage := app.has_facility_perm(v_t.org_id, v_t.facility_id, 'maintenance.manage');
  v_assignee := v_t.assigned_to = auth.uid() and v_manage;
  v_reporter := v_t.reported_by = auth.uid();
  if not (v_manage or v_reporter) then raise exception 'Intervento non trovato' using errcode = 'P0002'; end if;

  if p_to = 'assegnato' and v_t.status in ('aperto','assegnato','in_corso','in_attesa_ricambi') then
    if not v_manage then raise exception 'Permesso negato' using errcode = '42501'; end if;
    if p_assignee is null then raise exception 'Scegli a chi assegnare' using errcode = '22023'; end if;
    if not app.has_perm_for_user(v_t.org_id, p_assignee, v_t.facility_id, 'maintenance.manage') then
      raise exception 'La persona scelta non gestisce la manutenzione in questa struttura' using errcode = '22023';
    end if;
    update public.maintenance_tickets set assigned_to = p_assignee, assigned_at = now(),
      status = case when status = 'aperto' then 'assegnato' else status end
    where id = p_ticket returning * into v_t;
  elsif p_to = 'in_corso' and v_t.status in ('aperto','assegnato','in_attesa_ricambi') then
    if not v_manage then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.maintenance_tickets set status = 'in_corso', started_at = coalesce(started_at, now()),
      assigned_to = coalesce(assigned_to, auth.uid()), assigned_at = coalesce(assigned_at, now())
    where id = p_ticket returning * into v_t;
  elsif p_to = 'in_attesa_ricambi' and v_t.status in ('assegnato','in_corso') then
    if not v_manage then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.maintenance_tickets set status = 'in_attesa_ricambi', waiting_parts_at = now(),
      resolution_note = coalesce(nullif(trim(p_note), ''), resolution_note)
    where id = p_ticket returning * into v_t;
  elsif p_to = 'risolto' and v_t.status in ('assegnato','in_corso','in_attesa_ricambi') then
    if not v_manage then raise exception 'Permesso negato' using errcode = '42501'; end if;
    if length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Scrivi cosa è stato fatto' using errcode = '22023'; end if;
    update public.maintenance_tickets set status = 'risolto', resolved_at = now(), resolved_by = auth.uid(), resolution_note = trim(p_note),
      started_at = coalesce(started_at, now())
    where id = p_ticket returning * into v_t;
  elsif p_to = 'verificato' and v_t.status = 'risolto' then
    -- verifica: il responsabile o chi ha segnalato, ma non chi ha risolto (se c'è qualcun altro che può farlo)
    if not (v_manage or v_reporter) then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.maintenance_tickets set status = 'verificato', verified_at = now(), verified_by = auth.uid()
    where id = p_ticket returning * into v_t;
  elsif p_to = 'in_corso' and v_t.status = 'risolto' then
    -- riaperto in verifica
    if not (v_manage or v_reporter) then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.maintenance_tickets set status = 'in_corso', resolved_at = null, resolved_by = null,
      resolution_note = coalesce(nullif(trim(p_note), ''), resolution_note)
    where id = p_ticket returning * into v_t;
  elsif p_to = 'annullato' and v_t.status not in ('verificato','annullato') then
    if not (v_manage or (v_reporter and v_t.status = 'aperto')) then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.maintenance_tickets set status = 'annullato', cancelled_at = now(),
      resolution_note = coalesce(nullif(trim(p_note), ''), resolution_note)
    where id = p_ticket returning * into v_t;
  else
    raise exception 'Passaggio di stato non consentito (% → %)', v_t.status, p_to using errcode = 'P0001';
  end if;
  return v_t;
end $$;

-- Manutenzione programmata: un intervento per ogni piano scaduto entro p_date, poi la scadenza avanza.
-- Idempotente: rieseguita nello stesso giorno non crea doppioni (scadenza già avanzata + indice unico).
create or replace function app.generate_planned_maintenance_core(p_facility uuid, p_date date) returns int
language plpgsql security definer set search_path = public as $$
declare v_p record; v_n int := 0; v_id uuid;
begin
  for v_p in select mp.*, a.name as asset_name, a.location as asset_location
             from public.maintenance_plans mp join public.assets a on a.id = mp.asset_id
             where mp.facility_id = p_facility and mp.active and a.active and mp.next_due <= p_date
             for update of mp
  loop
    v_id := null;
    insert into public.maintenance_tickets (org_id, facility_id, number, location_text, asset_id, category, priority, description,
      source, plan_id, planned_for, assigned_to, assigned_at, status)
    values (v_p.org_id, p_facility, app.next_ticket_number(p_facility), coalesce(v_p.asset_location, v_p.asset_name), v_p.asset_id,
      case when v_p.category in ('elettrico','idraulico','climatizzazione','arredi','elettrodomestici','informatica','struttura','piscina','giardino','pulizia','altro')
           then v_p.category else 'altro' end,
      v_p.priority, v_p.title || coalesce(E'\n' || v_p.description, ''), 'pianificata', v_p.id, v_p.next_due,
      v_p.assigned_to, case when v_p.assigned_to is not null then now() end,
      case when v_p.assigned_to is not null then 'assegnato' else 'aperto' end)
    on conflict (plan_id, planned_for) where plan_id is not null do nothing
    returning id into v_id;
    if v_id is not null then v_n := v_n + 1; end if;
    update public.maintenance_plans set next_due = app.next_due_after(v_p.next_due, v_p.every_days, p_date) where id = v_p.id;
  end loop;
  return v_n;
end $$;

create or replace function public.generate_planned_maintenance(p_facility uuid, p_date date default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null or not app.can_access_facility(v_org, p_facility) then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_org, p_facility, 'maintenance.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  return app.generate_planned_maintenance_core(p_facility, coalesce(p_date, app.rooms_today(p_facility)));
end $$;

-- Per un job pianificato (pg_cron): tutte le strutture, data locale di ciascuna.
create or replace function app.generate_all_planned_maintenance() returns int
language plpgsql security definer set search_path = public as $$
declare v_f record; v_n int := 0;
begin
  for v_f in select distinct facility_id from public.maintenance_plans where active loop
    v_n := v_n + app.generate_planned_maintenance_core(v_f.facility_id, app.rooms_today(v_f.facility_id));
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: richieste degli ospiti
-- ---------------------------------------------------------------------------
create or replace function app.lock_guest_request(p_request uuid) returns public.guest_requests
language plpgsql security definer set search_path = public as $$
declare v_r public.guest_requests;
begin
  select * into v_r from public.guest_requests where id = p_request for update;
  if not found or not app.can_handle_guest_requests(v_r.org_id, v_r.facility_id) then
    raise exception 'Richiesta non trovata' using errcode = 'P0002';
  end if;
  return v_r;
end $$;

create or replace function public.guest_request_set_status(p_request uuid, p_to text, p_note text default null) returns public.guest_requests
language plpgsql security definer set search_path = public as $$
declare v_r public.guest_requests;
begin
  v_r := app.lock_guest_request(p_request);
  if p_to = 'presa_in_carico' and v_r.status in ('nuova','presa_in_carico') then
    update public.guest_requests set status = 'presa_in_carico', assigned_to = auth.uid(), taken_at = now() where id = p_request returning * into v_r;
  elsif p_to = 'risolta' and v_r.status in ('nuova','presa_in_carico') then
    update public.guest_requests set status = 'risolta', resolved_at = now(), resolution_note = nullif(trim(p_note), ''),
      assigned_to = coalesce(assigned_to, auth.uid()), taken_at = coalesce(taken_at, now())
    where id = p_request returning * into v_r;
  elsif p_to = 'annullata' and v_r.status in ('nuova','presa_in_carico') then
    if length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Indica il motivo' using errcode = '22023'; end if;
    update public.guest_requests set status = 'annullata', resolved_at = now(), resolution_note = trim(p_note) where id = p_request returning * into v_r;
  elsif p_to = 'presa_in_carico' and v_r.status in ('risolta','annullata') then
    -- riapertura
    update public.guest_requests set status = 'presa_in_carico', assigned_to = auth.uid(), taken_at = now(), resolved_at = null
    where id = p_request returning * into v_r;
  else
    raise exception 'Passaggio di stato non consentito' using errcode = 'P0001';
  end if;
  return v_r;
end $$;

-- Richiesta «manutenzione» → intervento di manutenzione collegato; la richiesta passa in carico.
create or replace function public.guest_request_to_ticket(p_request uuid, p_priority text default 'media', p_category text default 'altro')
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_r public.guest_requests; v_id uuid;
begin
  v_r := app.lock_guest_request(p_request);
  if v_r.status not in ('nuova','presa_in_carico') then raise exception 'La richiesta è già chiusa' using errcode = 'P0001'; end if;
  if v_r.category not in ('manutenzione','reclamo','assistenza','altro') then
    raise exception 'Solo le richieste di manutenzione diventano interventi' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.maintenance_tickets where guest_request_id = p_request and status <> 'annullato') then
    raise exception 'Esiste già un intervento per questa richiesta' using errcode = 'P0001';
  end if;
  if p_priority not in ('bassa','media','alta','urgente') then raise exception 'Priorità non valida' using errcode = '22023'; end if;
  insert into public.maintenance_tickets (org_id, facility_id, number, service_point_id, location_text, category, priority, description,
    source, guest_request_id, reported_by)
  values (v_r.org_id, v_r.facility_id, app.next_ticket_number(v_r.facility_id), v_r.service_point_id,
    case when v_r.service_point_id is null then coalesce(nullif(trim(v_r.guest_name), ''), 'Richiesta ospite') end,
    case when p_category in ('elettrico','idraulico','climatizzazione','arredi','elettrodomestici','informatica','struttura','piscina','giardino','pulizia','altro')
         then p_category else 'altro' end,
    p_priority, left('Richiesta ospite: ' || v_r.message, 2000), 'richiesta_ospite', p_request, auth.uid())
  returning id into v_id;
  update public.guest_requests set status = 'presa_in_carico', assigned_to = coalesce(assigned_to, auth.uid()), taken_at = coalesce(taken_at, now()),
    resolution_note = 'Inviata alla manutenzione'
  where id = p_request;
  return v_id;
end $$;

-- Richiesta «pulizia» → attività di housekeeping (sulla camera se indicata).
create or replace function public.guest_request_to_housekeeping(p_request uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_r public.guest_requests; v_task uuid; v_ru public.room_units; v_label text;
begin
  v_r := app.lock_guest_request(p_request);
  if not app.rooms_staff(v_r.org_id, v_r.facility_id) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_r.status not in ('nuova','presa_in_carico') then raise exception 'La richiesta è già chiusa' using errcode = 'P0001'; end if;
  if v_r.category not in ('pulizia','room_service','assistenza','altro') then
    raise exception 'Solo le richieste di pulizia diventano attività di housekeeping' using errcode = 'P0001';
  end if;
  if v_r.service_point_id is not null and exists (select 1 from public.service_points where id = v_r.service_point_id and kind in ('camera','piazzola')) then
    v_ru := app.room_lock(v_r.service_point_id);
    v_label := app.room_label(v_r.service_point_id);
    v_task := app.hk_create_task(v_ru, 'Richiesta ospite: ' || v_label, v_r.message);
  else
    select label into v_label from public.service_points where id = v_r.service_point_id;
    insert into public.tasks (org_id, facility_id, department_id, title, description, created_by)
    values (v_r.org_id, v_r.facility_id, app.hk_department(v_r.facility_id),
            left('Richiesta ospite' || coalesce(': ' || v_label, ''), 200), v_r.message, auth.uid())
    returning id into v_task;
  end if;
  update public.guest_requests set status = 'presa_in_carico', assigned_to = coalesce(assigned_to, auth.uid()), taken_at = coalesce(taken_at, now()),
    resolution_note = 'Inviata all''housekeeping'
  where id = p_request;
  return v_task;
end $$;

-- ---------------------------------------------------------------------------
-- Archivio file: cartella «maintenance» (foto dei guasti)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'Schema storage assente (ambiente di test): policy foto manutenzione saltata';
    return;
  end if;
  execute $p$
    create policy ordivia_files_insert_maintenance on storage.objects for insert to authenticated
    with check (bucket_id = 'ordivia-files' and app.is_member(((storage.foldername(name))[1])::uuid)
                and (storage.foldername(name))[2] = 'maintenance')
  $p$;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime (filtrato per facility_id, RLS applicata)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['room_units','room_stays','room_cleanings','stay_charges','maintenance_tickets'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Permessi di esecuzione (per funzione: niente anon)
-- ---------------------------------------------------------------------------
revoke execute on function app.rooms_staff(uuid, uuid) from public, anon;
grant execute on function app.rooms_staff(uuid, uuid) to authenticated;
revoke execute on function app.has_perm_for_user(uuid, uuid, uuid, text) from public, anon;
grant execute on function app.has_perm_for_user(uuid, uuid, uuid, text) to authenticated;
revoke execute on function app.rooms_today(uuid) from public, anon;
grant execute on function app.rooms_today(uuid) to authenticated;
revoke execute on function app.next_due_after(date, int, date) from public, anon;
grant execute on function app.next_due_after(date, int, date) to authenticated;
-- funzioni interne: non richiamabili dai client
revoke execute on function app.rooms_touch() from public, anon, authenticated;
revoke execute on function app.maintenance_plan_fill() from public, anon, authenticated;
revoke execute on function app.room_lock(uuid) from public, anon, authenticated;
revoke execute on function app.room_label(uuid) from public, anon, authenticated;
revoke execute on function app.hk_department(uuid) from public, anon, authenticated;
revoke execute on function app.hk_create_task(public.room_units, text, text) from public, anon, authenticated;
revoke execute on function app.hk_close_task(uuid) from public, anon, authenticated;
revoke execute on function app.next_ticket_number(uuid) from public, anon, authenticated;
revoke execute on function app.generate_planned_maintenance_core(uuid, date) from public, anon, authenticated;
revoke execute on function app.generate_all_planned_maintenance() from public, anon, authenticated;
revoke execute on function app.lock_guest_request(uuid) from public, anon, authenticated;

revoke execute on function public.rooms_create_units(uuid, text, text[], text, text, int) from public, anon;
grant execute on function public.rooms_create_units(uuid, text, text[], text, text, int) to authenticated;
revoke execute on function public.room_update_unit(uuid, text, text, int, text, boolean) from public, anon;
grant execute on function public.room_update_unit(uuid, text, text, int, text, boolean) to authenticated;
revoke execute on function public.room_set_status(uuid, text, text) from public, anon;
grant execute on function public.room_set_status(uuid, text, text) to authenticated;
revoke execute on function public.room_stay_save(uuid, uuid, text, uuid, int, int, date, date, time, text, text) from public, anon;
grant execute on function public.room_stay_save(uuid, uuid, text, uuid, int, int, date, date, time, text, text) to authenticated;
revoke execute on function public.room_stays_import(uuid, jsonb) from public, anon;
grant execute on function public.room_stays_import(uuid, jsonb) to authenticated;
revoke execute on function public.room_checkin(uuid) from public, anon;
grant execute on function public.room_checkin(uuid) to authenticated;
revoke execute on function public.room_checkout(uuid) from public, anon;
grant execute on function public.room_checkout(uuid) to authenticated;
revoke execute on function public.room_stay_cancel(uuid, text) from public, anon;
grant execute on function public.room_stay_cancel(uuid, text) to authenticated;
revoke execute on function public.hk_assign(uuid[], uuid, date) from public, anon;
grant execute on function public.hk_assign(uuid[], uuid, date) to authenticated;
revoke execute on function public.hk_start(uuid) from public, anon;
grant execute on function public.hk_start(uuid) to authenticated;
revoke execute on function public.hk_finish(uuid, text) from public, anon;
grant execute on function public.hk_finish(uuid, text) to authenticated;
revoke execute on function public.hk_inspect(uuid, boolean, text) from public, anon;
grant execute on function public.hk_inspect(uuid, boolean, text) to authenticated;
revoke execute on function public.minibar_products(uuid, uuid) from public, anon;
grant execute on function public.minibar_products(uuid, uuid) to authenticated;
revoke execute on function public.post_minibar(uuid, uuid, jsonb) from public, anon;
grant execute on function public.post_minibar(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.post_room_charge(uuid, text, numeric, numeric, text) from public, anon;
grant execute on function public.post_room_charge(uuid, text, numeric, numeric, text) to authenticated;
revoke execute on function public.set_stay_charge_price(uuid, numeric) from public, anon;
grant execute on function public.set_stay_charge_price(uuid, numeric) to authenticated;
revoke execute on function public.void_stay_charge(uuid, text) from public, anon;
grant execute on function public.void_stay_charge(uuid, text) to authenticated;
revoke execute on function public.open_maintenance_ticket(uuid, uuid, text, uuid, text, text, text, text) from public, anon;
grant execute on function public.open_maintenance_ticket(uuid, uuid, text, uuid, text, text, text, text) to authenticated;
revoke execute on function public.maintenance_set_photo(uuid, text) from public, anon;
grant execute on function public.maintenance_set_photo(uuid, text) to authenticated;
revoke execute on function public.maintenance_transition(uuid, text, text, uuid) from public, anon;
grant execute on function public.maintenance_transition(uuid, text, text, uuid) to authenticated;
revoke execute on function public.generate_planned_maintenance(uuid, date) from public, anon;
grant execute on function public.generate_planned_maintenance(uuid, date) to authenticated;
revoke execute on function public.guest_request_set_status(uuid, text, text) from public, anon;
grant execute on function public.guest_request_set_status(uuid, text, text) to authenticated;
revoke execute on function public.guest_request_to_ticket(uuid, text, text) from public, anon;
grant execute on function public.guest_request_to_ticket(uuid, text, text) to authenticated;
revoke execute on function public.guest_request_to_housekeeping(uuid) from public, anon;
grant execute on function public.guest_request_to_housekeeping(uuid) to authenticated;
