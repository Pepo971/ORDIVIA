-- Test del modulo Menu, ricette, food cost e HACCP: isolamento, permessi, calcoli, tracciabilità.
-- Esecuzione: scripts/db-test.sh — ogni assert fallito interrompe con errore.
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
-- Utenti: Marta (titolare Osteria), Walter (cameriere), Cosimo (cuoco), Fabio (manager di un'altra struttura),
-- Ugo (titolare di un'altra azienda)
-- ---------------------------------------------------------------------------
insert into auth.users (email) values
  ('marta@menu-test.it'), ('walter@menu-test.it'), ('cosimo@menu-test.it'), ('ugo@menu-test.it'), ('fabio@menu-test.it');

select pg_temp.as_user('marta@menu-test.it');
select public.create_organization('Osteria Marta srl', 'Osteria del Porto', 'ristorante') as org_m \gset
select pg_temp.as_user('ugo@menu-test.it');
select public.create_organization('Bar Ugo', 'Bar Ugo', 'lido') as org_u \gset

select pg_temp.as_admin();
select id as fac_m from public.facilities where org_id = :'org_m' \gset
select id as fac_u from public.facilities where org_id = :'org_u' \gset
insert into public.facilities (org_id, name, type) values (:'org_m', 'Osteria Due', 'ristorante') returning id as fac_m2 \gset
insert into public.warehouses (org_id, facility_id, name) values (:'org_m', :'fac_m2', 'Dispensa Due') returning id as wh_m2 \gset
select id as wh_m from public.warehouses where org_id = :'org_m' and facility_id = :'fac_m' order by name limit 1 \gset
select id as ps_cucina from public.prep_stations where facility_id = :'fac_m' and kind = 'cucina' \gset
insert into public.memberships (org_id, user_id, role_id, facility_ids) values
  (:'org_m', (select id from auth.users where email = 'walter@menu-test.it'), (select id from public.roles where org_id = :'org_m' and key = 'waiter'), array[:'fac_m']::uuid[]),
  (:'org_m', (select id from auth.users where email = 'cosimo@menu-test.it'), (select id from public.roles where org_id = :'org_m' and key = 'cook'), array[:'fac_m']::uuid[]),
  (:'org_m', (select id from auth.users where email = 'fabio@menu-test.it'), (select id from public.roles where org_id = :'org_m' and key = 'manager'), array[:'fac_m2']::uuid[]);

select pg_temp.assert(:'ps_cucina' is not null, 'centro di produzione cucina creato dal template');

-- ---------------------------------------------------------------------------
-- Menu e ricette (Marta)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('marta@menu-test.it');
insert into public.menu_categories (org_id, facility_id, name) values (:'org_m', :'fac_m', 'Primi') returning id as cat_primi \gset
insert into public.products (org_id, name, base_unit) values (:'org_m', 'Spaghetti MT', 'kg') returning id as p_pasta \gset
insert into public.products (org_id, name, base_unit) values (:'org_m', 'Vongole MT', 'kg') returning id as p_vongole \gset
insert into public.products (org_id, name, base_unit) values (:'org_m', 'Zafferano MT', 'g') returning id as p_zaff \gset

-- Spaghetti alle vongole: 13,20 € IVA 10% → netto 12,00 €
insert into public.menu_items (org_id, facility_id, category_id, prep_station_id, name, price, vat_rate, allergens, course, target_food_cost_pct)
  values (:'org_m', :'fac_m', :'cat_primi', :'ps_cucina', 'Spaghetti alle vongole', 13.20, 10, array['glutine','molluschi'], 2, 30) returning id as mi_vong \gset
-- Risotto: 11,00 € IVA 10% → netto 10,00 €; zafferano senza costo
insert into public.menu_items (org_id, facility_id, category_id, name, price, vat_rate, course, yield_portions, target_food_cost_pct)
  values (:'org_m', :'fac_m', :'cat_primi', 'Risotto allo zafferano', 11.00, 10, 2, 4, 25) returning id as mi_ris \gset

insert into public.recipe_lines (org_id, menu_item_id, product_id, qty, waste_pct) values
  (:'org_m', :'mi_vong', :'p_pasta', 0.100, 0),
  (:'org_m', :'mi_vong', :'p_vongole', 0.250, 20),
  (:'org_m', :'mi_ris', :'p_pasta', 0.400, 0),
  (:'org_m', :'mi_ris', :'p_zaff', 1, 0);

select pg_temp.expect_error(format($q$insert into public.menu_items (org_id, facility_id, category_id, name, price) values (%L, %L, %L, 'X', 1)$q$, :'org_m', :'fac_m2', :'cat_primi'),
  'una voce non può usare una categoria di un''altra struttura');
select pg_temp.expect_error(format($q$update public.prep_stations set warehouse_id = %L where id = %L$q$, :'wh_m2', :'ps_cucina'),
  'un centro di produzione non può scaricare da un magazzino di un''altra struttura');

-- Costi: pasta 2,00 €/kg (medio), vongole medio 10,00 €/kg ma ultimo carico 12,00 €/kg
select pg_temp.as_admin();
insert into public.product_costs (org_id, product_id, avg_cost, last_cost, qty_basis) values
  (:'org_m', :'p_pasta', 2.00, 2.00, 10),
  (:'org_m', :'p_vongole', 10.00, 12.00, 5);

select pg_temp.as_user('marta@menu-test.it');
-- vongole: 0,250 / 0,8 × 10 = 3,125; pasta 0,1 × 2 = 0,2 → 3,325
select pg_temp.assert((select portion_cost from public.menu_item_costs(:'fac_m') where menu_item_id = :'mi_vong') = 3.325, 'costo porzione con scarto 20% = 3,325 €');
select pg_temp.assert((select food_cost_pct from public.menu_food_cost(:'fac_m') where menu_item_id = :'mi_vong') = 27.7, 'food cost % = 3,325 / 12,00 = 27,7%');
select pg_temp.assert((select net_price from public.menu_food_cost(:'fac_m') where menu_item_id = :'mi_vong') = 12.00, 'prezzo netto IVA scorporata = 12,00 €');
select pg_temp.assert((select margin from public.menu_food_cost(:'fac_m') where menu_item_id = :'mi_vong') = 8.68, 'margine = 12,00 − 3,325 = 8,68 €');
-- consigliato: 3,325 / 0,30 × 1,10 = 12,1917 → 12,20
select pg_temp.assert((select recommended_price from public.menu_food_cost(:'fac_m') where menu_item_id = :'mi_vong') = 12.20, 'prezzo consigliato arrotondato per eccesso a 12,20 €');
select pg_temp.assert(not (select over_target from public.menu_food_cost(:'fac_m') where menu_item_id = :'mi_vong'), 'spaghetti sotto il target 30%');
select pg_temp.assert((select portion_cost_last from public.menu_food_cost(:'fac_m') where menu_item_id = :'mi_vong') = 3.95, 'costo all''ultimo prezzo = 0,2 + 0,3125 × 12 = 3,95 €');
-- risotto: 0,4 × 2 / 4 porzioni = 0,20; zafferano senza costo
select pg_temp.assert((select portion_cost = 0.2 and missing_costs = 1 and ingredients = 2 from public.menu_food_cost(:'fac_m') where menu_item_id = :'mi_ris'),
  'resa 4 porzioni e ingrediente senza costo segnalato');

select pg_temp.assert((select line_cost from public.menu_recipe_costs(:'mi_vong') where product_id = :'p_vongole') = 3.125, 'costo riga vongole per porzione = 3,125 €');
select pg_temp.assert((select unit_cost is null from public.menu_recipe_costs(:'mi_ris') where product_id = :'p_zaff'), 'riga senza costo restituita senza costo');
-- Abbassiamo il prezzo: sopra target
update public.menu_items set price = 5.50 where id = :'mi_vong';
select pg_temp.assert((select over_target from public.menu_food_cost(:'fac_m') where menu_item_id = :'mi_vong'), 'a 5,50 € il food cost supera il target');
update public.menu_items set price = 13.20 where id = :'mi_vong';

-- Effetto aumenti: ultimo carico vongole 12 > medio 10 → +2 €/kg × 0,3125 kg = 0,625 €/porzione
select pg_temp.assert((select impact_per_portion from public.menu_supplier_impact(:'fac_m', 90) where menu_item_id = :'mi_vong' and product_id = :'p_vongole') = 0.625,
  'aumento vongole: +0,625 € a porzione');
select pg_temp.assert((select count(*) from public.menu_supplier_impact(:'fac_m', 90) where product_id = :'p_pasta') = 0, 'nessun aumento sulla pasta');

-- Aumento da listino: zafferano da 5 a 6 € per confezione da 1 g
select pg_temp.as_admin();
insert into public.suppliers (org_id, name) values (:'org_m', 'Spezie MT') returning id as sup_m \gset
insert into public.supplier_products (org_id, supplier_id, product_id, pack_label, pack_qty, price) values (:'org_m', :'sup_m', :'p_zaff', 'bustina 1 g', 1, 5.00) returning id as sp_zaff \gset
update public.supplier_products set price = 6.00 where id = :'sp_zaff';
select pg_temp.as_user('marta@menu-test.it');
select pg_temp.assert((select impact_per_portion from public.menu_supplier_impact(:'fac_m', 90) where menu_item_id = :'mi_ris' and product_id = :'p_zaff') = 0.25,
  'aumento listino zafferano: +1 €/g × 0,25 g = +0,25 € a porzione');

-- ---------------------------------------------------------------------------
-- Permessi sui costi
-- ---------------------------------------------------------------------------
select pg_temp.as_user('walter@menu-test.it');
select pg_temp.assert((select count(*) from public.menu_items where facility_id = :'fac_m') = 2, 'il cameriere vede il menu');
select pg_temp.expect_error(format($q$select * from public.menu_food_cost(%L)$q$, :'fac_m'), 'il cameriere non vede il food cost');
select pg_temp.expect_error(format($q$select * from public.menu_item_costs(%L)$q$, :'fac_m'), 'il cameriere non vede i costi porzione');
select pg_temp.expect_error(format($q$select * from public.menu_supplier_impact(%L)$q$, :'fac_m'), 'il cameriere non vede l''effetto aumenti');
select pg_temp.assert((select count(*) from public.recipe_lines) = 0, 'il cameriere non vede le ricette');
select pg_temp.expect_error(format($q$select * from public.menu_recipe_costs(%L)$q$, :'mi_vong'), 'il cameriere non vede i costi della ricetta');
select pg_temp.assert((select count(*) from public.product_costs) = 0, 'il cameriere non vede i costi medi');
update public.menu_items set price = 1 where id = :'mi_vong';
select pg_temp.as_admin();
select pg_temp.assert((select price from public.menu_items where id = :'mi_vong') = 13.20, 'il cameriere non cambia i prezzi');

select pg_temp.as_user('cosimo@menu-test.it');
select pg_temp.expect_error(format($q$select * from public.menu_food_cost(%L)$q$, :'fac_m'), 'il cuoco non vede il food cost');
select pg_temp.assert((select count(*) from public.recipe_lines where menu_item_id = :'mi_vong') = 2, 'il cuoco vede la ricetta');

select pg_temp.as_user('fabio@menu-test.it');
select pg_temp.expect_error(format($q$select * from public.menu_food_cost(%L)$q$, :'fac_m'), 'il manager di un''altra struttura non vede il food cost');
select pg_temp.assert((select count(*) from public.menu_food_cost(:'fac_m2')) = 0, 'il manager vede il food cost della propria struttura');

-- ---------------------------------------------------------------------------
-- Isolamento tra aziende
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ugo@menu-test.it');
select pg_temp.assert((select count(*) from public.menu_items where org_id = :'org_m') = 0, 'Ugo non vede il menu di Marta');
select pg_temp.assert((select count(*) from public.recipe_lines where org_id = :'org_m') = 0, 'Ugo non vede le ricette di Marta');
select pg_temp.expect_error(format($q$select * from public.menu_food_cost(%L)$q$, :'fac_m'), 'Ugo non vede il food cost di Marta');
select pg_temp.expect_error(format($q$select * from public.menu_supplier_impact(%L)$q$, :'fac_m'), 'Ugo non vede gli aumenti di Marta');
select pg_temp.expect_error(format($q$select * from public.menu_recipe_costs(%L)$q$, :'mi_vong'), 'Ugo non vede i costi delle ricette di Marta');
select pg_temp.expect_error(format($q$insert into public.menu_items (org_id, facility_id, name, price) values (%L, %L, 'Intruso', 1)$q$, :'org_m', :'fac_m'),
  'Ugo non crea voci nel menu di Marta');
select pg_temp.expect_error(format($q$insert into public.recipe_lines (org_id, menu_item_id, product_id, qty) values (%L, %L, %L, 1)$q$, :'org_u', :'mi_vong', :'p_pasta'),
  'Ugo non aggiunge ingredienti alle ricette di Marta');

-- ---------------------------------------------------------------------------
-- HACCP: attrezzature e temperature
-- ---------------------------------------------------------------------------
select pg_temp.as_user('marta@menu-test.it');
insert into public.haccp_equipment (org_id, facility_id, name, kind, min_temp, max_temp) values (:'org_m', :'fac_m', 'Frigo carni', 'frigorifero', 0, 4) returning id as eq_frigo \gset
insert into public.haccp_equipment (org_id, facility_id, name, kind, min_temp, max_temp) values (:'org_m', :'fac_m2', 'Frigo sala 2', 'frigorifero', 0, 4) returning id as eq_frigo2 \gset
select pg_temp.expect_error(format($q$insert into public.haccp_equipment (org_id, facility_id, name, min_temp, max_temp) values (%L, %L, 'Rotto', 5, 1)$q$, :'org_m', :'fac_m'),
  'minimo maggiore del massimo rifiutato');

select pg_temp.as_user('cosimo@menu-test.it');
select (public.haccp_record_temperature(:'eq_frigo', 3.2)).id as t_ok \gset
select (public.haccp_record_temperature(:'eq_frigo', 7.5, null, 'porta lasciata aperta')).id as t_ko \gset
select pg_temp.assert((select not out_of_range from public.haccp_temperature_logs where id = :'t_ok'), '3,2 °C nel range 0–4');
select pg_temp.assert((select out_of_range from public.haccp_temperature_logs where id = :'t_ko'), '7,5 °C fuori range calcolato dal sistema');
select public.haccp_set_corrective_action(:'t_ko', 'Merce spostata nella cella, tecnico chiamato');
select pg_temp.assert((select corrective_action is not null and corrective_by is not null from public.haccp_temperature_logs where id = :'t_ko'), 'azione correttiva registrata con autore');
select pg_temp.expect_error(format($q$select public.haccp_set_corrective_action(%L, 'altro')$q$, :'t_ko'), 'azione correttiva non sovrascrivibile');
select pg_temp.expect_error(format($q$update public.haccp_temperature_logs set value = 2 where id = %L$q$, :'t_ko'), 'il registro temperature non si modifica direttamente');
select pg_temp.expect_error(format($q$insert into public.haccp_temperature_logs (org_id, facility_id, equipment_id, value, min_temp, max_temp, out_of_range, recorded_by) values (%L, %L, %L, 3, 0, 4, false, auth.uid())$q$, :'org_m', :'fac_m', :'eq_frigo'),
  'niente inserimenti diretti: solo RPC');
select pg_temp.expect_error(format($q$select public.haccp_record_temperature(%L, 3)$q$, :'eq_frigo2'), 'il cuoco non registra su una struttura non sua');
select pg_temp.expect_error(format($q$insert into public.haccp_equipment (org_id, facility_id, name, min_temp, max_temp) values (%L, %L, 'Frigo cuoco', 0, 4)$q$, :'org_m', :'fac_m'),
  'il cuoco non configura le attrezzature');

select pg_temp.as_user('walter@menu-test.it');
select pg_temp.expect_error(format($q$select public.haccp_record_temperature(%L, 3)$q$, :'eq_frigo'), 'il cameriere non registra temperature');
select pg_temp.assert((select count(*) from public.haccp_temperature_logs) = 0, 'il cameriere non legge il registro HACCP');

select pg_temp.as_user('ugo@menu-test.it');
select pg_temp.assert((select count(*) from public.haccp_equipment where org_id = :'org_m') = 0, 'Ugo non vede le attrezzature di Marta');
select pg_temp.assert((select count(*) from public.haccp_temperature_logs where org_id = :'org_m') = 0, 'Ugo non vede le temperature di Marta');
select pg_temp.expect_error(format($q$select public.haccp_record_temperature(%L, 3)$q$, :'eq_frigo'), 'Ugo non registra sulle attrezzature di Marta');

-- ---------------------------------------------------------------------------
-- HACCP: etichette, lotti, tracciabilità
-- ---------------------------------------------------------------------------
select pg_temp.as_user('marta@menu-test.it');
select public.manual_load(:'wh_m', :'p_vongole', 5, null, 'test') as mv1 \gset
select pg_temp.as_admin();
-- lotto fornitore sul carico (i carichi da ricezione portano lotto e scadenza)
insert into public.stock_movements (org_id, facility_id, warehouse_id, product_id, qty, kind, lot, expires_on, ref_type, created_by)
  values (:'org_m', :'fac_m', :'wh_m', :'p_vongole', 3, 'carico', 'VONG-778', current_date + 2, 'receipt', (select id from auth.users where email = 'marta@menu-test.it'));

select pg_temp.as_user('cosimo@menu-test.it');
select pg_temp.assert((select count(*) from public.haccp_available_lots(:'fac_m') where lot = 'VONG-778') = 1, 'lotto del carico disponibile per la tracciabilità');
select (public.haccp_create_label(:'fac_m', 'preparazione', 3, :'mi_vong', null, null, now(), null, '0–4 °C', null,
        jsonb_build_array(jsonb_build_object('product_id', :'p_vongole', 'lot', 'VONG-778', 'expires_on', to_char(current_date + 2, 'YYYY-MM-DD'))))).id as lbl1 \gset
select (public.haccp_create_label(:'fac_m', 'apertura', 2, null, :'p_pasta', null, null, now() - interval '1 hour', null, array['glutine'])).id as lbl2 \gset
select (public.haccp_create_label(:'fac_m', 'preparazione', 1, null, null, 'Fondo bruno')).id as lbl3 \gset

select pg_temp.assert((select lot_code ~ '^L\d{6}-001$' from public.haccp_labels where id = :'lbl1'), 'lotto interno generato L+AAMMGG-001');
select pg_temp.assert((select lot_code ~ '-003$' from public.haccp_labels where id = :'lbl3'), 'progressivo del giorno per struttura');
select pg_temp.assert((select allergens = array['glutine','molluschi'] from public.haccp_labels where id = :'lbl1'), 'allergeni ereditati dalla voce di menu');
select pg_temp.assert((select expiry_capped and expires_at < prepared_at + interval '3 days' from public.haccp_labels where id = :'lbl1'),
  'scadenza limitata dal lotto di origine');
select pg_temp.assert((select expires_at = opened_at + interval '2 days' from public.haccp_labels where id = :'lbl2'), 'etichetta di apertura: scadenza dall''apertura');
select pg_temp.assert((select length(token) = 32 from public.haccp_labels where id = :'lbl1'), 'token QR non indovinabile (128 bit)');
select pg_temp.assert((select count(*) from public.haccp_labels where source_lots @> '[{"lot":"VONG-778"}]') = 1, 'dal lotto di origine si risale alla preparazione');
select pg_temp.assert(public.haccp_label_by_token((select token from public.haccp_labels where id = :'lbl1')) = :'lbl1'::uuid, 'il QR risolve l''etichetta');
select pg_temp.expect_error(format($q$select public.haccp_create_label(%L, 'preparazione', 1, null, null, 'X', null, null, null, array['plutonio'])$q$, :'fac_m'), 'allergene sconosciuto rifiutato');
select pg_temp.expect_error(format($q$select public.haccp_create_label(%L, 'preparazione', 1, null, null, 'X', now() + interval '2 days')$q$, :'fac_m'), 'preparazione nel futuro rifiutata');
select pg_temp.expect_error(format($q$select public.haccp_create_label(%L, 'preparazione', 1, null, %L)$q$, :'fac_m', gen_random_uuid()), 'prodotto inesistente rifiutato');
select pg_temp.expect_error(format($q$select public.haccp_create_label(%L, 'preparazione', 1)$q$, :'fac_m'), 'etichetta senza contenuto rifiutata');
select pg_temp.expect_error(format($q$update public.haccp_labels set expires_at = now() + interval '30 days' where id = %L$q$, :'lbl1'), 'scadenza non modificabile direttamente');
select public.haccp_close_label(:'lbl3', 'consumata');
select pg_temp.expect_error(format($q$select public.haccp_close_label(%L, 'scartata')$q$, :'lbl3'), 'etichetta già chiusa');

select pg_temp.as_user('walter@menu-test.it');
select pg_temp.expect_error(format($q$select public.haccp_create_label(%L, 'preparazione', 1, null, null, 'X')$q$, :'fac_m'), 'il cameriere non crea etichette');
select pg_temp.assert((select count(*) from public.haccp_labels) = 0, 'il cameriere non vede le etichette');

select pg_temp.as_user('ugo@menu-test.it');
select pg_temp.assert((select count(*) from public.haccp_labels where org_id = :'org_m') = 0, 'Ugo non vede le etichette di Marta');
select pg_temp.expect_error(format($q$select public.haccp_label_by_token(%L)$q$, (select token from public.haccp_labels where id = :'lbl1')), 'Ugo non risolve il QR di Marta');
select pg_temp.expect_error(format($q$select public.haccp_close_label(%L, 'scartata')$q$, :'lbl1'), 'Ugo non chiude etichette di Marta');
select pg_temp.expect_error(format($q$select public.haccp_create_label(%L, 'preparazione', 1, %L)$q$, :'fac_u', :'mi_vong'), 'Ugo non etichetta con voci di menu di Marta');
select pg_temp.expect_error(format($q$select * from public.haccp_available_lots(%L)$q$, :'fac_m'), 'Ugo non vede i lotti di Marta');

-- Lotti per struttura e giorno: la seconda struttura riparte da 001
select pg_temp.as_user('marta@menu-test.it');
select pg_temp.assert((public.haccp_create_label(:'fac_m2', 'preparazione', 1, null, null, 'Brodo')).lot_code ~ '-001$', 'progressivo separato per struttura');

-- Audit
select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.audit_log where entity = 'haccp_temperature_logs' and entity_id = :'t_ko' and actor_id is not null) = 2,
  'rilevazione e azione correttiva in audit con autore');
select pg_temp.assert((select count(*) from public.audit_log where entity = 'haccp_labels' and entity_id = :'lbl3') = 2, 'creazione e chiusura etichetta in audit');

do $$ begin raise notice '✓ Test menu e HACCP superati'; end $$;
