-- Test modulo Camere, housekeeping, manutenzione e richieste ospiti.
-- Esecuzione: scripts/db-test.sh — ogni assert fallito interrompe con errore.
\set ON_ERROR_STOP on
set client_min_messages = warning;

create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
declare v_id text;
begin
  reset role;
  select id::text into v_id from auth.users where email = p_email;
  if v_id is null then raise exception 'utente di test mancante: %', p_email; end if;
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
-- Utenti e organizzazioni
-- ---------------------------------------------------------------------------
insert into auth.users (email) values
  ('titolare@rooms-test.it'), ('reception@rooms-test.it'), ('cameriera@rooms-test.it'), ('cameriera2@rooms-test.it'),
  ('manutentore@rooms-test.it'), ('cuoco@rooms-test.it'), ('contabile@rooms-test.it'), ('altro@rooms-test.it');

select pg_temp.as_user('titolare@rooms-test.it');
select public.create_organization('Hotel Mare srl', 'Hotel Mare', 'hotel') as org_h \gset
select pg_temp.as_user('altro@rooms-test.it');
select public.create_organization('Hotel Rivale', 'Hotel Rivale', 'hotel') as org_r \gset

select pg_temp.as_admin();
select id as fac_h from public.facilities where org_id = :'org_h' \gset
select id as fac_r from public.facilities where org_id = :'org_r' \gset
select (now() at time zone 'Europe/Rome')::date as today \gset
select id as u_cameriera from auth.users where email = 'cameriera@rooms-test.it' \gset
select id as u_cuoco from auth.users where email = 'cuoco@rooms-test.it' \gset
select id as u_manut from auth.users where email = 'manutentore@rooms-test.it' \gset
select id as u_rec from auth.users where email = 'reception@rooms-test.it' \gset

insert into public.roles (org_id, key, name, permissions) values (:'org_h', 'contabile', 'Contabile', array['finance.view']) returning id as role_cont \gset
insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_h', u.id, r.id, array[:'fac_h']::uuid[] from auth.users u join public.roles r on r.org_id = :'org_h'
  and r.key = case u.email when 'reception@rooms-test.it' then 'receptionist' when 'cameriera@rooms-test.it' then 'housekeeping'
                           when 'cameriera2@rooms-test.it' then 'housekeeping' when 'manutentore@rooms-test.it' then 'maintenance'
                           when 'cuoco@rooms-test.it' then 'cook' when 'contabile@rooms-test.it' then 'contabile' end
where u.email like '%@rooms-test.it' and u.email not in ('titolare@rooms-test.it','altro@rooms-test.it');
select pg_temp.assert((select count(*) from public.memberships where org_id = :'org_h') = 7, 'membri dell''hotel creati');

-- ---------------------------------------------------------------------------
-- Camere
-- ---------------------------------------------------------------------------
select pg_temp.as_user('cameriera@rooms-test.it');
select pg_temp.expect_error(format($q$select public.rooms_create_units(%L, 'camera', array['999'], '9')$q$, :'fac_h'), 'la cameriera non crea camere');

select pg_temp.as_user('reception@rooms-test.it');
select public.rooms_create_units(:'fac_h', 'camera', array['101','102','103','104'], '1', 'Doppia', 2) as n_rooms \gset
select pg_temp.assert(:'n_rooms'::int = 4, 'la reception crea 4 camere al piano 1');
select pg_temp.assert(public.rooms_create_units(:'fac_h', 'camera', array['104','105'], '1', 'Doppia', 2) = 1, 'le camere già esistenti vengono saltate');
select pg_temp.expect_error(format($q$select public.rooms_create_units(%L, 'tavolo', array['T1'])$q$, :'fac_h'), 'solo camere o piazzole');
select id as r101 from public.service_points where facility_id = :'fac_h' and kind = 'camera' and label = '101' \gset
select id as r102 from public.service_points where facility_id = :'fac_h' and kind = 'camera' and label = '102' \gset
select id as r103 from public.service_points where facility_id = :'fac_h' and kind = 'camera' and label = '103' \gset
select pg_temp.assert((select floor = '1' and capacity = 2 and status = 'libera_pulita' from public.room_units where service_point_id = :'r101'), 'unità con piano, capienza e stato iniziale');

