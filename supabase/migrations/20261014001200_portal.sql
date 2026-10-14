-- Ordivia v3 — Portale QR per gli ospiti.
-- Ogni punto di servizio (tavolo, ombrellone, camera…) ha un QR che apre /p/<service_points.public_token>;
-- ogni struttura ha un QR generico /p/f/<facilities.public_token>.
--
-- Regole principali
-- * Configurazione per struttura (testi IT/EN, colore, contatti, sezioni, offerte, info) con RLS: la scrive chi ha
--   portal.manage; la leggono anche sala e cassa.
-- * Il pubblico (anon) NON legge nessuna tabella: tutto passa da funzioni security definer public_portal_* che
--   validano il token e restituiscono solo campi sicuri (mai costi, IVA, centri di produzione, porzioni residue).
-- * Gli ordini dal portale entrano nella comanda del punto (pos_orders/pos_order_lines) con origine «portale»;
--   le righe nascono «da_confermare» (non vanno in produzione) finché un cameriere non le accetta. Le porzioni
--   sono scalate subito in modo atomico (come pos_add_lines) e restituite se l'ordine viene rifiutato.
-- * Anti-abuso: limiti di righe/quantità/lunghezza, orari d'ordine, tipi di punto abilitati, limite di frequenza
--   per punto (10 ordini e 10 richieste ogni 10 minuti) e per struttura dal QR generico.

-- ---------------------------------------------------------------------------
-- Token pubblico della struttura (QR generico). Istruzione identica in altri moduli: deve restare idempotente.
-- ---------------------------------------------------------------------------
alter table public.facilities add column if not exists public_token text unique default encode(extensions.gen_random_bytes(16),'hex');

-- ---------------------------------------------------------------------------
-- Configurazione del portale (una riga per struttura)
-- ---------------------------------------------------------------------------
create table public.portal_settings (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  facility_id     uuid not null,
  enabled         boolean not null default false,
  display_name    text check (display_name is null or length(trim(display_name)) between 1 and 80),
  welcome_it      text check (welcome_it is null or length(welcome_it) <= 400),
  welcome_en      text check (welcome_en is null or length(welcome_en) <= 400),
  accent          text not null default 'turchese' check (accent in ('turchese','blu','corallo','oliva','sabbia','bordeaux')),
  cover_url       text check (cover_url is null or (cover_url ~ '^https://[^\s"''<>]+$' and length(cover_url) <= 500)),
  hours_it        text check (hours_it is null or length(hours_it) <= 300),
  hours_en        text check (hours_en is null or length(hours_en) <= 300),
  phone           text check (phone is null or phone ~ '^\+?[0-9 ./-]{5,20}$'),
  whatsapp        text check (whatsapp is null or whatsapp ~ '^\+?[0-9 ./-]{5,20}$'),
  email           text check (email is null or (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 120)),
  address         text check (address is null or length(address) <= 200),
  map_url         text check (map_url is null or (map_url ~ '^https://[^\s"''<>]+$' and length(map_url) <= 500)),
  show_menu       boolean not null default true,
  show_order      boolean not null default true,
  show_booking    boolean not null default true,
  show_assistance boolean not null default true,
  show_offers     boolean not null default true,
  show_info       boolean not null default true,
  -- Tipi di punto da cui si può ordinare e fascia oraria (ora locale della struttura; null = sempre).
  order_kinds     text[] not null default array['tavolo','ombrellone']::text[]
                  check (order_kinds <@ array['tavolo','ombrellone','lettino','cabina','gazebo','camera','piazzola','piscina','ritiro','altro']::text[]),
  order_from      time,
  order_to        time,
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid(),
  unique (id, org_id),
  unique (facility_id),
  check ((order_from is null) = (order_to is null) and (order_from is null or order_from <> order_to)),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);

create table public.portal_offers (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  facility_id     uuid not null,
  title_it        text not null check (length(trim(title_it)) between 1 and 100),
  title_en        text check (title_en is null or length(trim(title_en)) between 1 and 100),
  description_it  text check (description_it is null or length(description_it) <= 600),
  description_en  text check (description_en is null or length(description_en) <= 600),
  price           numeric(10,2) check (price is null or price >= 0),
  valid_from      date,
  valid_to        date,
  active          boolean not null default true,
  sort            int not null default 0,
  created_at      timestamptz not null default now(),
  unique (id, org_id),
  check (valid_from is null or valid_to is null or valid_from <= valid_to),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);
