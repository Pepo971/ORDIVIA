-- Test Portale QR: configurazione con RLS, accesso anonimo solo tramite public_portal_*, token, tipi di punto,
-- orari, limite di frequenza, esauriti e porzioni, ordini nella comanda giusta, accettazione e rifiuto in sala.
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
-- Setup: Lido Sole (titolare Sara, cameriere Wanda, collaboratore Ugo) e Hotel Luna (titolare Luca)
-- ---------------------------------------------------------------------------
select pg_temp.as_admin();
insert into auth.users (email) values ('sara@portal-test.it'), ('wanda@portal-test.it'), ('ugo@portal-test.it'), ('luca@portal-test.it');

select pg_temp.as_user('sara@portal-test.it');
select public.create_organization('Lido Sole srl', 'Lido Sole', 'lido') as org_a \gset
select pg_temp.as_user('luca@portal-test.it');
select public.create_organization('Hotel Luna srl', 'Hotel Luna', 'hotel') as org_b \gset

select pg_temp.as_admin();
select id as fac_a, public_token as ftok_a from public.facilities where org_id = :'org_a' \gset
select id as fac_b, public_token as ftok_b from public.facilities where org_id = :'org_b' \gset
select pg_temp.assert(:'ftok_a' ~ '^[0-9a-f]{32}$', 'la struttura ha un token pubblico');
select id as ps_cucina from public.prep_stations where org_id = :'org_a' and kind = 'cucina' limit 1 \gset

insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_a', u.id, r.id, array[:'fac_a']::uuid[]
from auth.users u join public.roles r on r.org_id = :'org_a' and r.key = case u.email when 'wanda@portal-test.it' then 'waiter' else 'staff' end
where u.email in ('wanda@portal-test.it', 'ugo@portal-test.it');

-- Punti di servizio e menu
insert into public.service_points (org_id, facility_id, kind, label, zone) values (:'org_a', :'fac_a', 'ombrellone', '12', 'Fila A') returning id as omb12, public_token as tok_omb \gset
insert into public.service_points (org_id, facility_id, kind, label) values (:'org_a', :'fac_a', 'tavolo', '5') returning id as tav5, public_token as tok_tav \gset
insert into public.service_points (org_id, facility_id, kind, label) values (:'org_a', :'fac_a', 'camera', '101') returning id as cam101, public_token as tok_cam \gset
insert into public.service_points (org_id, facility_id, kind, label) values (:'org_b', :'fac_b', 'tavolo', '1') returning id as tav_b, public_token as tok_b \gset

select pg_temp.as_user('sara@portal-test.it');
insert into public.menu_categories (org_id, facility_id, name, sort) values (:'org_a', :'fac_a', 'Panini', 1) returning id as cat \gset
insert into public.menu_items (org_id, facility_id, category_id, prep_station_id, name, price, vat_rate, allergens, portions_left)
  values (:'org_a', :'fac_a', :'cat', :'ps_cucina', 'Panino caprese', 7.50, 10, array['glutine','latte'], 5) returning id as mi_pan \gset
insert into public.menu_items (org_id, facility_id, category_id, name, price, vat_rate)
  values (:'org_a', :'fac_a', :'cat', 'Acqua 50cl', 1.50, 10) returning id as mi_acqua \gset
insert into public.menu_items (org_id, facility_id, category_id, name, price, vat_rate, available)
  values (:'org_a', :'fac_a', :'cat', 'Granita', 3.00, 10, false) returning id as mi_gran \gset
insert into public.menu_items (org_id, facility_id, name, price, vat_rate, active)
  values (:'org_a', :'fac_a', 'Vecchio piatto', 9.00, 10, false) returning id as mi_old \gset
select pg_temp.as_user('luca@portal-test.it');
insert into public.menu_items (org_id, facility_id, name, price, vat_rate) values (:'org_b', :'fac_b', 'Club sandwich', 12, 10) returning id as mi_b \gset