-- Isolamento
select pg_temp.as_user('altro@rooms-test.it');
select pg_temp.assert((select count(*) from public.room_units) = 0, 'un''altra azienda non vede le camere');
select pg_temp.expect_error(format($q$select public.room_stay_save(null, %L, 'Intruso', null, 1, 0, %L, %L)$q$, :'r101', :'today', (:'today'::date + 2)), 'un''altra azienda non crea soggiorni');
select pg_temp.expect_error(format($q$select public.hk_start(%L)$q$, :'r101'), 'un''altra azienda non avvia pulizie');
select pg_temp.expect_error(format($q$select public.rooms_create_units(%L, 'camera', array['1'])$q$, :'fac_h'), 'un''altra azienda non crea camere nella nostra struttura');
select pg_temp.expect_error(format($q$insert into public.assets (org_id, facility_id, name) values (%L, %L, 'X')$q$, :'org_r', :'fac_h'), 'FK composita: cespite su struttura altrui rifiutato');

-- ---------------------------------------------------------------------------
-- Soggiorni, CSV, check-in e check-out
-- ---------------------------------------------------------------------------
select pg_temp.as_user('reception@rooms-test.it');
select public.room_stay_save(null, :'r101', 'Rossi Mario', null, 2, 1, (:'today'::date - 2), :'today', null, 'Cuscino extra', 'PMS-1') as st_rossi \gset
select pg_temp.expect_error(format($q$select public.room_stay_save(null, %L, 'Doppione', null, 2, 0, %L, %L)$q$, :'r101', (:'today'::date - 1), (:'today'::date + 1)), 'nessuna sovrapposizione sulla stessa camera');
select pg_temp.expect_error(format($q$select public.room_stay_save(null, %L, 'Date', null, 2, 0, %L, %L)$q$, :'r102', :'today', :'today'), 'partenza dopo l''arrivo');

select public.room_stays_import(:'fac_h', jsonb_build_array(
  jsonb_build_object('room', '101', 'guest_name', 'Bianchi Anna', 'arrival', :'today', 'departure', (:'today'::date + 3)::text, 'adults', 2),
  jsonb_build_object('room', '102', 'guest_name', 'Verdi Luca', 'arrival', (:'today'::date - 1)::text, 'departure', (:'today'::date + 2)::text, 'adults', 1)
)) as imp \gset
select pg_temp.assert((:'imp'::jsonb ->> 'inserted')::int = 2, 'import CSV: 2 soggiorni (arrivo nello stesso giorno della partenza ammesso)');
select pg_temp.assert((public.room_stays_import(:'fac_h', jsonb_build_array(
  jsonb_build_object('room', '101', 'guest_name', 'Bianchi Anna', 'arrival', :'today', 'departure', (:'today'::date + 3)::text, 'adults', 2)
)) ->> 'skipped')::int = 1, 'import CSV ripetuto: riga già presente saltata');
select pg_temp.expect_error(format($q$select public.room_stays_import(%L, '[{"room":"999","guest_name":"X","arrival":"2026-01-01","departure":"2026-01-02"}]')$q$, :'fac_h'), 'import CSV: camera inesistente rifiutata');
select pg_temp.assert((select count(*) from public.room_stays where facility_id = :'fac_h') = 3, 'import tutto-o-niente: nessuna riga parziale');

select id as st_bianchi from public.room_stays where guest_name = 'Bianchi Anna' \gset
select id as st_verdi from public.room_stays where guest_name = 'Verdi Luca' \gset

select public.room_checkin(:'st_rossi');
select pg_temp.assert((select status from public.room_units where service_point_id = :'r101') = 'occupata', 'check-in: camera occupata');
select pg_temp.expect_error(format($q$select public.room_checkin(%L)$q$, :'st_bianchi'), 'check-in rifiutato finché il precedente ospite non è partito');
select public.room_checkin(:'st_verdi');

-- La cameriera non fa check-in/out
select pg_temp.as_user('cameriera@rooms-test.it');
select pg_temp.expect_error(format($q$select public.room_checkout(%L)$q$, :'st_rossi'), 'la cameriera non fa check-out');
select pg_temp.assert((select count(*) from public.room_stays) = 3, 'la cameriera vede arrivi e partenze');

select pg_temp.as_user('reception@rooms-test.it');
select public.room_checkout(:'st_rossi');
select pg_temp.assert((select status = 'libera_sporca' and hk_status = 'sporca' and hk_task_id is not null from public.room_units where service_point_id = :'r101'),
  'check-out: camera libera sporca con attività di pulizia');
