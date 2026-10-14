-- Test Numeri: KPI operativi ed economici, separazione analytics.view / finance.view, isolamento tra aziende,
-- segnali dell'assistente, storico per il pianificatore, riscontri per persona.
\set ON_ERROR_STOP on
set client_min_messages = warning;

create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
declare v_id text;
begin
  reset role;
  select id::text into v_id from auth.users where email = p_email;
  perform set_config('request.jwt.claim.sub', v_id, false);
  set role authenticated;
end $$;
create or replace function pg_temp.as_admin() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
create or replace function pg_temp.assert(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'ASSERT FALLITO: %', p_msg; end if;
  raise notice 'ok  %', p_msg;
end $$;
create or replace function pg_temp.expect_error(p_sql text, p_msg text, p_code text default null) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_code is not null and sqlstate <> p_code then
      raise exception 'ASSERT FALLITO: % — errore % invece di %: %', p_msg, sqlstate, p_code, sqlerrm;
    end if;
    raise notice 'ok  % (errore atteso: %)', p_msg, sqlerrm;
    return;
  end;
  raise exception 'ASSERT FALLITO: % — nessun errore', p_msg;
end $$;

set client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Setup: Lido Sole (titolare Olga, responsabile Lucia con analytics.view senza finanza, cameriere Walter);
-- Trattoria Bruno in un'altra organizzazione.
-- ---------------------------------------------------------------------------
select pg_temp.as_admin();
insert into auth.users (email) values ('olga@analytics-test.it'), ('lucia@analytics-test.it'), ('walter@analytics-test.it'), ('bruno@analytics-test.it');

select pg_temp.as_user('olga@analytics-test.it');
select public.create_organization('Lido Sole srl', 'Lido Sole', 'lido') as org_a \gset
select pg_temp.as_user('bruno@analytics-test.it');
select public.create_organization('Trattoria Bruno', 'Trattoria Bruno', 'ristorante') as org_b \gset

select pg_temp.as_admin();
select id as fac_a from public.facilities where org_id = :'org_a' \gset
select id as fac_b from public.facilities where org_id = :'org_b' \gset
select id as ps_cucina from public.prep_stations where org_id = :'org_a' and kind = 'cucina' \gset
select id as ps_bar from public.prep_stations where org_id = :'org_a' and kind = 'bar' \gset
select warehouse_id as wh_cucina from public.prep_stations where id = :'ps_cucina' \gset
select id as u_olga from auth.users where email = 'olga@analytics-test.it' \gset
select id as u_lucia from auth.users where email = 'lucia@analytics-test.it' \gset

insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_a', u.id, r.id, array[:'fac_a']::uuid[]
from auth.users u join public.roles r on r.org_id = :'org_a' and r.key = case u.email
  when 'lucia@analytics-test.it' then 'dept_lead' when 'walter@analytics-test.it' then 'waiter' end
where u.email in ('lucia@analytics-test.it', 'walter@analytics-test.it');

-- Giorno di riferimento: due giorni fa nel fuso della struttura
select ((now() at time zone 'Europe/Rome')::date - 2) as d \gset
select (:'d'::date - 1) as d_prev \gset

-- Catalogo, costi, menu
insert into public.products (org_id, name, base_unit) values (:'org_a', 'Spaghetti', 'g') returning id as p_spag \gset
insert into public.product_costs (org_id, product_id, avg_cost, last_cost, qty_basis) values (:'org_a', :'p_spag', 0.01, 0.011, 1000);
insert into public.menu_items (org_id, facility_id, prep_station_id, name, price, vat_rate, target_food_cost_pct)
  values (:'org_a', :'fac_a', :'ps_cucina', 'Spaghetti al pomodoro', 11.00, 10, 30) returning id as mi_spag \gset
insert into public.menu_items (org_id, facility_id, prep_station_id, name, price, vat_rate)
  values (:'org_a', :'fac_a', :'ps_bar', 'Birra media', 6.10, 22) returning id as mi_birra \gset
insert into public.menu_items (org_id, facility_id, name, price, vat_rate)
  values (:'org_a', :'fac_a', 'Caffè', 1.50, 10) returning id as mi_caffe \gset
insert into public.recipe_lines (org_id, menu_item_id, product_id, qty) values (:'org_a', :'mi_spag', :'p_spag', 100);

-- Comande del giorno D: 2 comande, 6 coperti; cucina 20 e 10 minuti, bar 5 minuti
insert into public.pos_orders (org_id, facility_id, destination_kind, destination_label, business_date, number, covers, status, subtotal, total, paid, closed_at)
  values (:'org_a', :'fac_a', 'banco', 'Banco #1', :'d', 1, 4, 'chiusa', 40.30, 40.30, 40.30, now()) returning id as o1 \gset
insert into public.pos_orders (org_id, facility_id, destination_kind, destination_label, business_date, number, covers, status, subtotal, total, paid, closed_at)
  values (:'org_a', :'fac_a', 'banco', 'Banco #2', :'d', 2, 2, 'chiusa', 11.00, 11.00, 11.00, now()) returning id as o2 \gset
-- Comanda annullata: esclusa da tutto
insert into public.pos_orders (org_id, facility_id, destination_kind, destination_label, business_date, number, covers, status)
  values (:'org_a', :'fac_a', 'banco', 'Banco #3', :'d', 3, 9, 'annullata');

insert into public.pos_order_lines (org_id, facility_id, order_id, menu_item_id, prep_station_id, name, unit_price, vat_rate, qty, status, sent_at, ready_at, served_at) values
  (:'org_a', :'fac_a', :'o1', :'mi_spag', :'ps_cucina', 'Spaghetti al pomodoro', 11.00, 10, 2, 'servita',
     (:'d'::date + time '12:00') at time zone 'Europe/Rome', (:'d'::date + time '12:15') at time zone 'Europe/Rome', (:'d'::date + time '12:20') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', :'o1', :'mi_birra', :'ps_bar', 'Birra media', 6.10, 22, 3, 'servita',
     (:'d'::date + time '12:00') at time zone 'Europe/Rome', (:'d'::date + time '12:03') at time zone 'Europe/Rome', (:'d'::date + time '12:05') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', :'o2', :'mi_spag', :'ps_cucina', 'Spaghetti al pomodoro', 11.00, 10, 1, 'servita',
     (:'d'::date + time '13:00') at time zone 'Europe/Rome', (:'d'::date + time '13:08') at time zone 'Europe/Rome', (:'d'::date + time '13:10') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', :'o2', :'mi_birra', :'ps_bar', 'Birra media', 6.10, 22, 1, 'annullata',
     (:'d'::date + time '13:00') at time zone 'Europe/Rome', null, null);
insert into public.pos_payments (org_id, facility_id, order_id, method, amount, created_at) values
  (:'org_a', :'fac_a', :'o1', 'carta', 40.30, (:'d'::date + time '14:00') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', :'o2', 'carta', 11.00, (:'d'::date + time '14:00') at time zone 'Europe/Rome');

-- Magazzino: carico 1000 g, vendita 300 g, spreco 200 g, rettifica −50 g (tutti nel giorno D)
insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, unit_cost, created_at) values
  (:'org_a', :'fac_a', :'wh_cucina', :'p_spag', 1000, 'carico', 0.01, (:'d'::date + time '08:00') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', :'wh_cucina', :'p_spag', -300, 'scarico', null, (:'d'::date + time '15:00') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', :'wh_cucina', :'p_spag', 200, 'spreco', null, (:'d'::date + time '16:00') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', :'wh_cucina', :'p_spag', -50, 'rettifica', null, (:'d'::date + time '17:00') at time zone 'Europe/Rome');

-- Fornitore: listino 10,00 € → 11,00 € (confezione 1000 g) con l'aumento nel giorno D
insert into public.suppliers (org_id, name, delivery_weekdays, cutoff_time, lead_days) values (:'org_a', 'Pasta Sud', '{2,5}', '11:00', 1) returning id as sup \gset
insert into public.supplier_products (org_id, supplier_id, product_id, pack_label, pack_qty, price, preferred)
  values (:'org_a', :'sup', :'p_spag', 'cartone 1 kg', 1000, 10.00, true) returning id as sp \gset
update public.supplier_price_history set observed_at = now() - interval '30 days' where supplier_product_id = :'sp';
insert into public.supplier_price_history (org_id, supplier_product_id, price, source, observed_at)
  values (:'org_a', :'sp', 11.00, 'listino', (:'d'::date + time '09:00') at time zone 'Europe/Rome');
-- Ricezione confermata nel giorno D: 3 cartoni a 11 €
insert into public.receipts (org_id, facility_id, supplier_id, warehouse_id, status, confirmed_at)
  values (:'org_a', :'fac_a', :'sup', :'wh_cucina', 'confermata', (:'d'::date + time '10:00') at time zone 'Europe/Rome') returning id as rc \gset
insert into public.receipt_lines (org_id, receipt_id, product_id, pack_qty, qty_packs, unit_price) values (:'org_a', :'rc', :'p_spag', 1000, 3, 11.00);

-- HACCP: una lettura regolare e una fuori limite nel giorno D
insert into public.haccp_equipment (org_id, facility_id, name, min_temp, max_temp) values (:'org_a', :'fac_a', 'Frigo bibite', 0, 4) returning id as eq \gset
insert into public.haccp_temperature_logs (org_id, facility_id, equipment_id, value, min_temp, max_temp, out_of_range, recorded_by, recorded_at) values
  (:'org_a', :'fac_a', :'eq', 3, 0, 4, false, :'u_olga', (:'d'::date + time '08:00') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', :'eq', 9, 0, 4, true, :'u_olga', (:'d'::date + time '15:00') at time zone 'Europe/Rome');

-- Attività: una completata in tempo, una in ritardo
insert into public.tasks (org_id, facility_id, title, due_at, status, completed_at) values
  (:'org_a', :'fac_a', 'Pulizia frigo', (:'d'::date + time '10:00') at time zone 'Europe/Rome', 'completata', (:'d'::date + time '09:30') at time zone 'Europe/Rome'),
  (:'org_a', :'fac_a', 'Ordine bibite', (:'d'::date + time '11:00') at time zone 'Europe/Rome', 'completata', (:'d'::date + time '12:30') at time zone 'Europe/Rome');

-- Spiaggia: 2 ombrelloni, uno prenotato nel giorno D con incasso 20 €
insert into public.service_points (org_id, facility_id, kind, label, zone) values (:'org_a', :'fac_a', 'ombrellone', 'A1', 'Fila A') returning id as omb1 \gset
insert into public.service_points (org_id, facility_id, kind, label, zone) values (:'org_a', :'fac_a', 'ombrellone', 'A2', 'Fila A');
insert into public.beach_bookings (org_id, facility_id, service_point_id, period, start_date, end_date, customer_name, price, status)
  values (:'org_a', :'fac_a', :'omb1', 'giornata', :'d', :'d', 'Cliente prova', 20, 'uscito') returning id as bb \gset
insert into public.beach_payments (org_id, facility_id, booking_id, amount, created_at)
  values (:'org_a', :'fac_a', :'bb', 20, (:'d'::date + time '10:00') at time zone 'Europe/Rome');

-- Turno pubblicato di Lucia: 6 h con 1 h di pausa = 5 h a 12 €/h
insert into public.shifts (org_id, facility_id, user_id, starts_at, ends_at, break_minutes, status)
  values (:'org_a', :'fac_a', :'u_lucia', (:'d'::date + time '10:00') at time zone 'Europe/Rome', (:'d'::date + time '16:00') at time zone 'Europe/Rome', 60, 'pubblicato');
insert into public.member_hourly_costs (org_id, user_id, hourly_cost) values (:'org_a', :'u_lucia', 12);

-- ---------------------------------------------------------------------------
-- KPI operativi (Lucia: analytics.view senza finanza)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('lucia@analytics-test.it');
select public.analytics_operational(:'fac_a', :'d', :'d') as op \gset
select pg_temp.assert((:'op'::jsonb ->> 'covers')::int = 6, 'coperti 4 + 2 (comanda annullata esclusa)');
select pg_temp.assert((:'op'::jsonb ->> 'orders')::int = 2, 'comande del periodo: 2');
select pg_temp.assert((:'op'::jsonb ->> 'items_sold')::int = 6, 'pezzi venduti: 3 spaghetti + 3 birre (riga annullata esclusa)');
select pg_temp.assert((select (s ->> 'avg_served_min')::numeric = 15 from jsonb_array_elements(:'op'::jsonb -> 'service') s where s ->> 'station_id' = :'ps_cucina'),
  'tempo medio cucina inviata → servita = (20 + 10) / 2 = 15 min');
select pg_temp.assert((select (s ->> 'avg_served_min')::numeric = 5 from jsonb_array_elements(:'op'::jsonb -> 'service') s where s ->> 'station_id' = :'ps_bar'),
  'tempo medio bar = 5 min');
select pg_temp.assert((:'op'::jsonb -> 'items' -> 0 ->> 'qty')::int = 3, 'più venduto: 3 pezzi');
select pg_temp.assert(exists (select 1 from jsonb_array_elements(:'op'::jsonb -> 'items') i where i ->> 'menu_item_id' = :'mi_caffe' and (i ->> 'qty')::int = 0),
  'le voci mai vendute compaiono con 0 (coda della classifica)');
select pg_temp.assert((:'op'::jsonb -> 'beach' ->> 'occupancy_pct')::numeric = 50, 'occupazione spiaggia 1 su 2 = 50%');
select pg_temp.assert((:'op'::jsonb -> 'tasks' ->> 'on_time_pct')::numeric = 50, 'attività in tempo: 1 su 2 = 50%');
select pg_temp.assert((:'op'::jsonb -> 'haccp' ->> 'out_of_range')::int = 1, 'una temperatura fuori limite');
select pg_temp.assert((:'op'::jsonb -> 'haccp' ->> 'without_action')::int = 1, 'fuori limite senza azione correttiva');
select pg_temp.assert((:'op'::jsonb -> 'waste' -> 0 ->> 'qty')::numeric = 200, 'spreco 200 g di spaghetti');
select pg_temp.assert((:'op'::jsonb -> 'adjustments' -> 0 ->> 'qty')::numeric = -50, 'differenza inventario −50 g');
select pg_temp.assert(case when to_regclass('public.reservations') is null then :'op'::jsonb -> 'reservations' = 'null'::jsonb else true end,
  'senza modulo prenotazioni il no-show è null (mai inventato)');
select pg_temp.assert(not (:'op'::text like '%revenue%') and not (:'op'::text like '%unit_cost%'), 'nessun dato economico nei KPI operativi');

-- Periodo precedente equivalente: vuoto
select public.analytics_operational(:'fac_a', :'d_prev', :'d_prev') as op_prev \gset
select pg_temp.assert((:'op_prev'::jsonb ->> 'covers')::int = 0 and (:'op_prev'::jsonb ->> 'orders')::int = 0, 'periodo precedente senza dati: zero, non stime');

-- Economici: Lucia non ha finance.view → 42501
select pg_temp.expect_error(format($q$select public.analytics_economic(%L, %L, %L)$q$, :'fac_a', :'d', :'d'),
  'analytics.view senza finanza: KPI economici negati', '42501');
-- Segnali: senza finanza i blocchi economici sono null
select public.analytics_insight_signals(:'fac_a') as sig_l \gset
select pg_temp.assert((:'sig_l'::jsonb ->> 'finance')::boolean = false, 'segnali: finanza non disponibile per Lucia');
select pg_temp.assert(:'sig_l'::jsonb -> 'price_increases' = 'null'::jsonb and :'sig_l'::jsonb -> 'margin' = 'null'::jsonb and :'sig_l'::jsonb -> 'food_cost' = 'null'::jsonb,
  'segnali: aumenti, margini e food cost nascosti senza finanza');
select pg_temp.assert((select (w ->> 'cur_value') is null from jsonb_array_elements(:'sig_l'::jsonb -> 'waste') w limit 1), 'segnali: valore sprechi nascosto senza finanza');
select pg_temp.assert((select (s ->> 'on_hand')::numeric = 450 and (s ->> 'daily_use')::numeric = round(500 / 14.0, 3)
                         from jsonb_array_elements(:'sig_l'::jsonb -> 'stock') s where s ->> 'product_id' = :'p_spag'),
  'segnali scorte: giacenza 450 g, consumo medio 500 g / 14 giorni');
select pg_temp.assert((select s -> 'supplier' ->> 'name' = 'Pasta Sud' from jsonb_array_elements(:'sig_l'::jsonb -> 'stock') s where s ->> 'product_id' = :'p_spag'),
  'segnali scorte: fornitore preferito con finestra di consegna');
select pg_temp.assert((select (h ->> 'out_count')::int = 1 from jsonb_array_elements(:'sig_l'::jsonb -> 'haccp') h), 'segnali HACCP: 1 fuori limite in 14 giorni');

-- Pianificatore: storico dello stesso giorno della settimana
select public.analytics_prep_history(:'fac_a', (:'d'::date + 7), 2) as prep \gset
select pg_temp.assert((:'prep'::jsonb -> 'history' -> 0 ->> 'date')::date = :'d'::date, 'storico: prima settimana = stesso giorno di 7 giorni prima');
select pg_temp.assert((:'prep'::jsonb -> 'history' -> 0 -> 'items' ->> :'mi_spag')::int = 3, 'storico: 3 spaghetti venduti');
select pg_temp.assert((:'prep'::jsonb -> 'history' -> 0 ->> 'covers')::int = 6, 'storico: 6 coperti');
select pg_temp.assert(jsonb_array_length(:'prep'::jsonb -> 'history') = 2, 'storico: 2 settimane richieste');
select pg_temp.assert((select (r ->> 'qty_per_portion')::numeric = 100 from jsonb_array_elements(:'prep'::jsonb -> 'menu') m, jsonb_array_elements(m -> 'recipe') r where m ->> 'id' = :'mi_spag'),
  'pianificatore: 100 g di spaghetti a porzione');
select pg_temp.assert((select (p ->> 'on_hand')::numeric = 450 from jsonb_array_elements(:'prep'::jsonb -> 'products') p where p ->> 'id' = :'p_spag'),
  'pianificatore: giacenza attuale 450 g');
select pg_temp.expect_error(format($q$select public.analytics_prep_history(%L, %L, 99)$q$, :'fac_a', :'d'), 'settimane fuori intervallo', '22023');
select pg_temp.expect_error(format($q$select public.analytics_operational(%L, %L, %L)$q$, :'fac_a', :'d', :'d_prev'), 'periodo invertito', '22023');

-- Riscontri: Lucia ignora un suggerimento solo per sé
insert into public.insight_feedback (org_id, facility_id, insight_key, action, until)
  values (:'org_a', :'fac_a', 'spreco:' || :'p_spag', 'ignorato', now() + interval '30 days');
select pg_temp.assert(jsonb_array_length((public.analytics_insight_signals(:'fac_a')) -> 'feedback') = 1, 'il riscontro di Lucia è nei suoi segnali');
select pg_temp.expect_error(format($q$insert into public.insight_feedback (org_id, facility_id, user_id, insight_key, action, until) values (%L, %L, %L, 'x', 'ignorato', now())$q$, :'org_a', :'fac_a', :'u_olga'),
  'non si scrive un riscontro a nome di un''altra persona');

-- ---------------------------------------------------------------------------
-- Walter (cameriere): nessun permesso sui numeri
-- ---------------------------------------------------------------------------
select pg_temp.as_user('walter@analytics-test.it');
select pg_temp.expect_error(format($q$select public.analytics_operational(%L, %L, %L)$q$, :'fac_a', :'d', :'d'), 'il cameriere non vede i KPI operativi', '42501');
select pg_temp.expect_error(format($q$select public.analytics_insight_signals(%L)$q$, :'fac_a'), 'il cameriere non vede l''assistente', '42501');
select pg_temp.expect_error(format($q$select public.analytics_prep_history(%L, %L, 4)$q$, :'fac_a', :'d'), 'il cameriere non usa il pianificatore', '42501');

-- ---------------------------------------------------------------------------
-- KPI economici (Olga, titolare)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('olga@analytics-test.it');
select pg_temp.assert((select count(*) from public.insight_feedback) = 0, 'Olga non vede i riscontri di Lucia');
select public.analytics_economic(:'fac_a', :'d', :'d') as ec \gset
select pg_temp.assert((:'ec'::jsonb ->> 'revenue_pos')::numeric = 51.30, 'incasso cassa 40,30 + 11,00');
select pg_temp.assert((:'ec'::jsonb ->> 'revenue_beach')::numeric = 20, 'incasso spiaggia 20');
select pg_temp.assert((:'ec'::jsonb ->> 'revenue')::numeric = 71.30, 'incasso totale 71,30');
select pg_temp.assert((:'ec'::jsonb ->> 'avg_ticket')::numeric = 25.65, 'scontrino medio 51,30 / 2');
select pg_temp.assert((:'ec'::jsonb -> 'food_cost' ->> 'food_cost_pct')::numeric = 10, 'food cost teorico: 3 × 1,00 € / 30,00 € netti = 10%');
select pg_temp.assert((:'ec'::jsonb -> 'food_cost' ->> 'coverage_pct')::numeric = 66.7, 'copertura ricette: 30 su 45 € netti');
select pg_temp.assert((select (i ->> 'margin')::numeric = 27 from jsonb_array_elements(:'ec'::jsonb -> 'items') i where i ->> 'menu_item_id' = :'mi_spag'),
  'margine spaghetti: 30 − 3 = 27 €');
select pg_temp.assert((select (s ->> 'gross')::numeric = 33 from jsonb_array_elements(:'ec'::jsonb -> 'by_station') s where s ->> 'station_id' = :'ps_cucina'),
  'ricavi cucina 33 € (IVA inclusa)');
select pg_temp.assert((:'ec'::jsonb -> 'suppliers' -> 0 ->> 'spend')::numeric = 33, 'spesa fornitore 3 × 11 €');
select pg_temp.assert((:'ec'::jsonb -> 'price_increases' -> 0 ->> 'increase_pct')::numeric = 10, 'aumento listino +10%');
select pg_temp.assert((:'ec'::jsonb -> 'price_increases' -> 0 ->> 'impact')::numeric = 0.30, 'impatto aumento: 1 € / 1000 g × 300 g consumati = 0,30 €');
select pg_temp.assert((:'ec'::jsonb -> 'labour' ->> 'cost')::numeric = 60 and (:'ec'::jsonb -> 'labour' ->> 'hours')::numeric = 5, 'costo personale: 5 h × 12 € = 60 €');
select pg_temp.assert((:'ec'::jsonb -> 'waste' ->> 'value')::numeric = 2, 'valore spreco: 200 g × 0,01 € = 2 €');
select pg_temp.assert((:'ec'::jsonb ->> 'adjustments_value')::numeric = -0.5, 'valore rettifiche: −50 g × 0,01 €');

select public.analytics_insight_signals(:'fac_a') as sig_o \gset
select pg_temp.assert((:'sig_o'::jsonb ->> 'finance')::boolean, 'segnali: finanza disponibile per Olga');
select pg_temp.assert(jsonb_array_length(:'sig_o'::jsonb -> 'price_increases') = 1, 'segnali: aumento listino rilevato');
select pg_temp.assert(jsonb_array_length(:'sig_o'::jsonb -> 'feedback') = 0, 'segnali: i riscontri sono per persona');

-- Impostazioni del pianificatore
insert into public.analytics_settings (org_id, facility_id, weather_rain) values (:'org_a', :'fac_a', 0.7);
select pg_temp.assert((select weather_rain from public.analytics_settings where facility_id = :'fac_a') = 0.7, 'moltiplicatore pioggia salvato');
select pg_temp.as_user('lucia@analytics-test.it');
update public.analytics_settings set weather_rain = 0.2 where facility_id = :'fac_a';
select pg_temp.assert((select weather_rain from public.analytics_settings where facility_id = :'fac_a') = 0.7, 'Lucia (senza menu.manage) non modifica i moltiplicatori');

-- ---------------------------------------------------------------------------
-- Isolamento: Bruno non vede nulla del Lido Sole
-- ---------------------------------------------------------------------------
select pg_temp.as_user('bruno@analytics-test.it');
select pg_temp.expect_error(format($q$select public.analytics_operational(%L, %L, %L)$q$, :'fac_a', :'d', :'d'), 'Bruno non legge i KPI operativi altrui', '42501');
select pg_temp.expect_error(format($q$select public.analytics_economic(%L, %L, %L)$q$, :'fac_a', :'d', :'d'), 'Bruno non legge i KPI economici altrui', '42501');
select pg_temp.expect_error(format($q$select public.analytics_insight_signals(%L)$q$, :'fac_a'), 'Bruno non legge i segnali altrui', '42501');
select pg_temp.expect_error(format($q$select public.analytics_prep_history(%L, %L, 4)$q$, :'fac_a', :'d'), 'Bruno non legge lo storico altrui', '42501');
select pg_temp.expect_error(format($q$select public.analytics_economic(%L, %L, %L)$q$, gen_random_uuid(), :'d', :'d'), 'struttura inesistente', '42501');
select pg_temp.assert((select count(*) from public.analytics_settings) = 0, 'Bruno non vede le impostazioni altrui');
select pg_temp.expect_error(format($q$insert into public.analytics_settings (org_id, facility_id) values (%L, %L)$q$, :'org_a', :'fac_a'), 'Bruno non scrive impostazioni altrui');
select public.analytics_economic(:'fac_b', :'d', :'d') as ec_b \gset
select pg_temp.assert((:'ec_b'::jsonb ->> 'revenue')::numeric = 0, 'la Trattoria parte da zero: nessun dato del Lido');

-- Anonimo: nessuna esecuzione
select pg_temp.as_admin();
set role anon;
select pg_temp.expect_error(format($q$select public.analytics_operational(%L, %L, %L)$q$, :'fac_a', :'d', :'d'), 'anon non esegue le RPC dei numeri');
reset role;

-- ---------------------------------------------------------------------------
-- Prenotazioni lette in modo difensivo: si simula una tabella public.reservations in una transazione annullata
-- (solo se il modulo prenotazioni non è ancora installato).
-- ---------------------------------------------------------------------------
select to_regclass('public.reservations') is null as no_res \gset
\if :no_res
begin;
create table public.reservations (id uuid primary key default gen_random_uuid(), facility_id uuid, starts_at timestamptz, party_size int, status text);
insert into public.reservations (facility_id, starts_at, party_size, status) values
  (:'fac_a', (:'d'::date + time '20:00') at time zone 'Europe/Rome', 4, 'confermata'),
  (:'fac_a', (:'d'::date + time '20:30') at time zone 'Europe/Rome', 2, 'no_show'),
  (:'fac_a', (:'d'::date + time '21:00') at time zone 'Europe/Rome', 3, 'annullata');
select pg_temp.as_user('lucia@analytics-test.it');
select public.analytics_operational(:'fac_a', :'d', :'d') -> 'reservations' as res \gset
select pg_temp.assert((:'res'::jsonb ->> 'no_show_pct')::numeric = 50, 'no-show: 1 su 2 prenotazioni non annullate = 50%');
select pg_temp.assert((:'res'::jsonb ->> 'covers')::int = 4, 'coperti prenotati (esclusi no-show e annullate) = 4');
select pg_temp.assert((public.analytics_prep_history(:'fac_a', :'d', 2) ->> 'booked_covers')::int = 4, 'pianificatore: coperti prenotati del giorno');
select pg_temp.as_admin();
rollback;
\endif

do $$ begin raise notice '✓ Test numeri superati'; end $$;