create index on public.portal_offers (org_id, facility_id, sort);

create table public.portal_info_blocks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  facility_id uuid not null,
  title_it    text not null check (length(trim(title_it)) between 1 and 100),
  title_en    text check (title_en is null or length(trim(title_en)) between 1 and 100),
  body_it     text not null check (length(trim(body_it)) between 1 and 2000),
  body_en     text check (body_en is null or length(body_en) <= 2000),
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);
create index on public.portal_info_blocks (org_id, facility_id, sort);

-- ---------------------------------------------------------------------------
-- Ordini arrivati dal portale: un invio dell'ospite = una riga, collegata alla comanda e alle sue righe.
-- ---------------------------------------------------------------------------
create table public.portal_submissions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  service_point_id uuid,
  order_id         uuid not null,
  guest_name       text check (guest_name is null or length(guest_name) <= 60),
  notes            text check (notes is null or length(notes) <= 300),
  allergies        text check (allergies is null or length(allergies) <= 300),
  lang             text not null default 'it' check (lang in ('it','en')),
  total            numeric(10,2) not null default 0,
  status           text not null default 'da_confermare' check (status in ('da_confermare','accettato','rifiutato')),
  handled_by       uuid,
  handled_at       timestamptz,
  reject_reason    text check (reject_reason is null or length(reject_reason) <= 300),
  created_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete set null (service_point_id),
  foreign key (order_id, org_id) references public.pos_orders(id, org_id) on delete cascade
);
create index on public.portal_submissions (facility_id, status, created_at desc);
create index on public.portal_submissions (order_id);

-- Registro per il limite di frequenza (nessun accesso dai client).
create table public.portal_rate_events (
  id               bigint generated always as identity primary key,
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  service_point_id uuid,
  kind             text not null check (kind in ('ordine','richiesta')),
  created_at       timestamptz not null default now(),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete cascade
);
create index on public.portal_rate_events (facility_id, kind, created_at);
create index on public.portal_rate_events (service_point_id, kind, created_at);

-- ---------------------------------------------------------------------------
-- Aggiunte minime al POS: origine della comanda/riga e stato «da_confermare» delle righe.
-- ---------------------------------------------------------------------------
alter table public.pos_orders add column if not exists source text not null default 'staff' check (source in ('staff','portale'));
alter table public.pos_order_lines add column if not exists source text not null default 'staff' check (source in ('staff','portale'));
alter table public.pos_order_lines add column if not exists portal_submission_id uuid;
alter table public.pos_order_lines add constraint pos_order_lines_portal_submission_fk
  foreign key (portal_submission_id, org_id) references public.portal_submissions(id, org_id) on delete set null (portal_submission_id);
create index if not exists pos_order_lines_portal_submission_idx on public.pos_order_lines (portal_submission_id) where portal_submission_id is not null;

do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.pos_order_lines'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%' and pg_get_constraintdef(oid) like '%inviata%'
  loop
    execute format('alter table public.pos_order_lines drop constraint %I', c);
  end loop;
end $$;
alter table public.pos_order_lines add constraint pos_order_lines_status_check
  check (status in ('da_confermare','inviata','in_preparazione','pronta','servita','annullata'));

-- ---------------------------------------------------------------------------
-- Audit, RLS
-- ---------------------------------------------------------------------------
select app.enable_audit('public.portal_settings');
select app.enable_audit('public.portal_offers');
select app.enable_audit('public.portal_info_blocks');
select app.enable_audit('public.portal_submissions');

alter table public.portal_settings    enable row level security;
alter table public.portal_offers      enable row level security;
alter table public.portal_info_blocks enable row level security;
alter table public.portal_submissions enable row level security;
alter table public.portal_rate_events enable row level security;

