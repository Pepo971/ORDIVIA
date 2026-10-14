-- Test Sala, cassa, comande, KDS e pass: isolamento, permessi, porzioni atomiche, conto, pagamenti,
-- scarico dalle ricette, turni di cassa.
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
create or replace function pg_temp.expect_error(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok  % (errore atteso: %)', p_msg, sqlerrm;
    return;
  end;
  raise exception 'ASSERT FALLITO: % — nessun errore', p_msg;
end $$;

set client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Setup: Osteria (titolare Olga) con cameriere, cuoco, cassiere; Pizzeria (titolare Piero)
-- ---------------------------------------------------------------------------
select pg_temp.as_admin();
insert into auth.users (email) values ('olga@pos-test.it'), ('walter@pos-test.it'), ('chef@pos-test.it'), ('cassa@pos-test.it'), ('piero@pos-test.it');

select pg_temp.as_user('olga@pos-test.it');
select public.create_organization('Osteria del Porto srl', 'Osteria del Porto', 'ristorante') as org_a \gset
select pg_temp.as_user('piero@pos-test.it');
select public.create_organization('Pizzeria Piero', 'Pizzeria Piero', 'ristorante') as org_b \gset

select pg_temp.as_admin();
select id as fac_a from public.facilities where org_id = :'org_a' \gset
select id as fac_b from public.facilities where org_id = :'org_b' \gset
select id as ps_cucina from public.prep_stations where org_id = :'org_a' and kind = 'cucina' \gset
select id as ps_bar from public.prep_stations where org_id = :'org_a' and kind = 'bar' \gset
select warehouse_id as wh_cucina from public.prep_stations where id = :'ps_cucina' \gset
select pg_temp.assert(:'wh_cucina' <> '', 'la cucina ha un magazzino collegato');

insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_a', u.id, r.id, array[:'fac_a']::uuid[]
from auth.users u join public.roles r on r.org_id = :'org_a' and r.key = case u.email
  when 'walter@pos-test.it' then 'waiter' when 'chef@pos-test.it' then 'cook' when 'cassa@pos-test.it' then 'cashier' end
where u.email in ('walter@pos-test.it', 'chef@pos-test.it', 'cassa@pos-test.it');

-- Menu e ricetta (Olga ha menu.manage)
select pg_temp.as_user('olga@pos-test.it');
insert into public.products (org_id, name, base_unit) values (:'org_a', 'Spaghetti', 'g') returning id as p_spag \gset
insert into public.products (org_id, name, base_unit) values (:'org_a', 'Vongole', 'g') returning id as p_vong \gset
insert into public.menu_categories (org_id, facility_id, name) values (:'org_a', :'fac_a', 'Primi') returning id as cat_primi \gset
insert into public.menu_items (org_id, facility_id, category_id, prep_station_id, name, price, vat_rate, course, portions_left, yield_portions)
  values (:'org_a', :'fac_a', :'cat_primi', :'ps_cucina', 'Spaghetti alle vongole', 14.00, 10, 2, 3, 1) returning id as mi_spag \gset
insert into public.menu_items (org_id, facility_id, prep_station_id, name, price, vat_rate, course)
  values (:'org_a', :'fac_a', :'ps_bar', 'Birra media', 5.00, 22, 1) returning id as mi_birra \gset
insert into public.menu_items (org_id, facility_id, name, price, vat_rate, available)
  values (:'org_a', :'fac_a', 'Tiramisù', 6.00, 10, false) returning id as mi_tira \gset
insert into public.recipe_lines (org_id, menu_item_id, product_id, qty, waste_pct) values (:'org_a', :'mi_spag', :'p_spag', 100, 0);
insert into public.recipe_lines (org_id, menu_item_id, product_id, qty, waste_pct) values (:'org_a', :'mi_spag', :'p_vong', 120, 20);
-- Carico iniziale in cucina
select public.manual_load(:'wh_cucina', :'p_spag', 5000, 0.002, 'test');
select public.manual_load(:'wh_cucina', :'p_vong', 3000, 0.02, 'test');

-- ---------------------------------------------------------------------------
-- Punti di servizio in blocco
-- ---------------------------------------------------------------------------
select pg_temp.assert(public.pos_create_service_points(:'fac_a', 'tavolo', array['1','2','3','4','5'], 'Sala', 4) = 5, 'creati 5 tavoli in sala');
select pg_temp.assert(public.pos_create_service_points(:'fac_a', 'tavolo', array['5','T1','T2'], 'Terrazza', 2) = 2, 'duplicati ignorati');
select id as tav1 from public.service_points where facility_id = :'fac_a' and kind = 'tavolo' and label = '1' \gset
select id as tav2 from public.service_points where facility_id = :'fac_a' and kind = 'tavolo' and label = '2' \gset
select id as tav3 from public.service_points where facility_id = :'fac_a' and kind = 'tavolo' and label = '3' \gset
select pg_temp.as_admin();
insert into public.service_points (org_id, facility_id, kind, label, zone) values (:'org_a', :'fac_a', 'ombrellone', '12', 'Fila A') returning id as omb12 \gset

select pg_temp.as_user('walter@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_create_service_points(%L, 'tavolo', array['99'])$q$, :'fac_a'), 'il cameriere non crea tavoli');

-- ---------------------------------------------------------------------------
-- Comande: apertura, porzioni atomiche, instradamento
-- ---------------------------------------------------------------------------
select public.pos_open_order(:'fac_a', :'tav1', null, 4) as o1 \gset
select pg_temp.assert(public.pos_open_order(:'fac_a', :'tav1', null, 2) = :'o1'::uuid, 'un tavolo con comanda aperta restituisce la stessa comanda');
select pg_temp.assert((select destination_label from public.pos_orders where id = :'o1') = 'Tavolo 1', 'etichetta destinazione');
select public.pos_open_order(:'fac_a', :'omb12', null, 0) as o_omb \gset
select pg_temp.assert((select destination_kind from public.pos_orders where id = :'o_omb') = 'ombrellone', 'comanda su un ombrellone');
select public.pos_open_order(:'fac_a', null, 'asporto', 0) as o_asp \gset
select pg_temp.assert((select destination_label like 'Asporto #%' from public.pos_orders where id = :'o_asp'), 'comanda da asporto senza punto');
select pg_temp.expect_error(format($q$select public.pos_open_order(%L, null, 'tavolo', 0)$q$, :'fac_a'), 'senza punto solo banco o asporto');

select pg_temp.expect_error(format($q$insert into public.pos_orders (org_id, facility_id, destination_kind, destination_label, business_date, number) values (%L, %L, 'banco', 'x', current_date, 999)$q$, :'org_a', :'fac_a'),
  'nessuna scrittura diretta sulle comande');

select public.pos_add_lines(:'o1', jsonb_build_array(
  jsonb_build_object('menu_item_id', :'mi_spag', 'qty', 2),
  jsonb_build_object('menu_item_id', :'mi_birra', 'qty', 2, 'notes', 'ben fredde'))) as n1 \gset
select pg_temp.assert(:n1 = 2, 'due righe inviate');
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_spag') = 1, 'porzioni scalate 3 → 1');
select pg_temp.assert((select prep_station_id from public.pos_order_lines where order_id = :'o1' and menu_item_id = :'mi_spag') = :'ps_cucina'::uuid, 'spaghetti instradati in cucina');
select pg_temp.assert((select prep_station_id from public.pos_order_lines where order_id = :'o1' and menu_item_id = :'mi_birra') = :'ps_bar'::uuid, 'birra instradata al bar');
select pg_temp.assert((select course from public.pos_order_lines where order_id = :'o1' and menu_item_id = :'mi_spag') = 2, 'uscita dal menu');
select pg_temp.assert((select total from public.pos_orders where id = :'o1') = 38.00, 'totale 2×14 + 2×5 = 38');

select pg_temp.expect_error(format($q$select public.pos_add_lines(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1), jsonb_build_object('menu_item_id', %L, 'qty', 2)))$q$, :'o_omb', :'mi_birra', :'mi_spag'),
  'restano 1 porzione: 2 non si ordinano');
