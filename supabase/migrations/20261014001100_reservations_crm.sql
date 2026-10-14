-- Ordivia v3 — Prenotazioni (ristorante, aperitivo, pizzeria, eventi, degustazioni, pacchetti, servizi della struttura)
-- e Clienti (CRM).
--
-- Regole principali
-- * La disponibilità si calcola nel database: capacità per fascia oraria (coperti o posti) e durata del servizio.
--   Una prenotazione occupa i posti per tutta la sua durata; per una nuova richiesta conta il picco di presenze
--   contemporanee nell'intervallo [inizio, inizio + durata). Stessa regola di peakLoad() in packages/domain/src/reservations.ts.
-- * Le prenotazioni si scrivono solo tramite RPC (capacità verificata con il servizio bloccato: niente overbooking in
--   concorrenza). Un tavolo non può essere assegnato a due prenotazioni attive sovrapposte (vincolo di esclusione).
-- * I clienti sono dell'organizzazione: si collegano o si creano per telefono (normalizzato +39) o email, senza doppioni.
-- * Consenso marketing solo con fonte e data; la modifica dei consensi richiede crm.manage; ogni variazione è registrata.
-- * GDPR: esportazione JSON e anonimizzazione (crm.manage). L'anonimizzazione toglie i dati personali e conserva lo
--   storico economico (comande, incassi spiaggia, coperti).
-- * La spesa del cliente è visibile solo con finance.view.
-- * Portale QR / receptionist AI: public_reservation_services, public_reservation_slots e public_create_reservation,
--   eseguibili da anon e indirizzati dal token pubblico non indovinabile della struttura.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Token pubblico della struttura (portale, receptionist AI)
-- ---------------------------------------------------------------------------
alter table public.facilities add column if not exists public_token text default encode(extensions.gen_random_bytes(16), 'hex');
update public.facilities set public_token = encode(extensions.gen_random_bytes(16), 'hex') where public_token is null;
alter table public.facilities alter column public_token set not null;
create unique index if not exists facilities_public_token_key on public.facilities (public_token);

-- ---------------------------------------------------------------------------
-- Normalizzazione dei recapiti (stessa regola di normalizePhone()/normalizeEmail() nel dominio)
-- ---------------------------------------------------------------------------
create or replace function app.norm_phone(p text) returns text
language plpgsql immutable set search_path = public as $$
declare s text;
begin
  if p is null then return null; end if;
  s := trim(p);
  if left(s, 1) = '+' then
    s := '+' || regexp_replace(s, '[^0-9]', '', 'g');
  else
    s := regexp_replace(s, '[^0-9]', '', 'g');
    if s like '00%' then
      s := '+' || substr(s, 3);
    elsif s like '39%' and length(s) >= 11 then
      s := '+' || s;
    elsif s ~ '^[03]' then
      s := '+39' || s;
    elsif length(s) >= 11 then
      s := '+' || s;
    else
      s := '+39' || s;
    end if;
  end if;
  if s !~ '^\+[0-9]{6,15}$' then return null; end if;
  return s;
end $$;

create or replace function app.norm_email(p text) returns text
language sql immutable set search_path = public as $$
  select case when lower(trim(p)) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(trim(p)) <= 160 then lower(trim(p)) end
$$;

create index if not exists customers_norm_phone_idx on public.customers (org_id, app.norm_phone(phone)) where phone is not null;

-- Elenco di testi brevi pulito (allergie, tag): senza vuoti né doppioni, max 20 voci da 60 caratteri.
create or replace function app.clean_list(p text[]) returns text[]
language sql immutable set search_path = public as $$
  select coalesce(array_agg(v order by first), '{}') from (
    select lower(left(trim(x), 60)) as v, min(ord) as first
    from unnest(coalesce(p, '{}')) with ordinality as u(x, ord)
    where length(trim(x)) > 0
    group by lower(left(trim(x), 60))
    order by min(ord)
    limit 20
  ) s
$$;

-- ---------------------------------------------------------------------------
-- Servizi prenotabili
-- ---------------------------------------------------------------------------
create table public.reservation_services (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  facility_id         uuid not null,
  name                text not null check (length(trim(name)) between 1 and 80),
  kind                text not null default 'ristorante'
                      check (kind in ('ristorante','aperitivo','pizzeria','evento','degustazione','pacchetto','servizio')),
  description         text check (description is null or length(description) <= 1000),
  capacity_unit       text not null default 'coperti' check (capacity_unit in ('coperti','posti')),
  duration_min        int not null default 120 check (duration_min between 10 and 720),
  max_party_size      int not null default 10 check (max_party_size between 1 and 500),
  deposit_amount      numeric(10,2) check (deposit_amount is null or deposit_amount >= 0),     -- acconto per prenotazione
  price_per_person    numeric(10,2) check (price_per_person is null or price_per_person >= 0),
  cancellation_policy text check (cancellation_policy is null or length(cancellation_policy) <= 1000),
  booking_notice_min  int not null default 60 check (booking_notice_min between 0 and 10080),  -- preavviso minimo online
  public_bookable     boolean not null default true,
  -- Evento a data unica (serata, degustazione, concerto): una sola fascia con posti limitati.
  event_date          date,
  event_time          time,
  event_capacity      int check (event_capacity is null or event_capacity between 1 and 5000),
  active              boolean not null default true,
  sort_order          int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((event_date is null) = (event_time is null) and (event_date is null) = (event_capacity is null)),
  unique (id, org_id),
  unique (id, facility_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);
create index on public.reservation_services (org_id, facility_id) where active;

-- Fasce settimanali: dalle start_time alle end_time (ultimo arrivo) ogni interval_min minuti, capacity per fascia.
create table public.reservation_slots (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  facility_id  uuid not null,
  service_id   uuid not null,
  weekday      smallint not null check (weekday between 1 and 7),   -- 1 = lunedì
  start_time   time not null,
  end_time     time not null,
  interval_min int not null default 30 check (interval_min between 5 and 240),
  capacity     int not null check (capacity between 1 and 5000),
  max_party    int check (max_party is null or max_party between 1 and 500),
  created_at   timestamptz not null default now(),
  check (end_time >= start_time),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_id, org_id) references public.reservation_services(id, org_id) on delete cascade,
  foreign key (service_id, facility_id) references public.reservation_services(id, facility_id) on delete cascade
);
create index on public.reservation_slots (service_id, weekday);

-- Date speciali: chiusura (di un servizio o, con service_id nullo, dell'intera struttura) o capacità eccezionale.
create table public.reservation_exceptions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  facility_id uuid not null,
  service_id  uuid,
  on_date     date not null,
  closed      boolean not null default true,
  capacity    int check (capacity is null or capacity between 1 and 5000),
  note        text check (note is null or length(note) <= 300),
  created_at  timestamptz not null default now(),
  check (closed or capacity is not null),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_id, org_id) references public.reservation_services(id, org_id) on delete cascade,
  foreign key (service_id, facility_id) references public.reservation_services(id, facility_id) on delete cascade
);
create unique index reservation_exceptions_one_per_day
  on public.reservation_exceptions (facility_id, coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid), on_date);

-- ---------------------------------------------------------------------------
-- Prenotazioni
-- ---------------------------------------------------------------------------
create table public.reservations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  service_id       uuid not null,
  res_date         date not null,                -- data e ora «da parete» nel fuso della struttura
  res_time         time not null,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  party_size       int not null check (party_size between 1 and 500),
  customer_id      uuid,
  guest_name       text check (guest_name is null or length(trim(guest_name)) between 1 and 120), -- walk-in senza scheda
  service_point_id uuid,
  source           text not null default 'telefono' check (source in ('telefono','walk-in','sito','whatsapp','email','portale')),
  status           text not null default 'in_attesa_conferma'
                   check (status in ('in_attesa_conferma','confermata','arrivata','completata','no_show','annullata')),
  notes            text check (notes is null or length(notes) <= 1000),
  special_requests text check (special_requests is null or length(special_requests) <= 1000),
  allergies        text[] not null default '{}',
  deposit_required numeric(10,2) not null default 0 check (deposit_required >= 0),
  deposit_paid_at  timestamptz,
  confirmed_at     timestamptz,
  arrived_at       timestamptz,
  completed_at     timestamptz,
  no_show_at       timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text check (cancel_reason is null or length(cancel_reason) <= 300),
  reminded_at      timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_id, org_id) references public.reservation_services(id, org_id),
  foreign key (service_id, facility_id) references public.reservation_services(id, facility_id),
  foreign key (customer_id, org_id) references public.customers(id, org_id) on delete set null (customer_id),
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete set null (service_point_id),
  -- Lo stesso tavolo non può essere assegnato a due prenotazioni attive che si sovrappongono.
  constraint reservations_no_table_overlap exclude using gist (
    service_point_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (service_point_id is not null and status in ('in_attesa_conferma','confermata','arrivata'))
);
create index on public.reservations (facility_id, res_date);
create index on public.reservations (service_id, starts_at) where status in ('in_attesa_conferma','confermata','arrivata');
create index on public.reservations (customer_id) where customer_id is not null;

-- Lista d'attesa
create table public.reservation_waitlist (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  facility_id     uuid not null,
  service_id      uuid not null,
  wait_date       date not null,
  preferred_time  time,
  party_size      int not null check (party_size between 1 and 500),
  customer_id     uuid,
  notes           text check (notes is null or length(notes) <= 500),
  notify          boolean not null default true,      -- avvisare appena si libera posto
  status          text not null default 'in_attesa' check (status in ('in_attesa','avvisato','promossa','annullata')),
  reservation_id  uuid,
  notified_at     timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_id, facility_id) references public.reservation_services(id, facility_id) on delete cascade,
  foreign key (customer_id, org_id) references public.customers(id, org_id) on delete set null (customer_id),
  foreign key (reservation_id, org_id) references public.reservations(id, org_id) on delete set null (reservation_id)
);
create index on public.reservation_waitlist (facility_id, wait_date) where status in ('in_attesa','avvisato');