select hk_task_id as task_101 from public.room_units where service_point_id = :'r101' \gset
select pg_temp.as_admin();
select pg_temp.assert((select title like 'Pulizia Camera 101%' and status = 'assegnata' from public.tasks where id = :'task_101'), 'attività di pulizia creata');
select pg_temp.as_user('reception@rooms-test.it');

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
select pg_temp.expect_error(format($q$select public.hk_assign(array[%L]::uuid[], %L::uuid)$q$, :'r101', :'u_cuoco'),
  'non si assegnano camere a chi non fa housekeeping');
select public.hk_assign(array[:'r101', :'r102']::uuid[], :'u_cameriera'::uuid);
select pg_temp.as_user('cameriera@rooms-test.it');
select pg_temp.assert((select assignee_id from public.tasks where id = :'task_101') = :'u_cameriera'::uuid,
  'l''attività di pulizia segue l''assegnazione (e la cameriera la vede)');

select pg_temp.expect_error(format($q$select public.hk_assign(array[%L]::uuid[], null)$q$, :'r101'), 'la cameriera non assegna camere');
select public.hk_start(:'r101');
select pg_temp.assert((select hk_status from public.room_units where service_point_id = :'r101') = 'in_pulizia', 'pulizia iniziata');
select pg_temp.assert((select kind = 'partenza' and started_at is not null from public.room_cleanings where service_point_id = :'r101'), 'pulizia di partenza con orario di inizio');
select public.hk_finish(:'r101', 'Tutto ok');
select pg_temp.assert((select status = 'da_controllare' and hk_status = 'pulita' from public.room_units where service_point_id = :'r101'), 'fine pulizia: camera da controllare');
select pg_temp.assert((select status from public.tasks where id = :'task_101') = 'completata', 'attività di pulizia completata');
select pg_temp.expect_error(format($q$select public.hk_inspect(%L, true)$q$, :'r101'), 'la cameriera non ispeziona');

-- Segnalazione guasto dalla camera
select public.open_maintenance_ticket(:'fac_h', :'r101', null, null, 'idraulico', 'alta', 'Lavandino che perde', 'housekeeping') as tk_hk \gset
select pg_temp.assert((select count(*) from public.maintenance_tickets) = 1, 'la cameriera vede la propria segnalazione');

select pg_temp.as_user('reception@rooms-test.it');
select pg_temp.expect_error(format($q$select public.hk_inspect(%L, false)$q$, :'r101'), 'ispezione negativa senza nota rifiutata');
select public.hk_inspect(:'r101', true);
select pg_temp.assert((select status = 'libera_pulita' and hk_status = 'ispezionata' from public.room_units where service_point_id = :'r101'), 'ispezione ok: camera pronta');
select public.room_checkin(:'st_bianchi');
select pg_temp.assert((select status from public.room_units where service_point_id = :'r101') = 'occupata', 'nuovo ospite in camera dopo la pulizia');

-- ---------------------------------------------------------------------------
-- Minibar e addebiti
-- ---------------------------------------------------------------------------
select pg_temp.as_admin();
insert into public.warehouses (org_id, facility_id, name) values (:'org_h', :'fac_h', 'Minibar piano 1') returning id as wh_mb \gset
insert into public.products (org_id, name) values (:'org_h', 'Acqua 50 cl') returning id as p_acqua \gset
insert into public.products (org_id, name) values (:'org_h', 'Patatine') returning id as p_pat \gset
select pg_temp.as_user('titolare@rooms-test.it');
select public.manual_load(:'wh_mb', :'p_acqua', 20, 0.30, null);
select public.manual_load(:'wh_mb', :'p_pat', 10, 0.50, null);

select pg_temp.as_user('reception@rooms-test.it');
insert into public.minibar_prices (facility_id, product_id, org_id, price) values (:'fac_h', :'p_acqua', :'org_h', 3.00);

