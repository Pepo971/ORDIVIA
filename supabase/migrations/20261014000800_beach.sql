-- Ordivia v2 — Spiaggia: listino, prenotazioni e abbonamenti, giornata dello spiaggino, manutenzione postazioni.
-- La mappa usa i punti di servizio condivisi (public.service_points, kind ombrellone/lettino/cabina/gazebo;
-- zone = settore, row_label = fila, pos_x = posizione nella fila, pos_y = numero di fila).
--
-- Regole principali
-- * Nessuna doppia prenotazione: vincolo di esclusione (postazione, intervallo di date, fascia) sulle prenotazioni attive.
--   Mattina e pomeriggio dello stesso giorno convivono; la giornata intera esclude entrambe.
-- * Le prenotazioni si scrivono solo tramite RPC (prezzo da listino calcolato nel database).
-- * I dati del cliente (telefono, email) sono leggibili solo da chi ha beach.operate o beach.manage sulla struttura.
-- * Gli incassi aggregati richiedono finance.view.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Listino
-- ---------------------------------------------------------------------------
create table public.beach_rates (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  facility_id         uuid not null,
  name                text check (name is null or length(trim(name)) between 1 and 80), -- es. «Alta stagione»
  kind                text not null check (kind in ('ombrellone','lettino','cabina','gazebo')),
  zone                text check (zone is null or length(trim(zone)) between 1 and 40),       -- null = tutti i settori
  row_label           text check (row_label is null or length(trim(row_label)) between 1 and 20), -- null = tutte le file
  period              text not null check (period in ('giornata','mattina','pomeriggio','settimana','mese','stagione')),
  valid_from          date not null,
  valid_to            date not null,
  price               numeric(10,2) not null check (price >= 0),
  included_lettini    smallint not null default 2 check (included_lettini between 0 and 20),
  extra_lettino_price numeric(10,2) not null default 0 check (extra_lettino_price >= 0),
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  check (valid_from <= valid_to),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);
create index on public.beach_rates (facility_id, kind, period) where active;

-- ---------------------------------------------------------------------------
-- Prenotazioni (giornaliere, multi-giorno, abbonamenti)
-- ---------------------------------------------------------------------------
create table public.beach_bookings (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organizations(id) on delete cascade,
  facility_id           uuid not null,
  service_point_id      uuid not null,
  period                text not null check (period in ('giornata','mattina','pomeriggio','settimana','mese','stagione')),
  start_date            date not null,
  end_date              date not null,
  -- fascia della giornata: [0,1) mattina, [1,2) pomeriggio, [0,2) intera
  slot_range            int4range generated always as (
                          case period when 'mattina' then int4range(0, 1) when 'pomeriggio' then int4range(1, 2) else int4range(0, 2) end
                        ) stored,
  customer_name         text not null check (length(trim(customer_name)) between 1 and 120),
  customer_phone        text check (customer_phone is null or length(customer_phone) <= 40),
  customer_email        text check (customer_email is null or length(customer_email) <= 160),
  notes                 text check (notes is null or length(notes) <= 1000),
  lettini               smallint not null default 2 check (lettini between 0 and 20),
  list_price            numeric(10,2) check (list_price is null or list_price >= 0), -- da listino al momento della prenotazione
  price                 numeric(10,2) not null check (price >= 0),                    -- prezzo applicato
  price_override_reason text check (price_override_reason is null or length(price_override_reason) <= 300),
  paid_amount           numeric(10,2) not null default 0 check (paid_amount >= 0),
  status                text not null default 'prenotata' check (status in ('prenotata','presente','uscito','annullata','no_show')),
  last_checkin_on       date,      -- giorno dell'ultimo check-in (multi-giorno: il check-in è giornaliero)
  checked_in_at         timestamptz,
  checked_out_at        timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text check (cancel_reason is null or length(cancel_reason) <= 300),
  created_by            uuid references auth.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (start_date <= end_date and end_date - start_date <= 200),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id),
  constraint beach_bookings_no_overlap exclude using gist (
    service_point_id with =,
    daterange(start_date, end_date, '[]') with &&,
    slot_range with &&
  ) where (status in ('prenotata', 'presente'))
);
create index on public.beach_bookings (facility_id, start_date, end_date);
create index on public.beach_bookings (facility_id, period) where period in ('mese','stagione');
create index on public.beach_bookings (service_point_id);

