-- Test del modulo Prenotazioni e Clienti: isolamento, permessi, capacità, tavoli, lista d'attesa, prenotazioni pubbliche
-- (anon), doppioni, consensi, unione schede, esportazione e anonimizzazione GDPR.
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
-- Conta le righe visibili; un errore di permesso vale come «nessuna riga».
create or replace function pg_temp.visible(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into n;
  return n;
exception when insufficient_privilege then
  return 0;
end $$;
grant execute on function pg_temp.assert(boolean, text) to anon;
grant execute on function pg_temp.expect_error(text, text) to anon;
grant execute on function pg_temp.visible(text) to anon;

set client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Utenti e organizzazioni
-- ---------------------------------------------------------------------------
insert into auth.users (email) values
  ('titolare@crm-test.it'), ('reception@crm-test.it'), ('cameriere@crm-test.it'), ('manager@crm-test.it'), ('rivale@crm-test.it');

select pg_temp.as_user('titolare@crm-test.it');
select public.create_organization('Osteria del Porto srl', 'Osteria del Porto', 'ristorante') as org_o \gset
select pg_temp.as_user('rivale@crm-test.it');
select public.create_organization('Trattoria Rivale', 'Trattoria Rivale', 'ristorante') as org_r \gset

select pg_temp.as_admin();
select id as fac_o, public_token as tok_o from public.facilities where org_id = :'org_o' \gset
select id as fac_r, public_token as tok_r from public.facilities where org_id = :'org_r' \gset
select pg_temp.assert(:'tok_o' ~ '^[0-9a-f]{32}$' and :'tok_o' <> :'tok_r', 'ogni struttura ha un token pubblico non indovinabile');
select ((now() at time zone 'Europe/Rome')::date + 1) as tomorrow \gset
select ((now() at time zone 'Europe/Rome')::date + 2) as after2 \gset
select ((now() at time zone 'Europe/Rome')::date + 3) as after3 \gset
select ((now() at time zone 'Europe/Rome')::date + 200) as far \gset

insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_o', u.id, r.id, array[:'fac_o']::uuid[] from auth.users u, public.roles r
where u.email = 'reception@crm-test.it' and r.org_id = :'org_o' and r.key = 'receptionist';
insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_o', u.id, r.id, array[:'fac_o']::uuid[] from auth.users u, public.roles r
where u.email = 'cameriere@crm-test.it' and r.org_id = :'org_o' and r.key = 'waiter';
insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_o', u.id, r.id, array[:'fac_o']::uuid[] from auth.users u, public.roles r
where u.email = 'manager@crm-test.it' and r.org_id = :'org_o' and r.key = 'manager';

-- ---------------------------------------------------------------------------
-- Configurazione (titolare)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('titolare@crm-test.it');
insert into public.reservation_services (org_id, facility_id, name, kind, duration_min, max_party_size, deposit_amount, cancellation_policy)
values (:'org_o', :'fac_o', 'Cena', 'ristorante', 120, 8, null, 'Cancellazione gratuita fino a 24 ore prima') returning id as svc_cena \gset
insert into public.reservation_slots (org_id, facility_id, service_id, weekday, start_time, end_time, interval_min, capacity)
select :'org_o', :'fac_o', :'svc_cena', d, '19:00', '22:00', 30, 10 from generate_series(1, 7) d;
insert into public.reservation_services (org_id, facility_id, name, kind, duration_min, max_party_size)
values (:'org_o', :'fac_o', 'Aperitivo', 'aperitivo', 60, 6) returning id as svc_ape \gset
insert into public.reservation_slots (org_id, facility_id, service_id, weekday, start_time, end_time, interval_min, capacity)
select :'org_o', :'fac_o', :'svc_ape', d, '18:00', '20:00', 30, 50 from generate_series(1, 7) d;
insert into public.reservation_services (org_id, facility_id, name, kind, duration_min, max_party_size, event_date, event_time, event_capacity, price_per_person)
values (:'org_o', :'fac_o', 'Degustazione vini', 'degustazione', 150, 4, :'after2', '20:30', 3, 45) returning id as svc_evt \gset
insert into public.service_points (org_id, facility_id, kind, label, zone, seats) values
  (:'org_o', :'fac_o', 'tavolo', 'T1', 'Sala', 6), (:'org_o', :'fac_o', 'tavolo', 'T2', 'Sala', 4);
insert into public.service_points (org_id, facility_id, kind, label) values (:'org_o', :'fac_o', 'ombrellone', 'X1');
select id as t1 from public.service_points where facility_id = :'fac_o' and label = 'T1' \gset
select id as t2 from public.service_points where facility_id = :'fac_o' and label = 'T2' \gset
select id as umb from public.service_points where facility_id = :'fac_o' and label = 'X1' \gset

select pg_temp.as_user('rivale@crm-test.it');
insert into public.reservation_services (org_id, facility_id, name) values (:'org_r', :'fac_r', 'Pranzo') returning id as svc_r \gset
select pg_temp.expect_error(format($q$insert into public.reservation_services (org_id, facility_id, name) values (%L, %L, 'Intruso')$q$, :'org_r', :'fac_o'),
  'un servizio non può puntare a una struttura di un''altra organizzazione');
select pg_temp.expect_error(format($q$insert into public.reservation_slots (org_id, facility_id, service_id, weekday, start_time, end_time, capacity) values (%L, %L, %L, 1, '12:00', '13:00', 5)$q$, :'org_r', :'fac_r', :'svc_cena'),
  'le fasce non possono puntare a servizi di un''altra organizzazione');

-- ---------------------------------------------------------------------------
-- Capacità (receptionist)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('reception@crm-test.it');
select pg_temp.assert((select count(*) from public.res_slots(:'svc_cena', :'tomorrow')) = 7, '7 fasce dalle 19:00 alle 22:00 ogni 30 minuti');

select public.res_create(:'svc_cena', :'tomorrow', '20:00', 6, null, 'Mario Rossi', '333 123 4567', null, 'telefono', 'confermata',
  null, 'Tavolo vicino alla finestra', array['Glutine', 'glutine', ' frutta a guscio ']) as r1 \gset
select public.res_create(:'svc_cena', :'tomorrow', '21:00', 4, null, 'Giulia Bianchi', '+39 340 9876543', 'Giulia@Example.it') as r2 \gset
select pg_temp.assert((select available from public.res_slots(:'svc_cena', :'tomorrow') where slot_time = '21:00') = 0, 'alle 21:00 i 10 coperti sono esauriti (6 delle 20:00 ancora a tavola + 4)');
select pg_temp.assert((select available from public.res_slots(:'svc_cena', :'tomorrow') where slot_time = '19:00') = 4, 'alle 19:00 (fino alle 21:00) restano 4 coperti');
select pg_temp.assert((select available from public.res_slots(:'svc_cena', :'tomorrow') where slot_time = '19:30') = 0, 'alle 19:30 la durata arriva al picco delle 21:00: pieno');
select pg_temp.assert((select available from public.res_slots(:'svc_cena', :'tomorrow') where slot_time = '22:00') = 6, 'alle 22:00 restano 6 coperti (chi arriva alle 20:00 ha finito)');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '21:30', 1, null, 'Luca Verdi', '3471112223')$q$, :'svc_cena', :'tomorrow'),
  'niente overbooking: 21:30 è pieno');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '19:00', 5, null, 'Luca Verdi', '3471112223')$q$, :'svc_cena', :'tomorrow'),
  'una prenotazione alle 19:00 da 5 supererebbe la capacità alle 20:00');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '22:00', 9, null, 'Gruppo', '3471112224')$q$, :'svc_cena', :'tomorrow'),
  'oltre il gruppo massimo del servizio');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '23:30', 2, null, 'Tardi', '3471112225')$q$, :'svc_cena', :'tomorrow'),
  'fuori orario');
