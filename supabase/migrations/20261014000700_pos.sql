-- Ordivia v2 — Sala, cassa, comande, KDS e pass.
-- Comande su qualsiasi punto di servizio (tavolo, ombrellone, camera…) o al banco/asporto; righe instradate al
-- centro di produzione; stati con orari; conto con sconti, divisione e pagamenti; turni di cassa; scarico
-- automatico del magazzino dalle ricette alla chiusura.
-- Ordivia NON è un registratore telematico: ogni pagamento nasce «da_fiscalizzare» e lo scontrino si emette
-- dal registratore telematico della struttura.
--
-- Tutte le scritture passano da RPC (security definer) che ricontrollano i permessi: i client hanno solo SELECT.

-- ---------------------------------------------------------------------------
-- Supporto
-- ---------------------------------------------------------------------------

-- Postazione condivisa da cui arriva la richiesta, solo se esiste nella stessa organizzazione.
create or replace function app.pos_station(p_org uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select s.id from public.stations s where s.id = app.current_station() and s.org_id = p_org
$$;

-- ---------------------------------------------------------------------------
-- Turni di cassa
-- ---------------------------------------------------------------------------
create table public.pos_cash_sessions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  facility_id    uuid not null,
  station_id     uuid,
  status         text not null default 'aperta' check (status in ('aperta','chiusa')),
  opening_float  numeric(10,2) not null default 0 check (opening_float >= 0),
  opened_by      uuid default auth.uid(),
  opened_at      timestamptz not null default now(),
  expected_cash  numeric(10,2),
  counted_cash   numeric(10,2) check (counted_cash is null or counted_cash >= 0),
  difference     numeric(10,2),
  closed_by      uuid,
  closed_at      timestamptz,
  note           text check (note is null or length(note) <= 1000),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (station_id, org_id) references public.stations(id, org_id) on delete set null (station_id)
);
-- Un solo turno aperto per struttura (una cassa per struttura in questa versione).
create unique index pos_cash_sessions_one_open on public.pos_cash_sessions (facility_id) where status = 'aperta';
create index on public.pos_cash_sessions (org_id, facility_id, opened_at desc);

-- ---------------------------------------------------------------------------
-- Comande
-- ---------------------------------------------------------------------------
create table public.pos_orders (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  facility_id       uuid not null,
  service_point_id  uuid,
  destination_kind  text not null check (destination_kind in ('tavolo','ombrellone','lettino','cabina','gazebo','camera','piazzola','piscina','ritiro','altro','asporto','banco')),
  destination_label text not null,
  business_date     date not null,
  number            int not null,
  covers            smallint not null default 0 check (covers between 0 and 500),
  status            text not null default 'aperta' check (status in ('aperta','chiusa','annullata')),
  note              text check (note is null or length(note) <= 500),
  -- conto (calcolato da pos_recalc, IVA inclusa)
  subtotal          numeric(10,2) not null default 0,
  discount_kind     text check (discount_kind in ('percentuale','importo')),
  discount_value    numeric(10,2),
  discount_amount   numeric(10,2) not null default 0,
  discount_reason   text,
  discount_by       uuid,
  total             numeric(10,2) not null default 0,
  paid              numeric(10,2) not null default 0,
  opened_by         uuid default auth.uid(),
  opened_at         timestamptz not null default now(),
  closed_by         uuid,
  closed_at         timestamptz,
  cancel_reason     text,
  station_id        uuid,
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete set null (service_point_id),
  foreign key (station_id, org_id) references public.stations(id, org_id) on delete set null (station_id)
);
-- Un punto di servizio ha al massimo una comanda aperta.
create unique index pos_orders_one_open_per_point on public.pos_orders (service_point_id) where status = 'aperta' and service_point_id is not null;
create index on public.pos_orders (org_id, facility_id, status);
create index on public.pos_orders (facility_id, business_date);

