-- Ordivia — Numeri: andamento operativo ed economico, assistente operativo (segnali per le regole),
-- pianificatore delle preparazioni.
--
-- Principi:
--   • tutti i KPI si calcolano nel database con RPC security definer che ricontrollano i permessi;
--   • i dati operativi richiedono analytics.view (o finance.view); i dati economici SOLO finance.view;
--   • le tabelle create da altri moduli in parallelo (es. public.reservations) si leggono solo se esistono,
--     con SQL dinamico: in loro assenza i valori sono null, mai inventati.

-- ---------------------------------------------------------------------------
-- Impostazioni per struttura: obiettivo tempi cucina e moltiplicatori meteo del pianificatore
-- ---------------------------------------------------------------------------
create table public.analytics_settings (
  facility_id           uuid primary key,
  org_id                uuid not null references public.organizations(id) on delete cascade,
  ticket_target_minutes smallint not null default 15 check (ticket_target_minutes between 1 and 180),
  weather_sunny         numeric(4,2) not null default 1.10 check (weather_sunny between 0.1 and 3),
  weather_variable      numeric(4,2) not null default 1.00 check (weather_variable between 0.1 and 3),
  weather_rain          numeric(4,2) not null default 0.80 check (weather_rain between 0.1 and 3),
  prep_weeks            smallint not null default 6 check (prep_weeks between 1 and 26),
  updated_by            uuid default auth.uid(),
  updated_at            timestamptz not null default now(),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);

alter table public.analytics_settings enable row level security;
create policy ans_select on public.analytics_settings for select to authenticated
  using (app.can_access_facility(org_id, facility_id));
create policy ans_insert on public.analytics_settings for insert to authenticated
  with check (app.has_facility_perm(org_id, facility_id, 'menu.manage') or app.has_facility_perm(org_id, facility_id, 'org.manage'));
create policy ans_update on public.analytics_settings for update to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'menu.manage') or app.has_facility_perm(org_id, facility_id, 'org.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'menu.manage') or app.has_facility_perm(org_id, facility_id, 'org.manage'));
revoke delete on public.analytics_settings from authenticated, anon;
revoke all on public.analytics_settings from anon;
select app.enable_audit('public.analytics_settings');

-- ---------------------------------------------------------------------------
-- Riscontri dell'assistente: ogni persona può ignorare o rimandare un suggerimento (solo per sé)
-- ---------------------------------------------------------------------------
create table public.insight_feedback (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  facility_id uuid not null,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  insight_key text not null check (length(insight_key) between 1 and 200),
  action      text not null check (action in ('ignorato', 'rimandato')),
  until       timestamptz not null,
  created_at  timestamptz not null default now(),
  unique (user_id, facility_id, insight_key),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);
create index on public.insight_feedback (facility_id, user_id);

alter table public.insight_feedback enable row level security;
create policy if_select on public.insight_feedback for select to authenticated
  using (user_id = auth.uid() and app.can_access_facility(org_id, facility_id));
create policy if_insert on public.insight_feedback for insert to authenticated
  with check (user_id = auth.uid() and app.can_access_facility(org_id, facility_id));
create policy if_update on public.insight_feedback for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and app.can_access_facility(org_id, facility_id));
create policy if_delete on public.insight_feedback for delete to authenticated
  using (user_id = auth.uid());
revoke all on public.insight_feedback from anon;