select pg_temp.expect_error(format($q$select public.res_create(%L, (now() at time zone 'Europe/Rome')::date - 1, '20:00', 2, null, 'Ieri', '3471112226')$q$, :'svc_cena'),
  'niente prenotazioni nel passato');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '22:00', 2, null, 'Senza contatti')$q$, :'svc_cena', :'tomorrow'),
  'senza recapito serve un walk-in');

-- Cliente: collegato per telefono normalizzato, allergie copiate sulla scheda
select customer_id as cust_mario from public.reservations where id = :'r1' \gset
select public.res_create(:'svc_cena', :'after3', '20:00', 2, null, 'Mario R.', '+393331234567') as r_mario2 \gset
select pg_temp.assert((select customer_id from public.reservations where id = :'r_mario2') = :'cust_mario'::uuid, 'stesso telefono scritto diversamente: stessa scheda cliente');
select pg_temp.assert((select phone from public.customers where id = :'cust_mario') = '+393331234567', 'telefono salvato in formato +39');
select pg_temp.assert((select allergies from public.customers where id = :'cust_mario') = array['glutine','frutta a guscio'], 'allergie della prenotazione copiate sulla scheda, senza doppioni');
select pg_temp.assert((select allergies from public.reservations where id = :'r_mario2') = array['glutine','frutta a guscio'], 'allergie della scheda copiate sulla nuova prenotazione');
select pg_temp.assert((select count(*) from public.customers where org_id = :'org_o') = 2, 'nessun doppione creato');
select pg_temp.assert((select email from public.customers where full_name = 'Giulia Bianchi') = 'giulia@example.it', 'email in minuscolo');