create table public.pos_order_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  order_id         uuid not null,
  menu_item_id     uuid,
  prep_station_id  uuid,
  name             text not null,                         -- fotografia al momento della comanda
  unit_price       numeric(10,2) not null check (unit_price >= 0),
  vat_rate         numeric(5,2) not null,
  qty              int not null check (qty between 1 and 99),
  course           smallint not null default 1 check (course between 1 and 9),
  notes            text check (notes is null or length(notes) <= 300),
  without          text[] not null default '{}',          -- «senza X»
  allergy          boolean not null default false,
  allergy_note     text check (allergy_note is null or length(allergy_note) <= 300),
  status           text not null default 'inviata' check (status in ('inviata','in_preparazione','pronta','servita','annullata')),
  sent_at          timestamptz not null default now(),
  started_at       timestamptz,
  ready_at         timestamptz,
  served_at        timestamptz,
  voided_at        timestamptz,
  voided_by        uuid,
  void_reason      text,
  paid_payment_id  uuid,                                   -- pagata «per piatti»
  created_by       uuid default auth.uid(),
  station_id       uuid,
  unique (id, org_id),
  foreign key (order_id, org_id) references public.pos_orders(id, org_id) on delete cascade,
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (menu_item_id, org_id) references public.menu_items(id, org_id) on delete set null (menu_item_id),
  foreign key (prep_station_id, org_id) references public.prep_stations(id, org_id) on delete set null (prep_station_id),
  foreign key (station_id, org_id) references public.stations(id, org_id) on delete set null (station_id)
);
create index on public.pos_order_lines (order_id);
create index on public.pos_order_lines (facility_id, prep_station_id, status) where status in ('inviata','in_preparazione','pronta');

create table public.pos_payments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  order_id         uuid not null,
  cash_session_id  uuid,
  method           text not null check (method in ('contanti','carta','altro')),
  amount           numeric(10,2) not null check (amount > 0),
  tendered         numeric(10,2),
  change_given     numeric(10,2) not null default 0 check (change_given >= 0),
  split_label      text check (split_label is null or length(split_label) <= 80),
  -- Ordivia non fiscalizza: lo scontrino si emette dal registratore telematico.
  fiscal_status    text not null default 'da_fiscalizzare' check (fiscal_status in ('da_fiscalizzare','fiscalizzato')),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  station_id       uuid,
  unique (id, org_id),
  foreign key (order_id, org_id) references public.pos_orders(id, org_id) on delete cascade,
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (cash_session_id, org_id) references public.pos_cash_sessions(id, org_id),
  foreign key (station_id, org_id) references public.stations(id, org_id) on delete set null (station_id)
);
create index on public.pos_payments (order_id);
create index on public.pos_payments (cash_session_id);

alter table public.pos_order_lines add foreign key (paid_payment_id, org_id) references public.pos_payments(id, org_id);

-- ---------------------------------------------------------------------------
-- Audit, RLS, permessi di colonna
-- ---------------------------------------------------------------------------
select app.enable_audit('public.pos_orders');
select app.enable_audit('public.pos_order_lines');
select app.enable_audit('public.pos_payments');
select app.enable_audit('public.pos_cash_sessions');

alter table public.pos_orders        enable row level security;
alter table public.pos_order_lines   enable row level security;
alter table public.pos_payments      enable row level security;
alter table public.pos_cash_sessions enable row level security;

create policy pos_o_select on public.pos_orders for select to authenticated using (
  app.has_facility_perm(org_id, facility_id, 'pos.operate') or app.has_facility_perm(org_id, facility_id, 'pos.kitchen')
  or app.has_facility_perm(org_id, facility_id, 'pos.supervise'));
create policy pos_ol_select on public.pos_order_lines for select to authenticated using (
  app.has_facility_perm(org_id, facility_id, 'pos.operate') or app.has_facility_perm(org_id, facility_id, 'pos.kitchen')
  or app.has_facility_perm(org_id, facility_id, 'pos.supervise'));
create policy pos_p_select on public.pos_payments for select to authenticated using (
  app.has_facility_perm(org_id, facility_id, 'pos.operate') or app.has_facility_perm(org_id, facility_id, 'pos.supervise'));
create policy pos_cs_select on public.pos_cash_sessions for select to authenticated using (
  app.has_facility_perm(org_id, facility_id, 'pos.operate') or app.has_facility_perm(org_id, facility_id, 'pos.supervise'));
-- Nessuna policy di scrittura: solo RPC.
revoke insert, update, delete on public.pos_orders, public.pos_order_lines, public.pos_payments, public.pos_cash_sessions from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Ricalcolo del conto (interno)
-- ---------------------------------------------------------------------------
create or replace function app.pos_recalc(p_order uuid) returns public.pos_orders
language plpgsql security definer set search_path = public as $$
declare
  v_o public.pos_orders;
  v_sub numeric;
  v_disc numeric := 0;
begin
  select * into v_o from public.pos_orders where id = p_order for update;
  select coalesce(sum(unit_price * qty), 0) into v_sub from public.pos_order_lines where order_id = p_order and status <> 'annullata';
  if v_o.discount_kind = 'percentuale' then
    v_disc := round(v_sub * least(v_o.discount_value, 100) / 100, 2);
  elsif v_o.discount_kind = 'importo' then
    v_disc := least(v_o.discount_value, v_sub);
  end if;
  update public.pos_orders set subtotal = v_sub, discount_amount = v_disc, total = v_sub - v_disc,
         paid = (select coalesce(sum(amount), 0) from public.pos_payments where order_id = p_order)
   where id = p_order returning * into v_o;
  return v_o;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: punti di servizio in blocco (es. Sala 1–20, Terrazza T1–T8)