-- ---------------------------------------------------------------------------
-- Configurazione: RLS e isolamento
-- ---------------------------------------------------------------------------
select pg_temp.as_user('sara@portal-test.it');
insert into public.portal_settings (org_id, facility_id, enabled, display_name, welcome_it, welcome_en, accent, phone, whatsapp, order_kinds)
values (:'org_a', :'fac_a', true, 'Lido Sole', 'Benvenuti!', 'Welcome!', 'corallo', '+39 0541 000000', '+39 333 0000000', array['tavolo','ombrellone']);
insert into public.portal_offers (org_id, facility_id, title_it, title_en, price, valid_to) values (:'org_a', :'fac_a', 'Pranzo in spiaggia', 'Beach lunch', 15, current_date + 10);
insert into public.portal_offers (org_id, facility_id, title_it, price, valid_to) values (:'org_a', :'fac_a', 'Offerta scaduta', 10, current_date - 1);
insert into public.portal_offers (org_id, facility_id, title_it, active) values (:'org_a', :'fac_a', 'Offerta spenta', false);
insert into public.portal_info_blocks (org_id, facility_id, title_it, body_it, title_en, body_en) values (:'org_a', :'fac_a', 'Wi-Fi', 'Rete LidoSole', 'Wi-Fi', 'Network LidoSole');

select pg_temp.expect_error(format($q$update public.portal_settings set accent = 'fucsia' where facility_id = %L$q$, :'fac_a'), 'colore fuori palette rifiutato');
select pg_temp.expect_error(format($q$update public.portal_settings set order_kinds = array['tavolo','astronave'] where facility_id = %L$q$, :'fac_a'), 'tipo di punto sconosciuto rifiutato');
select pg_temp.expect_error(format($q$update public.portal_settings set cover_url = 'javascript:alert(1)' where facility_id = %L$q$, :'fac_a'), 'URL di copertina solo https');

select pg_temp.as_user('luca@portal-test.it');
select pg_temp.assert((select count(*) from public.portal_settings) = 0, 'Luca non vede la configurazione del Lido');
select pg_temp.assert((select count(*) from public.portal_offers) = 0, 'Luca non vede le offerte del Lido');
update public.portal_settings set display_name = 'Hackerato' where facility_id = :'fac_a';
select pg_temp.expect_error(format($q$insert into public.portal_offers (org_id, facility_id, title_it) values (%L, %L, 'X')$q$, :'org_a', :'fac_a'), 'Luca non scrive offerte nel Lido');
select pg_temp.expect_error(format($q$insert into public.portal_info_blocks (org_id, facility_id, title_it, body_it) values (%L, %L, 'X', 'Y')$q$, :'org_b', :'fac_a'), 'FK composite: niente righe incrociate tra aziende');
select pg_temp.expect_error(format($q$select public.portal_accept_submission(gen_random_uuid())$q$), 'accettare un invio inesistente fallisce');

select pg_temp.as_admin();
select pg_temp.assert((select display_name from public.portal_settings where facility_id = :'fac_a') = 'Lido Sole', 'aggiornamento cross-tenant senza effetto');

select pg_temp.as_user('ugo@portal-test.it');
select pg_temp.assert((select count(*) from public.portal_settings) = 0, 'il collaboratore senza permessi non vede la configurazione');
select pg_temp.expect_error(format($q$insert into public.portal_offers (org_id, facility_id, title_it) values (%L, %L, 'X')$q$, :'org_a', :'fac_a'), 'il collaboratore non crea offerte');
select pg_temp.as_user('wanda@portal-test.it');
select pg_temp.assert((select count(*) from public.portal_settings) = 1, 'la sala legge la configurazione');
select pg_temp.expect_error(format($q$insert into public.portal_offers (org_id, facility_id, title_it) values (%L, %L, 'X')$q$, :'org_a', :'fac_a'), 'il cameriere non modifica il portale');