select pg_temp.assert((select count(*) from public.pos_order_lines where order_id = :'o_omb') = 0, 'invio tutto-o-niente: nessuna riga parziale');
select public.pos_add_lines(:'o_omb', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_spag', 'qty', 1, 'without', jsonb_build_array('prezzemolo'), 'allergy_note', 'celiaco')));
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_spag') = 0, 'ultima porzione venduta');
select pg_temp.assert((select allergy and without = array['prezzemolo'] from public.pos_order_lines where order_id = :'o_omb'), 'allergia e «senza» registrati');
select pg_temp.expect_error(format($q$select public.pos_add_lines(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'o_asp', :'mi_spag'),
  'porzioni a 0: piatto esaurito');
select pg_temp.expect_error(format($q$select public.pos_add_lines(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'o_asp', :'mi_tira'),
  'piatto non disponibile');

-- Disponibilità: il cameriere no, il cuoco sì
select pg_temp.expect_error(format($q$select public.set_item_availability(%L, true, 10)$q$, :'mi_spag'), 'il cameriere non cambia la disponibilità');
select pg_temp.as_user('chef@pos-test.it');
select public.set_item_availability(:'mi_spag', true, 5);
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_spag') = 5, 'il cuoco imposta 5 porzioni');
select public.set_item_availability(:'mi_tira', true, null);
select pg_temp.as_user('walter@pos-test.it');
select public.pos_add_lines(:'o_asp', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_tira', 'qty', 1)));
select pg_temp.assert((select status from public.pos_order_lines where order_id = :'o_asp') = 'pronta', 'piatto senza centro di produzione subito pronto da servire');
select pg_temp.as_user('chef@pos-test.it');

-- ---------------------------------------------------------------------------
-- KDS e pass
-- ---------------------------------------------------------------------------
select id as l_spag from public.pos_order_lines where order_id = :'o1' and menu_item_id = :'mi_spag' \gset
select id as l_birra from public.pos_order_lines where order_id = :'o1' and menu_item_id = :'mi_birra' \gset
select public.pos_set_line_status(:'l_spag', 'in_preparazione');
select public.pos_set_line_status(:'l_spag', 'pronta');
select pg_temp.assert((select started_at is not null and ready_at is not null from public.pos_order_lines where id = :'l_spag'), 'orari di inizio e pronto');
select pg_temp.expect_error(format($q$select public.pos_set_line_status(%L, 'annullata', 'errore')$q$, :'l_birra'), 'il cuoco non annulla');
select pg_temp.as_user('walter@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_set_line_status(%L, 'pronta')$q$, :'l_birra'), 'il cameriere non segna pronto');
select public.pos_set_line_status(:'l_spag', 'servita');
select pg_temp.assert((select served_at is not null from public.pos_order_lines where id = :'l_spag'), 'servita con orario');
select pg_temp.expect_error(format($q$select public.pos_set_line_status(%L, 'in_preparazione')$q$, :'l_spag'), 'una riga servita non torna indietro');

-- Il cameriere non annulla né sconta
select pg_temp.expect_error(format($q$select public.pos_set_line_status(%L, 'annullata', 'cliente ha cambiato idea')$q$, :'l_birra'), 'il cameriere non annulla righe');
select pg_temp.expect_error(format($q$select public.pos_set_discount(%L, 'percentuale', 10, 'cliente abituale')$q$, :'o1'), 'il cameriere non applica sconti');
select pg_temp.expect_error(format($q$update public.pos_orders set discount_amount = 30, total = 8 where id = %L$q$, :'o1'), 'nessun update diretto sul conto');
select pg_temp.as_admin();
select pg_temp.assert((select total from public.pos_orders where id = :'o1') = 38.00, 'update diretto del totale impossibile');

-- ---------------------------------------------------------------------------
-- Cassa: turno, sconto, annullo, divisione, pagamenti, chiusura con scarico
-- ---------------------------------------------------------------------------
select pg_temp.as_user('walter@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_add_payment(%L, 'contanti', 10)$q$, :'o1'), 'contanti senza turno di cassa aperto');
select pg_temp.expect_error(format($q$select public.pos_open_cash_session(%L, 100)$q$, :'fac_a'), 'il cameriere non apre la cassa');

select pg_temp.as_user('cassa@pos-test.it');
select public.pos_open_cash_session(:'fac_a', 150) as sess \gset
select pg_temp.expect_error(format($q$select public.pos_open_cash_session(%L, 100)$q$, :'fac_a'), 'un solo turno aperto per struttura');

select pg_temp.expect_error(format($q$select public.pos_set_line_status(%L, 'annullata', '')$q$, :'l_birra'), 'annullo senza motivo rifiutato');
select public.pos_set_line_status(:'l_birra', 'annullata', 'birra versata');
select pg_temp.assert((select total from public.pos_orders where id = :'o1') = 28.00, 'riga annullata esclusa dal totale');
select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.audit_log where entity = 'pos_order_lines' and entity_id = :'l_birra' and after ->> 'status' = 'annullata' and actor_id is not null) = 1,
  'annullamento in audit con autore');
select pg_temp.as_user('cassa@pos-test.it');
select public.pos_add_lines(:'o1', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_birra', 'qty', 2))) \gset
select pg_temp.expect_error(format($q$select public.pos_set_discount(%L, 'percentuale', 10, '')$q$, :'o1'), 'sconto senza motivo rifiutato');
select public.pos_set_discount(:'o1', 'percentuale', 10, 'cliente abituale');
select pg_temp.assert((select subtotal = 38 and discount_amount = 3.80 and total = 34.20 from public.pos_orders where id = :'o1'), 'sconto 10%: 38 → 34,20');

-- Paga i due spaghetti «per piatti» con carta: 28 × 34,20/38 = 25,20
select (public.pos_add_payment(:'o1', 'carta', null, null, array[:'l_spag']::uuid[], 'Marco')).id as pay1 \gset
select pg_temp.assert((select amount from public.pos_payments where id = :'pay1') = 25.20, 'quota per piatti con sconto proporzionale');
select pg_temp.assert((select fiscal_status from public.pos_payments where id = :'pay1') = 'da_fiscalizzare', 'pagamento da fiscalizzare (nessuna funzione fiscale)');
select pg_temp.expect_error(format($q$select public.pos_add_payment(%L, 'carta', null, null, array[%L]::uuid[])$q$, :'o1', :'l_spag'), 'un piatto si paga una volta sola');
select pg_temp.expect_error(format($q$select public.pos_close_order(%L)$q$, :'o1'), 'non si chiude senza pagamento completo');
select pg_temp.expect_error(format($q$select public.pos_add_payment(%L, 'contanti', 50)$q$, :'o1'), 'importo oltre il residuo rifiutato');
select pg_temp.expect_error(format($q$select public.pos_add_payment(%L, 'contanti', 9, 5)$q$, :'o1'), 'contante ricevuto insufficiente');
select (public.pos_add_payment(:'o1', 'contanti', 9.00, 20.00)).id as pay2 \gset
select pg_temp.assert((select change_given from public.pos_payments where id = :'pay2') = 11.00, 'resto 20 − 9 = 11');
select pg_temp.assert((select paid = total from public.pos_orders where id = :'o1'), 'conto saldato');
select pg_temp.expect_error(format($q$select public.pos_set_discount(%L, 'percentuale', 50, 'errore')$q$, :'o1'), 'sconto che scende sotto il pagato rifiutato');

select public.pos_close_order(:'o1');
select pg_temp.assert((select status from public.pos_orders where id = :'o1') = 'chiusa', 'comanda chiusa');
-- Scarico: 2 porzioni × 100 g spaghetti = 200 g; vongole 2 × 120 / 0,8 = 300 g; la birra non ha ricetta
select pg_temp.as_user('olga@pos-test.it');
select pg_temp.assert((select -sum(qty) from public.stock_movements where ref_type = 'sale' and ref_id = :'o1' and product_id = :'p_spag') = 200, 'scaricati 200 g di spaghetti');
select pg_temp.assert((select -sum(qty) from public.stock_movements where ref_type = 'sale' and ref_id = :'o1' and product_id = :'p_vong') = 300, 'scaricati 300 g di vongole (scarto 20%)');
select pg_temp.assert((select count(*) from public.stock_movements where ref_type = 'sale' and ref_id = :'o1') = 2, 'solo righe con ricetta e magazzino');
select pg_temp.assert((select kind from public.stock_movements where ref_type = 'sale' and ref_id = :'o1' limit 1) = 'scarico', 'movimento di tipo scarico');
select pg_temp.assert((select qty from public.stock_on_hand where warehouse_id = :'wh_cucina' and product_id = :'p_spag') = 4800, 'giacenza spaghetti 5000 − 200');

select pg_temp.as_user('cassa@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_add_lines(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'o1', :'mi_birra'), 'niente righe su comanda chiusa');
select pg_temp.assert(public.pos_open_order(:'fac_a', :'tav1', null, 2) <> :'o1'::uuid, 'il tavolo si libera dopo la chiusura');

-- Annullo comanda con righe: solo responsabile, porzioni restituite
select public.pos_open_order(:'fac_a', :'tav2', null, 2) as o2 \gset
select public.pos_add_lines(:'o2', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_spag', 'qty', 2)));
select pg_temp.as_user('walter@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_cancel_order(%L, 'errore')$q$, :'o2'), 'il cameriere non annulla una comanda con piatti');
select pg_temp.as_user('cassa@pos-test.it');
select public.pos_cancel_order(:'o2', 'tavolo andato via');
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_spag') = 5, 'porzioni restituite all''annullo');

-- Chiusura turno: atteso = 150 fondo + 9 contanti = 159; contati 158,50 → −0,50
select pg_temp.assert((select expected_cash from public.pos_cash_session_summary(:'sess')) = 159, 'riepilogo turno: contanti attesi');
select public.pos_close_cash_session(:'sess', 158.50, 'manca mezzo euro');
select pg_temp.assert((select expected_cash = 159 and counted_cash = 158.50 and difference = -0.50 from public.pos_cash_sessions where id = :'sess'),
  'turno chiuso: atteso 159, contato 158,50, differenza −0,50');
select pg_temp.expect_error(format($q$select public.pos_close_cash_session(%L, 1)$q$, :'sess'), 'turno non richiudibile');

-- Pagamento e chiusura dell'ombrellone (cuoco non incassa)
select pg_temp.as_user('chef@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_add_payment(%L, 'carta', 14)$q$, :'o_omb'), 'il cuoco non incassa');
select pg_temp.as_user('walter@pos-test.it');
select public.pos_add_payment(:'o_omb', 'carta', 14);
select public.pos_close_order(:'o_omb');

-- ---------------------------------------------------------------------------
-- Isolamento tra aziende
-- ---------------------------------------------------------------------------
select pg_temp.as_user('piero@pos-test.it');
select pg_temp.assert((select count(*) from public.pos_orders) = 0, 'Piero non vede le comande dell''Osteria');
select pg_temp.assert((select count(*) from public.pos_order_lines) = 0, 'Piero non vede le righe dell''Osteria');
select pg_temp.assert((select count(*) from public.pos_payments) = 0, 'Piero non vede i pagamenti dell''Osteria');
select pg_temp.assert((select count(*) from public.pos_cash_sessions) = 0, 'Piero non vede i turni dell''Osteria');
select pg_temp.expect_error(format($q$select public.pos_open_order(%L, %L, null, 2)$q$, :'fac_a', :'tav3'), 'Piero non apre comande nell''Osteria');
select pg_temp.expect_error(format($q$select public.pos_open_order(%L, %L, null, 2)$q$, :'fac_b', :'tav3'), 'un punto di un''altra azienda non vale come destinazione');
select pg_temp.expect_error(format($q$select public.set_item_availability(%L, false)$q$, :'mi_spag'), 'Piero non cambia la disponibilità dell''Osteria');
select pg_temp.expect_error(format($q$select public.pos_set_line_status(%L, 'servita')$q$, :'l_spag'), 'Piero non tocca le righe dell''Osteria');
select pg_temp.expect_error(format($q$select public.pos_cash_session_summary(%L)$q$, :'sess'), 'Piero non legge i turni dell''Osteria');
select public.pos_open_order(:'fac_b', null, 'banco', 0) as o_b \gset
select pg_temp.expect_error(format($q$select public.pos_add_lines(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'o_b', :'mi_birra'),
  'un piatto di un''altra azienda non si ordina');

select pg_temp.as_user('chef@pos-test.it');
select pg_temp.assert((select count(*) from public.pos_payments) = 0, 'il cuoco non vede i pagamenti');
select pg_temp.assert((select count(*) from public.pos_order_lines) > 0, 'il cuoco vede le righe per il KDS');

do $$ begin raise notice '✓ Test POS superati'; end $$;