-- ---------------------------------------------------------------------------
-- Controllo permessi comune. p_scope: 'operativo' | 'economico' | 'preparazioni'
-- Restituisce l'organizzazione della struttura; struttura inesistente o altrui = permesso negato.
-- ---------------------------------------------------------------------------
create or replace function app.analytics_check(p_facility uuid, p_scope text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null then
    raise exception 'Permesso negato: struttura non accessibile' using errcode = '42501';
  end if;
  if p_scope = 'economico' then
    if not app.has_facility_perm(v_org, p_facility, 'finance.view') then
      raise exception 'Permesso negato: i dati economici richiedono il permesso «finanza»' using errcode = '42501';
    end if;
  elsif p_scope = 'preparazioni' then
    if not (app.has_facility_perm(v_org, p_facility, 'analytics.view') or app.has_facility_perm(v_org, p_facility, 'menu.manage')
            or app.has_facility_perm(v_org, p_facility, 'finance.view')) then
      raise exception 'Permesso negato: servono i permessi «numeri» o «menu»' using errcode = '42501';
    end if;
  else
    if not (app.has_facility_perm(v_org, p_facility, 'analytics.view') or app.has_facility_perm(v_org, p_facility, 'finance.view')) then
      raise exception 'Permesso negato: servono i permessi «numeri»' using errcode = '42501';
    end if;
  end if;
  return v_org;
end $$;

create or replace function app.analytics_check_period(p_from date, p_to date) returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Periodo non valido' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'Periodo troppo lungo: massimo 400 giorni' using errcode = '22023';
  end if;
end $$;

-- Costo unitario usato ovunque: medio ponderato, altrimenti ultimo (come menu_item_costs).
create or replace function app.analytics_unit_cost(p_product uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(c.avg_cost, 0), c.last_cost) from public.product_costs c where c.product_id = p_product
$$;

-- ---------------------------------------------------------------------------
-- Prenotazioni (tabella di un altro modulo): lettura difensiva con SQL dinamico.
-- Restituisce, per giorno, prenotazioni non annullate (no-show inclusi), coperti attesi (esclusi no-show), no-show e annullate; nessuna riga se la tabella
-- non esiste o non ha colonne riconoscibili.
-- ---------------------------------------------------------------------------
create or replace function app.analytics_reservations(p_facility uuid, p_from date, p_to date)
returns table (d date, reservations int, covers int, no_show int, cancelled int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_cols text[];
  v_date text;
  v_covers text;
  v_noshow text := 'false';
  v_cancel text := 'false';
  v_tz text := app.facility_tz(p_facility);
begin
  if to_regclass('public.reservations') is null then return; end if;
  select array_agg(column_name::text) into v_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'reservations';
  if not ('facility_id' = any(v_cols)) then return; end if;

  v_date := case
    when 'starts_at' = any(v_cols) then format('(starts_at at time zone %L)::date', v_tz)
    when 'start_at' = any(v_cols) then format('(start_at at time zone %L)::date', v_tz)
    when 'reserved_for' = any(v_cols) then format('(reserved_for at time zone %L)::date', v_tz)
    when 'service_date' = any(v_cols) then 'service_date::date'
    when 'reservation_date' = any(v_cols) then 'reservation_date::date'
    when 'date' = any(v_cols) then '"date"::date'
    when 'on_date' = any(v_cols) then 'on_date::date'
  end;
  if v_date is null then return; end if;
  v_covers := case
    when 'party_size' = any(v_cols) then 'coalesce(party_size, 0)::int'
    when 'covers' = any(v_cols) then 'coalesce(covers, 0)::int'
    when 'guests' = any(v_cols) then 'coalesce(guests, 0)::int'
    when 'pax' = any(v_cols) then 'coalesce(pax, 0)::int'
    when 'people' = any(v_cols) then 'coalesce(people, 0)::int'
    else '0'
  end;
  if 'status' = any(v_cols) then
    v_noshow := $s$status::text in ('no_show','noshow','non_presentato','non_presentata')$s$;
    v_cancel := $s$status::text in ('annullata','cancellata','cancelled','rifiutata','annullato')$s$;
  end if;

  begin
    return query execute format(
      'select x.dd, count(*) filter (where not x.canc)::int, coalesce(sum(x.cov) filter (where not x.canc and not x.ns), 0)::int,
              count(*) filter (where x.ns)::int, count(*) filter (where x.canc)::int
         from (select %s as dd, %s as cov, (%s) as ns, (%s) as canc from public.reservations where facility_id = $1) x
        where x.dd between $2 and $3
        group by x.dd order by x.dd',
      v_date, v_covers, v_noshow, v_cancel)
    using p_facility, p_from, p_to;
  exception when others then
    return; -- schema inatteso: meglio nessun dato che un dato sbagliato
  end;
end $$;

-- ---------------------------------------------------------------------------
-- KPI operativi del periodo [p_from, p_to] (date civili nel fuso della struttura)
-- ---------------------------------------------------------------------------
create or replace function public.analytics_operational(p_facility uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid;
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
  v_target int;
  v_out jsonb;
  v_res jsonb;
  v_beach_points int;
begin
  v_org := app.analytics_check(p_facility, 'operativo');
  perform app.analytics_check_period(p_from, p_to);
  v_tz := app.facility_tz(p_facility);
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  select coalesce((select ticket_target_minutes from public.analytics_settings where facility_id = p_facility), 15) into v_target;

  -- Prenotazioni (se il modulo esiste)
  if to_regclass('public.reservations') is not null then
    select jsonb_build_object(
             'reservations', coalesce(sum(r.reservations), 0),
             'no_show', coalesce(sum(r.no_show), 0),
             'cancelled', coalesce(sum(r.cancelled), 0),
             'covers', coalesce(sum(r.covers), 0),
             'no_show_pct', case when coalesce(sum(r.reservations), 0) > 0
                                 then round(sum(r.no_show)::numeric * 100 / sum(r.reservations), 1) end)
      into v_res
      from app.analytics_reservations(p_facility, p_from, p_to) r;
  end if;

  select count(*) into v_beach_points from public.service_points
   where facility_id = p_facility and active and kind in ('ombrellone','lettino','cabina','gazebo');

  with o as (
    select * from public.pos_orders
     where facility_id = p_facility and business_date between p_from and p_to and status <> 'annullata'
  ), l as (
    select l.* from public.pos_order_lines l join o on o.id = l.order_id where l.status <> 'annullata'
  ), days as (
    select g::date as d from generate_series(p_from, p_to, interval '1 day') g
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'covers', (select coalesce(sum(covers), 0) from o),
    'orders', (select count(*) from o),
    'orders_closed', (select count(*) from o where status = 'chiusa'),
    'items_sold', (select coalesce(sum(qty), 0) from l),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object(
                 'd', days.d,
                 'covers', (select coalesce(sum(covers), 0) from o where o.business_date = days.d),
                 'orders', (select count(*) from o where o.business_date = days.d)) order by days.d), '[]') from days),
    'ticket_target_minutes', v_target,
    'service', (select coalesce(jsonb_agg(s order by s.avg_served_min desc nulls last), '[]') from (
        select l.prep_station_id as station_id, coalesce(ps.name, 'Senza postazione') as name,
               count(*)::int as lines,
               count(l.ready_at)::int as lines_ready,
               count(l.served_at)::int as lines_served,
               round((avg(extract(epoch from l.ready_at - l.sent_at)) filter (where l.ready_at is not null) / 60)::numeric, 1) as avg_ready_min,
               round((avg(extract(epoch from l.served_at - l.sent_at)) filter (where l.served_at is not null) / 60)::numeric, 1) as avg_served_min,
               round((percentile_cont(0.9) within group (order by extract(epoch from l.served_at - l.sent_at)) filter (where l.served_at is not null) / 60)::numeric, 1) as p90_served_min
          from l left join public.prep_stations ps on ps.id = l.prep_station_id
         where l.prep_station_id is not null
         group by l.prep_station_id, ps.name) s),
    'items', (select coalesce(jsonb_agg(i order by i.qty desc, i.name), '[]') from (
        select x.menu_item_id, x.name, x.qty from (
          select l.menu_item_id, max(l.name) as name, sum(l.qty)::int as qty from l group by l.menu_item_id
          union all
          select m.id, m.name, 0 from public.menu_items m
           where m.facility_id = p_facility and m.active and not exists (select 1 from l where l.menu_item_id = m.id)
        ) x order by x.qty desc limit 300) i),
    'beach', case when v_beach_points = 0 then null else (
        select jsonb_build_object(
          'points', v_beach_points,
          'point_days', v_beach_points * (p_to - p_from + 1),
          'occupied_point_days', coalesce(sum(occ), 0),
          'occupancy_pct', round(coalesce(sum(occ), 0)::numeric * 100 / nullif(v_beach_points * (p_to - p_from + 1), 0), 1),
          'no_show', (select count(*) from public.beach_bookings b
                       where b.facility_id = p_facility and b.status = 'no_show' and b.start_date between p_from and p_to),
          'bookings', (select count(*) from public.beach_bookings b
                       where b.facility_id = p_facility and b.status <> 'annullata' and b.start_date between p_from and p_to))
        from (select (select count(distinct b.service_point_id) from public.beach_bookings b
                        join public.service_points sp on sp.id = b.service_point_id and sp.active
                       where b.facility_id = p_facility and b.status in ('prenotata','presente','uscito')
                         and days.d between b.start_date and b.end_date) as occ
                from days) z) end,
    'reservations', v_res,
    'tasks', (select jsonb_build_object(
        'due', count(*),
        'on_time', count(*) filter (where completed_at is not null and completed_at <= due_at),
        'late', count(*) filter (where completed_at is not null and completed_at > due_at),
        'open_overdue', count(*) filter (where completed_at is null and due_at < now()),
        'on_time_pct', case when count(*) filter (where completed_at is not null or due_at < now()) > 0 then
             round(count(*) filter (where completed_at is not null and completed_at <= due_at)::numeric * 100
                   / count(*) filter (where completed_at is not null or due_at < now()), 1) end)
        from public.tasks where facility_id = p_facility and status <> 'annullata' and due_at >= v_start and due_at < v_end),
    'haccp', (select jsonb_build_object(
        'readings', count(*),
        'out_of_range', count(*) filter (where out_of_range),
        'without_action', count(*) filter (where out_of_range and corrective_action is null))
        from public.haccp_temperature_logs where facility_id = p_facility and recorded_at >= v_start and recorded_at < v_end),
    'waste', (select coalesce(jsonb_agg(w order by w.qty desc), '[]') from (
        select m.product_id, p.name, p.base_unit::text as unit, round(-sum(m.qty), 3) as qty,
               round(-sum(m.qty) filter (where m.kind = 'spreco'), 3) as qty_spreco,
               round(-sum(m.qty) filter (where m.kind = 'scaduto'), 3) as qty_scaduto,
               count(*)::int as movements
          from public.stock_movements m join public.products p on p.id = m.product_id
         where m.facility_id = p_facility and m.kind in ('spreco','scaduto') and m.created_at >= v_start and m.created_at < v_end
         group by m.product_id, p.name, p.base_unit limit 100) w),
    'adjustments', (select coalesce(jsonb_agg(a order by abs(a.qty) desc), '[]') from (
        select m.product_id, p.name, p.base_unit::text as unit, round(sum(m.qty), 3) as qty, count(*)::int as movements
          from public.stock_movements m join public.products p on p.id = m.product_id
         where m.facility_id = p_facility and m.kind = 'rettifica' and m.created_at >= v_start and m.created_at < v_end
         group by m.product_id, p.name, p.base_unit limit 100) a)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- KPI economici del periodo: SOLO finance.view (controllato qui, non nell'interfaccia)
-- ---------------------------------------------------------------------------
create or replace function public.analytics_economic(p_facility uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid;
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
  v_out jsonb;
begin
  v_org := app.analytics_check(p_facility, 'economico');
  perform app.analytics_check_period(p_from, p_to);
  v_tz := app.facility_tz(p_facility);
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;

  with o as (
    select * from public.pos_orders
     where facility_id = p_facility and business_date between p_from and p_to and status <> 'annullata'
  ), l as (
    select l.* from public.pos_order_lines l join o on o.id = l.order_id where l.status <> 'annullata'
  ), pay as (
    select p.amount, o.business_date as d from public.pos_payments p join o on o.id = p.order_id
  ), bpay as (
    select p.amount, (p.created_at at time zone v_tz)::date as d from public.beach_payments p
     where p.facility_id = p_facility and p.created_at >= v_start and p.created_at < v_end
  ), pc as (
    select m.id as menu_item_id, m.target_food_cost_pct as target,
           coalesce(sum(r.qty / (1 - r.waste_pct / 100) * coalesce(nullif(c.avg_cost, 0), c.last_cost, 0)), 0) / m.yield_portions as cost,
           count(r.id)::int as ingredients,
           (count(r.id) filter (where coalesce(nullif(c.avg_cost, 0), c.last_cost) is null))::int as missing
      from public.menu_items m
      left join public.recipe_lines r on r.menu_item_id = m.id
      left join public.product_costs c on c.product_id = r.product_id
     where m.facility_id = p_facility
     group by m.id, m.yield_portions, m.target_food_cost_pct
  ), sold as (
    select l.menu_item_id, max(l.name) as name, sum(l.qty)::int as qty,
           sum(l.unit_price * l.qty) as gross, sum(l.unit_price * l.qty / (1 + l.vat_rate / 100)) as net
      from l group by l.menu_item_id
  ), im as (
    select s.menu_item_id, s.name, s.qty, round(s.gross, 2) as gross, round(s.net, 2) as net,
           coalesce(pc.ingredients, 0) > 0 as has_recipe, coalesce(pc.missing, 0) as missing_costs,
           pc.target as target_food_cost_pct,
           case when coalesce(pc.ingredients, 0) > 0 then round(s.qty * pc.cost, 2) end as cost,
           case when coalesce(pc.ingredients, 0) > 0 then round(s.net - s.qty * pc.cost, 2) end as margin,
           case when coalesce(pc.ingredients, 0) > 0 and s.net > 0 then round((s.net - s.qty * pc.cost) / s.net * 100, 1) end as margin_pct,
           case when coalesce(pc.ingredients, 0) > 0 and s.net > 0 then round(s.qty * pc.cost / s.net * 100, 1) end as food_cost_pct
      from sold s left join pc on pc.menu_item_id = s.menu_item_id
  ), days as (
    select g::date as d from generate_series(p_from, p_to, interval '1 day') g
  ), cons as (
    -- consumi del periodo per prodotto (scarichi da vendita e manuali), in unità base
    select m.product_id, -sum(m.qty) as qty from public.stock_movements m
     where m.facility_id = p_facility and m.kind = 'scarico' and m.created_at >= v_start and m.created_at < v_end
     group by m.product_id
  ), ph as (
    select sp.id as sp_id, sp.product_id, sp.supplier_id, sp.pack_qty, sp.pack_label,
           (select h.price from public.supplier_price_history h
             where h.supplier_product_id = sp.id and h.observed_at < v_end order by h.observed_at desc, h.id desc limit 1) as new_price,
           coalesce(
             (select h.price from public.supplier_price_history h
               where h.supplier_product_id = sp.id and h.observed_at < v_start order by h.observed_at desc, h.id desc limit 1),
             (select h.price from public.supplier_price_history h
               where h.supplier_product_id = sp.id and h.observed_at >= v_start and h.observed_at < v_end order by h.observed_at, h.id limit 1)) as old_price
      from public.supplier_products sp
     where sp.org_id = v_org
       and exists (select 1 from public.supplier_price_history h
                    where h.supplier_product_id = sp.id and h.observed_at >= v_start and h.observed_at < v_end)
  ), shifts as (
    select s.user_id,
           greatest(extract(epoch from s.ends_at - s.starts_at) / 3600 - s.break_minutes / 60.0, 0) as hours,
           mhc.hourly_cost
      from public.shifts s
      left join public.member_hourly_costs mhc on mhc.org_id = s.org_id and mhc.user_id = s.user_id
     where s.facility_id = p_facility and s.status = 'pubblicato' and s.starts_at >= v_start and s.starts_at < v_end
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'revenue_pos', (select coalesce(sum(amount), 0) from pay),
    'revenue_beach', (select coalesce(sum(amount), 0) from bpay),
    'revenue', (select coalesce(sum(amount), 0) from pay) + (select coalesce(sum(amount), 0) from bpay),
    'orders_closed', (select count(*) from o where status = 'chiusa'),
    'avg_ticket', (select round(sum(total) / nullif(count(*), 0), 2) from o where status = 'chiusa'),
    'avg_per_cover', (select round(sum(total) / nullif(sum(covers), 0), 2) from o where status = 'chiusa'),
    'discounts', (select coalesce(sum(discount_amount), 0) from o),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object(
                 'd', days.d,
                 'pos', (select coalesce(sum(amount), 0) from pay where pay.d = days.d),
                 'beach', (select coalesce(sum(amount), 0) from bpay where bpay.d = days.d)) order by days.d), '[]') from days),
    'by_station', (select coalesce(jsonb_agg(x order by x.gross desc), '[]') from (
        select l.prep_station_id as station_id, coalesce(ps.name, 'Banco / senza preparazione') as name,
               d.name as department, round(sum(l.unit_price * l.qty), 2) as gross,
               round(sum(l.unit_price * l.qty / (1 + l.vat_rate / 100)), 2) as net
          from l left join public.prep_stations ps on ps.id = l.prep_station_id
          left join public.departments d on d.id = ps.department_id
         group by l.prep_station_id, ps.name, d.name) x),
    'food_cost', (select jsonb_build_object(
        'net_sales', coalesce(round(sum(net), 2), 0),
        'net_sales_with_recipe', coalesce(round(sum(net) filter (where has_recipe), 2), 0),
        'theoretical_cost', coalesce(round(sum(cost), 2), 0),
        'food_cost_pct', round(sum(cost) / nullif(sum(net) filter (where has_recipe), 0) * 100, 1),
        'coverage_pct', round(sum(net) filter (where has_recipe) / nullif(sum(net), 0) * 100, 1),
        'items_missing_costs', count(*) filter (where missing_costs > 0))
        from im),
    'items', (select coalesce(jsonb_agg(im order by im.margin asc nulls last), '[]') from im),
    'suppliers', (select coalesce(jsonb_agg(x order by x.spend desc), '[]') from (
        select s.id as supplier_id, s.name, count(distinct rc.id)::int as receipts,
               round(sum(rl.qty_packs * coalesce(rl.unit_price, ol.unit_price, 0)), 2) as spend,
               (count(*) filter (where coalesce(rl.unit_price, ol.unit_price) is null))::int as lines_without_price
          from public.receipts rc
          join public.receipt_lines rl on rl.receipt_id = rc.id
          left join public.purchase_order_lines ol on ol.id = rl.order_line_id
          join public.suppliers s on s.id = rc.supplier_id
         where rc.facility_id = p_facility and rc.status = 'confermata' and rc.confirmed_at >= v_start and rc.confirmed_at < v_end
         group by s.id, s.name) x),
    'price_increases', (select coalesce(jsonb_agg(x order by x.impact desc nulls last, x.increase_pct desc), '[]') from (
        select ph.product_id, p.name as product, p.base_unit::text as unit, s.id as supplier_id, s.name as supplier, ph.pack_label,
               ph.old_price, ph.new_price, round((ph.new_price - ph.old_price) / ph.old_price * 100, 1) as increase_pct,
               round(coalesce(cons.qty, 0), 3) as consumed_qty,
               round((ph.new_price - ph.old_price) / ph.pack_qty * coalesce(cons.qty, 0), 2) as impact
          from ph join public.products p on p.id = ph.product_id join public.suppliers s on s.id = ph.supplier_id
          left join cons on cons.product_id = ph.product_id
         where ph.old_price > 0 and ph.new_price > ph.old_price) x),
    'labour', (select jsonb_build_object(
        'hours', coalesce(round(sum(hours)::numeric, 1), 0),
        'hours_with_cost', coalesce(round((sum(hours) filter (where hourly_cost is not null))::numeric, 1), 0),
        'cost', round((sum(hours * hourly_cost))::numeric, 2),
        'people', count(distinct user_id),
        'people_without_cost', count(distinct user_id) filter (where hourly_cost is null))
        from shifts),
    'waste', (select jsonb_build_object(
        'value', coalesce(round(sum(-m.qty * coalesce(app.analytics_unit_cost(m.product_id), 0)), 2), 0),
        'movements_without_cost', count(*) filter (where app.analytics_unit_cost(m.product_id) is null),
        'by_product', coalesce((select jsonb_agg(w order by w.value desc) from (
            select m2.product_id, p.name, round(-sum(m2.qty), 3) as qty, p.base_unit::text as unit,
                   round(-sum(m2.qty) * coalesce(app.analytics_unit_cost(m2.product_id), 0), 2) as value
              from public.stock_movements m2 join public.products p on p.id = m2.product_id
             where m2.facility_id = p_facility and m2.kind in ('spreco','scaduto') and m2.created_at >= v_start and m2.created_at < v_end
             group by m2.product_id, p.name, p.base_unit limit 50) w), '[]'))
        from public.stock_movements m
        where m.facility_id = p_facility and m.kind in ('spreco','scaduto') and m.created_at >= v_start and m.created_at < v_end),
    'adjustments_value', (select coalesce(round(sum(m.qty * coalesce(app.analytics_unit_cost(m.product_id), 0)), 2), 0)
        from public.stock_movements m
        where m.facility_id = p_facility and m.kind = 'rettifica' and m.created_at >= v_start and m.created_at < v_end)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Segnali per l'assistente operativo (le regole sono in packages/domain/src/insights.ts).
-- I blocchi economici sono null senza finance.view.
-- ---------------------------------------------------------------------------
create or replace function public.analytics_insight_signals(p_facility uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid;
  v_tz text;
  v_today date;
  v_fin boolean;
  v_target int;
  v_out jsonb;
  v_res_next jsonb;
  v_dormant jsonb;
  v_cols text[];
  v_date text;
  v_n int;
begin
  v_org := app.analytics_check(p_facility, 'operativo');
  v_fin := app.has_facility_perm(v_org, p_facility, 'finance.view');
  v_tz := app.facility_tz(p_facility);
  v_today := (now() at time zone v_tz)::date;
  select coalesce((select ticket_target_minutes from public.analytics_settings where facility_id = p_facility), 15) into v_target;

  if to_regclass('public.reservations') is not null then
    select coalesce(jsonb_object_agg(r.d::text, r.covers), '{}') into v_res_next
      from app.analytics_reservations(p_facility, v_today, v_today + 6) r;

    -- Clienti da ricontattare: solo conteggi, solo con consenso marketing (richiede reservations.customer_id)
    select array_agg(column_name::text) into v_cols from information_schema.columns
     where table_schema = 'public' and table_name = 'reservations';
    v_date := case
      when 'starts_at' = any(v_cols) then 'starts_at::date'
      when 'start_at' = any(v_cols) then 'start_at::date'
      when 'reserved_for' = any(v_cols) then 'reserved_for::date'
      when 'service_date' = any(v_cols) then 'service_date'
      when 'reservation_date' = any(v_cols) then 'reservation_date'
      when 'date' = any(v_cols) then '"date"'
      when 'on_date' = any(v_cols) then 'on_date'
    end;
    if v_date is not null and 'customer_id' = any(v_cols) and to_regclass('public.customers') is not null then
      begin
        execute format(
          'select count(*) from (select r.customer_id, max(%s)::date as last_visit from public.reservations r
              join public.customers c on c.id = r.customer_id
             where r.facility_id = $1 and c.org_id = $2 and c.marketing_consent and c.anonymized_at is null
             group by r.customer_id) x
           where x.last_visit between $3 - 365 and $3 - 90', v_date)
          into v_n using p_facility, v_org, v_today;
        v_dormant := jsonb_build_object('count', v_n, 'min_days', 90, 'max_days', 365);
      exception when others then
        v_dormant := null;
      end;
    end if;
  end if;

  with stock as (
    select m.product_id, sum(m.qty) as on_hand from public.stock_movements m
     where m.facility_id = p_facility group by m.product_id
  ), use14 as (
    select m.product_id, -sum(m.qty) / 14.0 as daily from public.stock_movements m
     where m.facility_id = p_facility and m.kind in ('scarico','spreco','scaduto') and m.created_at >= now() - interval '14 days'
     group by m.product_id
  ), incoming as (
    select ol.product_id, sum(greatest(ol.qty_packs * ol.pack_qty - ol.qty_received_base, 0)) as qty
      from public.purchase_order_lines ol join public.purchase_orders po on po.id = ol.order_id
     where po.facility_id = p_facility and po.status in ('approvato','inviato','parziale')
     group by ol.product_id
  ), best as (
    select distinct on (sp.product_id) sp.product_id, s.id as supplier_id, s.name, s.delivery_weekdays, s.cutoff_time, s.lead_days
      from public.supplier_products sp join public.suppliers s on s.id = sp.supplier_id and s.active
     where sp.org_id = v_org
     order by sp.product_id, sp.preferred desc, sp.price / sp.pack_qty asc
  ), w as (
    select m.product_id, m.kind, m.qty, m.created_at,
           case when m.created_at >= now() - interval '14 days' then 'cur' else 'prev' end as win
      from public.stock_movements m
     where m.facility_id = p_facility and m.kind in ('spreco','scaduto') and m.created_at >= now() - interval '28 days'
  ), sales as (
    select l.menu_item_id, l.qty, l.unit_price, l.vat_rate, o.business_date
      from public.pos_order_lines l join public.pos_orders o on o.id = l.order_id
     where o.facility_id = p_facility and o.status <> 'annullata' and l.status <> 'annullata'
       and o.business_date >= v_today - 28 and o.business_date < v_today
  ), pc as (
    select m.id as menu_item_id, m.name, m.target_food_cost_pct as target,
           coalesce(sum(r.qty / (1 - r.waste_pct / 100) * coalesce(nullif(c.avg_cost, 0), c.last_cost, 0)), 0) / m.yield_portions as cost,
           count(r.id)::int as ingredients,
           (count(r.id) filter (where coalesce(nullif(c.avg_cost, 0), c.last_cost) is null))::int as missing
      from public.menu_items m
      left join public.recipe_lines r on r.menu_item_id = m.id
      left join public.product_costs c on c.product_id = r.product_id
     where m.facility_id = p_facility and m.active
     group by m.id, m.name, m.yield_portions, m.target_food_cost_pct
  ), hist as (
    -- rapporto storico coperti / ore di turno (ultime 4 settimane)
    select (select coalesce(sum(covers), 0) from public.pos_orders
             where facility_id = p_facility and status <> 'annullata' and business_date >= v_today - 28 and business_date < v_today) as covers,
           (select coalesce(sum(greatest(extract(epoch from ends_at - starts_at) / 3600 - break_minutes / 60.0, 0)), 0) from public.shifts
             where facility_id = p_facility and status = 'pubblicato'
               and starts_at >= (v_today - 28)::timestamp at time zone v_tz and starts_at < v_today::timestamp at time zone v_tz) as hours
  )
  select jsonb_build_object(
    'generated_at', now(),
    'today', v_today,
    'timezone', v_tz,
    'finance', v_fin,
    'ticket_target_minutes', v_target,
    'stock', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', p.id, 'name', p.name, 'unit', p.base_unit::text,
        'on_hand', round(coalesce(st.on_hand, 0), 3), 'daily_use', round(u.daily, 3), 'incoming', round(coalesce(i.qty, 0), 3),
        'supplier', case when b.supplier_id is not null then jsonb_build_object(
            'id', b.supplier_id, 'name', b.name, 'delivery_weekdays', b.delivery_weekdays,
            'cutoff_time', b.cutoff_time::text, 'lead_days', b.lead_days) end)), '[]')
        from use14 u join public.products p on p.id = u.product_id
        left join stock st on st.product_id = u.product_id
        left join incoming i on i.product_id = u.product_id
        left join best b on b.product_id = u.product_id
        where u.daily > 0),
    'price_increases', case when v_fin then (select coalesce(jsonb_agg(x), '[]') from (
        select sp.product_id, p.name as product, p.base_unit::text as unit, s.id as supplier_id, s.name as supplier, sp.pack_label,
               h0.price as old_price, h1.price as new_price, h1.observed_at,
               round((h1.price - h0.price) / h0.price * 100, 1) as increase_pct,
               round((h1.price - h0.price) / sp.pack_qty * coalesce((
                 select -sum(m.qty) from public.stock_movements m
                  where m.facility_id = p_facility and m.product_id = sp.product_id and m.kind = 'scarico'
                    and m.created_at >= now() - interval '30 days'), 0), 2) as monthly_impact
          from public.supplier_products sp
          join public.suppliers s on s.id = sp.supplier_id and s.active
          join public.products p on p.id = sp.product_id
          cross join lateral (select h.id, h.price, h.observed_at from public.supplier_price_history h
                               where h.supplier_product_id = sp.id order by h.observed_at desc, h.id desc limit 1) h1
          cross join lateral (select h.price from public.supplier_price_history h
                               where h.supplier_product_id = sp.id and h.id <> h1.id and h.observed_at <= h1.observed_at and h.price <> h1.price
                               order by h.observed_at desc, h.id desc limit 1) h0
         where sp.org_id = v_org and h1.observed_at >= now() - interval '30 days' and h0.price > 0) x) end,
    'food_cost', case when v_fin then (select coalesce(jsonb_agg(x), '[]') from (
        select pc.menu_item_id, pc.name, pc.target, round(pc.cost, 4) as portion_cost, pc.missing,
               sum(s.qty)::int as qty_28d,
               round(sum(s.unit_price * s.qty / (1 + s.vat_rate / 100)), 2) as net_28d,
               round(pc.cost * sum(s.qty) / nullif(sum(s.unit_price * s.qty / (1 + s.vat_rate / 100)), 0) * 100, 1) as food_cost_pct
          from pc join sales s on s.menu_item_id = pc.menu_item_id
         where pc.ingredients > 0
         group by pc.menu_item_id, pc.name, pc.target, pc.cost, pc.missing) x) end,
    'margin', case when v_fin then (select jsonb_build_object(
        'cur', jsonb_build_object('net', coalesce(round(sum(s.unit_price * s.qty / (1 + s.vat_rate / 100)) filter (where s.business_date >= v_today - 14), 2), 0),
                                  'cost', coalesce(round(sum(pc.cost * s.qty) filter (where s.business_date >= v_today - 14), 2), 0)),
        'prev', jsonb_build_object('net', coalesce(round(sum(s.unit_price * s.qty / (1 + s.vat_rate / 100)) filter (where s.business_date < v_today - 14), 2), 0),
                                   'cost', coalesce(round(sum(pc.cost * s.qty) filter (where s.business_date < v_today - 14), 2), 0)))
        from sales s join pc on pc.menu_item_id = s.menu_item_id and pc.ingredients > 0) end,
    'waste', (select coalesce(jsonb_agg(x), '[]') from (
        select w.product_id, p.name, p.base_unit::text as unit,
               round(coalesce(-sum(w.qty) filter (where w.win = 'cur'), 0), 3) as cur,
               round(coalesce(-sum(w.qty) filter (where w.win = 'prev'), 0), 3) as prev,
               (count(*) filter (where w.win = 'cur'))::int as cur_movements,
               case when v_fin then round(coalesce(-sum(w.qty) filter (where w.win = 'cur'), 0) * app.analytics_unit_cost(w.product_id), 2) end as cur_value,
               case when v_fin then round(coalesce(-sum(w.qty) filter (where w.win = 'prev'), 0) * app.analytics_unit_cost(w.product_id), 2) end as prev_value
          from w join public.products p on p.id = w.product_id
         group by w.product_id, p.name, p.base_unit) x),
    'staffing', (select jsonb_build_object(
        'hist_covers', h.covers, 'hist_hours', round(h.hours::numeric, 1),
        'days', (select coalesce(jsonb_agg(jsonb_build_object(
            'date', d.d,
            'planned_hours', (select coalesce(round(sum(greatest(extract(epoch from s.ends_at - s.starts_at) / 3600 - s.break_minutes / 60.0, 0))::numeric, 1), 0)
                               from public.shifts s where s.facility_id = p_facility and s.status <> 'annullato'
                                and s.starts_at >= d.d::timestamp at time zone v_tz and s.starts_at < (d.d + 1)::timestamp at time zone v_tz),
            'forecast_covers', (select round(avg(c.cov), 0) from (
                                  select (select coalesce(sum(o.covers), 0) from public.pos_orders o
                                           where o.facility_id = p_facility and o.status <> 'annullata' and o.business_date = d.d - 7 * k) as cov,
                                         (select count(*) from public.pos_orders o
                                           where o.facility_id = p_facility and o.status <> 'annullata' and o.business_date = d.d - 7 * k) as n
                                    from generate_series(1, 4) k) c where c.n > 0),
            'booked_covers', case when v_res_next is not null then coalesce((v_res_next ->> d.d::text)::int, 0) end
          ) order by d.d), '[]') from (select (v_today + g)::date as d from generate_series(0, 6) g) d))
        from hist h),
    'kitchen', (select coalesce(jsonb_agg(x), '[]') from (
        select ps.id as station_id, ps.name, count(*)::int as lines,
               round((avg(extract(epoch from l.ready_at - l.sent_at)) / 60)::numeric, 1) as avg_ready_min,
               round((percentile_cont(0.9) within group (order by extract(epoch from l.ready_at - l.sent_at)) / 60)::numeric, 1) as p90_ready_min
          from public.pos_order_lines l join public.prep_stations ps on ps.id = l.prep_station_id
         where l.facility_id = p_facility and l.status <> 'annullata' and l.ready_at is not null and l.sent_at >= now() - interval '7 days'
         group by ps.id, ps.name) x),
    'haccp', (select coalesce(jsonb_agg(x), '[]') from (
        select e.id as equipment_id, e.name, count(*)::int as out_count,
               (count(*) filter (where t.corrective_action is null))::int as without_action, max(t.recorded_at) as last_at
          from public.haccp_temperature_logs t join public.haccp_equipment e on e.id = t.equipment_id
         where t.facility_id = p_facility and t.out_of_range and t.recorded_at >= now() - interval '14 days'
         group by e.id, e.name) x),
    'maintenance', (select coalesce(jsonb_agg(x), '[]') from (
        select coalesce(sp.label, 'Generale') as label, sp.kind, count(*)::int as count,
               (count(*) filter (where g.status in ('nuova','presa_in_carico')))::int as open
          from public.guest_requests g left join public.service_points sp on sp.id = g.service_point_id
         where g.facility_id = p_facility and g.category = 'manutenzione' and g.created_at >= now() - interval '30 days'
         group by sp.label, sp.kind having count(*) >= 2) x),
    'labels', (select jsonb_build_object(
        'expired', count(*) filter (where expires_at < now()),
        'expiring_24h', count(*) filter (where expires_at >= now() and expires_at < now() + interval '24 hours'))
        from public.haccp_labels where facility_id = p_facility and status = 'attiva'),
    'customers', v_dormant,
    'feedback', (select coalesce(jsonb_agg(jsonb_build_object('key', f.insight_key, 'action', f.action, 'until', f.until)), '[]')
        from public.insight_feedback f where f.facility_id = p_facility and f.user_id = auth.uid() and f.until > now())
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Pianificatore preparazioni: storico vendite degli stessi giorni della settimana, coperti,
-- prenotazioni del giorno, ricette e giacenze. La matematica è in packages/domain/src/insights.ts.
-- ---------------------------------------------------------------------------
create or replace function public.analytics_prep_history(p_facility uuid, p_date date, p_weeks int default 6)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid;
  v_booked int;
  v_out jsonb;