-- Incassi: registro append-only (anche i rimborsi sono righe negative)
create table public.beach_payments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  facility_id uuid not null,
  booking_id  uuid not null,
  amount      numeric(10,2) not null check (amount <> 0),
  method      text not null default 'contanti' check (method in ('contanti','carta','bonifico','altro')),
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (booking_id, org_id) references public.beach_bookings(id, org_id) on delete cascade
);
create index on public.beach_payments (facility_id, created_at);
create index on public.beach_payments (booking_id);

-- Cambi postazione (registro)
create table public.beach_moves (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  facility_id   uuid not null,
  booking_id    uuid not null,
  from_point_id uuid not null,
  to_point_id   uuid not null,
  note          text check (note is null or length(note) <= 300),
  moved_by      uuid references auth.users(id),
  moved_at      timestamptz not null default now(),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (booking_id, org_id) references public.beach_bookings(id, org_id) on delete cascade,
  foreign key (from_point_id, org_id) references public.service_points(id, org_id),
  foreign key (to_point_id, org_id) references public.service_points(id, org_id)
);
create index on public.beach_moves (booking_id);

-- Manutenzione: postazione fuori servizio
create table public.beach_point_flags (
  service_point_id uuid primary key,
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  out_of_service   boolean not null default false,
  note             text check (note is null or length(note) <= 300),
  updated_by       uuid references auth.users(id),
  updated_at       timestamptz not null default now(),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete cascade
);
create index on public.beach_point_flags (facility_id) where out_of_service;

-- ---------------------------------------------------------------------------
-- Audit, RLS
-- ---------------------------------------------------------------------------
select app.enable_audit('public.beach_rates');
select app.enable_audit('public.beach_bookings');
select app.enable_audit('public.beach_payments');
select app.enable_audit('public.beach_moves');
select app.enable_audit('public.beach_point_flags');

alter table public.beach_rates       enable row level security;
alter table public.beach_bookings    enable row level security;
alter table public.beach_payments    enable row level security;
alter table public.beach_moves       enable row level security;
alter table public.beach_point_flags enable row level security;

create or replace function app.beach_staff(p_org uuid, p_facility uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_facility_perm(p_org, p_facility, 'beach.operate') or app.has_facility_perm(p_org, p_facility, 'beach.manage')
$$;

-- Listino: lo legge chi lavora in spiaggia (serve per i walk-in), lo modifica solo beach.manage.
create policy br_select on public.beach_rates for select to authenticated
  using (app.beach_staff(org_id, facility_id) or app.has_facility_perm(org_id, facility_id, 'finance.view'));
create policy br_write on public.beach_rates for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'beach.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'beach.manage'));

-- Prenotazioni: contengono dati personali → solo il personale di spiaggia della struttura. Scritture solo via RPC.
create policy bb_select on public.beach_bookings for select to authenticated using (app.beach_staff(org_id, facility_id));
create policy bm_select on public.beach_moves for select to authenticated using (app.beach_staff(org_id, facility_id));
create policy bf_select on public.beach_point_flags for select to authenticated using (app.can_access_facility(org_id, facility_id));
-- Il registro incassi: responsabili di spiaggia o chi vede la finanza.
create policy bp_select on public.beach_payments for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'beach.manage') or app.has_facility_perm(org_id, facility_id, 'finance.view'));

-- ---------------------------------------------------------------------------
-- Funzioni di supporto
-- ---------------------------------------------------------------------------
create or replace function app.beach_today(p_facility uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select timezone from public.facilities where id = p_facility), 'Europe/Rome'))::date
$$;