-- ---------------------------------------------------------------------------
create or replace function public.pos_create_service_points(p_facility uuid, p_kind text, p_labels text[], p_zone text default null, p_seats int default null)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_n int;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not (app.has_facility_perm(v_org, p_facility, 'pos.supervise') or app.has_facility_perm(v_org, p_facility, 'menu.manage')
          or app.has_facility_perm(v_org, p_facility, 'org.manage')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if p_kind not in ('tavolo','ritiro','piscina','camera','altro','gazebo','piazzola') then
    raise exception 'Tipo di punto non gestibile dalla sala' using errcode = '22023';
  end if;
  if coalesce(array_length(p_labels, 1), 0) = 0 or array_length(p_labels, 1) > 200 then
    raise exception 'Indica da 1 a 200 etichette' using errcode = '22023';
  end if;
  if p_seats is not null and (p_seats < 0 or p_seats > 500) then raise exception 'Coperti non validi' using errcode = '22023'; end if;
  insert into public.service_points (org_id, facility_id, kind, label, zone, seats)
  select v_org, p_facility, p_kind, trim(l), nullif(trim(p_zone), ''), p_seats
  from unnest(p_labels) l
  where length(trim(l)) between 1 and 40
  on conflict (facility_id, kind, label) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Attiva / disattiva un punto di servizio della sala (senza toccare quelli della spiaggia).
create or replace function public.pos_set_service_point_active(p_point uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_sp public.service_points;
begin
  select * into v_sp from public.service_points where id = p_point;
  if not found then raise exception 'Punto di servizio non trovato' using errcode = 'P0002'; end if;
  if not (app.has_facility_perm(v_sp.org_id, v_sp.facility_id, 'pos.supervise') or app.has_facility_perm(v_sp.org_id, v_sp.facility_id, 'menu.manage')
          or app.has_facility_perm(v_sp.org_id, v_sp.facility_id, 'org.manage')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if not p_active and exists (select 1 from public.pos_orders where service_point_id = p_point and status = 'aperta') then
    raise exception 'C''è una comanda aperta su questo punto' using errcode = 'P0001';
  end if;
  update public.service_points set active = p_active where id = p_point;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: apertura comanda
-- Con un punto di servizio che ha già una comanda aperta restituisce quella (doppio tocco dal palmare).
-- ---------------------------------------------------------------------------
create or replace function public.pos_open_order(p_facility uuid, p_service_point uuid, p_kind text default null, p_covers int default 0, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_fac public.facilities;
  v_sp public.service_points;
  v_kind text;
  v_label text;
  v_id uuid;
  v_date date;
  v_num int;
begin
  select * into v_fac from public.facilities where id = p_facility;
  if not found then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_fac.org_id, p_facility, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if p_covers is null or p_covers < 0 or p_covers > 500 then raise exception 'Coperti non validi' using errcode = '22023'; end if;

  if p_service_point is not null then
    select * into v_sp from public.service_points where id = p_service_point and facility_id = p_facility;
    if not found then raise exception 'Punto di servizio non trovato' using errcode = 'P0002'; end if;
    if not v_sp.active then raise exception 'Punto di servizio non attivo' using errcode = 'P0001'; end if;
    select id into v_id from public.pos_orders where service_point_id = p_service_point and status = 'aperta';
    if found then return v_id; end if;
    v_kind := v_sp.kind;
    v_label := initcap(v_sp.kind) || ' ' || v_sp.label;
  else
    v_kind := coalesce(p_kind, 'banco');
    if v_kind not in ('asporto','banco') then raise exception 'Senza punto di servizio la comanda è al banco o da asporto' using errcode = '22023'; end if;
    v_label := initcap(v_kind);
  end if;

  perform pg_advisory_xact_lock(hashtext('pos_order_number:' || p_facility::text));
  v_date := (now() at time zone v_fac.timezone)::date;
  select coalesce(max(number), 0) + 1 into v_num from public.pos_orders where facility_id = p_facility and business_date = v_date;
  if p_service_point is null then v_label := v_label || ' #' || v_num; end if;

  insert into public.pos_orders (org_id, facility_id, service_point_id, destination_kind, destination_label, business_date, number, covers, note, station_id)
  values (v_fac.org_id, p_facility, p_service_point, v_kind, v_label, v_date, v_num, p_covers, nullif(trim(p_note), ''), app.pos_station(v_fac.org_id))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.pos_update_order(p_order uuid, p_covers int, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_o public.pos_orders;
begin
  select * into v_o from public.pos_orders where id = p_order for update;
  if not found then raise exception 'Comanda non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_o.status <> 'aperta' then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;
  if p_covers is null or p_covers < 0 or p_covers > 500 then raise exception 'Coperti non validi' using errcode = '22023'; end if;
  update public.pos_orders set covers = p_covers, note = nullif(trim(p_note), '') where id = p_order;
end $$;

-- Sposta la comanda su un altro punto di servizio libero (cambio tavolo).
create or replace function public.pos_move_order(p_order uuid, p_service_point uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_o public.pos_orders;
  v_sp public.service_points;
begin
  select * into v_o from public.pos_orders where id = p_order for update;
  if not found then raise exception 'Comanda non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_o.status <> 'aperta' then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;
  select * into v_sp from public.service_points where id = p_service_point and facility_id = v_o.facility_id and active;
  if not found then raise exception 'Punto di servizio non trovato' using errcode = 'P0002'; end if;
  if exists (select 1 from public.pos_orders where service_point_id = p_service_point and status = 'aperta') then
    raise exception 'Il punto di destinazione ha già una comanda aperta' using errcode = 'P0001';
  end if;
  update public.pos_orders set service_point_id = p_service_point, destination_kind = v_sp.kind,
         destination_label = initcap(v_sp.kind) || ' ' || v_sp.label where id = p_order;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: aggiunta righe e invio in produzione
-- p_lines: [{menu_item_id, qty, course?, notes?, without?: [..], allergy?: bool, allergy_note?}]
-- Le porzioni disponibili si scalano in modo atomico: con portions_left insufficiente la comanda intera fallisce.
-- ---------------------------------------------------------------------------
create or replace function public.pos_add_lines(p_order uuid, p_lines jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_o public.pos_orders;
  v_l jsonb;
  v_item public.menu_items;
  v_qty int;
  v_course int;
  v_without text[];
  v_allergy_note text;
  v_n int := 0;
  v_station uuid;
begin
  select * into v_o from public.pos_orders where id = p_order for update;
  if not found then raise exception 'Comanda non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_o.status <> 'aperta' then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Nessun piatto da inviare' using errcode = '22023'; end if;
  if jsonb_array_length(p_lines) > 100 then raise exception 'Troppe righe in un invio' using errcode = '22023'; end if;
  v_station := app.pos_station(v_o.org_id);

  for v_l in select * from jsonb_array_elements(p_lines) loop
    begin
      v_qty := (v_l ->> 'qty')::int;
    exception when others then
      raise exception 'Quantità non valida' using errcode = '22023';
    end;
    if v_qty is null or v_qty < 1 or v_qty > 99 then raise exception 'Quantità non valida' using errcode = '22023'; end if;

    -- Blocco atomico della porzione: l'update fallisce (0 righe) se non ce ne sono abbastanza.
    update public.menu_items m
       set portions_left = case when m.portions_left is null then null else m.portions_left - v_qty end
     where m.id = (v_l ->> 'menu_item_id')::uuid
       and m.facility_id = v_o.facility_id and m.active and m.available
       and (m.portions_left is null or m.portions_left >= v_qty)
    returning * into v_item;
    if not found then
      select * into v_item from public.menu_items where id = (v_l ->> 'menu_item_id')::uuid and facility_id = v_o.facility_id;
      if not found or not v_item.active then raise exception 'Piatto non trovato nel menu' using errcode = 'P0002'; end if;
      if not v_item.available or v_item.portions_left = 0 then
        raise exception '«%» è esaurito', v_item.name using errcode = 'P0001';
      end if;
      raise exception '«%»: restano solo % porzioni', v_item.name, v_item.portions_left using errcode = 'P0001';
    end if;

    v_course := coalesce((v_l ->> 'course')::int, v_item.course);
    if v_course < 1 or v_course > 9 then raise exception 'Uscita non valida' using errcode = '22023'; end if;
    v_without := coalesce(array(select trim(x) from jsonb_array_elements_text(coalesce(v_l -> 'without', '[]'::jsonb)) x where trim(x) <> ''), '{}');
    v_allergy_note := nullif(trim(v_l ->> 'allergy_note'), '');

    insert into public.pos_order_lines (org_id, facility_id, order_id, menu_item_id, prep_station_id, name, unit_price, vat_rate, qty, course,
                                        notes, without, allergy, allergy_note, station_id, status, ready_at)
    values (v_o.org_id, v_o.facility_id, p_order, v_item.id, v_item.prep_station_id, v_item.name, v_item.price, v_item.vat_rate, v_qty, v_course,
            nullif(trim(v_l ->> 'notes'), ''), v_without,
            coalesce((v_l ->> 'allergy')::boolean, false) or v_allergy_note is not null, v_allergy_note, v_station,
            -- senza centro di produzione (es. acqua al banco) la riga è subito pronta da servire
            case when v_item.prep_station_id is null then 'pronta' else 'inviata' end,
            case when v_item.prep_station_id is null then now() end);
    v_n := v_n + 1;
  end loop;

  perform app.pos_recalc(p_order);
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: stato delle righe (KDS, pass, sala)
-- inviata → in_preparazione → pronta → servita; un passo indietro per correggere un tocco sbagliato;
-- annullata solo con pos.supervise e motivo.
-- ---------------------------------------------------------------------------
create or replace function public.pos_set_line_status(p_line uuid, p_to text, p_reason text default null)
returns public.pos_order_lines
language plpgsql security definer set search_path = public as $$
declare
  v_l public.pos_order_lines;
  v_o public.pos_orders;
  v_kitchen boolean;
begin
  select * into v_l from public.pos_order_lines where id = p_line for update;
  if not found then raise exception 'Riga non trovata' using errcode = 'P0002'; end if;
  v_kitchen := app.has_facility_perm(v_l.org_id, v_l.facility_id, 'pos.kitchen');

  if v_l.status in ('servita','annullata') and p_to <> 'annullata' then
    raise exception 'La riga è già %', v_l.status using errcode = 'P0001';
  end if;

  if p_to = 'in_preparazione' then
    if not v_kitchen then raise exception 'Permesso negato' using errcode = '42501'; end if;
    if v_l.status = 'inviata' then
      update public.pos_order_lines set status = p_to, started_at = now() where id = p_line returning * into v_l;
    elsif v_l.status = 'pronta' then -- correzione
      update public.pos_order_lines set status = p_to, ready_at = null where id = p_line returning * into v_l;
    else
      raise exception 'Passaggio non consentito' using errcode = 'P0001';
    end if;
  elsif p_to = 'inviata' then
    if not v_kitchen then raise exception 'Permesso negato' using errcode = '42501'; end if;
    if v_l.status <> 'in_preparazione' then raise exception 'Passaggio non consentito' using errcode = 'P0001'; end if;
    update public.pos_order_lines set status = p_to, started_at = null where id = p_line returning * into v_l;
  elsif p_to = 'pronta' then
    if not v_kitchen then raise exception 'Permesso negato' using errcode = '42501'; end if;
    if v_l.status not in ('inviata','in_preparazione') then raise exception 'Passaggio non consentito' using errcode = 'P0001'; end if;
    update public.pos_order_lines set status = p_to, started_at = coalesce(started_at, now()), ready_at = now() where id = p_line returning * into v_l;
  elsif p_to = 'servita' then
    if not (v_kitchen or app.has_facility_perm(v_l.org_id, v_l.facility_id, 'pos.operate')) then raise exception 'Permesso negato' using errcode = '42501'; end if;
    update public.pos_order_lines set status = p_to, served_at = now() where id = p_line returning * into v_l;
  elsif p_to = 'annullata' then
    if not app.has_facility_perm(v_l.org_id, v_l.facility_id, 'pos.supervise') then
      raise exception 'Solo un responsabile può annullare una riga' using errcode = '42501';
    end if;
    if v_l.status = 'annullata' then raise exception 'La riga è già annullata' using errcode = 'P0001'; end if;
    if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Indica il motivo dell''annullamento' using errcode = '22023'; end if;
    if v_l.paid_payment_id is not null then raise exception 'La riga è già stata pagata' using errcode = 'P0001'; end if;
    select * into v_o from public.pos_orders where id = v_l.order_id for update;
    if v_o.status <> 'aperta' then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;
    -- Piatto non ancora iniziato: la porzione torna disponibile.
    if v_l.status = 'inviata' and v_l.menu_item_id is not null then
      update public.menu_items set portions_left = portions_left + v_l.qty where id = v_l.menu_item_id and portions_left is not null;
    end if;
    update public.pos_order_lines set status = 'annullata', voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
     where id = p_line returning * into v_l;
    v_o := app.pos_recalc(v_l.order_id);
    if v_o.total < v_o.paid then
      raise exception 'Il conto scenderebbe sotto quanto già incassato' using errcode = 'P0001';
    end if;
  else
    raise exception 'Stato non valido' using errcode = '22023';
  end if;
  return v_l;
end $$;

-- Più righe insieme (incastri, «servi tutto»): stessa logica, tutto o niente.
create or replace function public.pos_set_lines_status(p_lines uuid[], p_to text) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_n int := 0;
begin
  if p_to = 'annullata' then raise exception 'Gli annullamenti si fanno riga per riga, con il motivo' using errcode = '22023'; end if;
  foreach v_id in array coalesce(p_lines, '{}') loop
    perform public.pos_set_line_status(v_id, p_to);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: disponibilità in servizio (cucina o chi gestisce il menu)
-- p_portions_left null = senza limite di porzioni.
-- ---------------------------------------------------------------------------
create or replace function public.set_item_availability(p_item uuid, p_available boolean, p_portions_left int default null)
returns public.menu_items
language plpgsql security definer set search_path = public as $$
declare v_m public.menu_items;
begin
  select * into v_m from public.menu_items where id = p_item for update;
  if not found then raise exception 'Piatto non trovato' using errcode = 'P0002'; end if;
  if not (app.has_facility_perm(v_m.org_id, v_m.facility_id, 'pos.kitchen') or app.has_facility_perm(v_m.org_id, v_m.facility_id, 'menu.manage')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if p_portions_left is not null and (p_portions_left < 0 or p_portions_left > 10000) then
    raise exception 'Porzioni non valide' using errcode = '22023';
  end if;
  update public.menu_items set available = coalesce(p_available, available), portions_left = p_portions_left
   where id = p_item returning * into v_m;
  return v_m;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: sconto sul conto (pos.supervise, con motivo). p_kind null o valore 0 = togli sconto.
-- ---------------------------------------------------------------------------
create or replace function public.pos_set_discount(p_order uuid, p_kind text, p_value numeric, p_reason text)
returns public.pos_orders
language plpgsql security definer set search_path = public as $$
declare v_o public.pos_orders;
begin
  select * into v_o from public.pos_orders where id = p_order for update;
  if not found then raise exception 'Comanda non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.supervise') then
    raise exception 'Solo un responsabile può applicare sconti' using errcode = '42501';
  end if;
  if v_o.status <> 'aperta' then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;

  if p_kind is null or coalesce(p_value, 0) = 0 then
    update public.pos_orders set discount_kind = null, discount_value = null, discount_reason = null, discount_by = auth.uid() where id = p_order;
  else
    if p_kind not in ('percentuale','importo') then raise exception 'Tipo di sconto non valido' using errcode = '22023'; end if;
    if p_value < 0 or (p_kind = 'percentuale' and p_value > 100) then raise exception 'Valore dello sconto non valido' using errcode = '22023'; end if;
    if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Indica il motivo dello sconto' using errcode = '22023'; end if;
    update public.pos_orders set discount_kind = p_kind, discount_value = p_value, discount_reason = trim(p_reason), discount_by = auth.uid() where id = p_order;
  end if;
  v_o := app.pos_recalc(p_order);
  if v_o.total < v_o.paid then raise exception 'Il conto scenderebbe sotto quanto già incassato' using errcode = 'P0001'; end if;
  return v_o;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: pagamenti
-- Con p_line_ids si pagano quei piatti (importo calcolato qui, sconto incluso in proporzione);
-- altrimenti si paga p_amount (es. una quota alla romana). Mai oltre il residuo.
-- I contanti richiedono un turno di cassa aperto; il resto è calcolato dal contante ricevuto.
-- ---------------------------------------------------------------------------
create or replace function public.pos_add_payment(p_order uuid, p_method text, p_amount numeric default null, p_tendered numeric default null,
                                                  p_line_ids uuid[] default null, p_label text default null)
returns public.pos_payments
language plpgsql security definer set search_path = public as $$
declare
  v_o public.pos_orders;
  v_sess uuid;
  v_amount numeric;
  v_sel numeric;
  v_cnt int;
  v_remaining numeric;
  v_p public.pos_payments;
begin
  select * into v_o from public.pos_orders where id = p_order for update;
  if not found then raise exception 'Comanda non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_o.status <> 'aperta' then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;
  if p_method not in ('contanti','carta','altro') then raise exception 'Metodo di pagamento non valido' using errcode = '22023'; end if;
  v_o := app.pos_recalc(p_order);
  v_remaining := v_o.total - v_o.paid;
  if v_remaining <= 0 then raise exception 'Il conto è già saldato' using errcode = 'P0001'; end if;

  if p_line_ids is not null and array_length(p_line_ids, 1) > 0 then
    select count(*), coalesce(sum(unit_price * qty), 0) into v_cnt, v_sel
      from public.pos_order_lines
     where id = any(p_line_ids) and order_id = p_order and status <> 'annullata' and paid_payment_id is null;
    if v_cnt <> (select count(distinct x) from unnest(p_line_ids) x) then
      raise exception 'Alcuni piatti non sono di questa comanda o sono già pagati' using errcode = 'P0001';
    end if;
    v_amount := least(round(v_sel * v_o.total / nullif(v_o.subtotal, 0), 2), v_remaining);
  else
    v_amount := round(p_amount, 2);
  end if;
  if v_amount is null or v_amount <= 0 then raise exception 'Importo non valido' using errcode = '22023'; end if;
  if v_amount > v_remaining then raise exception 'L''importo supera il residuo da pagare (% €)', v_remaining using errcode = 'P0001'; end if;

  select id into v_sess from public.pos_cash_sessions where facility_id = v_o.facility_id and status = 'aperta';
  if p_method = 'contanti' then
    if v_sess is null then raise exception 'Apri il turno di cassa prima di incassare contanti' using errcode = 'P0001'; end if;
    if p_tendered is not null and p_tendered < v_amount then raise exception 'Il contante ricevuto non basta' using errcode = '22023'; end if;
  end if;

  insert into public.pos_payments (org_id, facility_id, order_id, cash_session_id, method, amount, tendered, change_given, split_label, station_id)
  values (v_o.org_id, v_o.facility_id, p_order, v_sess, p_method, v_amount,
          case when p_method = 'contanti' then coalesce(p_tendered, v_amount) end,
          case when p_method = 'contanti' then coalesce(p_tendered, v_amount) - v_amount else 0 end,
          nullif(trim(p_label), ''), app.pos_station(v_o.org_id))
  returning * into v_p;

  if p_line_ids is not null then
    update public.pos_order_lines set paid_payment_id = v_p.id where id = any(p_line_ids) and order_id = p_order;
  end if;
  perform app.pos_recalc(p_order);
  return v_p;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: chiusura comanda — richiede il conto saldato; scarica il magazzino dalle ricette.
-- Quantità = riga ricetta × porzioni vendute / resa, maggiorata dello scarto; nel magazzino del centro di produzione.
-- Righe senza ricetta o senza magazzino: nessuno scarico.
-- ---------------------------------------------------------------------------
create or replace function public.pos_close_order(p_order uuid) returns public.pos_orders
language plpgsql security definer set search_path = public as $$
declare
  v_o public.pos_orders;
begin
  select * into v_o from public.pos_orders where id = p_order for update;
  if not found then raise exception 'Comanda non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_o.status <> 'aperta' then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;
  v_o := app.pos_recalc(p_order);
  if v_o.paid < v_o.total then
    raise exception 'Mancano % € per saldare il conto', v_o.total - v_o.paid using errcode = 'P0001';
  end if;
  if v_o.total = 0 and not exists (select 1 from public.pos_order_lines where order_id = p_order and status <> 'annullata') then
    raise exception 'La comanda è vuota: annullala invece di chiuderla' using errcode = 'P0001';
  end if;

  insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, ref_type, ref_id, note, created_by)
  select v_o.org_id, v_o.facility_id, s.warehouse_id, s.product_id, round(s.qty, 3), 'scarico', 'sale', v_o.id,
         'Vendita ' || v_o.destination_label, auth.uid()
  from (
    select ps.warehouse_id, r.product_id,
           sum(r.qty * l.qty / m.yield_portions / (1 - r.waste_pct / 100)) as qty
    from public.pos_order_lines l
    join public.menu_items m on m.id = l.menu_item_id
    join public.recipe_lines r on r.menu_item_id = m.id
    join public.prep_stations ps on ps.id = l.prep_station_id
    where l.order_id = p_order and l.status <> 'annullata' and ps.warehouse_id is not null
    group by ps.warehouse_id, r.product_id
  ) s
  where round(s.qty, 3) > 0;

  update public.pos_orders set status = 'chiusa', closed_by = auth.uid(), closed_at = now() where id = p_order returning * into v_o;
  return v_o;
end $$;

-- Annulla una comanda senza pagamenti: vuota → basta pos.operate; con righe → pos.supervise e motivo.
create or replace function public.pos_cancel_order(p_order uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_o public.pos_orders;
  v_has_lines boolean;
begin
  select * into v_o from public.pos_orders where id = p_order for update;
  if not found then raise exception 'Comanda non trovata' using errcode = 'P0002'; end if;
  if v_o.status <> 'aperta' then raise exception 'La comanda è già chiusa' using errcode = 'P0001'; end if;
  if exists (select 1 from public.pos_payments where order_id = p_order) then
    raise exception 'La comanda ha già pagamenti: non si può annullare' using errcode = 'P0001';
  end if;
  v_has_lines := exists (select 1 from public.pos_order_lines where order_id = p_order and status <> 'annullata');
  if v_has_lines then
    if not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.supervise') then
      raise exception 'Solo un responsabile può annullare una comanda con piatti' using errcode = '42501';
    end if;
    if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Indica il motivo dell''annullamento' using errcode = '22023'; end if;
    update public.menu_items m set portions_left = m.portions_left + x.q
      from (select menu_item_id, sum(qty) q from public.pos_order_lines where order_id = p_order and status = 'inviata' group by menu_item_id) x
     where m.id = x.menu_item_id and m.portions_left is not null;
    update public.pos_order_lines set status = 'annullata', voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
     where order_id = p_order and status <> 'annullata';
  elsif not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.operate') then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  update public.pos_orders set status = 'annullata', cancel_reason = nullif(trim(p_reason), ''), closed_by = auth.uid(), closed_at = now() where id = p_order;
  perform app.pos_recalc(p_order);
end $$;

-- ---------------------------------------------------------------------------
-- RPC: turni di cassa
-- ---------------------------------------------------------------------------
create or replace function public.pos_open_cash_session(p_facility uuid, p_float numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_org, p_facility, 'pos.supervise') then raise exception 'Solo un responsabile può aprire la cassa' using errcode = '42501'; end if;
  if p_float is null or p_float < 0 or p_float > 100000 then raise exception 'Fondo cassa non valido' using errcode = '22023'; end if;
  if exists (select 1 from public.pos_cash_sessions where facility_id = p_facility and status = 'aperta') then
    raise exception 'C''è già un turno di cassa aperto' using errcode = 'P0001';
  end if;
  insert into public.pos_cash_sessions (org_id, facility_id, station_id, opening_float)
  values (v_org, p_facility, app.pos_station(v_org), round(p_float, 2)) returning id into v_id;
  return v_id;
end $$;

-- Contanti attesi = fondo + incassi in contanti del turno (il resto dato è già escluso dall'importo).
create or replace function public.pos_close_cash_session(p_session uuid, p_counted numeric, p_note text default null)
returns public.pos_cash_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_s public.pos_cash_sessions;
  v_expected numeric;
begin
  select * into v_s from public.pos_cash_sessions where id = p_session for update;
  if not found then raise exception 'Turno di cassa non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'pos.supervise') then raise exception 'Solo un responsabile può chiudere la cassa' using errcode = '42501'; end if;
  if v_s.status <> 'aperta' then raise exception 'Il turno è già chiuso' using errcode = 'P0001'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'Contante contato non valido' using errcode = '22023'; end if;
  select v_s.opening_float + coalesce(sum(amount), 0) into v_expected
    from public.pos_payments where cash_session_id = p_session and method = 'contanti';
  update public.pos_cash_sessions
     set status = 'chiusa', expected_cash = v_expected, counted_cash = round(p_counted, 2), difference = round(p_counted, 2) - v_expected,
         closed_by = auth.uid(), closed_at = now(), note = nullif(trim(p_note), '')
   where id = p_session returning * into v_s;
  return v_s;
end $$;

-- Riepilogo del turno (per l'anteprima di chiusura).
create or replace function public.pos_cash_session_summary(p_session uuid)
returns table (opening_float numeric, cash numeric, card numeric, other numeric, expected_cash numeric, payments int, da_fiscalizzare int)
language plpgsql stable security definer set search_path = public as $$
declare v_s public.pos_cash_sessions;
begin
  select * into v_s from public.pos_cash_sessions where id = p_session;
  if not found then raise exception 'Turno di cassa non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'pos.supervise') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  return query
    select v_s.opening_float,
           coalesce(sum(p.amount) filter (where p.method = 'contanti'), 0),
           coalesce(sum(p.amount) filter (where p.method = 'carta'), 0),
           coalesce(sum(p.amount) filter (where p.method = 'altro'), 0),
           v_s.opening_float + coalesce(sum(p.amount) filter (where p.method = 'contanti'), 0),
           count(p.id)::int,
           (count(p.id) filter (where p.fiscal_status = 'da_fiscalizzare'))::int
    from public.pos_payments p where p.cash_session_id = p_session;
end $$;

-- Segna come fiscalizzati (scontrino emesso dal registratore telematico) i pagamenti di una comanda.
create or replace function public.pos_mark_fiscalized(p_order uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_o public.pos_orders;
  v_n int;
begin
  select * into v_o from public.pos_orders where id = p_order;
  if not found then raise exception 'Comanda non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_o.org_id, v_o.facility_id, 'pos.operate') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  update public.pos_payments set fiscal_status = 'fiscalizzato' where order_id = p_order and fiscal_status = 'da_fiscalizzare';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime: le tabelle operative pubblicano le modifiche (filtrate per facility_id da LiveRefresh).
-- menu_items è inclusa perché la sala veda in diretta esauriti e porzioni.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['pos_orders','pos_order_lines','pos_payments','pos_cash_sessions','menu_items'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

alter function app.pos_recalc(uuid) set search_path = public;
revoke execute on function app.pos_recalc(uuid) from authenticated, anon, public;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