-- Tavoli
select public.res_assign_table(:'r1', :'t1');
select pg_temp.expect_error(format($q$select public.res_assign_table(%L, %L)$q$, :'r2', :'t1'),
  'lo stesso tavolo non può essere assegnato a due prenotazioni sovrapposte');
select public.res_assign_table(:'r2', :'t2');
select pg_temp.expect_error(format($q$select public.res_assign_table(%L, %L)$q$, :'r2', :'umb'), 'si assegnano solo tavoli');
select public.res_create(:'svc_cena', :'tomorrow', '22:00', 2, null, 'Elena Neri', '3289998887', null, 'telefono', 'confermata', null, null, null, :'t1') as r3 \gset
select pg_temp.assert((select service_point_id from public.reservations where id = :'r3') = :'t1'::uuid, 'T1 è di nuovo libero alle 22:00 (fine della cena delle 20:00)');

-- Stati
select pg_temp.expect_error(format($q$select public.res_set_status(%L, 'arrivata')$q$, :'r1'), 'non si segna arrivato un cliente di domani');
select pg_temp.expect_error(format($q$select public.res_set_status(%L, 'completata')$q$, :'r1'), 'passaggio di stato non consentito');
select public.res_set_status(:'r2', 'annullata', 'Cambio programma');
select pg_temp.assert((select status = 'annullata' and cancelled_at is not null and cancel_reason = 'Cambio programma' from public.reservations where id = :'r2'), 'annullamento con data e motivo');
select pg_temp.assert((select available from public.res_slots(:'svc_cena', :'tomorrow') where slot_time = '21:30') = 4, 'l''annullamento libera i posti (10 - 6 ancora a tavola alle 21:30)');

-- Lista d'attesa
select public.res_waitlist_add(:'svc_cena', :'tomorrow', 2, '21:30', null, 'Paolo Gialli', '3391234000') as wl \gset
select public.res_waitlist_promote(:'wl', '21:30') as r_wl \gset
select pg_temp.assert((select status = 'promossa' and reservation_id = :'r_wl'::uuid from public.reservation_waitlist where id = :'wl'), 'lista d''attesa promossa a prenotazione');
select pg_temp.assert((select status from public.reservations where id = :'r_wl') = 'confermata', 'la prenotazione dalla lista d''attesa è confermata');
select public.res_waitlist_add(:'svc_cena', :'tomorrow', 4, '21:30', null, 'Sara Blu', '3391234001') as wl2 \gset
select pg_temp.expect_error(format($q$select public.res_waitlist_promote(%L, '21:30')$q$, :'wl2'), 'la promozione verifica la capacità');
select pg_temp.expect_error(format($q$select public.res_set_status(%L, 'confermata')$q$, :'r2'), 'ripristino di un annullamento solo se i posti ci sono ancora');

-- Evento a data unica
select pg_temp.assert((select count(*) from public.res_slots(:'svc_evt', :'after2')) = 1, 'evento: una sola fascia');
select pg_temp.assert((select count(*) from public.res_slots(:'svc_evt', :'tomorrow')) = 0, 'evento: nessuna fascia in altre date');
select public.res_create(:'svc_evt', :'after2', '20:30', 3, :'cust_mario');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '20:30', 1, %L)$q$, :'svc_evt', :'after2', :'cust_mario'), 'evento: posti limitati esauriti');