select pg_temp.as_user('cameriera@rooms-test.it');
select pg_temp.expect_error(format($q$insert into public.minibar_prices (facility_id, product_id, org_id, price) values (%L, %L, %L, 1)$q$, :'fac_h', :'p_pat', :'org_h'), 'la cameriera non imposta i prezzi del minibar');
select pg_temp.assert((select count(*) from public.minibar_products(:'fac_h', null)) = 2, 'prodotti del magazzino minibar');
select pg_temp.assert((select bool_and(price is null) from public.minibar_products(:'fac_h', null)), 'la cameriera non vede i prezzi del minibar');
select public.post_minibar(:'r101', null, jsonb_build_array(jsonb_build_object('product_id', :'p_acqua', 'qty', 2), jsonb_build_object('product_id', :'p_pat', 'qty', 1))) as n_mb \gset
select pg_temp.assert(:'n_mb'::int = 2, 'minibar: due righe registrate');
select pg_temp.assert((select count(*) from public.stay_charges where stay_id = :'st_bianchi' and source = 'minibar') = 2, 'la cameriera vede le righe di addebito');
select pg_temp.assert((select count(*) from public.stay_charge_prices) = 0, 'la cameriera non vede gli importi degli addebiti');
select pg_temp.expect_error(format($q$select public.post_minibar(%L, null, '[{"product_id":"%s","qty":1}]')$q$, :'r103', :'p_acqua'), 'minibar: niente addebito senza ospite in camera');
select pg_temp.expect_error(format($q$select public.post_room_charge(%L, 'Cena', 1, 50)$q$, :'st_bianchi'), 'la cameriera non registra addebiti manuali');

select pg_temp.as_user('titolare@rooms-test.it');
select pg_temp.assert((select qty from public.stock_on_hand where warehouse_id = :'wh_mb' and product_id = :'p_acqua') = 18, 'minibar: scarico di magazzino');
select pg_temp.assert((select count(*) from public.stock_movements where ref_type = 'minibar' and kind = 'scarico') = 2, 'movimenti con ref_type minibar');
select pg_temp.as_user('reception@rooms-test.it');
select pg_temp.assert((select sum(amount) from public.stay_charge_prices p join public.stay_charges c on c.id = p.charge_id where c.stay_id = :'st_bianchi') = 6.00,
  'addebito minibar a prezzo di listino (acqua 2 × 3 €; patatine da prezzare)');
select id as ch_pat from public.stay_charges where product_id = :'p_pat' \gset
select public.set_stay_charge_price(:'ch_pat', 2.5);
select public.post_room_charge(:'st_bianchi', 'Colazione in camera', 2, 12, 'room_service');
select pg_temp.assert((select sum(amount) from public.stay_charge_prices p join public.stay_charges c on c.id = p.charge_id where c.stay_id = :'st_bianchi' and c.voided_at is null) = 32.50,
  'totale addebiti 32,50 €');
select public.void_stay_charge(:'ch_pat', 'Errore');
select pg_temp.as_user('titolare@rooms-test.it');
select pg_temp.assert((select qty from public.stock_on_hand where warehouse_id = :'wh_mb' and product_id = :'p_pat') = 10, 'storno minibar: merce rientrata');

select pg_temp.as_user('contabile@rooms-test.it');
select pg_temp.assert((select count(*) from public.stay_charge_prices) = 3, 'la finanza vede gli importi');
select pg_temp.assert((select count(*) from public.room_stays) = 0, 'la finanza non vede i dati degli ospiti');

select pg_temp.as_user('altro@rooms-test.it');
select pg_temp.assert((select count(*) from public.stay_charges) + (select count(*) from public.stay_charge_prices) = 0, 'un''altra azienda non vede gli addebiti');
select pg_temp.expect_error(format($q$select public.minibar_products(%L, null)$q$, :'fac_h'), 'un''altra azienda non vede il minibar');

-- ---------------------------------------------------------------------------
-- Manutenzione: ciclo di vita e visibilità
-- ---------------------------------------------------------------------------
select pg_temp.as_user('cuoco@rooms-test.it');
select public.open_maintenance_ticket(:'fac_h', null, 'Cucina', null, 'elettrodomestici', 'urgente', 'Frigo a +9 gradi') as tk_cuoco \gset
select pg_temp.assert((select count(*) from public.maintenance_tickets) = 1, 'chi segnala vede solo i propri interventi');
select pg_temp.expect_error(format($q$select public.maintenance_transition(%L, 'in_corso')$q$, :'tk_cuoco'), 'chi segnala non lavora l''intervento');
select pg_temp.expect_error(format($q$select public.open_maintenance_ticket(%L, null, '', null, 'altro', 'media', 'Senza luogo')$q$, :'fac_h'), 'serve il luogo');
select pg_temp.expect_error(format($q$insert into public.maintenance_tickets (org_id, facility_id, number, category, description, location_text) values (%L, %L, 99, 'altro', 'diretto', 'x')$q$, :'org_h', :'fac_h'),
  'gli interventi si aprono solo tramite RPC');