-- ---------------------------------------------------------------------------
-- Anonimo: nessuna tabella leggibile, solo public_portal_*
-- ---------------------------------------------------------------------------
select pg_temp.as_anon();
select pg_temp.expect_error('select count(*) from public.portal_settings', 'anon non legge portal_settings');
select pg_temp.expect_error('select count(*) from public.portal_offers', 'anon non legge portal_offers');
select pg_temp.expect_error('select count(*) from public.portal_submissions', 'anon non legge portal_submissions');
select pg_temp.expect_error('select count(*) from public.portal_rate_events', 'anon non legge portal_rate_events');
select pg_temp.assert((select count(*) from public.service_points) = 0, 'anon non vede i punti di servizio (RLS)');
select pg_temp.assert((select count(*) from public.menu_items) = 0, 'anon non vede il menu direttamente (RLS)');
select pg_temp.assert((select count(*) from public.facilities) = 0, 'anon non vede le strutture (RLS)');
select pg_temp.assert((select count(*) from public.pos_orders) = 0, 'anon non vede le comande (RLS)');
select pg_temp.expect_error(format($q$select public.pos_open_order(%L, null, 'banco', 0)$q$, :'fac_a'), 'anon non esegue le RPC del POS');
select pg_temp.expect_error(format($q$select public.portal_accept_submission(%L)$q$, gen_random_uuid()), 'anon non accetta ordini');
select pg_temp.assert(
  (select bool_and(has_function_privilege('anon', p.oid, 'execute') = (p.proname like 'public\_portal\_%'))
     from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'public\_portal\_%' or p.proname like 'portal\_%')),
  'anon esegue solo le funzioni public_portal_*');

select pg_temp.expect_error($q$select public.public_portal_point('nonvalido')$q$, 'token malformato rifiutato');
select pg_temp.expect_error($q$select public.public_portal_point('00000000000000000000000000000000')$q$, 'token inesistente rifiutato');
select pg_temp.expect_error(format($q$select public.public_portal_point(%L)$q$, :'ftok_a'), 'il token della struttura non vale come punto');

select public.public_portal_point(:'tok_omb') as p_omb \gset
select pg_temp.assert((:'p_omb'::jsonb ->> 'enabled')::boolean, 'portale attivo');
select pg_temp.assert(:'p_omb'::jsonb #>> '{point,label}' = '12' and :'p_omb'::jsonb #>> '{point,kind}' = 'ombrellone', 'il punto è riconosciuto');
select pg_temp.assert(:'p_omb'::jsonb #>> '{facility,name}' = 'Lido Sole', 'nome visualizzato');
select pg_temp.assert((:'p_omb'::jsonb #>> '{ordering,allowed}')::boolean, 'dall''ombrellone si ordina');
select pg_temp.assert(jsonb_array_length(:'p_omb'::jsonb -> 'offers') = 1, 'solo offerte attive e valide');
select pg_temp.assert(jsonb_array_length(:'p_omb'::jsonb -> 'info') = 1, 'blocchi informativi');
select pg_temp.assert(not (:'p_omb'::text ~ 'vat_rate|portions_left|prep_station|org_id|facility_id|service_point_id|cost'), 'nessun campo interno o di costo nel payload');
select pg_temp.assert(not (:'p_omb'::text like '%Vecchio piatto%'), 'piatti non attivi esclusi');
select pg_temp.assert((select (i ->> 'sold_out')::boolean from jsonb_array_elements(:'p_omb'::jsonb #> '{menu,0,items}') i where i ->> 'name' = 'Granita'), 'granita segnata esaurita');
select pg_temp.assert((select i -> 'allergens' ? 'glutine' from jsonb_array_elements(:'p_omb'::jsonb #> '{menu,0,items}') i where i ->> 'name' = 'Panino caprese'), 'allergeni nel menu');

select public.public_portal_point(:'tok_cam') as p_cam \gset
select pg_temp.assert(not (:'p_cam'::jsonb #>> '{ordering,allowed}')::boolean and :'p_cam'::jsonb #>> '{ordering,reason}' = 'tipo_non_abilitato', 'dalla camera non si ordina');
select public.public_portal_facility(:'ftok_a') as p_fac \gset
select pg_temp.assert(:'p_fac'::jsonb -> 'point' = 'null'::jsonb and not (:'p_fac'::jsonb #>> '{ordering,allowed}')::boolean, 'QR generico: niente ordini, solo vetrina');
select public.public_portal_facility(:'ftok_b') as p_fac_b \gset
select pg_temp.assert(not (:'p_fac_b'::jsonb ->> 'enabled')::boolean, 'Hotel Luna: portale non ancora attivo');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'tok_b', :'mi_b'),
  'portale disattivato: niente ordini');

-- ---------------------------------------------------------------------------
-- Ordini dal portale
-- ---------------------------------------------------------------------------
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'tok_cam', :'mi_acqua'),
  'tipo di punto non abilitato rifiutato');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, '[]'::jsonb)$q$, :'tok_omb'), 'carrello vuoto rifiutato');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 21)))$q$, :'tok_omb', :'mi_acqua'),
  'quantità oltre 20 rifiutata');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, (select jsonb_agg(jsonb_build_object('menu_item_id', %L, 'qty', 1)) from generate_series(1, 31)))$q$, :'tok_omb', :'mi_acqua'),
  'più di 30 righe rifiutate');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)), repeat('x', 61))$q$, :'tok_omb', :'mi_acqua'),
  'nome troppo lungo rifiutato');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'tok_omb', :'mi_gran'),
  'piatto esaurito rifiutato');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'tok_omb', :'mi_old'),
  'piatto non attivo rifiutato');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'tok_omb', :'mi_b'),
  'piatto di un''altra struttura rifiutato');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1), jsonb_build_object('menu_item_id', %L, 'qty', 6)))$q$, :'tok_omb', :'mi_acqua', :'mi_pan'),
  'porzioni insufficienti (5): ordine intero rifiutato');