-- Date speciali
insert into public.reservation_exceptions (org_id, facility_id, service_id, on_date, closed) values (:'org_o', :'fac_o', null, :'after3', true);
select pg_temp.assert((select count(*) from public.res_slots(:'svc_ape', :'after3')) = 0, 'chiusura della struttura: nessuna fascia');
insert into public.reservation_exceptions (org_id, facility_id, service_id, on_date, closed, capacity) values (:'org_o', :'fac_o', :'svc_cena', :'after2', false, 3);
select pg_temp.assert((select max(capacity) from public.res_slots(:'svc_cena', :'after2')) = 3, 'capacità eccezionale applicata');

-- ---------------------------------------------------------------------------
-- Permessi: cameriere e altra azienda
-- ---------------------------------------------------------------------------
select pg_temp.as_user('cameriere@crm-test.it');
select pg_temp.assert((select count(*) from public.customers) = 0, 'il cameriere senza crm.view non vede i clienti');
select pg_temp.assert((select count(*) from public.reservations) = 0, 'il cameriere non vede le prenotazioni');
select pg_temp.assert((select count(*) from public.reservation_services) = 3, 'il cameriere vede i servizi della struttura');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '22:00', 2, null, 'X', '3330000000')$q$, :'svc_cena', :'tomorrow'), 'il cameriere non prenota');
select pg_temp.expect_error(format($q$select * from public.crm_customers(%L)$q$, :'org_o'), 'il cameriere non cerca clienti');
select pg_temp.expect_error(format($q$select public.crm_customer_card(%L)$q$, :'cust_mario'), 'il cameriere non apre schede');
select pg_temp.expect_error(format($q$insert into public.reservation_services (org_id, facility_id, name) values (%L, %L, 'Mio')$q$, :'org_o', :'fac_o'), 'il cameriere non configura servizi');

select pg_temp.as_user('rivale@crm-test.it');
select pg_temp.assert((select count(*) from public.reservations where org_id = :'org_o') = 0, 'un''altra azienda non vede le prenotazioni');
select pg_temp.assert((select count(*) from public.customers where org_id = :'org_o') = 0, 'un''altra azienda non vede i clienti');
select pg_temp.assert((select count(*) from public.reservation_services where org_id = :'org_o') = 0, 'un''altra azienda non vede i servizi');
select pg_temp.expect_error(format($q$select public.res_set_status(%L, 'annullata')$q$, :'r1'), 'un''altra azienda non annulla');
select pg_temp.expect_error(format($q$select * from public.res_slots(%L, %L)$q$, :'svc_cena', :'tomorrow'), 'un''altra azienda non legge la disponibilità interna');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '22:00', 2, %L)$q$, :'svc_r', :'tomorrow', :'cust_mario'), 'non si collega il cliente di un''altra azienda');
select pg_temp.expect_error(format($q$select public.crm_export_customer(%L)$q$, :'cust_mario'), 'un''altra azienda non esporta');
select pg_temp.expect_error(format($q$select public.crm_merge_customers(%L, %L)$q$, :'cust_mario', :'cust_mario'), 'un''altra azienda non unisce');

-- ---------------------------------------------------------------------------
-- Prenotazioni pubbliche (anon)
-- ---------------------------------------------------------------------------
select pg_temp.as_anon();
select pg_temp.assert((select count(*) from public.public_reservation_services(:'tok_o')) = 3, 'anon: elenco dei servizi prenotabili');
select pg_temp.assert((select count(*) from public.public_reservation_slots(:'tok_o', :'svc_ape', :'tomorrow')) = 5, 'anon: fasce dell''aperitivo');
select pg_temp.assert((select max(available) from public.public_reservation_slots(:'tok_o', :'svc_ape', :'tomorrow')) = 6, 'anon: la disponibilità non rivela la capienza totale');
select pg_temp.expect_error(format($q$select * from public.public_reservation_slots(%L, %L, %L)$q$, :'tok_r', :'svc_ape', :'tomorrow'), 'anon: servizio di un''altra struttura');
select pg_temp.expect_error(format($q$select * from public.public_reservation_slots('nonvalido', %L, %L)$q$, :'svc_ape', :'tomorrow'), 'anon: token non valido');
select pg_temp.expect_error(format($q$select * from public.public_reservation_slots(%L, %L, %L)$q$, :'tok_o', :'svc_ape', :'far'), 'anon: oltre 120 giorni');