create or replace function app.portal_can_read(p_org uuid, p_facility uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_facility_perm(p_org, p_facility, 'portal.manage') or app.has_facility_perm(p_org, p_facility, 'pos.operate')
      or app.has_facility_perm(p_org, p_facility, 'pos.supervise')
$$;

create policy portal_settings_select on public.portal_settings for select to authenticated using (app.portal_can_read(org_id, facility_id));
create policy portal_settings_write  on public.portal_settings for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'portal.manage')) with check (app.has_facility_perm(org_id, facility_id, 'portal.manage'));
create policy portal_offers_select on public.portal_offers for select to authenticated using (app.portal_can_read(org_id, facility_id));
create policy portal_offers_write  on public.portal_offers for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'portal.manage')) with check (app.has_facility_perm(org_id, facility_id, 'portal.manage'));
create policy portal_info_select on public.portal_info_blocks for select to authenticated using (app.portal_can_read(org_id, facility_id));
create policy portal_info_write  on public.portal_info_blocks for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'portal.manage')) with check (app.has_facility_perm(org_id, facility_id, 'portal.manage'));
-- Gli invii si leggono (sala, cassa, chi gestisce il portale) ma si scrivono solo via RPC.
create policy portal_sub_select on public.portal_submissions for select to authenticated using (app.portal_can_read(org_id, facility_id));

revoke all on public.portal_settings, public.portal_offers, public.portal_info_blocks, public.portal_submissions, public.portal_rate_events from anon;
revoke insert, update, delete on public.portal_submissions from authenticated;
revoke all on public.portal_rate_events from authenticated;

-- updated_at
create or replace function app.portal_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger portal_settings_touch before update on public.portal_settings for each row execute function app.portal_touch();

-- ---------------------------------------------------------------------------
-- Supporto interno
-- ---------------------------------------------------------------------------
create or replace function app.portal_check_token(p_token text) returns void
language plpgsql immutable set search_path = pg_catalog as $$
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    raise exception 'Codice QR non valido' using errcode = 'P0002';
  end if;
end $$;

-- Impostazioni effettive (valori di default se la struttura non ha ancora configurato il portale).
create or replace function app.portal_settings_for(p_facility uuid) returns public.portal_settings
language plpgsql stable security definer set search_path = public as $$
declare v public.portal_settings;
begin
  select * into v from public.portal_settings where facility_id = p_facility;
  if not found then
    v.facility_id := p_facility;
    v.enabled := false;
    v.accent := 'turchese';
    v.show_menu := true; v.show_order := true; v.show_booking := true;
    v.show_assistance := true; v.show_offers := true; v.show_info := true;
    v.order_kinds := array['tavolo','ombrellone'];
  end if;
  return v;
end $$;

-- Ordini aperti in questo momento? (ora locale della struttura; fascia anche a cavallo della mezzanotte)
create or replace function app.portal_within_hours(p_from time, p_to time, p_tz text, p_now timestamptz default now()) returns boolean
language sql stable set search_path = pg_catalog as $$
  select case
    when p_from is null or p_to is null then true
    when p_from < p_to then (p_now at time zone p_tz)::time >= p_from and (p_now at time zone p_tz)::time < p_to
    else (p_now at time zone p_tz)::time >= p_from or (p_now at time zone p_tz)::time < p_to
  end
$$;

-- Motivo per cui non si può ordinare da un punto (null = si può).
create or replace function app.portal_order_block(p_settings public.portal_settings, p_point public.service_points, p_tz text) returns text
language sql stable set search_path = public as $$
  select case
    when not coalesce(p_settings.enabled, false) then 'disattivato'
    when p_point.id is null then 'nessun_punto'
    when not p_point.active then 'punto_non_attivo'
    when not (p_settings.show_order and p_settings.show_menu) then 'ordini_disattivati'
    when not (p_point.kind = any(p_settings.order_kinds)) then 'tipo_non_abilitato'
    when not app.portal_within_hours(p_settings.order_from, p_settings.order_to, p_tz) then 'fuori_orario'
    else null
  end
$$;