begin
  v_org := app.analytics_check(p_facility, 'preparazioni');
  if p_date is null then raise exception 'Data non valida' using errcode = '22023'; end if;
  if p_weeks is null or p_weeks < 1 or p_weeks > 26 then raise exception 'Numero di settimane non valido (1–26)' using errcode = '22023'; end if;

  if to_regclass('public.reservations') is not null then
    select coalesce(sum(r.covers), 0) into v_booked from app.analytics_reservations(p_facility, p_date, p_date) r;
  end if;

  with wk as (
    select k, (p_date - 7 * k)::date as d from generate_series(1, p_weeks) k
  ), o as (
    select o.* from public.pos_orders o join wk on wk.d = o.business_date
     where o.facility_id = p_facility and o.status <> 'annullata'
  )
  select jsonb_build_object(
    'date', p_date,
    'weeks', p_weeks,
    'booked_covers', v_booked,
    'reservations_available', to_regclass('public.reservations') is not null,
    'history', (select coalesce(jsonb_agg(jsonb_build_object(
        'date', wk.d,
        'orders', (select count(*) from o where o.business_date = wk.d),
        'covers', (select coalesce(sum(covers), 0) from o where o.business_date = wk.d),
        'items', (select coalesce(jsonb_object_agg(x.menu_item_id, x.qty), '{}') from (
                    select l.menu_item_id, sum(l.qty)::int as qty from public.pos_order_lines l join o on o.id = l.order_id
                     where o.business_date = wk.d and l.status <> 'annullata' and l.menu_item_id is not null
                     group by l.menu_item_id) x)) order by wk.d desc), '[]') from wk),
    'menu', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'prep_station_id', m.prep_station_id, 'course', m.course,
        'recipe', (select coalesce(jsonb_agg(jsonb_build_object(
                     'product_id', r.product_id,
                     'qty_per_portion', round(r.qty / (1 - r.waste_pct / 100) / m.yield_portions, 4))), '[]')
                     from public.recipe_lines r where r.menu_item_id = m.id)) order by m.course, m.sort, m.name), '[]')
        from public.menu_items m where m.facility_id = p_facility and m.active),
    'products', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'unit', p.base_unit::text,
        'on_hand', round(coalesce((select sum(m.qty) from public.stock_movements m where m.facility_id = p_facility and m.product_id = p.id), 0), 3))), '[]')
        from public.products p
       where p.org_id = v_org and exists (
         select 1 from public.recipe_lines r join public.menu_items mi on mi.id = r.menu_item_id
          where r.product_id = p.id and mi.facility_id = p_facility and mi.active))
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Permessi di esecuzione: funzione per funzione (niente revoca generalizzata sullo schema)
-- ---------------------------------------------------------------------------
revoke execute on function app.analytics_check(uuid, text) from public, anon, authenticated;
revoke execute on function app.analytics_check_period(date, date) from public, anon, authenticated;
revoke execute on function app.analytics_unit_cost(uuid) from public, anon, authenticated;
revoke execute on function app.analytics_reservations(uuid, date, date) from public, anon, authenticated;

revoke execute on function public.analytics_operational(uuid, date, date) from public, anon;
revoke execute on function public.analytics_economic(uuid, date, date) from public, anon;
revoke execute on function public.analytics_insight_signals(uuid) from public, anon;
revoke execute on function public.analytics_prep_history(uuid, date, int) from public, anon;
grant execute on function public.analytics_operational(uuid, date, date) to authenticated;
grant execute on function public.analytics_economic(uuid, date, date) to authenticated;
grant execute on function public.analytics_insight_signals(uuid) to authenticated;
grant execute on function public.analytics_prep_history(uuid, date, int) to authenticated;