select (public.public_create_reservation(:'tok_o', :'svc_ape', :'tomorrow', '18:00', 2, 'Anna Web', '345 000 0001', 'anna@web.it',
        'Compleanno', array['lattosio'], true, true, 'sito') ->> 'reservation_id') as r_pub \gset
select pg_temp.expect_error(format($q$select public.public_create_reservation(%L, %L, %L, '18:00', 7, 'Anna Web', '3450000001', null, null, null, true)$q$, :'tok_o', :'svc_ape', :'tomorrow'), 'anon: gruppo oltre il massimo');
select pg_temp.expect_error(format($q$select public.public_create_reservation(%L, %L, %L, '18:10', 2, 'Anna Web', '3450000001', null, null, null, true)$q$, :'tok_o', :'svc_ape', :'tomorrow'), 'anon: orario non in griglia');
select pg_temp.expect_error(format($q$select public.public_create_reservation(%L, %L, %L, '18:00', 2, 'Anna Web', 'abc', null, null, null, true)$q$, :'tok_o', :'svc_ape', :'tomorrow'), 'anon: telefono non valido');
select pg_temp.expect_error(format($q$select public.public_create_reservation(%L, %L, %L, '18:00', 2, 'Anna Web', '3450000001', null, null, null, false)$q$, :'tok_o', :'svc_ape', :'tomorrow'), 'anon: serve il consenso privacy');
select pg_temp.expect_error(format($q$select public.public_create_reservation(%L, %L, %L, '18:00', 2, '<script>', '3450000001', null, null, null, true)$q$, :'tok_o', :'svc_ape', :'tomorrow'), 'anon: nome non valido');
select public.public_create_reservation(:'tok_o', :'svc_ape', :'tomorrow', '18:30', 1, 'Anna Web', '+393450000001', null, null, null, true);
select public.public_create_reservation(:'tok_o', :'svc_ape', :'tomorrow', '19:00', 1, 'Anna Web', '3450000001', null, null, null, true);
select public.public_create_reservation(:'tok_o', :'svc_ape', :'after2', '19:30', 1, 'Anna Web', '3450000001', null, null, null, true);
select public.public_create_reservation(:'tok_o', :'svc_ape', :'after2', '20:00', 1, 'Anna Web', '3450000001', null, null, null, true);
select pg_temp.expect_error(format($q$select public.public_create_reservation(%L, %L, %L, '18:00', 1, 'Anna Web', '0039 345 0000001', null, null, null, true)$q$, :'tok_o', :'svc_ape', :'after2'), 'anon: massimo 5 richieste in attesa per telefono al giorno');
select pg_temp.assert(pg_temp.visible('select * from public.customers') = 0, 'anon non legge i clienti');
select pg_temp.assert(pg_temp.visible('select * from public.reservations') = 0, 'anon non legge le prenotazioni');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '22:00', 2, null, 'X', '3330000000')$q$, :'svc_cena', :'tomorrow'), 'anon non usa le RPC dello staff');
select pg_temp.expect_error(format($q$select * from public.crm_customers(%L)$q$, :'org_o'), 'anon non cerca clienti');

select pg_temp.as_admin();
select pg_temp.assert((select status = 'in_attesa_conferma' and source = 'sito' from public.reservations where id = :'r_pub'), 'la prenotazione online è in attesa di conferma');
select id as cust_anna from public.customers where org_id = :'org_o' and phone = '+393450000001' \gset
select pg_temp.assert((select count(*) from public.customers where org_id = :'org_o' and phone = '+393450000001') = 1, 'online: una sola scheda per telefono');
select pg_temp.assert((select marketing_consent and consent_source = 'sito' and privacy_consent_at is not null and marketing_consent_at is not null from public.customers where id = :'cust_anna'), 'consensi online con fonte e data');
select pg_temp.assert((select count(*) from public.customer_consents where customer_id = :'cust_anna') = 2, 'registro dei consensi (privacy + marketing)');
select pg_temp.assert(has_function_privilege('anon', 'public.public_create_reservation(text, uuid, date, text, int, text, text, text, text, text[], boolean, boolean, text)', 'execute'), 'anon può eseguire public_create_reservation');
select pg_temp.assert(not has_function_privilege('anon', 'public.crm_anonymize_customer(uuid)', 'execute'), 'anon non può eseguire le RPC del CRM');