-- Limite di frequenza: registra l'evento o fallisce. Serializzato per punto (o struttura) con un lock transazionale.
create or replace function app.portal_rate_hit(p_org uuid, p_facility uuid, p_point uuid, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_n int;
  v_max int;
begin
  perform pg_advisory_xact_lock(hashtext('portal_rate:' || coalesce(p_point, p_facility)::text || ':' || p_kind));
  if p_point is not null then
    v_max := 10;
    select count(*) into v_n from public.portal_rate_events
     where service_point_id = p_point and kind = p_kind and created_at > now() - interval '10 minutes';
  else
    v_max := 30; -- QR generico della struttura: condiviso da tutti gli ospiti
    select count(*) into v_n from public.portal_rate_events
     where facility_id = p_facility and service_point_id is null and kind = p_kind and created_at > now() - interval '10 minutes';
  end if;
  if v_n >= v_max then
    raise exception 'Troppe richieste da questo QR: riprova tra qualche minuto o chiedi al personale' using errcode = 'P0001';
  end if;
  insert into public.portal_rate_events (org_id, facility_id, service_point_id, kind) values (p_org, p_facility, p_point, p_kind);
  -- pulizia leggera
  delete from public.portal_rate_events where facility_id = p_facility and created_at < now() - interval '1 day';
end $$;

-- Contenuto pubblico della struttura: solo campi sicuri.
create or replace function app.portal_payload(p_facility uuid, p_point uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_fac public.facilities;
  v_s public.portal_settings;
  v_sp public.service_points;
  v_block text;
  v_today date;
  v_menu jsonb := '[]'::jsonb;
  v_offers jsonb := '[]'::jsonb;
  v_info jsonb := '[]'::jsonb;
begin
  select * into v_fac from public.facilities where id = p_facility;
  v_s := app.portal_settings_for(p_facility);
  if p_point is not null then
    select * into v_sp from public.service_points where id = p_point;
  end if;
  v_block := app.portal_order_block(v_s, v_sp, v_fac.timezone);
  v_today := (now() at time zone v_fac.timezone)::date;

  if v_s.show_menu then
    select coalesce(jsonb_agg(c order by c_sort, c_name), '[]'::jsonb) into v_menu from (
      select coalesce(mc.sort, 9999) as c_sort, coalesce(mc.name, 'Altro') as c_name,
             jsonb_build_object(
               'name', coalesce(mc.name, 'Altro'),
               'items', jsonb_agg(jsonb_build_object(
                  'id', m.id, 'name', m.name, 'description', m.description, 'price', m.price,
                  'allergens', to_jsonb(m.allergens),
                  'sold_out', (not m.available or coalesce(m.portions_left, 1) <= 0))
                 order by m.sort, m.name)) as c
      from public.menu_items m
      left join public.menu_categories mc on mc.id = m.category_id
      where m.facility_id = p_facility and m.active
      group by mc.id, mc.sort, mc.name
    ) x;
  end if;

  if v_s.show_offers then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title_it', o.title_it, 'title_en', o.title_en, 'description_it', o.description_it, 'description_en', o.description_en,
             'price', o.price, 'valid_from', o.valid_from, 'valid_to', o.valid_to) order by o.sort, o.title_it), '[]'::jsonb)
      into v_offers
      from public.portal_offers o
     where o.facility_id = p_facility and o.active
       and (o.valid_to is null or o.valid_to >= v_today);
  end if;

  if v_s.show_info then
    select coalesce(jsonb_agg(jsonb_build_object('title_it', b.title_it, 'title_en', b.title_en, 'body_it', b.body_it, 'body_en', b.body_en)
             order by b.sort, b.title_it), '[]'::jsonb)
      into v_info
      from public.portal_info_blocks b
     where b.facility_id = p_facility and b.active;
  end if;

  return jsonb_build_object(
    'enabled', coalesce(v_s.enabled, false),
    'facility', jsonb_build_object('name', coalesce(v_s.display_name, v_fac.name), 'timezone', v_fac.timezone),
    'point', case when v_sp.id is null then null else jsonb_build_object('kind', v_sp.kind, 'label', v_sp.label, 'zone', v_sp.zone) end,
    'settings', jsonb_build_object(
      'welcome_it', v_s.welcome_it, 'welcome_en', v_s.welcome_en, 'accent', v_s.accent, 'cover_url', v_s.cover_url,
      'hours_it', v_s.hours_it, 'hours_en', v_s.hours_en, 'phone', v_s.phone, 'whatsapp', v_s.whatsapp, 'email', v_s.email,
      'address', v_s.address, 'map_url', v_s.map_url,
      'show_menu', v_s.show_menu, 'show_order', v_s.show_order, 'show_booking', v_s.show_booking,
      'show_assistance', v_s.show_assistance, 'show_offers', v_s.show_offers, 'show_info', v_s.show_info),
    'ordering', jsonb_build_object(
      'allowed', v_block is null, 'reason', v_block,
      'from', to_char(v_s.order_from, 'HH24:MI'), 'to', to_char(v_s.order_to, 'HH24:MI')),
    'menu', v_menu,
    'offers', v_offers,
    'info', v_info);