select public.public_portal_place_order(:'tok_omb',
  jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_pan', 'qty', 2, 'notes', 'senza pomodoro'),
                    jsonb_build_object('menu_item_id', :'mi_acqua', 'qty', 2)),
  'Giulia', 'Portateci anche i tovaglioli', 'Celiachia', 'it') as r1 \gset
select pg_temp.assert((:'r1'::jsonb ->> 'total')::numeric = 18.00, 'totale 2×7,50 + 2×1,50 = 18');
select (:'r1'::jsonb ->> 'reference') as ref1 \gset
select public.public_portal_order_status(:'tok_omb', :'ref1') as st1 \gset
select pg_temp.assert(:'st1'::jsonb ->> 'status' = 'da_confermare', 'l''ospite vede l''ordine in attesa di conferma');
select pg_temp.expect_error(format($q$select public.public_portal_order_status(%L, %L)$q$, :'tok_tav', :'ref1'), 'lo stato non si legge con il token di un altro punto');

select pg_temp.as_admin();
select id as o_omb, source as o_src, facility_id as o_fac, service_point_id as o_sp, total as o_tot from public.pos_orders where service_point_id = :'omb12' and status = 'aperta' \gset
select pg_temp.assert(:'o_src' = 'portale' and :'o_fac' = :'fac_a' and :'o_sp' = :'omb12', 'comanda aperta sul punto giusto, origine portale');
select pg_temp.assert(:'o_tot'::numeric = 0, 'il conto esclude le righe da confermare');
select pg_temp.assert((select count(*) from public.pos_order_lines where order_id = :'o_omb' and status = 'da_confermare' and source = 'portale') = 2, 'righe da confermare con origine portale');
select pg_temp.assert((select bool_and(allergy and allergy_note = 'Celiachia') from public.pos_order_lines where order_id = :'o_omb'), 'allergie riportate sulle righe');
select pg_temp.assert((select prep_station_id from public.pos_order_lines where order_id = :'o_omb' and menu_item_id = :'mi_pan') = :'ps_cucina'::uuid, 'instradamento al centro di produzione predisposto');
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_pan') = 3, 'porzioni scalate 5 → 3');
select pg_temp.assert((select guest_name from public.portal_submissions where id = :'ref1') = 'Giulia', 'nome ospite salvato sull''invio');

-- La cucina non vede ancora le righe da confermare (filtro KDS: inviata/in_preparazione/pronta)
select pg_temp.assert((select count(*) from public.pos_order_lines where order_id = :'o_omb' and status in ('inviata','in_preparazione','pronta')) = 0, 'niente in produzione prima della conferma');