-- ---------------------------------------------------------------------------
-- CRM: segmenti salvati, registro consensi
-- ---------------------------------------------------------------------------
create table public.customer_segments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 80),
  filters    jsonb not null default '{}' check (jsonb_typeof(filters) = 'object'),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.customer_consents (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null,
  kind        text not null check (kind in ('privacy','marketing')),
  granted     boolean not null,
  source      text,
  recorded_at timestamptz not null default now(),
  recorded_by uuid default auth.uid(),
  foreign key (customer_id, org_id) references public.customers(id, org_id) on delete cascade
);
create index on public.customer_consents (customer_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- Collegamento a clienti di prenotazioni spiaggia e comande (senza toccare il codice di quei moduli)
-- ---------------------------------------------------------------------------
alter table public.beach_bookings add column if not exists customer_id uuid;
do $$ begin
  alter table public.beach_bookings add constraint beach_bookings_customer_fk
    foreign key (customer_id, org_id) references public.customers(id, org_id) on delete set null (customer_id);
exception when duplicate_object then null; end $$;
create index if not exists beach_bookings_customer_idx on public.beach_bookings (customer_id) where customer_id is not null;

alter table public.pos_orders add column if not exists customer_id uuid;
do $$ begin
  alter table public.pos_orders add constraint pos_orders_customer_fk
    foreign key (customer_id, org_id) references public.customers(id, org_id) on delete set null (customer_id);
exception when duplicate_object then null; end $$;
create index if not exists pos_orders_customer_idx on public.pos_orders (customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------
-- Audit, RLS
-- ---------------------------------------------------------------------------
select app.enable_audit('public.reservation_services');
select app.enable_audit('public.reservation_slots');
select app.enable_audit('public.reservation_exceptions');
select app.enable_audit('public.reservations');
select app.enable_audit('public.reservation_waitlist');
select app.enable_audit('public.customer_segments');

alter table public.reservation_services   enable row level security;
alter table public.reservation_slots      enable row level security;
alter table public.reservation_exceptions enable row level security;
alter table public.reservations           enable row level security;
alter table public.reservation_waitlist   enable row level security;
alter table public.customer_segments      enable row level security;
alter table public.customer_consents      enable row level security;

-- Configurazione: la vede chi lavora nella struttura, la modifica chi gestisce le prenotazioni.
create policy rsv_s_select on public.reservation_services for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy rsv_s_write on public.reservation_services for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'reservations.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'reservations.manage'));
create policy rsv_sl_select on public.reservation_slots for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy rsv_sl_write on public.reservation_slots for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'reservations.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'reservations.manage'));
create policy rsv_ex_select on public.reservation_exceptions for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy rsv_ex_write on public.reservation_exceptions for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'reservations.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'reservations.manage'));

-- Prenotazioni: chi le gestisce nella struttura, o chi vede le schede clienti (storico del cliente). Scritture solo via RPC.
create policy rsv_select on public.reservations for select to authenticated using (
  app.has_facility_perm(org_id, facility_id, 'reservations.manage') or app.has_perm(org_id, 'crm.view') or app.has_perm(org_id, 'crm.manage'));
create policy rsv_w_select on public.reservation_waitlist for select to authenticated using (
  app.has_facility_perm(org_id, facility_id, 'reservations.manage'));
revoke insert, update, delete on public.reservations, public.reservation_waitlist from authenticated, anon;

create policy cseg_select on public.customer_segments for select to authenticated using (app.can_see_customers(org_id));
create policy cseg_write on public.customer_segments for all to authenticated
  using (app.has_perm(org_id, 'crm.manage')) with check (app.has_perm(org_id, 'crm.manage'));

create policy ccons_select on public.customer_consents for select to authenticated using (app.can_see_customers(org_id));
revoke insert, update, delete on public.customer_consents from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------
create or replace function app.res_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger reservations_touch before update on public.reservations for each row execute function app.res_touch();
create trigger reservation_services_touch before update on public.reservation_services for each row execute function app.res_touch();

-- Operazioni di sistema (nessun utente) o RPC che hanno già verificato i permessi (flag locale alla transazione).
create or replace function app.crm_trusted() returns boolean
language sql stable set search_path = public as $$
  select auth.uid() is null or coalesce(current_setting('ordivia.crm_trusted', true), '') = 'on'
$$;

-- Consensi: marketing solo con fonte e data; modifica dei consensi esistenti solo con crm.manage.
create or replace function app.crm_customer_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.anonymized_at is not null and new.anonymized_at is null then
      raise exception 'Un cliente anonimizzato non può essere ripristinato' using errcode = 'P0001';
    end if;
    if new.anonymized_at is distinct from old.anonymized_at and not app.crm_trusted() then
      raise exception 'Per anonimizzare un cliente usa la funzione dedicata' using errcode = '42501';
    end if;
    if not app.crm_trusted()
       and (new.marketing_consent is distinct from old.marketing_consent
            or new.marketing_consent_at is distinct from old.marketing_consent_at
            or new.privacy_consent_at is distinct from old.privacy_consent_at
            or new.consent_source is distinct from old.consent_source)
       and not app.has_perm(new.org_id, 'crm.manage') then
      raise exception 'Solo chi gestisce il CRM può modificare i consensi' using errcode = '42501';
    end if;
  end if;
  if new.marketing_consent and (tg_op = 'INSERT' or not old.marketing_consent) then
    if nullif(trim(coalesce(new.consent_source, '')), '') is null then
      raise exception 'Il consenso marketing richiede la fonte (portale, reception, modulo firmato…)' using errcode = '22023';
    end if;
  end if;
  if tg_op = 'INSERT' then
    if new.marketing_consent then new.marketing_consent_at := coalesce(new.marketing_consent_at, now()); end if;
  elsif new.marketing_consent is distinct from old.marketing_consent and new.marketing_consent_at is not distinct from old.marketing_consent_at then
    new.marketing_consent_at := now();
  end if;
  if new.email is not null then new.email := lower(trim(new.email)); end if;
  return new;
end $$;
create trigger customers_guard before insert or update on public.customers for each row execute function app.crm_customer_guard();

create or replace function app.crm_log_consent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.privacy_consent_at is not null then
      insert into public.customer_consents (org_id, customer_id, kind, granted, source, recorded_at) values (new.org_id, new.id, 'privacy', true, new.consent_source, new.privacy_consent_at);
    end if;
    if new.marketing_consent then
      insert into public.customer_consents (org_id, customer_id, kind, granted, source, recorded_at) values (new.org_id, new.id, 'marketing', true, new.consent_source, new.marketing_consent_at);
    end if;
  else
    if new.privacy_consent_at is distinct from old.privacy_consent_at then
      insert into public.customer_consents (org_id, customer_id, kind, granted, source, recorded_at)
      values (new.org_id, new.id, 'privacy', new.privacy_consent_at is not null, new.consent_source, coalesce(new.privacy_consent_at, now()));
    end if;
    if new.marketing_consent is distinct from old.marketing_consent then
      insert into public.customer_consents (org_id, customer_id, kind, granted, source, recorded_at)
      values (new.org_id, new.id, 'marketing', new.marketing_consent, new.consent_source, coalesce(new.marketing_consent_at, now()));
    end if;
  end if;
  return null;
end $$;
create trigger customers_log_consent after insert or update on public.customers for each row execute function app.crm_log_consent();

-- ---------------------------------------------------------------------------
-- Supporto
-- ---------------------------------------------------------------------------
create or replace function app.res_tz(p_facility uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select timezone from public.facilities where id = p_facility), 'Europe/Rome')
$$;

create or replace function app.res_today(p_facility uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone app.res_tz(p_facility))::date
$$;

create or replace function app.res_parse_time(p text) returns time
language plpgsql immutable set search_path = public as $$
begin
  if p is null or p !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' then
    raise exception 'Orario non valido (usa HH:MM)' using errcode = '22023';
  end if;
  return p::time;
end $$;

-- Cliente esistente per telefono (normalizzato) o email; altrimenti nuova scheda. Completa i recapiti mancanti.
create or replace function app.crm_match_or_create(p_org uuid, p_name text, p_phone text, p_email text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_phone text := app.norm_phone(p_phone);
  v_email text := app.norm_email(p_email);
  v_id uuid;
begin
  if v_phone is not null then
    select id into v_id from public.customers
    where org_id = p_org and anonymized_at is null and phone is not null and app.norm_phone(phone) = v_phone
    order by created_at limit 1;
  end if;
  if v_id is null and v_email is not null then
    select id into v_id from public.customers
    where org_id = p_org and anonymized_at is null and lower(email) = v_email
    order by created_at limit 1;
  end if;
  if v_id is not null then
    update public.customers
    set phone = coalesce(phone, v_phone), email = coalesce(email, v_email), updated_at = now()
    where id = v_id and ((phone is null and v_phone is not null) or (email is null and v_email is not null));
    return v_id;
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 or (v_phone is null and v_email is null) then return null; end if;
  insert into public.customers (org_id, full_name, phone, email, created_by)
  values (p_org, left(trim(p_name), 160), v_phone, v_email, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Le prenotazioni spiaggia si collegano da sole alla scheda cliente (stesso telefono o email).
create or replace function app.crm_link_beach_booking() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is null and (new.customer_phone is not null or new.customer_email is not null) then
    new.customer_id := app.crm_match_or_create(new.org_id, new.customer_name, new.customer_phone, new.customer_email);
  end if;
  return new;
end $$;
create trigger beach_bookings_link_customer before insert or update of customer_name, customer_phone, customer_email
  on public.beach_bookings for each row execute function app.crm_link_beach_booking();

update public.beach_bookings
set customer_id = app.crm_match_or_create(org_id, customer_name, customer_phone, customer_email)
where customer_id is null and (customer_phone is not null or customer_email is not null);

-- Fasce del giorno con capacità teorica (chiusure e capacità eccezionali applicate).
create or replace function app.res_day_slots(p_service uuid, p_date date)
returns table (slot_time time, capacity int, max_party int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_s public.reservation_services;
  v_cap int;
begin
  select * into v_s from public.reservation_services where id = p_service;
  if not found or not v_s.active then return; end if;
  if exists (select 1 from public.reservation_exceptions e
             where e.facility_id = v_s.facility_id and e.on_date = p_date and e.closed
               and (e.service_id is null or e.service_id = p_service)) then
    return;
  end if;
  select e.capacity into v_cap from public.reservation_exceptions e
  where e.service_id = p_service and e.on_date = p_date and not e.closed;

  if v_s.event_date is not null then
    if p_date = v_s.event_date then
      return query select v_s.event_time, coalesce(v_cap, v_s.event_capacity), least(v_s.max_party_size, coalesce(v_cap, v_s.event_capacity));
    end if;
    return;
  end if;

  return query
    select t.ts::time,
           max(coalesce(v_cap, r.capacity))::int,
           max(least(coalesce(r.max_party, v_s.max_party_size), v_s.max_party_size, coalesce(v_cap, r.capacity)))::int
    from public.reservation_slots r
    cross join lateral generate_series(timestamp '2000-01-01' + r.start_time, timestamp '2000-01-01' + r.end_time,
                                       make_interval(mins => r.interval_min)) as t(ts)
    where r.service_id = p_service and r.weekday = extract(isodow from p_date)::int
    group by t.ts::time
    order by 1;
end $$;

-- Picco di coperti contemporanei nell'intervallo [p_from, p_to) per le prenotazioni attive del servizio.
create or replace function app.res_peak_load(p_service uuid, p_from timestamptz, p_to timestamptz, p_exclude uuid default null)
returns int
language sql stable security definer set search_path = public as $$
  with act as (
    select r.starts_at, r.ends_at, r.party_size from public.reservations r
    where r.service_id = p_service and r.status in ('in_attesa_conferma','confermata','arrivata')
      and (p_exclude is null or r.id <> p_exclude)
      and r.starts_at < p_to and r.ends_at > p_from
  ), pts as (
    select p_from as pt union select a.starts_at from act a where a.starts_at > p_from
  )
  select coalesce(max((select sum(a.party_size) from act a where a.starts_at <= pts.pt and a.ends_at > pts.pt)), 0)::int from pts
$$;

-- Disponibilità per fascia.
create or replace function app.res_availability(p_service uuid, p_date date, p_exclude uuid default null)
returns table (slot_time time, starts_at timestamptz, capacity int, booked int, available int, max_party int)
language sql stable security definer set search_path = public as $$
  select d.slot_time, x.st, d.capacity, l.booked, greatest(d.capacity - l.booked, 0), d.max_party
  from app.res_day_slots(p_service, p_date) d
  cross join lateral (
    select ((p_date + d.slot_time) at time zone app.res_tz(s.facility_id)) as st, s.duration_min
    from public.reservation_services s where s.id = p_service
  ) x
  cross join lateral (select app.res_peak_load(p_service, x.st, x.st + make_interval(mins => x.duration_min), p_exclude) as booked) l
  order by d.slot_time
$$;

-- Verifica orario e capacità. p_exact: l'orario deve coincidere con una fascia (prenotazioni online);
-- altrimenti vale la fascia precedente purché l'orario cada nella sua durata (walk-in, orari concordati al telefono).
create or replace function app.res_check(p_service uuid, p_date date, p_time time, p_party int, p_exclude uuid, p_exact boolean,
                                         out o_start timestamptz, out o_end timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  v_s public.reservation_services;
  v_cap int;
  v_maxp int;
  v_slot time;
  v_booked int;
begin
  select * into v_s from public.reservation_services where id = p_service;
  if not found or not v_s.active then raise exception 'Servizio non disponibile' using errcode = 'P0002'; end if;
  if p_party is null or p_party < 1 or p_party > 500 then raise exception 'Numero di persone non valido' using errcode = '22023'; end if;

  select d.slot_time, d.capacity, d.max_party into v_slot, v_cap, v_maxp
  from app.res_day_slots(p_service, p_date) d
  where (p_exact and d.slot_time = p_time)
     or (not p_exact and d.slot_time <= p_time and (p_time - d.slot_time) < make_interval(mins => v_s.duration_min))
  order by d.slot_time desc limit 1;
  if v_slot is null then
    raise exception 'Orario non disponibile per %: il servizio è chiuso o fuori orario', v_s.name using errcode = 'P0001';
  end if;
  if p_party > v_maxp then
    raise exception 'Massimo % persone per prenotazione: per gruppi più numerosi contatta la struttura', v_maxp using errcode = '22023';
  end if;

  o_start := (p_date + p_time) at time zone app.res_tz(v_s.facility_id);
  o_end := o_start + make_interval(mins => v_s.duration_min);
  v_booked := app.res_peak_load(p_service, o_start, o_end, p_exclude);
  if v_booked + p_party > v_cap then
    raise exception 'Posti esauriti alle %: % % disponibili su %', to_char(p_time, 'HH24:MI'), greatest(v_cap - v_booked, 0), v_s.capacity_unit, v_cap
      using errcode = 'P0001';
  end if;
end $$;

create or replace function app.res_lock(p_reservation uuid) returns public.reservations
language plpgsql security definer set search_path = public as $$
declare v_r public.reservations;
begin
  select * into v_r from public.reservations where id = p_reservation for update;
  if not found or not app.has_facility_perm(v_r.org_id, v_r.facility_id, 'reservations.manage') then
    raise exception 'Prenotazione non trovata' using errcode = 'P0002';
  end if;
  return v_r;
end $$;

create or replace function app.res_check_table(p_facility uuid, p_point uuid) returns public.service_points
language plpgsql stable security definer set search_path = public as $$
declare v_sp public.service_points;
begin
  select * into v_sp from public.service_points where id = p_point;
  if not found or v_sp.facility_id <> p_facility then raise exception 'Tavolo non trovato' using errcode = 'P0002'; end if;
  if v_sp.kind <> 'tavolo' then raise exception 'Si possono assegnare solo tavoli' using errcode = '22023'; end if;
  if not v_sp.active then raise exception 'Il tavolo % non è attivo', v_sp.label using errcode = 'P0001'; end if;
  return v_sp;
end $$;

-- Inserimento comune (staff e portale). Il servizio deve essere già bloccato dal chiamante.
create or replace function app.res_insert(
  p_service public.reservation_services, p_date date, p_time time, p_party int, p_customer uuid, p_guest_name text,
  p_source text, p_status text, p_notes text, p_special text, p_allergies text[], p_point uuid, p_deposit numeric, p_exact boolean
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_chk record;
  v_all text[] := app.clean_list(p_allergies);
  v_sp public.service_points;
  v_id uuid;
begin
  if p_source not in ('telefono','walk-in','sito','whatsapp','email','portale') then raise exception 'Canale non valido' using errcode = '22023'; end if;
  if p_status not in ('in_attesa_conferma','confermata','arrivata') then raise exception 'Stato iniziale non valido' using errcode = '22023'; end if;
  if length(coalesce(p_notes, '')) > 1000 or length(coalesce(p_special, '')) > 1000 then raise exception 'Note troppo lunghe' using errcode = '22023'; end if;
  select * into v_chk from app.res_check(p_service.id, p_date, p_time, p_party, null, p_exact);
  if p_point is not null then v_sp := app.res_check_table(p_service.facility_id, p_point); end if;

  -- Allergie: dalla prenotazione alla scheda e viceversa.
  if p_customer is not null then
    if cardinality(v_all) > 0 then
      update public.customers set allergies = app.clean_list(allergies || v_all), updated_at = now()
      where id = p_customer and not (allergies @> v_all);
    else
      select allergies into v_all from public.customers where id = p_customer;
    end if;
  end if;

  begin
    insert into public.reservations (org_id, facility_id, service_id, res_date, res_time, starts_at, ends_at, party_size,
      customer_id, guest_name, service_point_id, source, status, notes, special_requests, allergies, deposit_required,
      confirmed_at, arrived_at, created_by)
    values (p_service.org_id, p_service.facility_id, p_service.id, p_date, p_time, v_chk.o_start, v_chk.o_end, p_party,
      p_customer, nullif(left(trim(coalesce(p_guest_name, '')), 120), ''), p_point, p_source, p_status,
      nullif(trim(p_notes), ''), nullif(trim(p_special), ''), coalesce(v_all, '{}'), round(coalesce(p_deposit, p_service.deposit_amount, 0), 2),
      case when p_status in ('confermata','arrivata') then now() end, case when p_status = 'arrivata' then now() end, auth.uid())
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Il tavolo % è già assegnato a un''altra prenotazione in quell''orario', v_sp.label using errcode = 'P0001';
  end;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- RPC staff: disponibilità e prenotazioni
-- ---------------------------------------------------------------------------
create or replace function public.res_slots(p_service uuid, p_date date)
returns table (slot_time text, starts_at timestamptz, capacity int, booked int, available int, max_party int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_s public.reservation_services;
begin
  select * into v_s from public.reservation_services where id = p_service;
  if not found or not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'reservations.manage') then
    raise exception 'Servizio non trovato' using errcode = 'P0002';
  end if;
  return query select to_char(a.slot_time, 'HH24:MI'), a.starts_at, a.capacity, a.booked, a.available, a.max_party
               from app.res_availability(p_service, p_date) a;
end $$;

create or replace function public.res_create(
  p_service   uuid,
  p_date      date,
  p_time      text,
  p_party     int,
  p_customer  uuid default null,
  p_name      text default null,
  p_phone     text default null,
  p_email     text default null,
  p_source    text default 'telefono',
  p_status    text default 'confermata',
  p_notes     text default null,
  p_special   text default null,
  p_allergies text[] default null,
  p_point     uuid default null,
  p_deposit   numeric default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_s public.reservation_services;
  v_c public.customers;
  v_cust uuid;
  v_guest text;
begin
  select * into v_s from public.reservation_services where id = p_service for update;
  if not found or not app.can_access_facility(v_s.org_id, v_s.facility_id) then raise exception 'Servizio non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'reservations.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_date is null or p_date < app.res_today(v_s.facility_id) then raise exception 'Non puoi prenotare per una data passata' using errcode = '22023'; end if;
  if p_date > app.res_today(v_s.facility_id) + 730 then raise exception 'Data troppo lontana' using errcode = '22023'; end if;
  if p_deposit is not null and (p_deposit < 0 or p_deposit > 100000) then raise exception 'Acconto non valido' using errcode = '22023'; end if;
  if p_status = 'arrivata' and p_date <> app.res_today(v_s.facility_id) then raise exception 'Un cliente può risultare arrivato solo oggi' using errcode = '22023'; end if;
  if p_email is not null and trim(p_email) <> '' and app.norm_email(p_email) is null then raise exception 'Email non valida' using errcode = '22023'; end if;
  if p_phone is not null and trim(p_phone) <> '' and app.norm_phone(p_phone) is null then raise exception 'Numero di telefono non valido' using errcode = '22023'; end if;

  if p_customer is not null then
    select * into v_c from public.customers where id = p_customer;
    if not found or v_c.org_id <> v_s.org_id then raise exception 'Cliente non trovato' using errcode = 'P0002'; end if;
    if v_c.anonymized_at is not null then raise exception 'Il cliente è stato anonimizzato' using errcode = 'P0001'; end if;
    v_cust := p_customer;
  else
    v_cust := app.crm_match_or_create(v_s.org_id, p_name, p_phone, p_email);
    if v_cust is null then
      if p_source <> 'walk-in' then
        raise exception 'Inserisci nome e telefono (o email) del cliente' using errcode = '22023';
      end if;
      v_guest := coalesce(nullif(trim(p_name), ''), 'Walk-in');
    end if;
  end if;

  -- Al telefono si prenota tra la prima e l'ultima fascia; i walk-in possono arrivare finché il servizio è in corso.
  if coalesce(p_source, 'telefono') <> 'walk-in'
     and app.res_parse_time(p_time) > (select max(d.slot_time) from app.res_day_slots(p_service, p_date) d) then
    raise exception 'Orario oltre l''ultimo arrivo previsto per %', v_s.name using errcode = 'P0001';
  end if;

  return app.res_insert(v_s, p_date, app.res_parse_time(p_time), p_party, v_cust, v_guest, coalesce(p_source, 'telefono'),
                        coalesce(p_status, 'confermata'), p_notes, p_special, p_allergies, p_point, p_deposit, false);
end $$;

-- Stati: in_attesa_conferma → confermata → arrivata → completata; no_show / annullata; ripristini consentiti.
create or replace function public.res_set_status(p_reservation uuid, p_status text, p_reason text default null) returns public.reservations
language plpgsql security definer set search_path = public as $$
declare
  v_r public.reservations;
  v_s public.reservation_services;
  v_ok boolean;
  v_today date;
begin
  v_r := app.res_lock(p_reservation);
  v_today := app.res_today(v_r.facility_id);
  if p_status = v_r.status then return v_r; end if;
  v_ok := case v_r.status
    when 'in_attesa_conferma' then p_status in ('confermata','arrivata','annullata','no_show')
    when 'confermata'         then p_status in ('arrivata','annullata','no_show')
    when 'arrivata'           then p_status in ('completata','confermata')
    when 'completata'         then p_status in ('arrivata')
    when 'no_show'            then p_status in ('confermata')
    when 'annullata'          then p_status in ('confermata')
    else false end;
  if not v_ok then raise exception 'Passaggio di stato non consentito' using errcode = 'P0001'; end if;
  if p_status = 'arrivata' and v_r.res_date > v_today then raise exception 'La prenotazione è per un altro giorno' using errcode = 'P0001'; end if;
  if p_status = 'no_show' and v_r.starts_at > now() then raise exception 'La prenotazione non è ancora iniziata' using errcode = 'P0001'; end if;
  if length(coalesce(p_reason, '')) > 300 then raise exception 'Motivo troppo lungo' using errcode = '22023'; end if;

  -- Ripristino: i posti devono esserci ancora.
  if v_r.status in ('no_show','annullata') then
    select * into v_s from public.reservation_services where id = v_r.service_id for update;
    perform app.res_check(v_r.service_id, v_r.res_date, v_r.res_time, v_r.party_size, v_r.id, false);
  end if;
  if v_r.status = 'completata' then
    select * into v_s from public.reservation_services where id = v_r.service_id;
  end if;

  begin
    update public.reservations set
      status = p_status,
      confirmed_at = case when p_status = 'confermata' then coalesce(confirmed_at, now()) else confirmed_at end,
      arrived_at   = case when p_status = 'arrivata' then coalesce(arrived_at, now()) when p_status = 'confermata' then null else arrived_at end,
      completed_at = case when p_status = 'completata' then now() when p_status = 'arrivata' then null else completed_at end,
      no_show_at   = case when p_status = 'no_show' then now() else no_show_at end,
      cancelled_at = case when p_status = 'annullata' then now() else cancelled_at end,
      cancel_reason = case when p_status = 'annullata' then nullif(trim(p_reason), '') else cancel_reason end,
      -- chi se ne va libera i posti per le fasce successive
      ends_at = case when p_status = 'completata' then greatest(starts_at + interval '1 minute', least(ends_at, now()))
                     when v_r.status = 'completata' then starts_at + make_interval(mins => v_s.duration_min)
                     else ends_at end
    where id = p_reservation returning * into v_r;
  exception when exclusion_violation then
    raise exception 'Il tavolo assegnato è nel frattempo occupato: togli o cambia il tavolo' using errcode = 'P0001';
  end;
  return v_r;
end $$;

create or replace function public.res_assign_table(p_reservation uuid, p_point uuid) returns public.reservations
language plpgsql security definer set search_path = public as $$
declare v_r public.reservations; v_sp public.service_points;
begin
  v_r := app.res_lock(p_reservation);
  if v_r.status not in ('in_attesa_conferma','confermata','arrivata') then raise exception 'Prenotazione non attiva' using errcode = 'P0001'; end if;
  if p_point is not null then v_sp := app.res_check_table(v_r.facility_id, p_point); end if;
  begin
    update public.reservations set service_point_id = p_point where id = p_reservation returning * into v_r;
  exception when exclusion_violation then
    raise exception 'Il tavolo % è già assegnato a un''altra prenotazione in quell''orario', v_sp.label using errcode = 'P0001';
  end;
  return v_r;
end $$;

create or replace function public.res_update(
  p_reservation uuid, p_date date, p_time text, p_party int,
  p_notes text default null, p_special text default null, p_allergies text[] default null, p_deposit numeric default null
) returns public.reservations
language plpgsql security definer set search_path = public as $$
declare
  v_r public.reservations;
  v_s public.reservation_services;
  v_t time := app.res_parse_time(p_time);
  v_start timestamptz;
  v_end timestamptz;
  v_all text[] := app.clean_list(p_allergies);
begin
  v_r := app.res_lock(p_reservation);
  if v_r.status not in ('in_attesa_conferma','confermata','arrivata') then raise exception 'Prenotazione non modificabile' using errcode = 'P0001'; end if;
  if p_date is null or (p_date < app.res_today(v_r.facility_id) and p_date <> v_r.res_date) then
    raise exception 'Non puoi spostare la prenotazione a una data passata' using errcode = '22023';
  end if;
  if p_deposit is not null and (p_deposit < 0 or p_deposit > 100000) then raise exception 'Acconto non valido' using errcode = '22023'; end if;
  if length(coalesce(p_notes, '')) > 1000 or length(coalesce(p_special, '')) > 1000 then raise exception 'Note troppo lunghe' using errcode = '22023'; end if;
  select * into v_s from public.reservation_services where id = v_r.service_id for update;
  if p_date <> v_r.res_date or v_t <> v_r.res_time or p_party > v_r.party_size then
    select c.o_start, c.o_end into v_start, v_end from app.res_check(v_r.service_id, p_date, v_t, p_party, v_r.id, false) c;
  else
    v_start := v_r.starts_at; v_end := v_r.ends_at;
  end if;
  if v_r.customer_id is not null and cardinality(v_all) > 0 then
    update public.customers set allergies = app.clean_list(allergies || v_all), updated_at = now()
    where id = v_r.customer_id and not (allergies @> v_all) and anonymized_at is null;
  end if;
  begin
    update public.reservations set
      res_date = p_date, res_time = v_t, starts_at = v_start, ends_at = v_end, party_size = p_party,
      notes = nullif(trim(p_notes), ''), special_requests = nullif(trim(p_special), ''), allergies = v_all,
      deposit_required = coalesce(round(p_deposit, 2), deposit_required),
      reminded_at = case when p_date <> v_r.res_date or v_t <> v_r.res_time then null else reminded_at end
    where id = p_reservation returning * into v_r;
  exception when exclusion_violation then
    raise exception 'Il tavolo assegnato è occupato nel nuovo orario: togli o cambia il tavolo' using errcode = 'P0001';
  end;
  return v_r;
end $$;

create or replace function public.res_set_deposit_paid(p_reservation uuid, p_paid boolean) returns public.reservations
language plpgsql security definer set search_path = public as $$
declare v_r public.reservations;
begin
  v_r := app.res_lock(p_reservation);
  if v_r.deposit_required <= 0 and p_paid then raise exception 'Per questa prenotazione non è previsto un acconto' using errcode = 'P0001'; end if;
  update public.reservations set deposit_paid_at = case when p_paid then coalesce(deposit_paid_at, now()) end
  where id = p_reservation returning * into v_r;
  return v_r;
end $$;

-- Promemoria inviati (l'invio vero avviene da WhatsApp/email del telefono di chi lavora).
create or replace function public.res_mark_reminded(p_reservations uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if cardinality(coalesce(p_reservations, '{}')) > 500 then raise exception 'Troppe prenotazioni' using errcode = '22023'; end if;
  update public.reservations r set reminded_at = now()
  where r.id = any(p_reservations) and r.reminded_at is null
    and r.status in ('in_attesa_conferma','confermata')
    and app.has_facility_perm(r.org_id, r.facility_id, 'reservations.manage');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- RPC staff: lista d'attesa
-- ---------------------------------------------------------------------------
create or replace function public.res_waitlist_add(
  p_service uuid, p_date date, p_party int, p_time text default null,
  p_customer uuid default null, p_name text default null, p_phone text default null, p_email text default null,
  p_notes text default null, p_notify boolean default true
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_s public.reservation_services; v_cust uuid; v_id uuid;
begin
  select * into v_s from public.reservation_services where id = p_service;
  if not found or not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'reservations.manage') then raise exception 'Servizio non trovato' using errcode = 'P0002'; end if;
  if p_date is null or p_date < app.res_today(v_s.facility_id) then raise exception 'Data non valida' using errcode = '22023'; end if;
  if p_party is null or p_party < 1 or p_party > 500 then raise exception 'Numero di persone non valido' using errcode = '22023'; end if;
  if length(coalesce(p_notes, '')) > 500 then raise exception 'Note troppo lunghe' using errcode = '22023'; end if;
  if p_customer is not null then
    select id into v_cust from public.customers where id = p_customer and org_id = v_s.org_id and anonymized_at is null;
    if v_cust is null then raise exception 'Cliente non trovato' using errcode = 'P0002'; end if;
  else
    v_cust := app.crm_match_or_create(v_s.org_id, p_name, p_phone, p_email);
    if v_cust is null then raise exception 'Inserisci nome e telefono (o email) per poter avvisare il cliente' using errcode = '22023'; end if;
  end if;
  insert into public.reservation_waitlist (org_id, facility_id, service_id, wait_date, preferred_time, party_size, customer_id, notes, notify, created_by)
  values (v_s.org_id, v_s.facility_id, p_service, p_date, case when nullif(trim(p_time), '') is not null then app.res_parse_time(p_time) end,
          p_party, v_cust, nullif(trim(p_notes), ''), coalesce(p_notify, true), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.res_waitlist_set(p_entry uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare v_w public.reservation_waitlist;
begin
  select * into v_w from public.reservation_waitlist where id = p_entry for update;
  if not found or not app.has_facility_perm(v_w.org_id, v_w.facility_id, 'reservations.manage') then raise exception 'Richiesta non trovata' using errcode = 'P0002'; end if;
  if p_status not in ('in_attesa','avvisato','annullata') then raise exception 'Stato non valido' using errcode = '22023'; end if;
  if v_w.status = 'promossa' then raise exception 'Già trasformata in prenotazione' using errcode = 'P0001'; end if;
  update public.reservation_waitlist set status = p_status, notified_at = case when p_status = 'avvisato' then now() else notified_at end
  where id = p_entry;
end $$;

-- Dalla lista d'attesa a prenotazione confermata (capacità verificata).
create or replace function public.res_waitlist_promote(p_entry uuid, p_time text, p_point uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_w public.reservation_waitlist; v_s public.reservation_services; v_id uuid;
begin
  select * into v_w from public.reservation_waitlist where id = p_entry for update;
  if not found or not app.has_facility_perm(v_w.org_id, v_w.facility_id, 'reservations.manage') then raise exception 'Richiesta non trovata' using errcode = 'P0002'; end if;
  if v_w.status not in ('in_attesa','avvisato') then raise exception 'Richiesta non più in attesa' using errcode = 'P0001'; end if;
  select * into v_s from public.reservation_services where id = v_w.service_id for update;
  v_id := app.res_insert(v_s, v_w.wait_date, app.res_parse_time(coalesce(nullif(trim(p_time), ''), to_char(v_w.preferred_time, 'HH24:MI'))),
                         v_w.party_size, v_w.customer_id, case when v_w.customer_id is null then 'Lista d''attesa' end, 'telefono', 'confermata',
                         v_w.notes, null, null, p_point, null, false);
  update public.reservation_waitlist set status = 'promossa', reservation_id = v_id where id = p_entry;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- RPC pubbliche (anon): portale QR, sito, receptionist AI
-- ---------------------------------------------------------------------------
create or replace function app.res_public_service(p_facility_token text, p_service uuid) returns public.reservation_services
language plpgsql stable security definer set search_path = public as $$
declare v_s public.reservation_services;
begin
  if p_facility_token is null or p_facility_token !~ '^[0-9a-f]{32}$' then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  select s.* into v_s from public.reservation_services s join public.facilities f on f.id = s.facility_id
  where f.public_token = p_facility_token and s.id = p_service and s.active and s.public_bookable;
  if not found then raise exception 'Servizio non trovato' using errcode = 'P0002'; end if;
  return v_s;
end $$;

create or replace function public.public_reservation_services(p_facility_token text)
returns table (id uuid, name text, kind text, description text, capacity_unit text, duration_min int, max_party_size int,
               deposit_amount numeric, price_per_person numeric, cancellation_policy text, event_date date, event_time text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_fac uuid;
begin
  if p_facility_token is null or p_facility_token !~ '^[0-9a-f]{32}$' then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  select f.id into v_fac from public.facilities f where f.public_token = p_facility_token;
  if v_fac is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  return query
    select s.id, s.name, s.kind, s.description, s.capacity_unit, s.duration_min, s.max_party_size, s.deposit_amount, s.price_per_person,
           s.cancellation_policy, s.event_date, to_char(s.event_time, 'HH24:MI')
    from public.reservation_services s
    where s.facility_id = v_fac and s.active and s.public_bookable
      and (s.event_date is null or s.event_date >= app.res_today(v_fac))
    order by s.sort_order, s.name;
end $$;

-- Fasce prenotabili online: solo orari futuri oltre il preavviso; i posti mostrati sono limitati al gruppo massimo
-- (non rivela la capienza totale).
create or replace function public.public_reservation_slots(p_facility_token text, p_service uuid, p_date date)
returns table (slot_time text, available int, max_party int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_s public.reservation_services; v_today date;
begin
  v_s := app.res_public_service(p_facility_token, p_service);
  v_today := app.res_today(v_s.facility_id);
  if p_date is null or p_date < v_today or p_date > v_today + 120 then
    raise exception 'Si può prenotare online da oggi a 120 giorni' using errcode = '22023';
  end if;
  return query
    select to_char(a.slot_time, 'HH24:MI'), least(a.available, a.max_party), a.max_party
    from app.res_availability(p_service, p_date) a
    where a.starts_at >= now() + make_interval(mins => v_s.booking_notice_min)
    order by a.slot_time;
end $$;

create or replace function public.public_create_reservation(
  p_facility_token    text,
  p_service           uuid,
  p_date              date,
  p_time              text,
  p_party             int,
  p_name              text,
  p_phone             text,
  p_email             text default null,
  p_notes             text default null,
  p_allergies         text[] default null,
  p_privacy_consent   boolean default false,
  p_marketing_consent boolean default false,
  p_source            text default 'sito'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_s public.reservation_services;
  v_today date;
  v_t time;
  v_phone text := app.norm_phone(p_phone);
  v_email text;
  v_cust uuid;
  v_pending int;
  v_id uuid;
  v_r public.reservations;
begin
  v_s := app.res_public_service(p_facility_token, p_service);
  -- serializza le richieste sullo stesso servizio
  perform 1 from public.reservation_services where id = v_s.id for update;
  v_today := app.res_today(v_s.facility_id);

  if coalesce(p_source, '') not in ('sito','portale','whatsapp') then raise exception 'Canale non valido' using errcode = '22023'; end if;
  if p_date is null or p_date < v_today or p_date > v_today + 120 then raise exception 'Si può prenotare online da oggi a 120 giorni' using errcode = '22023'; end if;
  v_t := app.res_parse_time(p_time);
  if p_party is null or p_party < 1 or p_party > v_s.max_party_size then
    raise exception 'Per gruppi oltre % persone contatta la struttura', v_s.max_party_size using errcode = '22023';
  end if;
  if p_name is null or length(trim(p_name)) not between 2 and 120 or p_name ~ '[[:cntrl:]<>]' then raise exception 'Nome non valido' using errcode = '22023'; end if;
  if v_phone is null then raise exception 'Numero di telefono non valido' using errcode = '22023'; end if;
  if p_email is not null and trim(p_email) <> '' then
    v_email := app.norm_email(p_email);
    if v_email is null then raise exception 'Email non valida' using errcode = '22023'; end if;
  end if;
  if length(coalesce(p_notes, '')) > 500 then raise exception 'Note troppo lunghe (max 500 caratteri)' using errcode = '22023'; end if;
  if cardinality(coalesce(p_allergies, '{}')) > 14 then raise exception 'Troppe allergie indicate' using errcode = '22023'; end if;
  if not coalesce(p_privacy_consent, false) then raise exception 'Serve il consenso al trattamento dei dati per prenotare' using errcode = '22023'; end if;
  if ((p_date + v_t) at time zone app.res_tz(v_s.facility_id)) < now() + make_interval(mins => v_s.booking_notice_min) then
    raise exception 'Orario troppo vicino: prenota almeno % minuti prima o chiama la struttura', v_s.booking_notice_min using errcode = 'P0001';
  end if;

  v_cust := app.crm_match_or_create(v_s.org_id, p_name, v_phone, v_email);

  -- anti-abuso: al massimo 5 richieste in attesa di conferma per telefono al giorno
  select count(*) into v_pending from public.reservations r
  where r.facility_id = v_s.facility_id and r.customer_id = v_cust and r.status = 'in_attesa_conferma'
    and r.created_at >= (v_today::timestamp at time zone app.res_tz(v_s.facility_id));
  if v_pending >= 5 then
    raise exception 'Troppe richieste da questo numero oggi: contatta direttamente la struttura' using errcode = 'P0001';
  end if;

  -- consensi raccolti online (con fonte e data)
  perform set_config('ordivia.crm_trusted', 'on', true);
  update public.customers set
    privacy_consent_at = coalesce(privacy_consent_at, now()),
    consent_source = case when privacy_consent_at is null or (p_marketing_consent and not marketing_consent) then p_source else consent_source end,
    marketing_consent = marketing_consent or coalesce(p_marketing_consent, false),
    updated_at = now()
  where id = v_cust and (privacy_consent_at is null or (p_marketing_consent and not marketing_consent));
  perform set_config('ordivia.crm_trusted', 'off', true);

  v_id := app.res_insert(v_s, p_date, v_t, p_party, v_cust, null, p_source, 'in_attesa_conferma',
                         p_notes, null, p_allergies, null, null, true);
  select * into v_r from public.reservations where id = v_id;
  return jsonb_build_object(
    'reservation_id', v_r.id,
    'status', v_r.status,
    'date', v_r.res_date,
    'time', to_char(v_r.res_time, 'HH24:MI'),
    'party_size', v_r.party_size,
    'deposit_required', v_r.deposit_required,
    'cancellation_policy', v_s.cancellation_policy
  );
end $$;

-- ---------------------------------------------------------------------------
-- RPC CRM
-- ---------------------------------------------------------------------------
create or replace function app.crm_lock_customer(p_customer uuid) returns public.customers
language plpgsql security definer set search_path = public as $$
declare v_c public.customers;
begin
  select * into v_c from public.customers where id = p_customer for update;
  if not found or not app.can_see_customers(v_c.org_id) then raise exception 'Cliente non trovato' using errcode = 'P0002'; end if;
  return v_c;
end $$;

-- Crea o aggiorna una scheda: recapiti normalizzati, controllo doppioni (telefono o email già presenti).
create or replace function public.crm_save_customer(
  p_org uuid, p_id uuid, p_name text, p_phone text default null, p_email text default null, p_language text default 'it',
  p_birthday date default null, p_allergies text[] default null, p_preferences text default null, p_notes text default null,
  p_tags text[] default null, p_force boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_c public.customers;
  v_phone text := app.norm_phone(p_phone);
  v_email text := app.norm_email(p_email);
  v_dup public.customers;
  v_id uuid;
begin
  if p_id is not null then
    v_c := app.crm_lock_customer(p_id);
    p_org := v_c.org_id;
    if v_c.anonymized_at is not null then raise exception 'Il cliente è stato anonimizzato' using errcode = 'P0001'; end if;
  end if;
  if p_org is null or not app.can_see_customers(p_org) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 160 then raise exception 'Inserisci il nome del cliente' using errcode = '22023'; end if;
  if nullif(trim(p_phone), '') is not null and v_phone is null then raise exception 'Numero di telefono non valido' using errcode = '22023'; end if;
  if nullif(trim(p_email), '') is not null and v_email is null then raise exception 'Email non valida' using errcode = '22023'; end if;
  if p_language is not null and p_language !~ '^[a-z]{2}$' then raise exception 'Lingua non valida' using errcode = '22023'; end if;
  if p_birthday is not null and (p_birthday < date '1900-01-01' or p_birthday > current_date) then raise exception 'Data di nascita non valida' using errcode = '22023'; end if;
  if length(coalesce(p_preferences, '')) > 2000 or length(coalesce(p_notes, '')) > 2000 then raise exception 'Testo troppo lungo' using errcode = '22023'; end if;

  if not coalesce(p_force, false) then
    select * into v_dup from public.customers c
    where c.org_id = p_org and c.anonymized_at is null and (p_id is null or c.id <> p_id)
      and ((v_phone is not null and c.phone is not null and app.norm_phone(c.phone) = v_phone) or (v_email is not null and lower(c.email) = v_email))
    limit 1;
    if v_dup.id is not null then
      raise exception 'Esiste già un cliente con questo %: %', case when v_phone is not null and app.norm_phone(v_dup.phone) = v_phone then 'telefono' else 'email' end, v_dup.full_name
        using errcode = 'P0001';
    end if;
  end if;

  if p_id is null then
    insert into public.customers (org_id, full_name, phone, email, language, birthday, allergies, preferences, notes, tags)
    values (p_org, trim(p_name), v_phone, v_email, coalesce(p_language, 'it'), p_birthday, app.clean_list(p_allergies),
            nullif(trim(p_preferences), ''), nullif(trim(p_notes), ''), app.clean_list(p_tags))
    returning id into v_id;
  else
    update public.customers set full_name = trim(p_name), phone = v_phone, email = v_email, language = coalesce(p_language, language),
      birthday = p_birthday, allergies = app.clean_list(p_allergies), preferences = nullif(trim(p_preferences), ''),
      notes = nullif(trim(p_notes), ''), tags = app.clean_list(p_tags), updated_at = now()
    where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.crm_set_consent(p_customer uuid, p_kind text, p_granted boolean, p_source text) returns public.customers
language plpgsql security definer set search_path = public as $$
declare v_c public.customers;
begin
  v_c := app.crm_lock_customer(p_customer);
  if not app.has_perm(v_c.org_id, 'crm.manage') then raise exception 'Solo chi gestisce il CRM può modificare i consensi' using errcode = '42501'; end if;
  if v_c.anonymized_at is not null then raise exception 'Il cliente è stato anonimizzato' using errcode = 'P0001'; end if;
  if p_kind not in ('privacy','marketing') then raise exception 'Tipo di consenso non valido' using errcode = '22023'; end if;
  if p_source is null or p_source not in ('reception','telefono','email','whatsapp','portale','sito','modulo_firmato','importazione') then
    raise exception 'Indica la fonte del consenso' using errcode = '22023';
  end if;
  if p_kind = 'privacy' then
    update public.customers set privacy_consent_at = case when p_granted then now() end, consent_source = p_source, updated_at = now()
    where id = p_customer returning * into v_c;
  else
    update public.customers set marketing_consent = coalesce(p_granted, false), marketing_consent_at = now(), consent_source = p_source, updated_at = now()
    where id = p_customer returning * into v_c;
  end if;
  return v_c;
end $$;

-- Ricerca e segmenti: frequenza, ultima visita, spesa (solo con finance.view), tag, consenso marketing.
-- Visite = prenotazioni arrivate/completate + giornate in spiaggia (presente/uscito) + comande chiuse collegate.
create or replace function public.crm_customers(
  p_org uuid, p_search text default null, p_tags text[] default null, p_min_visits int default null,
  p_last_visit_after date default null, p_last_visit_before date default null, p_marketing boolean default null,
  p_min_spend numeric default null, p_include_anonymized boolean default false, p_limit int default 200,
  p_customer uuid default null
) returns table (id uuid, full_name text, email text, phone text, tags text[], allergies text[], marketing_consent boolean,
                 visits int, last_visit date, no_shows int, spend numeric, anonymized boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_fin boolean; v_q text; v_qphone text;
begin
  if p_org is null or not app.can_see_customers(p_org) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  v_fin := app.has_perm(p_org, 'finance.view');
  if p_min_spend is not null and not v_fin then raise exception 'Per filtrare per spesa serve il permesso finanza' using errcode = '42501'; end if;
  v_q := nullif(lower(trim(coalesce(p_search, ''))), '');
  if v_q is not null and length(v_q) > 80 then raise exception 'Ricerca troppo lunga' using errcode = '22023'; end if;
  v_qphone := case when v_q ~ '^[+0-9 ./()-]{5,}$' then regexp_replace(v_q, '[^0-9]', '', 'g') end;
  return query
  with base as (
    select c.* from public.customers c
    where c.org_id = p_org
      and (p_customer is null or c.id = p_customer)
      and (p_include_anonymized or c.anonymized_at is null or c.id = p_customer)
      and (v_q is null or lower(c.full_name) like '%' || v_q || '%' or lower(coalesce(c.email, '')) like '%' || v_q || '%'
           or (v_qphone is not null and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_qphone || '%'))
      and (p_tags is null or cardinality(p_tags) = 0 or c.tags @> app.clean_list(p_tags))
      and (p_marketing is null or c.marketing_consent = p_marketing)
  ), ev as (
    select r.customer_id cid, r.res_date d, 0::numeric amount, 1 visit, 0 noshow from public.reservations r
      where r.org_id = p_org and r.customer_id in (select b.id from base b) and r.status in ('arrivata','completata')
    union all
    select r.customer_id, r.res_date, 0, 0, 1 from public.reservations r
      where r.org_id = p_org and r.customer_id in (select b.id from base b) and r.status = 'no_show'
    union all
    select bb.customer_id, coalesce(bb.last_checkin_on, bb.start_date), bb.paid_amount, 1, 0 from public.beach_bookings bb
      where bb.org_id = p_org and bb.customer_id in (select b.id from base b) and bb.status in ('presente','uscito')
    union all
    select bb.customer_id, null, bb.paid_amount, 0, 0 from public.beach_bookings bb
      where bb.org_id = p_org and bb.customer_id in (select b.id from base b) and bb.status not in ('presente','uscito')
    union all
    select o.customer_id, o.business_date, o.total, 1, 0 from public.pos_orders o
      where o.org_id = p_org and o.customer_id in (select b.id from base b) and o.status = 'chiusa'
  ), agg as (
    select cid, sum(visit)::int visits, max(d) filter (where visit = 1) last_visit, sum(noshow)::int no_shows, sum(amount) spend
    from ev group by cid
  )
  select b.id, b.full_name, b.email, b.phone, b.tags, b.allergies, b.marketing_consent,
         coalesce(a.visits, 0), a.last_visit, coalesce(a.no_shows, 0),
         case when v_fin then coalesce(a.spend, 0) end, b.anonymized_at is not null, b.created_at
  from base b left join agg a on a.cid = b.id
  where (p_min_visits is null or coalesce(a.visits, 0) >= p_min_visits)
    and (p_last_visit_after is null or a.last_visit >= p_last_visit_after)
    and (p_last_visit_before is null or a.last_visit is null or a.last_visit < p_last_visit_before)
    and (p_min_spend is null or coalesce(a.spend, 0) >= p_min_spend)
  order by a.last_visit desc nulls last, b.full_name
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $$;

-- Scheda cliente: storico spiaggia (senza importi), statistiche, spesa solo con finance.view.
create or replace function public.crm_customer_card(p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_c public.customers; v_fin boolean;
begin
  select * into v_c from public.customers where id = p_customer;
  if not found or not app.can_see_customers(v_c.org_id) then raise exception 'Cliente non trovato' using errcode = 'P0002'; end if;
  v_fin := app.has_perm(v_c.org_id, 'finance.view');
  return jsonb_build_object(
    'beach', coalesce((
      select jsonb_agg(jsonb_build_object('id', bb.id, 'start_date', bb.start_date, 'end_date', bb.end_date, 'period', bb.period,
               'status', bb.status, 'point', sp.label, 'facility', f.name,
               'price', case when v_fin then bb.price end, 'paid', case when v_fin then bb.paid_amount end) order by bb.start_date desc)
      from public.beach_bookings bb join public.service_points sp on sp.id = bb.service_point_id join public.facilities f on f.id = bb.facility_id
      where bb.customer_id = p_customer), '[]'::jsonb),
    'orders', case when v_fin then coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'date', o.business_date, 'total', o.total, 'destination', o.destination_label, 'facility', f.name)
                       order by o.business_date desc)
      from public.pos_orders o join public.facilities f on f.id = o.facility_id
      where o.customer_id = p_customer and o.status = 'chiusa'), '[]'::jsonb) end,
    'spend', case when v_fin then jsonb_build_object(
      'orders', (select coalesce(sum(o.total), 0) from public.pos_orders o where o.customer_id = p_customer and o.status = 'chiusa'),
      'beach', (select coalesce(sum(bb.paid_amount), 0) from public.beach_bookings bb where bb.customer_id = p_customer)) end,
    'consents', coalesce((
      select jsonb_agg(jsonb_build_object('kind', k.kind, 'granted', k.granted, 'source', k.source, 'at', k.recorded_at) order by k.recorded_at desc)
      from public.customer_consents k where k.customer_id = p_customer), '[]'::jsonb)
  );
end $$;

-- Possibili doppioni: stesso telefono normalizzato, stessa email o stesso nome.
create or replace function public.crm_find_duplicates(p_org uuid)
returns table (a_id uuid, a_name text, b_id uuid, b_name text, reason text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if p_org is null or not app.can_see_customers(p_org) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  return query
  with c as (
    select id, full_name, created_at, app.norm_phone(phone) ph, lower(email) em,
           regexp_replace(lower(full_name), '[^a-zà-ÿ]', '', 'g') nm
    from public.customers where org_id = p_org and anonymized_at is null
  )
  select distinct on (least(x.id, y.id), greatest(x.id, y.id))
         x.id, x.full_name, y.id, y.full_name,
         case when x.ph is not null and x.ph = y.ph then 'telefono' when x.em is not null and x.em = y.em then 'email' else 'nome' end
  from c x join c y on (x.created_at, x.id) < (y.created_at, y.id)
   and ((x.ph is not null and x.ph = y.ph) or (x.em is not null and x.em = y.em) or (length(x.nm) >= 6 and x.nm = y.nm))
  order by least(x.id, y.id), greatest(x.id, y.id)
  limit 200;
end $$;

-- Unione di due schede: tutti i riferimenti (prenotazioni, spiaggia, comande, richieste… anche di moduli futuri)
-- passano alla scheda che resta; dati e consensi si completano; la scheda unita viene eliminata.
create or replace function public.crm_merge_customers(p_keep uuid, p_merge uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_k public.customers;
  v_m public.customers;
  r record;
begin
  if p_keep = p_merge then raise exception 'Scegli due clienti diversi' using errcode = '22023'; end if;
  v_k := app.crm_lock_customer(p_keep);
  v_m := app.crm_lock_customer(p_merge);
  if v_k.org_id <> v_m.org_id then raise exception 'Cliente non trovato' using errcode = 'P0002'; end if;
  if not app.has_perm(v_k.org_id, 'crm.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_k.anonymized_at is not null or v_m.anonymized_at is not null then raise exception 'Non si possono unire clienti anonimizzati' using errcode = 'P0001'; end if;

  for r in
    select con.conrelid::regclass as tbl, a.attname as col
    from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid
      and a.attnum = con.conkey[array_position(con.confkey, (select attnum from pg_attribute where attrelid = 'public.customers'::regclass and attname = 'id'))]
    where con.contype = 'f' and con.confrelid = 'public.customers'::regclass and con.conrelid <> 'public.customers'::regclass
  loop
    execute format('update %s set %I = $1 where %I = $2', r.tbl, r.col, r.col) using p_keep, p_merge;
  end loop;

  update public.customers set
    phone = coalesce(phone, v_m.phone),
    email = coalesce(email, v_m.email),
    birthday = coalesce(birthday, v_m.birthday),
    allergies = app.clean_list(allergies || v_m.allergies),
    tags = app.clean_list(tags || v_m.tags),
    preferences = nullif(concat_ws(' · ', preferences, case when v_m.preferences is distinct from preferences then v_m.preferences end), ''),
    notes = nullif(concat_ws(' · ', notes, case when v_m.notes is distinct from notes then v_m.notes end), ''),
    privacy_consent_at = coalesce(privacy_consent_at, v_m.privacy_consent_at),
    marketing_consent = marketing_consent or v_m.marketing_consent,
    marketing_consent_at = case when not marketing_consent and v_m.marketing_consent then v_m.marketing_consent_at else marketing_consent_at end,
    consent_source = case when (not marketing_consent and v_m.marketing_consent) or (privacy_consent_at is null and v_m.privacy_consent_at is not null)
                          then coalesce(v_m.consent_source, 'unione schede') else consent_source end,
    created_at = least(created_at, v_m.created_at),
    updated_at = now()
  where id = p_keep;

  delete from public.customers where id = p_merge;
  insert into public.audit_log (org_id, actor_id, action, entity, entity_id, before, after)
  values (v_k.org_id, auth.uid(), 'merge', 'customers', p_keep::text, jsonb_build_object('merged_id', p_merge), null);
  return p_keep;
end $$;

-- GDPR: esportazione completa dei dati di un cliente.
create or replace function public.crm_export_customer(p_customer uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_c public.customers; v_out jsonb;
begin
  v_c := app.crm_lock_customer(p_customer);
  if not app.has_perm(v_c.org_id, 'crm.manage') then raise exception 'Solo chi gestisce il CRM può esportare i dati' using errcode = '42501'; end if;
  v_out := jsonb_build_object(
    'esportato_il', now(),
    'titolare_trattamento', (select name from public.organizations where id = v_c.org_id),
    'cliente', to_jsonb(v_c) - 'created_by' - 'org_id',
    'consensi', coalesce((select jsonb_agg(jsonb_build_object('tipo', k.kind, 'concesso', k.granted, 'fonte', k.source, 'data', k.recorded_at) order by k.recorded_at)
                          from public.customer_consents k where k.customer_id = p_customer), '[]'),
    'prenotazioni', coalesce((select jsonb_agg(jsonb_build_object('struttura', f.name, 'servizio', s.name, 'data', r.res_date, 'ora', to_char(r.res_time, 'HH24:MI'),
                               'persone', r.party_size, 'stato', r.status, 'canale', r.source, 'note', r.notes, 'richieste', r.special_requests,
                               'allergie', r.allergies, 'acconto', r.deposit_required, 'creata_il', r.created_at) order by r.starts_at)
                              from public.reservations r join public.reservation_services s on s.id = r.service_id join public.facilities f on f.id = r.facility_id
                              where r.customer_id = p_customer), '[]'),
    'lista_attesa', coalesce((select jsonb_agg(jsonb_build_object('data', w.wait_date, 'persone', w.party_size, 'stato', w.status, 'note', w.notes, 'creata_il', w.created_at))
                              from public.reservation_waitlist w where w.customer_id = p_customer), '[]'),
    'spiaggia', coalesce((select jsonb_agg(jsonb_build_object('struttura', f.name, 'postazione', sp.label, 'periodo', bb.period, 'dal', bb.start_date, 'al', bb.end_date,
                           'stato', bb.status, 'nome', bb.customer_name, 'telefono', bb.customer_phone, 'email', bb.customer_email, 'note', bb.notes,
                           'prezzo', bb.price, 'pagato', bb.paid_amount) order by bb.start_date)
                          from public.beach_bookings bb join public.service_points sp on sp.id = bb.service_point_id join public.facilities f on f.id = bb.facility_id
                          where bb.customer_id = p_customer), '[]'),
    'comande', coalesce((select jsonb_agg(jsonb_build_object('struttura', f.name, 'data', o.business_date, 'totale', o.total, 'stato', o.status) order by o.business_date)
                         from public.pos_orders o join public.facilities f on f.id = o.facility_id where o.customer_id = p_customer), '[]'),
    'richieste', coalesce((select jsonb_agg(jsonb_build_object('data', g.created_at, 'categoria', g.category, 'messaggio', g.message, 'stato', g.status) order by g.created_at)
                           from public.guest_requests g where g.customer_id = p_customer), '[]')
  );
  insert into public.audit_log (org_id, actor_id, action, entity, entity_id) values (v_c.org_id, auth.uid(), 'export', 'customers', p_customer::text);
  return v_out;
end $$;

-- GDPR: anonimizzazione. Toglie i dati personali da scheda, prenotazioni, lista d'attesa, spiaggia e richieste,
-- e li oscura nel registro operazioni; restano importi, date e coperti.
create or replace function public.crm_anonymize_customer(p_customer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_c public.customers;
begin
  v_c := app.crm_lock_customer(p_customer);
  if not app.has_perm(v_c.org_id, 'crm.manage') then raise exception 'Solo chi gestisce il CRM può anonimizzare' using errcode = '42501'; end if;
  if v_c.anonymized_at is not null then raise exception 'Cliente già anonimizzato' using errcode = 'P0001'; end if;

  perform set_config('ordivia.crm_trusted', 'on', true);
  update public.customers set full_name = 'Cliente anonimizzato', email = null, phone = null, birthday = null, allergies = '{}',
    preferences = null, notes = null, tags = '{}', privacy_consent_at = null, marketing_consent = false,
    consent_source = 'anonimizzazione', anonymized_at = now(), updated_at = now()
  where id = p_customer;
  perform set_config('ordivia.crm_trusted', 'off', true);
  update public.reservations set notes = null, special_requests = null, allergies = '{}', guest_name = null where customer_id = p_customer;
  update public.reservation_waitlist set notes = null where customer_id = p_customer;
  update public.beach_bookings set customer_name = 'Cliente anonimizzato', customer_phone = null, customer_email = null, notes = null
  where customer_id = p_customer;
  update public.guest_requests set guest_name = null, guest_contact = null where customer_id = p_customer;

  -- Registro operazioni: niente dati personali residui (anche delle schede unite in passato a questa).
  update public.audit_log set
    before = case when before is not null then jsonb_build_object('id', entity_id, 'oscurato', true) end,
    after  = case when after  is not null then jsonb_build_object('id', entity_id, 'oscurato', true) end
  where org_id = v_c.org_id and entity = 'customers' and action <> 'merge'
    and entity_id in (
      with recursive ids(id) as (
        select p_customer::text
        union
        select a.before ->> 'merged_id' from public.audit_log a join ids on a.entity_id = ids.id
        where a.org_id = v_c.org_id and a.entity = 'customers' and a.action = 'merge'
      ) select id from ids);
  update public.audit_log set
    before = before - array['notes','special_requests','allergies','guest_name'],
    after  = after  - array['notes','special_requests','allergies','guest_name']
  where org_id = v_c.org_id and entity in ('reservations','reservation_waitlist')
    and entity_id in (select id::text from public.reservations where customer_id = p_customer
                      union all select id::text from public.reservation_waitlist where customer_id = p_customer);
  update public.audit_log set
    before = before - array['customer_name','customer_phone','customer_email','notes'],
    after  = after  - array['customer_name','customer_phone','customer_email','notes']
  where org_id = v_c.org_id and entity = 'beach_bookings'
    and entity_id in (select id::text from public.beach_bookings where customer_id = p_customer);
  update public.audit_log set
    before = before - array['guest_name','guest_contact'],
    after  = after  - array['guest_name','guest_contact']
  where org_id = v_c.org_id and entity = 'guest_requests'
    and entity_id in (select id::text from public.guest_requests where customer_id = p_customer);

  insert into public.audit_log (org_id, actor_id, action, entity, entity_id) values (v_c.org_id, auth.uid(), 'anonymize', 'customers', p_customer::text);
end $$;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reservations') then
      alter publication supabase_realtime add table public.reservations;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reservation_waitlist') then
      alter publication supabase_realtime add table public.reservation_waitlist;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Permessi di esecuzione (funzione per funzione: non tocca le concessioni ad anon degli altri moduli)
-- ---------------------------------------------------------------------------
-- Interne: nessun client.
revoke execute on function app.norm_phone(text) from public, anon;
revoke execute on function app.norm_email(text) from public, anon;
revoke execute on function app.clean_list(text[]) from public, anon;
revoke execute on function app.res_touch() from public, anon, authenticated;
revoke execute on function app.crm_customer_guard() from public, anon, authenticated;
revoke execute on function app.crm_trusted() from public, anon;
grant execute on function app.crm_trusted() to authenticated;
revoke execute on function app.crm_log_consent() from public, anon, authenticated;
revoke execute on function app.res_tz(uuid) from public, anon, authenticated;
revoke execute on function app.res_today(uuid) from public, anon, authenticated;
revoke execute on function app.res_parse_time(text) from public, anon, authenticated;
revoke execute on function app.crm_match_or_create(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function app.crm_link_beach_booking() from public, anon, authenticated;
revoke execute on function app.res_day_slots(uuid, date) from public, anon, authenticated;
revoke execute on function app.res_peak_load(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function app.res_availability(uuid, date, uuid) from public, anon, authenticated;
revoke execute on function app.res_check(uuid, date, time, int, uuid, boolean) from public, anon, authenticated;
revoke execute on function app.res_lock(uuid) from public, anon, authenticated;
revoke execute on function app.res_check_table(uuid, uuid) from public, anon, authenticated;
revoke execute on function app.res_insert(public.reservation_services, date, time, int, uuid, text, text, text, text, text, text[], uuid, numeric, boolean) from public, anon, authenticated;
revoke execute on function app.res_public_service(text, uuid) from public, anon, authenticated;
revoke execute on function app.crm_lock_customer(uuid) from public, anon, authenticated;
grant execute on function app.norm_phone(text) to authenticated;
grant execute on function app.norm_email(text) to authenticated;
grant execute on function app.clean_list(text[]) to authenticated;

-- Staff.
revoke execute on function public.res_slots(uuid, date) from public, anon;
grant  execute on function public.res_slots(uuid, date) to authenticated;
revoke execute on function public.res_create(uuid, date, text, int, uuid, text, text, text, text, text, text, text, text[], uuid, numeric) from public, anon;
grant  execute on function public.res_create(uuid, date, text, int, uuid, text, text, text, text, text, text, text, text[], uuid, numeric) to authenticated;
revoke execute on function public.res_set_status(uuid, text, text) from public, anon;
grant  execute on function public.res_set_status(uuid, text, text) to authenticated;
revoke execute on function public.res_assign_table(uuid, uuid) from public, anon;
grant  execute on function public.res_assign_table(uuid, uuid) to authenticated;
revoke execute on function public.res_update(uuid, date, text, int, text, text, text[], numeric) from public, anon;
grant  execute on function public.res_update(uuid, date, text, int, text, text, text[], numeric) to authenticated;
revoke execute on function public.res_set_deposit_paid(uuid, boolean) from public, anon;
grant  execute on function public.res_set_deposit_paid(uuid, boolean) to authenticated;
revoke execute on function public.res_mark_reminded(uuid[]) from public, anon;
grant  execute on function public.res_mark_reminded(uuid[]) to authenticated;
revoke execute on function public.res_waitlist_add(uuid, date, int, text, uuid, text, text, text, text, boolean) from public, anon;
grant  execute on function public.res_waitlist_add(uuid, date, int, text, uuid, text, text, text, text, boolean) to authenticated;
revoke execute on function public.res_waitlist_set(uuid, text) from public, anon;
grant  execute on function public.res_waitlist_set(uuid, text) to authenticated;
revoke execute on function public.res_waitlist_promote(uuid, text, uuid) from public, anon;
grant  execute on function public.res_waitlist_promote(uuid, text, uuid) to authenticated;
revoke execute on function public.crm_save_customer(uuid, uuid, text, text, text, text, date, text[], text, text, text[], boolean) from public, anon;
grant  execute on function public.crm_save_customer(uuid, uuid, text, text, text, text, date, text[], text, text, text[], boolean) to authenticated;
revoke execute on function public.crm_set_consent(uuid, text, boolean, text) from public, anon;
grant  execute on function public.crm_set_consent(uuid, text, boolean, text) to authenticated;
revoke execute on function public.crm_customers(uuid, text, text[], int, date, date, boolean, numeric, boolean, int, uuid) from public, anon;
grant  execute on function public.crm_customers(uuid, text, text[], int, date, date, boolean, numeric, boolean, int, uuid) to authenticated;
revoke execute on function public.crm_customer_card(uuid) from public, anon;
grant  execute on function public.crm_customer_card(uuid) to authenticated;
revoke execute on function public.crm_find_duplicates(uuid) from public, anon;
grant  execute on function public.crm_find_duplicates(uuid) to authenticated;
revoke execute on function public.crm_merge_customers(uuid, uuid) from public, anon;
grant  execute on function public.crm_merge_customers(uuid, uuid) to authenticated;
revoke execute on function public.crm_export_customer(uuid) from public, anon;
grant  execute on function public.crm_export_customer(uuid) to authenticated;
revoke execute on function public.crm_anonymize_customer(uuid) from public, anon;
grant  execute on function public.crm_anonymize_customer(uuid) to authenticated;

-- Pubbliche: portale QR, sito, receptionist AI (anon) e staff.
revoke execute on function public.public_reservation_services(text) from public;
revoke execute on function public.public_reservation_slots(text, uuid, date) from public;
revoke execute on function public.public_create_reservation(text, uuid, date, text, int, text, text, text, text, text[], boolean, boolean, text) from public;
grant execute on function public.public_reservation_services(text) to anon, authenticated;
grant execute on function public.public_reservation_slots(text, uuid, date) to anon, authenticated;
grant execute on function public.public_create_reservation(text, uuid, date, text, int, text, text, text, text, text[], boolean, boolean, text) to anon, authenticated;