end $$;

-- ---------------------------------------------------------------------------
-- RPC pubbliche (anon): lettura
-- ---------------------------------------------------------------------------
create or replace function public.public_portal_point(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_sp public.service_points;
begin
  perform app.portal_check_token(p_token);
  select * into v_sp from public.service_points where public_token = p_token;
  if not found then raise exception 'Codice QR non valido' using errcode = 'P0002'; end if;
  return app.portal_payload(v_sp.facility_id, v_sp.id);
end $$;

create or replace function public.public_portal_facility(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_fac uuid;
begin
  perform app.portal_check_token(p_token);
  select id into v_fac from public.facilities where public_token = p_token;
  if v_fac is null then raise exception 'Codice QR non valido' using errcode = 'P0002'; end if;
  return app.portal_payload(v_fac, null);
end $$;

-- ---------------------------------------------------------------------------
-- RPC pubblica: ordine dal punto di servizio
-- p_lines: [{menu_item_id, qty, notes?}] — massimo 30 righe, quantità 1–20.
-- Le righe entrano nella comanda aperta del punto (o in una nuova, origine «portale») come «da_confermare».
-- Restituisce {reference, total, lines}: reference è l'id opaco dell'invio (serve per seguirne lo stato).
-- ---------------------------------------------------------------------------
create or replace function public.public_portal_place_order(p_token text, p_lines jsonb, p_guest_name text default null,
                                                            p_notes text default null, p_allergies text default null, p_lang text default 'it')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sp public.service_points;
  v_fac public.facilities;
  v_s public.portal_settings;
  v_block text;
  v_order uuid;
  v_sub uuid;
  v_l jsonb;
  v_item public.menu_items;
  v_item_id uuid;
  v_qty int;
  v_note text;
  v_allergies text := nullif(trim(p_allergies), '');
  v_name text := nullif(trim(p_guest_name), '');
  v_notes text := nullif(trim(p_notes), '');
  v_total numeric := 0;
  v_n int := 0;
  v_date date;
  v_num int;
begin
  perform app.portal_check_token(p_token);
  select * into v_sp from public.service_points where public_token = p_token;
  if not found then raise exception 'Codice QR non valido' using errcode = 'P0002'; end if;
  select * into v_fac from public.facilities where id = v_sp.facility_id;
  v_s := app.portal_settings_for(v_sp.facility_id);

  v_block := app.portal_order_block(v_s, v_sp, v_fac.timezone);
  if v_block = 'fuori_orario' then
    raise exception 'Gli ordini dal QR sono aperti dalle % alle %', to_char(v_s.order_from, 'HH24:MI'), to_char(v_s.order_to, 'HH24:MI') using errcode = 'P0001';
  elsif v_block is not null then
    raise exception 'Da questo punto non si può ordinare dal QR: chiedi al personale' using errcode = 'P0001';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Il carrello è vuoto' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 30 then raise exception 'Massimo 30 righe per ordine' using errcode = '22023'; end if;
  if v_name is not null and length(v_name) > 60 then raise exception 'Nome troppo lungo (massimo 60 caratteri)' using errcode = '22023'; end if;
  if v_notes is not null and length(v_notes) > 300 then raise exception 'Note troppo lunghe (massimo 300 caratteri)' using errcode = '22023'; end if;
  if v_allergies is not null and length(v_allergies) > 300 then raise exception 'Allergie: massimo 300 caratteri' using errcode = '22023'; end if;
  if coalesce(p_lang, 'it') not in ('it','en') then raise exception 'Lingua non valida' using errcode = '22023'; end if;

  perform app.portal_rate_hit(v_sp.org_id, v_sp.facility_id, v_sp.id, 'ordine');

  -- Comanda del punto: quella aperta oppure una nuova con origine portale (serializzato per punto).
  perform pg_advisory_xact_lock(hashtext('pos_point_order:' || v_sp.id::text));
  select id into v_order from public.pos_orders where service_point_id = v_sp.id and status = 'aperta' for update;
  if v_order is null then
    perform pg_advisory_xact_lock(hashtext('pos_order_number:' || v_fac.id::text));
    v_date := (now() at time zone v_fac.timezone)::date;
    select coalesce(max(number), 0) + 1 into v_num from public.pos_orders where facility_id = v_fac.id and business_date = v_date;
    insert into public.pos_orders (org_id, facility_id, service_point_id, destination_kind, destination_label, business_date, number, covers, source, opened_by)
    values (v_fac.org_id, v_fac.id, v_sp.id, v_sp.kind, initcap(v_sp.kind) || ' ' || v_sp.label, v_date, v_num, 0, 'portale', null)
    returning id into v_order;
  end if;

  insert into public.portal_submissions (org_id, facility_id, service_point_id, order_id, guest_name, notes, allergies, lang)
  values (v_fac.org_id, v_fac.id, v_sp.id, v_order, v_name, v_notes, v_allergies, coalesce(p_lang, 'it'))
  returning id into v_sub;

  for v_l in select * from jsonb_array_elements(p_lines) loop
    begin
      v_item_id := (v_l ->> 'menu_item_id')::uuid;
      v_qty := (v_l ->> 'qty')::int;
    exception when others then
      raise exception 'Riga del carrello non valida' using errcode = '22023';
    end;
    if v_item_id is null then raise exception 'Riga del carrello non valida' using errcode = '22023'; end if;
    if v_qty is null or v_qty < 1 or v_qty > 20 then raise exception 'Quantità non valida (da 1 a 20)' using errcode = '22023'; end if;
    v_note := nullif(trim(v_l ->> 'notes'), '');
    if v_note is not null and length(v_note) > 200 then raise exception 'Nota del piatto troppo lunga (massimo 200 caratteri)' using errcode = '22023'; end if;

    -- Stessa logica di pos_add_lines: porzione scalata in modo atomico, tutto o niente.
    update public.menu_items m
       set portions_left = case when m.portions_left is null then null else m.portions_left - v_qty end
     where m.id = v_item_id and m.facility_id = v_fac.id and m.active and m.available
       and (m.portions_left is null or m.portions_left >= v_qty)
    returning * into v_item;
    if not found then
      select * into v_item from public.menu_items where id = v_item_id and facility_id = v_fac.id;
      if not found or not v_item.active then raise exception 'Piatto non presente nel menu' using errcode = 'P0002'; end if;
      if not v_item.available or v_item.portions_left = 0 then
        raise exception '«%» è esaurito', v_item.name using errcode = 'P0001';
      end if;
      raise exception '«%»: ne restano solo %', v_item.name, v_item.portions_left using errcode = 'P0001';
    end if;

    insert into public.pos_order_lines (org_id, facility_id, order_id, menu_item_id, prep_station_id, name, unit_price, vat_rate, qty, course,
                                        notes, allergy, allergy_note, status, created_by, source, portal_submission_id)
    values (v_fac.org_id, v_fac.id, v_order, v_item.id, v_item.prep_station_id, v_item.name, v_item.price, v_item.vat_rate, v_qty, v_item.course,
            v_note, v_allergies is not null, v_allergies, 'da_confermare', null, 'portale', v_sub);
    v_total := v_total + v_item.price * v_qty;
    v_n := v_n + 1;
  end loop;

  update public.portal_submissions set total = v_total where id = v_sub;
  perform app.pos_recalc(v_order);
  return jsonb_build_object('reference', v_sub, 'total', v_total, 'lines', v_n);
end $$;

-- Stato di un invio (per la pagina di conferma dell'ospite): serve il token del punto e il riferimento.
create or replace function public.public_portal_order_status(p_token text, p_reference uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_sp uuid;
  v_s public.portal_submissions;
begin
  perform app.portal_check_token(p_token);
  select id into v_sp from public.service_points where public_token = p_token;
  if v_sp is null then raise exception 'Codice QR non valido' using errcode = 'P0002'; end if;
  select * into v_s from public.portal_submissions where id = p_reference and service_point_id = v_sp;
  if not found then raise exception 'Ordine non trovato' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'status', v_s.status, 'total', v_s.total, 'created_at', v_s.created_at,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'status',
                     case when l.status = 'annullata' then 'annullata' when l.status = 'da_confermare' then 'da_confermare' else 'confermata' end)
                     order by l.course, l.name), '[]'::jsonb)
              from public.pos_order_lines l where l.portal_submission_id = v_s.id));