-- Secondo ordine dallo stesso punto: stessa comanda
select pg_temp.as_anon();
select public.public_portal_place_order(:'tok_omb', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_pan', 'qty', 1))) as r2 \gset
select (:'r2'::jsonb ->> 'reference') as ref2 \gset
select pg_temp.as_admin();
select pg_temp.assert((select count(distinct order_id) from public.portal_submissions where service_point_id = :'omb12') = 1, 'secondo invio nella stessa comanda aperta');

-- Accettazione in sala
select pg_temp.as_user('ugo@portal-test.it');
select pg_temp.expect_error(format($q$select public.portal_accept_submission(%L)$q$, :'ref1'), 'il collaboratore non accetta ordini');
select pg_temp.as_user('luca@portal-test.it');
select pg_temp.expect_error(format($q$select public.portal_accept_submission(%L)$q$, :'ref1'), 'un''altra azienda non accetta ordini');
select pg_temp.assert((select count(*) from public.portal_submissions) = 0, 'un''altra azienda non vede gli invii');
select pg_temp.as_user('wanda@portal-test.it');
select pg_temp.assert((select count(*) from public.portal_submissions where facility_id = :'fac_a') = 2, 'la sala vede gli invii');
select pg_temp.expect_error(format($q$update public.portal_submissions set status = 'accettato' where id = %L$q$, :'ref1'), 'niente scritture dirette sugli invii');
select pg_temp.assert(public.portal_accept_submission(:'ref1') = 2, 'due righe accettate');
select pg_temp.assert((select status from public.pos_order_lines where portal_submission_id = :'ref1' and menu_item_id = :'mi_pan') = 'inviata', 'panino inviato in cucina');
select pg_temp.assert((select status from public.pos_order_lines where portal_submission_id = :'ref1' and menu_item_id = :'mi_acqua') = 'pronta', 'acqua senza centro: subito pronta');
select pg_temp.expect_error(format($q$select public.portal_accept_submission(%L)$q$, :'ref1'), 'non si accetta due volte');

-- Rifiuto: porzioni restituite
select pg_temp.expect_error(format($q$select public.portal_reject_submission(%L, '')$q$, :'ref2'), 'il rifiuto richiede un motivo');
select public.portal_reject_submission(:'ref2', 'Cucina chiusa');
select pg_temp.assert((select portions_left from public.menu_items where id = :'mi_pan') = 3, 'porzione restituita dopo il rifiuto');
select pg_temp.assert((select status from public.portal_submissions where id = :'ref2') = 'rifiutato', 'invio rifiutato');
select pg_temp.assert((select total from public.pos_orders where id = :'o_omb') = 18.00, 'il conto esclude le righe rifiutate');
select pg_temp.assert((select status from public.pos_orders where id = :'o_omb') = 'aperta', 'la comanda con altre righe resta aperta');

select pg_temp.as_anon();
select public.public_portal_order_status(:'tok_omb', :'ref1') as st1b \gset
select pg_temp.assert(:'st1b'::jsonb ->> 'status' = 'accettato', 'l''ospite vede l''ordine confermato');

-- Comanda aperta solo dal portale e poi rifiutata: annullata
select public.public_portal_place_order(:'tok_tav', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_acqua', 'qty', 1))) as r3 \gset
select pg_temp.as_user('wanda@portal-test.it');
select public.portal_reject_submission((:'r3'::jsonb ->> 'reference')::uuid, 'Tavolo non presente');
select pg_temp.assert((select status from public.pos_orders where service_point_id = :'tav5' order by opened_at desc limit 1) = 'annullata', 'comanda solo-portale annullata al rifiuto');

-- ---------------------------------------------------------------------------
-- Richieste di assistenza
-- ---------------------------------------------------------------------------
select pg_temp.as_anon();
select pg_temp.expect_error(format($q$select public.public_portal_request(%L, 'hacker', 'ciao')$q$, :'tok_omb'), 'categoria non valida');
select pg_temp.expect_error(format($q$select public.public_portal_request(%L, 'assistenza', 'x')$q$, :'tok_omb'), 'messaggio troppo corto');
select pg_temp.expect_error(format($q$select public.public_portal_request(%L, 'assistenza', repeat('x', 1001))$q$, :'tok_omb'), 'messaggio troppo lungo');
select pg_temp.expect_error(format($q$select public.public_portal_request(%L, 'assistenza', 'Serve aiuto')$q$, :'tok_b'), 'portale non attivo: niente richieste');
select public.public_portal_request(:'tok_omb', 'pulizia', 'Sabbia sul lettino, grazie', 'Giulia', '+39 333 1111111');
select public.public_portal_request(:'ftok_a', 'informazioni', 'A che ora chiude il bar?');
select pg_temp.as_user('wanda@portal-test.it');
select pg_temp.assert((select count(*) from public.guest_requests where facility_id = :'fac_a' and source = 'portale') = 2, 'richieste dal portale ricevute');
select pg_temp.assert((select service_point_id from public.guest_requests where category = 'pulizia') = :'omb12'::uuid, 'richiesta legata all''ombrellone');
select pg_temp.assert((select service_point_id is null from public.guest_requests where category = 'informazioni'), 'richiesta dal QR generico senza punto');

-- ---------------------------------------------------------------------------
-- Limite di frequenza: 10 richieste e 10 ordini per punto ogni 10 minuti
-- ---------------------------------------------------------------------------
select pg_temp.as_anon();
-- l'ombrellone ha già 1 richiesta: altre 9 passano, l'11ª no
select public.public_portal_request(:'tok_omb', 'assistenza', 'Richiesta numero ' || g) from generate_series(1, 9) g;
select pg_temp.expect_error(format($q$select public.public_portal_request(%L, 'assistenza', 'Ancora una')$q$, :'tok_omb'), 'limite di 10 richieste in 10 minuti');
-- un altro punto non è influenzato
select public.public_portal_request(:'tok_tav', 'assistenza', 'Dal tavolo 5');
-- ordini: l'ombrellone ne ha già 2 riusciti (i tentativi falliti non contano)
select public.public_portal_place_order(:'tok_omb', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_acqua', 'qty', 1))) from generate_series(1, 8);
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'tok_omb', :'mi_acqua'),
  'limite di 10 ordini in 10 minuti');
select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.portal_submissions where service_point_id = :'omb12') = 10, '10 ordini registrati dall''ombrellone');
-- dopo 10 minuti si riparte
update public.portal_rate_events set created_at = created_at - interval '11 minutes' where service_point_id = :'omb12';
select pg_temp.as_anon();
select pg_temp.assert((public.public_portal_place_order(:'tok_omb', jsonb_build_array(jsonb_build_object('menu_item_id', :'mi_acqua', 'qty', 1))) ->> 'lines')::int = 1,
  'dopo la finestra si può ordinare di nuovo');