-- ---------------------------------------------------------------------------
-- CRM: consensi, doppioni, unione, spesa
-- ---------------------------------------------------------------------------
select pg_temp.as_user('reception@crm-test.it');
select pg_temp.assert((select count(*) from public.customers) = 6, 'la reception vede i clienti (Mario, Giulia, Elena, Paolo, Sara, Anna)');
select pg_temp.expect_error(format($q$select public.crm_set_consent(%L, 'marketing', true, 'reception')$q$, :'cust_mario'), 'la reception non modifica i consensi (crm.manage)');
select pg_temp.expect_error(format($q$update public.customers set marketing_consent = true, consent_source = 'reception' where id = %L$q$, :'cust_mario'), 'nemmeno con un update diretto');
select pg_temp.expect_error(format($q$select public.crm_export_customer(%L)$q$, :'cust_mario'), 'la reception non esporta (crm.manage)');
select pg_temp.expect_error(format($q$select public.crm_anonymize_customer(%L)$q$, :'cust_mario'), 'la reception non anonimizza (crm.manage)');
select pg_temp.expect_error(format($q$update public.customers set anonymized_at = now() where id = %L$q$, :'cust_mario'), 'nessuna anonimizzazione con update diretto');
select pg_temp.assert((select spend from public.crm_customers(:'org_o') where id = :'cust_mario') is null, 'senza finance.view la spesa non si vede');
select pg_temp.assert((select visits from public.crm_customers(:'org_o', '333 1234') where id = :'cust_mario') = 0, 'ricerca per telefono');
select pg_temp.expect_error(format($q$select public.crm_save_customer(%L, null, 'Mario Doppio', '0039 333 1234567')$q$, :'org_o'), 'nuova scheda con telefono già presente: doppione segnalato');

select pg_temp.as_user('manager@crm-test.it');
select pg_temp.expect_error(format($q$insert into public.customers (org_id, full_name, marketing_consent) values (%L, 'Senza fonte', true)$q$, :'org_o'), 'consenso marketing senza fonte rifiutato');
select public.crm_set_consent(:'cust_mario', 'marketing', true, 'modulo_firmato');
select pg_temp.assert((select marketing_consent and marketing_consent_at is not null and consent_source = 'modulo_firmato' from public.customers where id = :'cust_mario'), 'consenso marketing con fonte e data');
select pg_temp.expect_error(format($q$select public.crm_set_consent(%L, 'marketing', true, null)$q$, :'cust_mario'), 'consenso senza fonte rifiutato');
select pg_temp.assert((select spend from public.crm_customers(:'org_o') where id = :'cust_mario') = 0, 'con finance.view la spesa si vede');

select public.crm_save_customer(:'org_o', null, 'Mario Rossi', '333-1234567', 'mario@rossi.it', 'it', null, array['sedano'], 'Vino rosso', null, array['abituale'], true) as cust_dup \gset
select pg_temp.assert(exists (select 1 from public.crm_find_duplicates(:'org_o') where reason = 'telefono'
  and ((a_id = :'cust_mario' and b_id = :'cust_dup') or (a_id = :'cust_dup' and b_id = :'cust_mario'))), 'doppione individuato per telefono');
select public.res_create(:'svc_ape', :'tomorrow', '19:30', 2, :'cust_dup') as r_dup \gset
select public.crm_merge_customers(:'cust_mario', :'cust_dup');
select pg_temp.assert((select count(*) from public.customers where id = :'cust_dup') = 0, 'la scheda unita è eliminata');
select pg_temp.assert((select customer_id from public.reservations where id = :'r_dup') = :'cust_mario'::uuid, 'le prenotazioni passano alla scheda che resta');
select pg_temp.assert((select email = 'mario@rossi.it' and 'sedano' = any(allergies) and 'abituale' = any(tags) and preferences = 'Vino rosso' from public.customers where id = :'cust_mario'),
  'dati della scheda unita completati');
select pg_temp.assert((select count(*) from public.crm_customers(:'org_o', null, array['abituale'], null, null, null, true)) = 1, 'segmento: abituali con consenso marketing');