-- Tariffa applicabile: la più specifica (fila > settore > tutta la spiaggia), poi la validità più recente.
-- Stessa regola di pickRate() in packages/domain/src/beach.ts.
create or replace function app.beach_rate_for(p_facility uuid, p_kind text, p_zone text, p_row text, p_period text, p_date date)
returns public.beach_rates
language sql stable security definer set search_path = public as $$
  select r.* from public.beach_rates r
  where r.facility_id = p_facility and r.active and r.kind = p_kind and r.period = p_period
    and p_date between r.valid_from and r.valid_to
    and (r.zone is null or r.zone = p_zone)
    and (r.row_label is null or r.row_label = p_row)
  order by (case when r.row_label is not null then 2 else 0 end + case when r.zone is not null then 1 else 0 end) desc,
           r.valid_from desc, r.created_at desc
  limit 1
$$;

-- Prezzo da listino (stessa regola di quotePrice()): giornata e mezze giornate sommate giorno per giorno,
-- settimana/mese/stagione a prezzo fisso della tariffa valida il primo giorno; lettini oltre gli inclusi a parte.
-- Restituisce null se manca una tariffa per uno dei giorni.
create or replace function app.beach_list_price(p_point uuid, p_period text, p_start date, p_end date, p_lettini int)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  v_sp public.service_points;
  v_rate public.beach_rates;
  v_total numeric := 0;
  v_day date;
  v_last date;
begin
  select * into v_sp from public.service_points where id = p_point;
  if not found then return null; end if;
  v_last := case when p_period in ('settimana','mese','stagione') then p_start else p_end end;
  v_day := p_start;
  while v_day <= v_last loop
    v_rate := app.beach_rate_for(v_sp.facility_id, v_sp.kind, v_sp.zone, v_sp.row_label, p_period, v_day);
    if v_rate.id is null then return null; end if;
    v_total := v_total + v_rate.price + greatest(p_lettini - v_rate.included_lettini, 0) * v_rate.extra_lettino_price;
    v_day := v_day + 1;
  end loop;
  return round(v_total, 2);
end $$;

create or replace function app.beach_check_period(p_period text, p_start date, p_end date) returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_period is null or p_period not in ('giornata','mattina','pomeriggio','settimana','mese','stagione') then
    raise exception 'Periodo non valido' using errcode = '22023';
  end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'La data di fine è precedente all''inizio' using errcode = '22023'; end if;
  if p_end - p_start > 200 then raise exception 'Il periodo è troppo lungo' using errcode = '22023'; end if;
  if p_period = 'settimana' and p_end <> p_start + 6 then raise exception 'Una settimana dura 7 giorni' using errcode = '22023'; end if;
  if p_period = 'mese' and p_end <> (p_start + interval '1 month')::date - 1 then
    raise exception 'Un mese va dal giorno scelto al giorno prima del mese successivo' using errcode = '22023';
  end if;
end $$;

-- Lettura con blocco e controllo di accesso comune alle RPC sulle prenotazioni.
create or replace function app.beach_lock_booking(p_booking uuid) returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings;
begin
  select * into v_b from public.beach_bookings where id = p_booking for update;
  if not found or not app.beach_staff(v_b.org_id, v_b.facility_id) then
    raise exception 'Prenotazione non trovata' using errcode = 'P0002';
  end if;
  return v_b;
end $$;

create or replace function app.beach_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger beach_bookings_touch before update on public.beach_bookings for each row execute function app.beach_touch();

-- ---------------------------------------------------------------------------
-- RPC: preventivo da listino
-- ---------------------------------------------------------------------------
create or replace function public.beach_quote(p_point uuid, p_period text, p_start date, p_end date, p_lettini int default 2)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v_sp public.service_points;
begin
  select * into v_sp from public.service_points where id = p_point;
  if not found or not app.beach_staff(v_sp.org_id, v_sp.facility_id) then raise exception 'Postazione non trovata' using errcode = 'P0002'; end if;
  perform app.beach_check_period(p_period, p_start, p_end);
  return app.beach_list_price(p_point, p_period, p_start, p_end, coalesce(p_lettini, 0));
end $$;