-- ---------------------------------------------------------------------------
-- Orari d'ordine (ora locale della struttura)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('sara@portal-test.it');
update public.portal_settings
   set order_from = ((now() at time zone 'Europe/Rome')::time + interval '2 hours')::time,
       order_to   = ((now() at time zone 'Europe/Rome')::time + interval '3 hours')::time
 where facility_id = :'fac_a';
select pg_temp.as_anon();
select pg_temp.assert(public.public_portal_point(:'tok_tav') #>> '{ordering,reason}' = 'fuori_orario', 'fuori orario segnalato nel portale');
select pg_temp.expect_error(format($q$select public.public_portal_place_order(%L, jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1)))$q$, :'tok_tav', :'mi_acqua'),
  'ordine fuori orario rifiutato');
select pg_temp.as_user('sara@portal-test.it');
update public.portal_settings
   set order_from = ((now() at time zone 'Europe/Rome')::time - interval '1 hour')::time,
       order_to   = ((now() at time zone 'Europe/Rome')::time + interval '1 hour')::time
 where facility_id = :'fac_a';
select pg_temp.as_anon();
select pg_temp.assert((public.public_portal_point(:'tok_tav') #>> '{ordering,allowed}')::boolean, 'dentro la fascia si ordina (anche a cavallo della mezzanotte)');

-- Funzione oraria: fascia a cavallo della mezzanotte
select pg_temp.as_admin();
select pg_temp.assert(app.portal_within_hours('22:00', '02:00', 'Europe/Rome', '2026-07-01 23:30+02'), 'fascia notturna: 23:30 dentro');
select pg_temp.assert(app.portal_within_hours('22:00', '02:00', 'Europe/Rome', '2026-07-02 01:59+02'), 'fascia notturna: 01:59 dentro');
select pg_temp.assert(not app.portal_within_hours('22:00', '02:00', 'Europe/Rome', '2026-07-02 02:00+02'), 'fascia notturna: 02:00 fuori');
select pg_temp.assert(not app.portal_within_hours('10:00', '18:00', 'Europe/Rome', '2026-07-01 07:30+00'), '09:30 locali (07:30 UTC estate) fuori');
select pg_temp.assert(app.portal_within_hours('10:00', '18:00', 'Europe/Rome', '2026-07-01 08:30+00'), '10:30 locali dentro');

select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.audit_log where entity = 'portal_submissions' and org_id = :'org_a') > 0, 'gli invii dal portale sono in audit');
do $$ begin raise notice '✓ Test portale QR superati'; end $$;