insert into public.customer_segments (org_id, name, filters) values (:'org_o', 'Abituali con consenso', '{"tags":["abituale"],"marketing":true}');
select pg_temp.as_user('reception@crm-test.it');
select pg_temp.assert((select count(*) from public.customer_segments) = 1, 'la reception vede i segmenti salvati');
select pg_temp.expect_error(format($q$insert into public.customer_segments (org_id, name) values (%L, 'Mio')$q$, :'org_o'), 'solo crm.manage salva segmenti');

-- ---------------------------------------------------------------------------
-- GDPR: esportazione e anonimizzazione
-- ---------------------------------------------------------------------------
select pg_temp.as_user('manager@crm-test.it');
select public.crm_export_customer(:'cust_mario') as export \gset
select pg_temp.assert((:'export'::jsonb -> 'cliente' ->> 'phone') = '+393331234567', 'esportazione: dati anagrafici');
select pg_temp.assert(jsonb_array_length(:'export'::jsonb -> 'prenotazioni') = 4, 'esportazione: tutte le prenotazioni');
select pg_temp.assert(jsonb_array_length(:'export'::jsonb -> 'consensi') >= 1, 'esportazione: registro consensi');

select count(*) as res_before from public.reservations where customer_id = :'cust_mario' \gset
select public.crm_anonymize_customer(:'cust_mario');
select pg_temp.assert((select full_name = 'Cliente anonimizzato' and phone is null and email is null and allergies = '{}' and preferences is null
  and not marketing_consent and anonymized_at is not null from public.customers where id = :'cust_mario'), 'anonimizzazione: dati personali rimossi');
select pg_temp.assert((select count(*) from public.reservations where customer_id = :'cust_mario') = :res_before, 'anonimizzazione: lo storico delle prenotazioni resta');
select pg_temp.assert((select bool_and(notes is null and special_requests is null and allergies = '{}') from public.reservations where customer_id = :'cust_mario'), 'anonimizzazione: note e allergie tolte dalle prenotazioni');
update public.customers set full_name = 'Mario' where id = :'cust_mario'; -- RLS: 0 righe
select pg_temp.assert((select count(*) from public.customers where id = :'cust_mario' and full_name = 'Mario') = 0, 'la scheda anonimizzata resta anonima');
select pg_temp.expect_error(format($q$select public.res_create(%L, %L, '19:30', 2, %L)$q$, :'svc_ape', :'after2', :'cust_mario'), 'niente nuove prenotazioni su un cliente anonimizzato');

select pg_temp.as_admin();
select pg_temp.assert(not exists (select 1 from public.audit_log where org_id = :'org_o' and (before::text like '%3331234567%' or after::text like '%3331234567%' or before::text like '%mario@rossi%' or after::text like '%mario@rossi%')),
  'anonimizzazione: il registro operazioni non contiene più telefono ed email');
select pg_temp.assert((select count(*) from public.audit_log where entity = 'customers' and action in ('merge','export','anonymize')) = 3, 'unione, esportazione e anonimizzazione in audit');
select pg_temp.assert((select count(*) from public.audit_log where entity = 'reservations' and entity_id = :'r1') >= 3, 'prenotazione e tavolo in audit');

-- Collegamento automatico delle prenotazioni spiaggia (trigger su beach_bookings)
insert into public.beach_rates (org_id, facility_id, kind, period, valid_from, valid_to, price) values (:'org_o', :'fac_o', 'ombrellone', 'giornata', current_date - 10, current_date + 10, 20);
select pg_temp.as_user('titolare@crm-test.it');
select public.beach_book(:'umb', 'giornata', :'tomorrow', :'tomorrow', 'Giulia B.', '340-9876543') as bb \gset
select pg_temp.assert((select b.customer_id = c.id from public.beach_bookings b join public.customers c on c.full_name = 'Giulia Bianchi' where b.id = :'bb'), 'spiaggia: prenotazione collegata alla scheda per telefono');
select pg_temp.assert(jsonb_array_length(public.crm_customer_card((select customer_id from public.beach_bookings where id = :'bb')) -> 'beach') = 1, 'la scheda cliente mostra le prenotazioni spiaggia');

do $$ begin raise notice '✓ Test prenotazioni e clienti superati'; end $$;