-- ---------------------------------------------------------------------------
-- RPC: nuova prenotazione
--   beach.operate: giornata o mezza giornata, da oggi in avanti, al prezzo di listino.
--   beach.manage: anche settimana/mese/stagione, date passate e prezzo diverso dal listino (con motivo).
--   p_checkin = true: walk-in, cliente già in spiaggia (solo per oggi).
-- ---------------------------------------------------------------------------
create or replace function public.beach_book(
  p_point          uuid,
  p_period         text,
  p_start          date,
  p_end            date,
  p_customer_name  text,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_notes          text default null,
  p_lettini        int default 2,
  p_price          numeric default null,
  p_price_reason   text default null,
  p_paid           numeric default 0,
  p_payment_method text default 'contanti',
  p_checkin        boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sp public.service_points;
  v_manage boolean;
  v_today date;
  v_list numeric;
  v_price numeric;
  v_id uuid;
begin
  select * into v_sp from public.service_points where id = p_point;
  if not found or not app.can_access_facility(v_sp.org_id, v_sp.facility_id) then raise exception 'Postazione non trovata' using errcode = 'P0002'; end if;
  if not app.beach_staff(v_sp.org_id, v_sp.facility_id) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_sp.kind not in ('ombrellone','lettino','cabina','gazebo') then raise exception 'Questa postazione non è della spiaggia' using errcode = '22023'; end if;
  if not v_sp.active then raise exception 'Postazione disattivata' using errcode = 'P0001'; end if;
  if exists (select 1 from public.beach_point_flags f where f.service_point_id = p_point and f.out_of_service) then
    raise exception 'Postazione fuori servizio' using errcode = 'P0001';
  end if;

  v_manage := app.has_facility_perm(v_sp.org_id, v_sp.facility_id, 'beach.manage');
  v_today := app.beach_today(v_sp.facility_id);
  p_end := coalesce(p_end, p_start);
  perform app.beach_check_period(p_period, p_start, p_end);
  if length(trim(coalesce(p_customer_name, ''))) = 0 then raise exception 'Inserisci il nome del cliente' using errcode = '22023'; end if;
  if p_lettini is null or p_lettini < 0 or p_lettini > 20 then raise exception 'Numero di lettini non valido' using errcode = '22023'; end if;
  if coalesce(p_paid, 0) < 0 then raise exception 'Importo incassato non valido' using errcode = '22023'; end if;

  if not v_manage then
    if p_period not in ('giornata','mattina','pomeriggio') then
      raise exception 'Abbonamenti e settimane li registra il responsabile della spiaggia' using errcode = '42501';
    end if;
    if p_start < v_today then raise exception 'Non puoi prenotare per una data passata' using errcode = '42501'; end if;
  end if;
  if p_checkin and not (p_start <= v_today and v_today <= p_end) then
    raise exception 'Il check-in immediato vale solo per prenotazioni che comprendono oggi' using errcode = 'P0001';
  end if;

  v_list := app.beach_list_price(p_point, p_period, p_start, p_end, p_lettini);
  if p_price is not null and (v_list is null or p_price <> v_list) then
    if not v_manage then raise exception 'Solo il responsabile della spiaggia può cambiare il prezzo di listino' using errcode = '42501'; end if;
    if length(trim(coalesce(p_price_reason, ''))) = 0 then raise exception 'Indica il motivo del prezzo diverso dal listino' using errcode = '22023'; end if;
    if p_price < 0 then raise exception 'Prezzo non valido' using errcode = '22023'; end if;
    v_price := round(p_price, 2);
  else
    if v_list is null then raise exception 'Nessuna tariffa a listino per questa postazione e questo periodo' using errcode = 'P0001'; end if;
    v_price := v_list;
    p_price_reason := null;
  end if;
  if coalesce(p_paid, 0) > v_price then raise exception 'L''acconto supera il prezzo' using errcode = '22023'; end if;

  begin
    insert into public.beach_bookings (org_id, facility_id, service_point_id, period, start_date, end_date,
      customer_name, customer_phone, customer_email, notes, lettini, list_price, price, price_override_reason,
      paid_amount, status, last_checkin_on, checked_in_at, created_by)
    values (v_sp.org_id, v_sp.facility_id, p_point, p_period, p_start, p_end,
      trim(p_customer_name), nullif(trim(p_customer_phone), ''), nullif(lower(trim(p_customer_email)), ''), nullif(trim(p_notes), ''),
      p_lettini, v_list, v_price, nullif(trim(p_price_reason), ''),
      coalesce(p_paid, 0), case when p_checkin then 'presente' else 'prenotata' end,
      case when p_checkin then v_today end, case when p_checkin then now() end, auth.uid())
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Postazione % già occupata in quel periodo', v_sp.label using errcode = 'P0001';
  end;

  if coalesce(p_paid, 0) > 0 then
    insert into public.beach_payments (org_id, facility_id, booking_id, amount, method, created_by)
    values (v_sp.org_id, v_sp.facility_id, v_id, p_paid, coalesce(p_payment_method, 'contanti'), auth.uid());
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: giornata (check-in, check-out, no-show, cambio postazione)
-- ---------------------------------------------------------------------------
create or replace function public.beach_checkin(p_booking uuid) returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings; v_today date;
begin
  v_b := app.beach_lock_booking(p_booking);
  v_today := app.beach_today(v_b.facility_id);
  if v_b.status not in ('prenotata','presente') then raise exception 'Prenotazione non attiva' using errcode = 'P0001'; end if;
  if v_b.status = 'presente' and v_b.last_checkin_on = v_today then raise exception 'Il cliente è già presente' using errcode = 'P0001'; end if;
  if not (v_b.start_date <= v_today and v_today <= v_b.end_date) then raise exception 'La prenotazione non è valida per oggi' using errcode = 'P0001'; end if;
  update public.beach_bookings set status = 'presente', last_checkin_on = v_today, checked_in_at = now(), checked_out_at = null
  where id = p_booking returning * into v_b;
  return v_b;
end $$;

-- Uscita: per le prenotazioni di più giorni la postazione resta del cliente fino all'ultimo giorno.
create or replace function public.beach_checkout(p_booking uuid) returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings; v_today date;
begin
  v_b := app.beach_lock_booking(p_booking);
  v_today := app.beach_today(v_b.facility_id);
  if v_b.status <> 'presente' then raise exception 'Il cliente non risulta presente' using errcode = 'P0001'; end if;
  update public.beach_bookings
  set status = case when v_b.end_date > v_today then 'prenotata' else 'uscito' end, checked_out_at = now()
  where id = p_booking returning * into v_b;
  return v_b;
end $$;

create or replace function public.beach_no_show(p_booking uuid) returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings; v_today date;
begin
  v_b := app.beach_lock_booking(p_booking);
  v_today := app.beach_today(v_b.facility_id);
  if v_b.status <> 'prenotata' then raise exception 'Solo una prenotazione in attesa può diventare «non presentato»' using errcode = 'P0001'; end if;
  if v_b.start_date > v_today then raise exception 'La prenotazione non è ancora iniziata' using errcode = 'P0001'; end if;
  if v_b.start_date <> v_b.end_date and not app.has_facility_perm(v_b.org_id, v_b.facility_id, 'beach.manage') then
    raise exception 'Per le prenotazioni di più giorni decide il responsabile della spiaggia' using errcode = '42501';
  end if;
  update public.beach_bookings set status = 'no_show' where id = p_booking returning * into v_b;
  return v_b;
end $$;

-- Cambio postazione: sposta l'intera prenotazione su una postazione libera nello stesso periodo e lo registra.
create or replace function public.beach_move(p_booking uuid, p_to_point uuid, p_note text default null) returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings; v_to public.service_points; v_from uuid;
begin
  v_b := app.beach_lock_booking(p_booking);
  if v_b.status not in ('prenotata','presente') then raise exception 'Prenotazione non attiva' using errcode = 'P0001'; end if;
  select * into v_to from public.service_points where id = p_to_point;
  if not found or v_to.facility_id <> v_b.facility_id then raise exception 'Postazione non trovata' using errcode = 'P0002'; end if;
  if v_to.id = v_b.service_point_id then raise exception 'Scegli una postazione diversa' using errcode = '22023'; end if;
  if v_to.kind not in ('ombrellone','lettino','cabina','gazebo') or not v_to.active then raise exception 'Postazione non disponibile' using errcode = 'P0001'; end if;
  if exists (select 1 from public.beach_point_flags f where f.service_point_id = p_to_point and f.out_of_service) then
    raise exception 'Postazione fuori servizio' using errcode = 'P0001';
  end if;
  v_from := v_b.service_point_id;
  begin
    update public.beach_bookings set service_point_id = p_to_point where id = p_booking returning * into v_b;
  exception when exclusion_violation then
    raise exception 'La postazione % è già occupata in quel periodo', v_to.label using errcode = 'P0001';
  end;
  insert into public.beach_moves (org_id, facility_id, booking_id, from_point_id, to_point_id, note, moved_by)
  values (v_b.org_id, v_b.facility_id, p_booking, v_from, p_to_point, nullif(trim(p_note), ''), auth.uid());
  return v_b;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: incassi, prezzo, annullamento, dati cliente
-- ---------------------------------------------------------------------------
create or replace function public.beach_add_payment(p_booking uuid, p_amount numeric, p_method text default 'contanti') returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings;
begin
  v_b := app.beach_lock_booking(p_booking);
  if p_amount is null or p_amount = 0 then raise exception 'Importo non valido' using errcode = '22023'; end if;
  if coalesce(p_method, '') not in ('contanti','carta','bonifico','altro') then raise exception 'Metodo di pagamento non valido' using errcode = '22023'; end if;
  if p_amount < 0 and not app.has_facility_perm(v_b.org_id, v_b.facility_id, 'beach.manage') then
    raise exception 'Solo il responsabile della spiaggia può registrare un rimborso' using errcode = '42501';
  end if;
  if v_b.paid_amount + p_amount > v_b.price then raise exception 'L''importo supera il saldo da incassare' using errcode = '22023'; end if;
  if v_b.paid_amount + p_amount < 0 then raise exception 'Il rimborso supera quanto incassato' using errcode = '22023'; end if;
  insert into public.beach_payments (org_id, facility_id, booking_id, amount, method, created_by)
  values (v_b.org_id, v_b.facility_id, p_booking, round(p_amount, 2), p_method, auth.uid());
  update public.beach_bookings set paid_amount = paid_amount + round(p_amount, 2) where id = p_booking returning * into v_b;
  return v_b;
end $$;

create or replace function public.beach_set_price(p_booking uuid, p_price numeric, p_reason text) returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings;
begin
  v_b := app.beach_lock_booking(p_booking);
  if not app.has_facility_perm(v_b.org_id, v_b.facility_id, 'beach.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_price is null or p_price < 0 then raise exception 'Prezzo non valido' using errcode = '22023'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Indica il motivo della modifica del prezzo' using errcode = '22023'; end if;
  if p_price < v_b.paid_amount then raise exception 'Il prezzo è inferiore a quanto già incassato: registra prima un rimborso' using errcode = 'P0001'; end if;
  update public.beach_bookings set price = round(p_price, 2), price_override_reason = trim(p_reason) where id = p_booking returning * into v_b;
  return v_b;
end $$;

-- Annullamento: il responsabile sempre; lo spiaggino solo prenotazioni giornaliere non ancora pagate.
create or replace function public.beach_cancel(p_booking uuid, p_reason text default null) returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings;
begin
  v_b := app.beach_lock_booking(p_booking);
  if v_b.status not in ('prenotata','presente') then raise exception 'Prenotazione non attiva' using errcode = 'P0001'; end if;
  if not app.has_facility_perm(v_b.org_id, v_b.facility_id, 'beach.manage') then
    if v_b.paid_amount > 0 then raise exception 'La prenotazione è già pagata: può annullarla solo il responsabile della spiaggia' using errcode = '42501'; end if;
    if v_b.period not in ('giornata','mattina','pomeriggio') then raise exception 'Gli abbonamenti li annulla il responsabile della spiaggia' using errcode = '42501'; end if;
  end if;
  update public.beach_bookings set status = 'annullata', cancelled_at = now(), cancel_reason = nullif(trim(p_reason), '')
  where id = p_booking returning * into v_b;
  return v_b;
end $$;

create or replace function public.beach_update_customer(p_booking uuid, p_name text, p_phone text, p_email text, p_notes text) returns public.beach_bookings
language plpgsql security definer set search_path = public as $$
declare v_b public.beach_bookings;
begin
  v_b := app.beach_lock_booking(p_booking);
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Inserisci il nome del cliente' using errcode = '22023'; end if;
  update public.beach_bookings
  set customer_name = trim(p_name), customer_phone = nullif(trim(p_phone), ''), customer_email = nullif(lower(trim(p_email)), ''), notes = nullif(trim(p_notes), '')
  where id = p_booking returning * into v_b;
  return v_b;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: manutenzione
-- ---------------------------------------------------------------------------
create or replace function public.beach_set_out_of_service(p_point uuid, p_out boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_sp public.service_points;
begin
  select * into v_sp from public.service_points where id = p_point;
  if not found or not app.can_access_facility(v_sp.org_id, v_sp.facility_id) then raise exception 'Postazione non trovata' using errcode = 'P0002'; end if;
  if not app.beach_staff(v_sp.org_id, v_sp.facility_id) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_out and length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Descrivi il problema' using errcode = '22023'; end if;
  insert into public.beach_point_flags (service_point_id, org_id, facility_id, out_of_service, note, updated_by, updated_at)
  values (p_point, v_sp.org_id, v_sp.facility_id, coalesce(p_out, false), case when p_out then trim(p_note) end, auth.uid(), now())
  on conflict (service_point_id) do update
    set out_of_service = excluded.out_of_service, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- ---------------------------------------------------------------------------
-- RPC: incassi della giornata (solo finance.view)
--   sold      = valore delle prenotazioni create nel giorno (non annullate)
--   accrued   = quota del giorno delle prenotazioni che lo comprendono (prezzo / giorni)
--   collected = incassato nel giorno (al netto dei rimborsi), anche per metodo
-- ---------------------------------------------------------------------------
create or replace function public.beach_day_revenue(p_facility uuid, p_date date)
returns table (sold numeric, sold_count int, accrued numeric, collected numeric, collected_cash numeric, collected_card numeric, collected_other numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid; v_tz text;
begin
  select org_id, timezone into v_org, v_tz from public.facilities where id = p_facility;
  if v_org is null or not app.has_facility_perm(v_org, p_facility, 'finance.view') then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  return query
  select
    coalesce((select sum(b.price) from public.beach_bookings b
              where b.facility_id = p_facility and b.status <> 'annullata' and (b.created_at at time zone v_tz)::date = p_date), 0)::numeric,
    (select count(*) from public.beach_bookings b
              where b.facility_id = p_facility and b.status <> 'annullata' and (b.created_at at time zone v_tz)::date = p_date)::int,
    coalesce((select round(sum(b.price / (b.end_date - b.start_date + 1)), 2) from public.beach_bookings b
              where b.facility_id = p_facility and b.status <> 'annullata' and p_date between b.start_date and b.end_date), 0)::numeric,
    coalesce((select sum(p.amount) from public.beach_payments p where p.facility_id = p_facility and (p.created_at at time zone v_tz)::date = p_date), 0)::numeric,
    coalesce((select sum(p.amount) from public.beach_payments p where p.facility_id = p_facility and p.method = 'contanti' and (p.created_at at time zone v_tz)::date = p_date), 0)::numeric,
    coalesce((select sum(p.amount) from public.beach_payments p where p.facility_id = p_facility and p.method = 'carta' and (p.created_at at time zone v_tz)::date = p_date), 0)::numeric,
    coalesce((select sum(p.amount) from public.beach_payments p where p.facility_id = p_facility and p.method not in ('contanti','carta') and (p.created_at at time zone v_tz)::date = p_date), 0)::numeric;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime: la mappa dello spiaggino si aggiorna da sola (filtrata per facility_id, RLS applicata).
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.beach_bookings, public.beach_point_flags;
  end if;
end $$;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
