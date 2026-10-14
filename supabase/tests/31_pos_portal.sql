-- Test integrazione POS ↔ portale QR: righe «da_confermare» fuori dal conto, dal KDS, dai pagamenti per piatti,
-- dallo scarico e dalle analisi; chiusura bloccata finché non sono gestite; annullo che restituisce le porzioni;
-- collegamento del cliente CRM alla comanda; permessi anon ancora intatti sulle public_*.
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
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  set role anon;
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
-- Setup: Bagno Onda (titolare Ornella, cameriere Willy, cuoco Carlo, cassiere Cesare); Altro (titolare Aldo)
-- ---------------------------------------------------------------------------
select pg_temp.as_admin();
insert into auth.users (email) values ('ornella@pos-test.it'), ('willy@pos-test.it'), ('carlo@pos-test.it'), ('cesare@pos-test.it'), ('aldo@pos-test.it');

select pg_temp.as_user('ornella@pos-test.it');
select public.create_organization('Bagno Onda srl', 'Bagno Onda', 'lido') as org_a \gset
select pg_temp.as_user('aldo@pos-test.it');
select public.create_organization('Altro srl', 'Altro', 'ristorante') as org_b \gset

select pg_temp.as_admin();
select id as fac_a from public.facilities where org_id = :'org_a' \gset
select id as ps_cucina, warehouse_id as wh_cucina from public.prep_stations where org_id = :'org_a' and kind = 'cucina' \gset
insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_a', u.id, r.id, array[:'fac_a']::uuid[]
from auth.users u join public.roles r on r.org_id = :'org_a' and r.key = case u.email
  when 'willy@pos-test.it' then 'waiter' when 'carlo@pos-test.it' then 'cook' when 'cesare@pos-test.it' then 'cashier' end
where u.email in ('willy@pos-test.it', 'carlo@pos-test.it', 'cesare@pos-test.it');
insert into public.service_points (org_id, facility_id, kind, label) values (:'org_a', :'fac_a', 'ombrellone', '7') returning id as omb7, public_token as tok7 \gset
insert into public.service_points (org_id, facility_id, kind, label) values (:'org_a', :'fac_a', 'ombrellone', '8') returning id as omb8, public_token as tok8 \gset

select pg_temp.as_user('ornella@pos-test.it');
insert into public.products (org_id, name, base_unit) values (:'org_a', 'Pane', 'pz') returning id as p_pane \gset
insert into public.menu_items (org_id, facility_id, prep_station_id, name, price, vat_rate, portions_left)
  values (:'org_a', :'fac_a', :'ps_cucina', 'Piadina', 8.00, 10, 10) returning id as mi_pia \gset
insert into public.recipe_lines (org_id, menu_item_id, product_id, qty) values (:'org_a', :'mi_pia', :'p_pane', 1);
select public.manual_load(:'wh_cucina', :'p_pane', 100, 0.5, 'test');
insert into public.portal_settings (org_id, facility_id, enabled, order_kinds) values (:'org_a', :'fac_a', true, array['ombrellone']);
insert into public.customers (org_id, full_name, phone) values (:'org_a', 'Mario Bianchi', '+39 333 1112222') returning id as cust \gset