select public.maintenance_set_photo(:'tk_cuoco', :'org_h' || '/maintenance/' || :'tk_cuoco' || '/foto.jpg');
select pg_temp.assert((select photo_path like '%/foto.jpg' from public.maintenance_tickets where id = :'tk_cuoco'), 'chi segnala allega la foto');
select pg_temp.expect_error(format($q$select public.maintenance_set_photo(%L, %L)$q$, :'tk_cuoco', :'org_h' || '/tasks/x.jpg'), 'percorso foto fuori cartella rifiutato');

select pg_temp.as_user('manutentore@rooms-test.it');
select pg_temp.assert((select count(*) from public.maintenance_tickets) = 2, 'la manutenzione vede tutti gli interventi');
select pg_temp.expect_error(format($q$select public.maintenance_transition(%L, 'assegnato', null, %L::uuid)$q$, :'tk_cuoco', :'u_cuoco'),
  'non si assegna a chi non fa manutenzione');
select public.maintenance_transition(:'tk_cuoco', 'assegnato', null, :'u_manut'::uuid);
select pg_temp.assert((select status = 'assegnato' and assigned_at is not null from public.maintenance_tickets where id = :'tk_cuoco'), 'assegnato');
select public.maintenance_transition(:'tk_cuoco', 'in_corso');
select public.maintenance_transition(:'tk_cuoco', 'in_attesa_ricambi', 'Ordinato termostato');
select public.maintenance_transition(:'tk_cuoco', 'in_corso');
select pg_temp.expect_error(format($q$select public.maintenance_transition(%L, 'risolto')$q$, :'tk_cuoco'), 'risoluzione senza nota rifiutata');
select public.maintenance_transition(:'tk_cuoco', 'risolto', 'Sostituito termostato');
select pg_temp.assert((select status = 'risolto' and started_at is not null and waiting_parts_at is not null and resolved_at is not null
                       from public.maintenance_tickets where id = :'tk_cuoco'), 'risolto con orari di ogni passaggio');
select pg_temp.expect_error(format($q$select public.maintenance_transition(%L, 'aperto')$q$, :'tk_cuoco'), 'transizione non consentita');

select pg_temp.as_user('cuoco@rooms-test.it');
select public.maintenance_transition(:'tk_cuoco', 'verificato');
select pg_temp.assert((select status from public.maintenance_tickets where id = :'tk_cuoco') = 'verificato', 'chi ha segnalato verifica la riparazione');

-- ---------------------------------------------------------------------------
-- Manutenzione programmata (idempotente)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('manutentore@rooms-test.it');
insert into public.assets (org_id, facility_id, name, location, category) values (:'org_h', :'fac_h', 'Caldaia', 'Locale tecnico', 'climatizzazione') returning id as asset_c \gset
insert into public.maintenance_plans (org_id, facility_id, asset_id, title, category, every_days, next_due)
values (:'org_h', :'fac_r', :'asset_c', 'Controllo caldaia', 'climatizzazione', 30, (:'today'::date - 5)) returning id as plan_c \gset
select pg_temp.assert((select facility_id from public.maintenance_plans where id = :'plan_c') = :'fac_h'::uuid, 'il piano prende la struttura dal cespite');
select pg_temp.assert(public.generate_planned_maintenance(:'fac_h', :'today') = 1, 'manutenzione programmata: un intervento generato');
select pg_temp.assert(public.generate_planned_maintenance(:'fac_h', :'today') = 0, 'rieseguita: nessun doppione');
select pg_temp.assert((select next_due from public.maintenance_plans where id = :'plan_c') = :'today'::date + 25, 'scadenza avanzata di 30 giorni');
select pg_temp.assert((select count(*) from public.maintenance_tickets where plan_id = :'plan_c' and source = 'pianificata') = 1, 'un solo intervento pianificato');

select pg_temp.as_user('cuoco@rooms-test.it');
select pg_temp.expect_error(format($q$select public.generate_planned_maintenance(%L, %L)$q$, :'fac_h', :'today'), 'chi segnala non genera la manutenzione programmata');
select pg_temp.assert((select count(*) from public.maintenance_plans) = 0, 'chi segnala non vede i piani');
select pg_temp.as_user('altro@rooms-test.it');
select pg_temp.assert((select count(*) from public.maintenance_tickets) + (select count(*) from public.assets) = 0, 'un''altra azienda non vede manutenzione e cespiti');
select pg_temp.expect_error(format($q$select public.maintenance_transition(%L, 'annullato')$q$, :'tk_hk'), 'un''altra azienda non tocca i nostri interventi');