end $$;

-- ---------------------------------------------------------------------------
-- RPC pubblica: richiesta di assistenza (dal QR del punto o da quello generico della struttura)
-- ---------------------------------------------------------------------------
create or replace function public.public_portal_request(p_token text, p_category text, p_message text,
                                                        p_guest_name text default null, p_contact text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sp public.service_points;
  v_fac public.facilities;
  v_s public.portal_settings;
  v_msg text := trim(coalesce(p_message, ''));
  v_name text := nullif(trim(p_guest_name), '');
  v_contact text := nullif(trim(p_contact), '');
  v_id uuid;
begin
  perform app.portal_check_token(p_token);
  select * into v_sp from public.service_points where public_token = p_token;
  if found then
    select * into v_fac from public.facilities where id = v_sp.facility_id;
  else
    select * into v_fac from public.facilities where public_token = p_token;
    if not found then raise exception 'Codice QR non valido' using errcode = 'P0002'; end if;
  end if;
  v_s := app.portal_settings_for(v_fac.id);
  if not coalesce(v_s.enabled, false) or not v_s.show_assistance then
    raise exception 'Le richieste dal QR non sono attive: chiedi al personale' using errcode = 'P0001';
  end if;
  if v_sp.id is not null and not v_sp.active then
    raise exception 'Questo punto non è attivo: chiedi al personale' using errcode = 'P0001';
  end if;
  if coalesce(p_category, '') not in ('assistenza','pulizia','manutenzione','room_service','informazioni','reclamo','altro') then
    raise exception 'Categoria non valida' using errcode = '22023';
  end if;
  if length(v_msg) < 3 then raise exception 'Scrivi un messaggio (almeno 3 caratteri)' using errcode = '22023'; end if;
  if length(v_msg) > 1000 then raise exception 'Messaggio troppo lungo (massimo 1000 caratteri)' using errcode = '22023'; end if;
  if v_name is not null and length(v_name) > 60 then raise exception 'Nome troppo lungo (massimo 60 caratteri)' using errcode = '22023'; end if;
  if v_contact is not null and length(v_contact) > 120 then raise exception 'Contatto troppo lungo (massimo 120 caratteri)' using errcode = '22023'; end if;

  perform app.portal_rate_hit(v_fac.org_id, v_fac.id, v_sp.id, 'richiesta');

  insert into public.guest_requests (org_id, facility_id, service_point_id, source, category, message, guest_name, guest_contact, created_by)
  values (v_fac.org_id, v_fac.id, v_sp.id, 'portale', p_category, v_msg, v_name, v_contact, null)
  returning id into v_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- RPC staff: accettare o rifiutare un ordine dal portale (pos.operate)
-- ---------------------------------------------------------------------------
create or replace function public.portal_accept_submission(p_submission uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_s public.portal_submissions;
  v_n int;
begin
  select * into v_s from public.portal_submissions where id = p_submission for update;
  if not found then raise exception 'Ordine non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_s.status <> 'da_confermare' then raise exception 'L''ordine è già stato gestito' using errcode = 'P0001'; end if;
  perform 1 from public.pos_orders where id = v_s.order_id and status = 'aperta' for update;
  if not found then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;
  update public.pos_order_lines
     set status = case when prep_station_id is null then 'pronta' else 'inviata' end,
         sent_at = now(),
         ready_at = case when prep_station_id is null then now() end,
         station_id = app.pos_station(org_id)
   where portal_submission_id = p_submission and status = 'da_confermare';
  get diagnostics v_n = row_count;
  update public.portal_submissions set status = 'accettato', handled_by = auth.uid(), handled_at = now() where id = p_submission;
  perform app.pos_recalc(v_s.order_id);
  return v_n;
end $$;

create or replace function public.portal_reject_submission(p_submission uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_s public.portal_submissions;
  v_o public.pos_orders;
begin
  select * into v_s from public.portal_submissions where id = p_submission for update;
  if not found then raise exception 'Ordine non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_s.status <> 'da_confermare' then raise exception 'L''ordine è già stato gestito' using errcode = 'P0001'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Indica il motivo del rifiuto' using errcode = '22023'; end if;
  if length(trim(p_reason)) > 300 then raise exception 'Motivo troppo lungo (massimo 300 caratteri)' using errcode = '22023'; end if;
  select * into v_o from public.pos_orders where id = v_s.order_id for update;

  -- Le porzioni riservate tornano disponibili.
  update public.menu_items m set portions_left = m.portions_left + x.q
    from (select menu_item_id, sum(qty) q from public.pos_order_lines
           where portal_submission_id = p_submission and status = 'da_confermare' group by menu_item_id) x
   where m.id = x.menu_item_id and m.portions_left is not null;
  update public.pos_order_lines set status = 'annullata', voided_at = now(), voided_by = auth.uid(), void_reason = 'Portale: ' || trim(p_reason)
   where portal_submission_id = p_submission and status = 'da_confermare';
  update public.portal_submissions set status = 'rifiutato', handled_by = auth.uid(), handled_at = now(), reject_reason = trim(p_reason)
   where id = p_submission;

  if v_o.status = 'aperta' then
    perform app.pos_recalc(v_o.id);
    -- Comanda aperta solo dal portale e rimasta senza piatti né pagamenti: si annulla.
    if v_o.source = 'portale'
       and not exists (select 1 from public.pos_order_lines where order_id = v_o.id and status <> 'annullata')
       and not exists (select 1 from public.pos_payments where order_id = v_o.id) then
      update public.pos_orders set status = 'annullata', cancel_reason = 'Ordine dal portale rifiutato', closed_by = auth.uid(), closed_at = now()
       where id = v_o.id;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime: la sala vede subito i nuovi ordini dal portale.
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'portal_submissions') then
      alter publication supabase_realtime add table public.portal_submissions;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Permessi di esecuzione: funzione per funzione (niente revoke globali).
-- ---------------------------------------------------------------------------
revoke execute on function app.portal_can_read(uuid, uuid) from public, anon;
grant  execute on function app.portal_can_read(uuid, uuid) to authenticated;
revoke execute on function app.portal_touch() from public, anon, authenticated;
revoke execute on function app.portal_check_token(text) from public, anon, authenticated;
revoke execute on function app.portal_settings_for(uuid) from public, anon, authenticated;
revoke execute on function app.portal_within_hours(time, time, text, timestamptz) from public, anon, authenticated;
revoke execute on function app.portal_order_block(public.portal_settings, public.service_points, text) from public, anon, authenticated;
revoke execute on function app.portal_rate_hit(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function app.portal_payload(uuid, uuid) from public, anon, authenticated;

revoke execute on function public.portal_accept_submission(uuid) from public, anon;
grant  execute on function public.portal_accept_submission(uuid) to authenticated;
revoke execute on function public.portal_reject_submission(uuid, text) from public, anon;
grant  execute on function public.portal_reject_submission(uuid, text) to authenticated;

revoke execute on function public.public_portal_point(text) from public, anon;
revoke execute on function public.public_portal_facility(text) from public, anon;
revoke execute on function public.public_portal_place_order(text, jsonb, text, text, text, text) from public, anon;
revoke execute on function public.public_portal_order_status(text, uuid) from public, anon;
revoke execute on function public.public_portal_request(text, text, text, text, text) from public, anon;
grant execute on function public.public_portal_point(text) to authenticated;
grant execute on function public.public_portal_facility(text) to authenticated;
grant execute on function public.public_portal_place_order(text, jsonb, text, text, text, text) to authenticated;
grant execute on function public.public_portal_order_status(text, uuid) to authenticated;
grant execute on function public.public_portal_request(text, text, text, text, text) to authenticated;

-- Il pubblico (QR) può chiamare SOLO le funzioni public_portal_*.
grant execute on function public.public_portal_point(text) to anon;
grant execute on function public.public_portal_facility(text) to anon;
grant execute on function public.public_portal_place_order(text, jsonb, text, text, text, text) to anon;
grant execute on function public.public_portal_order_status(text, uuid) to anon;
grant execute on function public.public_portal_request(text, text, text, text, text) to anon;