-- ---------------------------------------------------------------------------
-- Ordine misto: il cameriere invia 1 piadina, l'ospite ne chiede 2 dal QR
-- ---------------------------------------------------------------------------
select pg_temp.as_user('willy@pos-test.it');
select public.pos_open_order(:'fac_a', :'omb7', null, 0) as o7 \gset
select public.pos_add_lines(:'o7', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_pia', 'qty', 1)));
select id as l_staff from public.pos_order_lines where order_id = :'o7' \gset

select pg_temp.as_anon();
select (public.public_portal_place_order(:'tok7', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_pia', 'qty', 2)), 'Giulia', 'sotto l''ombrellone', 'lattosio') ->> 'reference') as sub1 \gset

select pg_temp.as_user('willy@pos-test.it');
select id as l_web from public.pos_order_lines where portal_submission_id = :'sub1' \gset
select pg_temp.assert((select status from public.pos_order_lines where id = :'l_web') = 'da_confermare', 'riga online da confermare');
select pg_temp.assert((select subtotal = 8 and total = 8 from public.pos_orders where id = :'o7'), 'il conto esclude le righe da confermare (8, non 24)');
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_pia') = 7, 'porzioni riservate anche per l''online (10 − 1 − 2)');

select pg_temp.as_user('carlo@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_set_line_status(%L, 'in_preparazione')$q$, :'l_web'), 'il KDS non lavora righe da confermare');
select pg_temp.expect_error(format($q$select public.pos_set_lines_status(array[%L]::uuid[], 'pronta')$q$, :'l_web'), 'nemmeno in blocco');

select pg_temp.as_user('cesare@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_set_line_status(%L, 'annullata', 'non la vogliamo')$q$, :'l_web'), 'neanche il responsabile annulla: si rifiuta');
select public.pos_open_cash_session(:'fac_a', 100) as sess \gset
select pg_temp.expect_error(format($q$select public.pos_add_payment(%L, 'carta', null, null, array[%L]::uuid[])$q$, :'o7', :'l_web'), 'non si pagano per piatti righe da confermare');
select public.pos_add_payment(:'o7', 'carta', 8);
select pg_temp.expect_error(format($q$select public.pos_close_order(%L)$q$, :'o7'), 'chiusura bloccata con righe online da confermare');

-- Accettazione: entrano nel conto e in produzione
select pg_temp.as_user('willy@pos-test.it');
select public.portal_accept_submission(:'sub1');
select pg_temp.assert((select status from public.pos_order_lines where id = :'l_web') = 'inviata', 'accettata: in produzione');
select pg_temp.assert((select total from public.pos_orders where id = :'o7') = 24, 'accettata: nel conto (8 + 16)');
select public.pos_add_payment(:'o7', 'carta', null, null, array[:'l_web']::uuid[]);
select public.pos_close_order(:'o7');
select pg_temp.as_user('ornella@pos-test.it');
select pg_temp.assert((select -sum(qty) from public.stock_movements where ref_type = 'sale' and ref_id = :'o7') = 3, 'scarico per 3 piadine confermate');

-- ---------------------------------------------------------------------------
-- Annullo di una comanda con righe online: porzioni restituite, invio chiuso come rifiutato
-- ---------------------------------------------------------------------------
select pg_temp.as_anon();
select (public.public_portal_place_order(:'tok8', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_pia', 'qty', 2))) ->> 'reference') as sub2 \gset
select pg_temp.as_user('ornella@pos-test.it');
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_pia') = 5, 'porzioni riservate dal secondo ordine online');
select id as o8 from public.pos_orders where service_point_id = :'omb8' and status = 'aperta' \gset
select pg_temp.as_user('willy@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_cancel_order(%L, 'errore')$q$, :'o8'), 'senza piatti confermati ma con righe online: serve un responsabile');
select pg_temp.as_user('cesare@pos-test.it');
select public.pos_cancel_order(:'o8', 'ospite andato via');
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_pia') = 7, 'porzioni online restituite all''annullo');
select pg_temp.assert((select status from public.portal_submissions where id = :'sub2') = 'rifiutato', 'invio chiuso come rifiutato');
select pg_temp.assert((select count(*) from public.pos_order_lines where order_id = :'o8' and status <> 'annullata') = 0, 'righe online annullate');

-- ---------------------------------------------------------------------------
-- Cliente collegato alla comanda (CRM)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('willy@pos-test.it');
select public.pos_open_order(:'fac_a', :'omb8', null, 0) as o8b \gset
select pg_temp.expect_error(format($q$select public.pos_set_order_customer(%L, %L)$q$, :'o8b', :'cust'), 'il cameriere senza accesso ai clienti non collega');
select public.pos_add_lines(:'o8b', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_pia', 'qty', 1)));
select pg_temp.as_user('cesare@pos-test.it');
select public.pos_set_order_customer(:'o8b', :'cust');
select public.pos_add_payment(:'o8b', 'contanti', 8, 10);
select public.pos_close_order(:'o8b');
select pg_temp.assert((select customer_id from public.pos_orders where id = :'o8b') = :'cust'::uuid, 'il cliente resta collegato dopo la chiusura');
select pg_temp.as_user('aldo@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_set_order_customer(%L, null)$q$, :'o8b'), 'un''altra azienda non tocca il cliente della comanda');
insert into public.customers (org_id, full_name) values (:'org_b', 'Estraneo') returning id as cust_b \gset
select pg_temp.as_user('cesare@pos-test.it');
select pg_temp.expect_error(format($q$select public.pos_set_order_customer(%L, %L)$q$, :'o8b', :'cust_b'), 'cliente di un''altra azienda rifiutato');

-- ---------------------------------------------------------------------------
-- Analisi: le righe da confermare non sono vendute
-- ---------------------------------------------------------------------------
select pg_temp.as_anon();
select public.public_portal_place_order(:'tok8', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_pia', 'qty', 4)));
select pg_temp.as_user('ornella@pos-test.it');
select (now() at time zone 'Europe/Rome')::date as today \gset
select pg_temp.assert((public.analytics_operational(:'fac_a', :'today', :'today') ->> 'items_sold')::int = 4,
  'analisi: vendute 4 piadine (3 + 1), escluse le 4 da confermare e le annullate');

-- ---------------------------------------------------------------------------
-- Permessi di esecuzione: anon conserva solo le funzioni pubbliche
-- ---------------------------------------------------------------------------
select pg_temp.as_admin();
select pg_temp.assert(has_function_privilege('anon', 'public.public_portal_place_order(text, jsonb, text, text, text, text)', 'execute'), 'anon esegue ancora public_portal_place_order');
select pg_temp.assert(has_function_privilege('anon', 'public.public_portal_point(text)', 'execute'), 'anon esegue ancora public_portal_point');
select pg_temp.assert(has_function_privilege('anon', 'public.public_reservation_services(text)', 'execute'), 'anon esegue ancora public_reservation_services');
select pg_temp.assert(not has_function_privilege('anon', 'public.pos_close_order(uuid)', 'execute'), 'anon non esegue pos_close_order');
select pg_temp.assert(not has_function_privilege('anon', 'public.pos_set_order_customer(uuid, uuid)', 'execute'), 'anon non esegue pos_set_order_customer');
select pg_temp.assert(not has_function_privilege('anon', 'public.analytics_operational(uuid, date, date)', 'execute'), 'anon non esegue le analisi');
select pg_temp.assert(not has_function_privilege('authenticated', 'app.pos_recalc(uuid)', 'execute'), 'pos_recalc resta interna');

do $$ begin raise notice '✓ Test integrazione POS ↔ portale superati'; end $$;