-- ---------------------------------------------------------------------------
-- Richieste degli ospiti
-- ---------------------------------------------------------------------------
select pg_temp.as_user('reception@rooms-test.it');
insert into public.guest_requests (org_id, facility_id, service_point_id, source, category, message, guest_name, created_by)
values (:'org_h', :'fac_h', :'r102', 'telefono', 'manutenzione', 'La TV non si accende', 'Verdi Luca', :'u_rec'::uuid)
returning id as gr_tv \gset
insert into public.guest_requests (org_id, facility_id, service_point_id, source, category, message, created_by)
values (:'org_h', :'fac_h', :'r102', 'telefono', 'pulizia', 'Asciugamani puliti', :'u_rec'::uuid)
returning id as gr_pul \gset
select public.guest_request_to_ticket(:'gr_tv', 'alta', 'elettrodomestici') as tk_tv \gset
select pg_temp.assert((select guest_request_id = :'gr_tv'::uuid and source = 'richiesta_ospite' and service_point_id = :'r102'::uuid from public.maintenance_tickets where id = :'tk_tv'),
  'richiesta di manutenzione convertita in intervento');
select pg_temp.assert((select status from public.guest_requests where id = :'gr_tv') = 'presa_in_carico', 'la richiesta passa in carico');
select pg_temp.expect_error(format($q$select public.guest_request_to_ticket(%L)$q$, :'gr_tv'), 'nessun intervento doppio per la stessa richiesta');
select public.guest_request_to_housekeeping(:'gr_pul') as task_pul \gset
select pg_temp.assert((select hk_task_id from public.room_units where service_point_id = :'r102') = :'task_pul'::uuid, 'richiesta di pulizia → attività sulla camera');
select pg_temp.as_admin();
select pg_temp.assert((select assignee_id from public.tasks where id = :'task_pul') = :'u_cameriera'::uuid, 'assegnata a chi ha la camera oggi');
select pg_temp.as_user('reception@rooms-test.it');
select pg_temp.expect_error(format($q$select public.guest_request_to_ticket(%L)$q$, :'gr_pul'), 'una richiesta di pulizia non diventa intervento');

select pg_temp.as_user('cameriera@rooms-test.it');
select public.guest_request_set_status(:'gr_pul', 'risolta', 'Portati');
select pg_temp.assert((select status = 'risolta' and resolution_note = 'Portati' from public.guest_requests where id = :'gr_pul'), 'la cameriera risolve la richiesta');
select pg_temp.as_user('cuoco@rooms-test.it');
select pg_temp.expect_error(format($q$select public.guest_request_set_status(%L, 'risolta')$q$, :'gr_tv'), 'chi non gestisce le richieste non le chiude');
select pg_temp.as_user('altro@rooms-test.it');
select pg_temp.expect_error(format($q$select public.guest_request_set_status(%L, 'presa_in_carico')$q$, :'gr_tv'), 'un''altra azienda non prende in carico');

-- ---------------------------------------------------------------------------
-- Stato manuale, audit
-- ---------------------------------------------------------------------------
select pg_temp.as_user('reception@rooms-test.it');
select pg_temp.expect_error(format($q$select public.room_set_status(%L, 'fuori_servizio')$q$, :'r103'), 'fuori servizio senza motivo rifiutato');
select public.room_set_status(:'r103', 'fuori_servizio', 'Infiltrazione');
select pg_temp.expect_error(format($q$select public.room_set_status(%L, 'libera_pulita')$q$, :'r101'), 'camera occupata: stato manuale rifiutato');
select pg_temp.as_user('cameriera@rooms-test.it');
update public.room_units set status = 'libera_pulita' where service_point_id = :'r103';
select pg_temp.assert((select status from public.room_units where service_point_id = :'r103') = 'fuori_servizio', 'nessuna scrittura diretta sullo stato camere');

select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.audit_log where entity = 'room_stays' and entity_id = :'st_rossi') >= 3, 'soggiorno, check-in e check-out in audit');
select pg_temp.assert((select count(*) from public.audit_log where entity = 'maintenance_tickets' and entity_id = :'tk_cuoco') >= 6, 'ogni passaggio dell''intervento in audit');
select pg_temp.assert(not has_function_privilege('anon', 'public.room_checkout(uuid)', 'execute'), 'anon non esegue le RPC delle camere');

do $$ begin raise notice '✓ Test camere e manutenzione superati'; end $$;
