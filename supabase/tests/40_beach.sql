-- Test del modulo Spiaggia: isolamento, permessi, listino, doppie prenotazioni, mezze giornate, giornata dello spiaggino.
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
-- Utenti e organizzazioni
-- ---------------------------------------------------------------------------
insert into auth.users (email) values
  ('titolare@beach-test.it'), ('spiaggino@beach-test.it'), ('capo@beach-test.it'), ('barista@beach-test.it'), ('altro@beach-test.it');

select pg_temp.as_user('titolare@beach-test.it');
select public.create_organization('Bagni Sole srl', 'Bagni Sole', 'lido') as org_s \gset
select pg_temp.as_user('altro@beach-test.it');
select public.create_organization('Lido Rivale', 'Lido Rivale', 'lido') as org_r \gset

select pg_temp.as_admin();
select id as fac_s from public.facilities where org_id = :'org_s' \gset
select id as fac_r from public.facilities where org_id = :'org_r' \gset
select (now() at time zone 'Europe/Rome')::date as today \gset
select ((now() at time zone 'Europe/Rome')::date + 1) as tomorrow \gset
select ((now() at time zone 'Europe/Rome')::date - 1) as yesterday \gset

-- Spiaggino (ruolo di sistema «beach»), capo spiaggia = ruolo personalizzato con beach.manage senza finance.view, barista
insert into public.roles (org_id, key, name, permissions) values (:'org_s', 'capo_spiaggia', 'Capo spiaggia', array['beach.operate','beach.manage']) returning id as role_capo \gset
insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_s', u.id, r.id, array[:'fac_s']::uuid[] from auth.users u, public.roles r
where u.email = 'spiaggino@beach-test.it' and r.org_id = :'org_s' and r.key = 'beach';
insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_s', u.id, :'role_capo', array[:'fac_s']::uuid[] from auth.users u where u.email = 'capo@beach-test.it';
insert into public.memberships (org_id, user_id, role_id, facility_ids)
select :'org_s', u.id, r.id, array[:'fac_s']::uuid[] from auth.users u, public.roles r
where u.email = 'barista@beach-test.it' and r.org_id = :'org_s' and r.key = 'bartender';

-- ---------------------------------------------------------------------------
-- Mappa e listino (capo spiaggia)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('capo@beach-test.it');
insert into public.service_points (org_id, facility_id, kind, label, zone, row_label, pos_x, pos_y, seats)
select :'org_s', :'fac_s', 'ombrellone', 'A' || ((r - 1) * 4 + x), 'A', r::text, x, r, 2
from generate_series(1, 2) r, generate_series(1, 4) x;
insert into public.service_points (org_id, facility_id, kind, label, zone, row_label, pos_x, pos_y, seats)
values (:'org_s', :'fac_s', 'cabina', 'C1', 'Cabine', '1', 1, 1, 0);
select pg_temp.assert((select count(*) from public.service_points where facility_id = :'fac_s') = 9, 'il capo spiaggia crea la mappa (8 ombrelloni + 1 cabina)');
select id as p_a1 from public.service_points where facility_id = :'fac_s' and label = 'A1' \gset
select id as p_a2 from public.service_points where facility_id = :'fac_s' and label = 'A2' \gset
select id as p_a3 from public.service_points where facility_id = :'fac_s' and label = 'A3' \gset
select id as p_a5 from public.service_points where facility_id = :'fac_s' and label = 'A5' \gset
select id as p_a6 from public.service_points where facility_id = :'fac_s' and label = 'A6' \gset
select id as p_c1 from public.service_points where facility_id = :'fac_s' and label = 'C1' \gset

insert into public.beach_rates (org_id, facility_id, name, kind, period, valid_from, valid_to, price, included_lettini, extra_lettino_price) values
  (:'org_s', :'fac_s', 'Base', 'ombrellone', 'giornata', :'today'::date - 60, :'today'::date + 60, 20, 2, 5),
  (:'org_s', :'fac_s', 'Base', 'ombrellone', 'mattina', :'today'::date - 60, :'today'::date + 60, 12, 2, 3),
  (:'org_s', :'fac_s', 'Base', 'ombrellone', 'pomeriggio', :'today'::date - 60, :'today'::date + 60, 14, 2, 3),
  (:'org_s', :'fac_s', 'Settimana', 'ombrellone', 'settimana', :'today'::date - 60, :'today'::date + 60, 120, 2, 20),
  (:'org_s', :'fac_s', 'Stagione', 'ombrellone', 'stagione', :'today'::date - 60, :'today'::date + 60, 1500, 2, 100);
insert into public.beach_rates (org_id, facility_id, name, kind, zone, row_label, period, valid_from, valid_to, price, included_lettini, extra_lettino_price)
values (:'org_s', :'fac_s', 'Prima fila', 'ombrellone', 'A', '1', 'giornata', :'today'::date - 60, :'today'::date + 60, 30, 2, 5);
-- alta stagione da domani in poi (stessa specificità, validità più recente)
insert into public.beach_rates (org_id, facility_id, name, kind, period, valid_from, valid_to, price, included_lettini, extra_lettino_price)
values (:'org_s', :'fac_s', 'Alta', 'ombrellone', 'giornata', :'tomorrow', :'today'::date + 30, 25, 2, 5);

select pg_temp.assert(public.beach_quote(:'p_a1', 'giornata', :'today', :'today', 2) = 30, 'prima fila: tariffa più specifica (30 €)');
select pg_temp.assert(public.beach_quote(:'p_a5', 'giornata', :'today', :'today', 3) = 25, 'seconda fila: base 20 € + 1 lettino extra 5 €');
select pg_temp.assert(public.beach_quote(:'p_a5', 'giornata', :'today', :'tomorrow', 2) = 45, 'oggi base 20 € + domani alta stagione 25 €');
select pg_temp.assert(public.beach_quote(:'p_a5', 'settimana', :'today', :'today'::date + 6, 2) = 120, 'settimana a prezzo fisso');
select pg_temp.assert(public.beach_quote(:'p_c1', 'giornata', :'today', :'today', 0) is null, 'nessuna tariffa per la cabina');
select pg_temp.expect_error(format($q$select public.beach_quote(%L, 'settimana', %L, %L, 2)$q$, :'p_a5', :'today', :'today'), 'una settimana deve durare 7 giorni');

-- ---------------------------------------------------------------------------
-- Isolamento tra aziende
-- ---------------------------------------------------------------------------
select pg_temp.as_user('altro@beach-test.it');
select pg_temp.assert((select count(*) from public.beach_rates) = 0, 'un''altra azienda non vede il listino');
select pg_temp.assert((select count(*) from public.service_points where facility_id = :'fac_s') = 0, 'un''altra azienda non vede la mappa');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Intruso')$q$, :'p_a1', :'today', :'today'), 'un''altra azienda non prenota sulla nostra mappa');
select pg_temp.expect_error(format($q$select public.beach_quote(%L, 'giornata', %L, %L, 2)$q$, :'p_a1', :'today', :'today'), 'un''altra azienda non ottiene preventivi');
select pg_temp.expect_error(format($q$insert into public.beach_rates (org_id, facility_id, kind, period, valid_from, valid_to, price) values (%L, %L, 'ombrellone', 'giornata', %L, %L, 1)$q$, :'org_s', :'fac_s', :'today', :'today'),
  'un''altra azienda non scrive nel nostro listino');
select pg_temp.expect_error(format($q$insert into public.beach_rates (org_id, facility_id, kind, period, valid_from, valid_to, price) values (%L, %L, 'ombrellone', 'giornata', %L, %L, 1)$q$, :'org_r', :'fac_s', :'today', :'today'),
  'FK composita: listino della propria azienda su struttura altrui rifiutato');
select pg_temp.expect_error(format($q$select public.beach_day_revenue(%L, %L)$q$, :'fac_s', :'today'), 'un''altra azienda non vede gli incassi');
select pg_temp.expect_error(format($q$select public.beach_set_out_of_service(%L, true, 'rotto')$q$, :'p_a1'), 'un''altra azienda non mette fuori servizio');

-- ---------------------------------------------------------------------------
-- Prenotazioni: spiaggino
-- ---------------------------------------------------------------------------
select pg_temp.as_user('spiaggino@beach-test.it');
update public.beach_rates set price = 1; -- RLS: 0 righe
select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.beach_rates where price = 1) = 0, 'lo spiaggino non modifica il listino');
select pg_temp.as_user('spiaggino@beach-test.it');
select pg_temp.expect_error(format($q$insert into public.beach_rates (org_id, facility_id, kind, period, valid_from, valid_to, price) values (%L, %L, 'ombrellone', 'giornata', %L, %L, 1)$q$, :'org_s', :'fac_s', :'today', :'today'),
  'lo spiaggino non aggiunge tariffe');
select pg_temp.assert((select count(*) from public.beach_rates) = 7, 'lo spiaggino legge il listino');
select pg_temp.expect_error(format($q$insert into public.beach_bookings (org_id, facility_id, service_point_id, period, start_date, end_date, customer_name, price) values (%L, %L, %L, 'giornata', %L, %L, 'Diretto', 0)$q$, :'org_s', :'fac_s', :'p_a2', :'today', :'today'),
  'le prenotazioni si creano solo tramite RPC');

select public.beach_book(:'p_a1', 'giornata', :'today', :'today', 'Rossi Mario', '+39 333 1234567', 'mario@example.it', null, 3, null, null, 10) as bk_rossi \gset
select pg_temp.assert((select price from public.beach_bookings where id = :'bk_rossi') = 35, 'prezzo da listino: prima fila 30 € + lettino extra 5 €');
select pg_temp.assert((select paid_amount from public.beach_bookings where id = :'bk_rossi') = 10, 'acconto registrato');
select pg_temp.assert((select count(*) from public.beach_payments) = 0, 'lo spiaggino non legge il registro incassi');

select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Bianchi')$q$, :'p_a1', :'today', :'today'), 'doppia prenotazione rifiutata');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'mattina', %L, %L, 'Bianchi')$q$, :'p_a1', :'today', :'today'), 'mezza giornata su giornata intera rifiutata');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Sconto', null, null, null, 2, 5, 'amico')$q$, :'p_a2', :'today', :'today'),
  'lo spiaggino non cambia il prezzo di listino');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'stagione', %L, %L, 'Abbonato')$q$, :'p_a2', :'today', :'today'::date + 30), 'lo spiaggino non crea abbonamenti');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Ieri')$q$, :'p_a2', :'yesterday', :'yesterday'), 'lo spiaggino non prenota nel passato');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Cabina')$q$, :'p_c1', :'today', :'today'), 'senza tariffa niente prenotazione al prezzo di listino');

-- Mezze giornate sulla stessa postazione
select public.beach_book(:'p_a2', 'mattina', :'today', :'today', 'Verdi (mattina)') as bk_matt \gset
select public.beach_book(:'p_a2', 'pomeriggio', :'today', :'today', 'Neri (pomeriggio)') as bk_pom \gset
select pg_temp.assert((select count(*) from public.beach_bookings where service_point_id = :'p_a2' and status = 'prenotata') = 2, 'mattina e pomeriggio convivono sulla stessa postazione');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Intera')$q$, :'p_a2', :'today', :'today'), 'giornata intera rifiutata se ci sono mezze giornate');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'pomeriggio', %L, %L, 'Altro pomeriggio')$q$, :'p_a2', :'today', :'today'), 'due pomeriggi sulla stessa postazione rifiutati');

-- Walk-in con check-in immediato
select public.beach_book(:'p_a3', 'giornata', :'today', :'today', 'Walk-in', null, null, null, 2, null, null, 20, 'carta', true) as bk_walk \gset
select pg_temp.assert((select status from public.beach_bookings where id = :'bk_walk') = 'presente', 'walk-in già presente');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Domani subito', null, null, null, 2, null, null, 0, 'contanti', true)$q$, :'p_a5', :'tomorrow', :'tomorrow'),
  'check-in immediato solo per oggi');

-- ---------------------------------------------------------------------------
-- Check-in, check-out, cambio postazione
-- ---------------------------------------------------------------------------
select public.beach_checkin(:'bk_rossi');
select pg_temp.assert((select status from public.beach_bookings where id = :'bk_rossi') = 'presente', 'check-in');
select pg_temp.expect_error(format($q$select public.beach_checkin(%L)$q$, :'bk_rossi'), 'doppio check-in rifiutato');

select pg_temp.expect_error(format($q$select public.beach_move(%L, %L)$q$, :'bk_rossi', :'p_a3'), 'spostamento su postazione occupata rifiutato');
select public.beach_move(:'bk_rossi', :'p_a5', 'Troppo sole');
select pg_temp.assert((select service_point_id from public.beach_bookings where id = :'bk_rossi') = :'p_a5'::uuid, 'cambio postazione eseguito');
select pg_temp.assert((select count(*) from public.beach_moves where booking_id = :'bk_rossi' and from_point_id = :'p_a1' and to_point_id = :'p_a5') = 1, 'cambio postazione registrato');
select public.beach_book(:'p_a1', 'giornata', :'today', :'today', 'Gialli') as bk_gialli \gset
select pg_temp.assert(:'bk_gialli' is not null, 'la postazione liberata è di nuovo prenotabile');

select public.beach_checkout(:'bk_rossi');
select pg_temp.assert((select status from public.beach_bookings where id = :'bk_rossi') = 'uscito', 'check-out');
select pg_temp.expect_error(format($q$select public.beach_checkout(%L)$q$, :'bk_rossi'), 'check-out di chi non è presente rifiutato');
select public.beach_book(:'p_a5', 'giornata', :'today', :'today', 'Dopo Rossi') as bk_dopo \gset
select pg_temp.assert(:'bk_dopo' is not null, 'dopo il check-out la postazione si libera');

-- Incassi e annullamenti
select public.beach_add_payment(:'bk_gialli', 30, 'contanti');
select pg_temp.expect_error(format($q$select public.beach_add_payment(%L, 5)$q$, :'bk_gialli'), 'non si incassa più del prezzo');
select pg_temp.expect_error(format($q$select public.beach_add_payment(%L, -10)$q$, :'bk_gialli'), 'lo spiaggino non registra rimborsi');
select pg_temp.expect_error(format($q$select public.beach_cancel(%L, 'cambio idea')$q$, :'bk_gialli'), 'lo spiaggino non annulla una prenotazione pagata');
select pg_temp.expect_error(format($q$select public.beach_set_price(%L, 10, 'sconto')$q$, :'bk_gialli'), 'lo spiaggino non cambia il prezzo di una prenotazione');
select public.beach_cancel(:'bk_pom', 'non arriva');
select pg_temp.assert((select status from public.beach_bookings where id = :'bk_pom') = 'annullata', 'lo spiaggino annulla una prenotazione non pagata');
select public.beach_book(:'p_a2', 'pomeriggio', :'today', :'today', 'Nuovo pomeriggio') as bk_pom2 \gset
select pg_temp.assert(:'bk_pom2' is not null, 'una prenotazione annullata libera la fascia');

-- Fuori servizio
select public.beach_set_out_of_service(:'p_a6', true, 'Ombrellone strappato');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'X')$q$, :'p_a6', :'today', :'today'), 'non si prenota una postazione fuori servizio');
select pg_temp.expect_error(format($q$select public.beach_move(%L, %L)$q$, :'bk_walk', :'p_a6'), 'non si sposta su una postazione fuori servizio');
select pg_temp.expect_error(format($q$select public.beach_set_out_of_service(%L, true, '')$q$, :'p_a6'), 'serve una nota per il fuori servizio');

-- Incassi del giorno nascosti
select pg_temp.expect_error(format($q$select public.beach_day_revenue(%L, %L)$q$, :'fac_s', :'today'), 'lo spiaggino non vede gli incassi del giorno');

-- ---------------------------------------------------------------------------
-- Capo spiaggia (beach.manage senza finance.view)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('capo@beach-test.it');
select id as p_a8 from public.service_points where facility_id = :'fac_s' and label = 'A8' \gset
select public.beach_book(:'p_a8', 'stagione', :'today'::date - 30, :'today'::date + 30, 'Abbonato Esposito', '+39 320 0000000', null, 'Vuole la sdraio', 2, 1300, 'cliente storico', 500, 'bonifico') as bk_abb \gset
select pg_temp.assert((select price = 1300 and list_price = 1500 and price_override_reason = 'cliente storico' from public.beach_bookings where id = :'bk_abb'), 'il capo spiaggia applica un prezzo diverso con motivo');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Senza motivo', null, null, null, 2, 1)$q$, :'p_a3', :'tomorrow', :'tomorrow'), 'prezzo diverso senza motivo rifiutato');
select pg_temp.assert((select count(*) from public.beach_payments where booking_id = :'bk_abb') = 1, 'il capo spiaggia vede il registro incassi');
select public.beach_cancel(:'bk_gialli', 'meteo');
select pg_temp.assert((select status from public.beach_bookings where id = :'bk_gialli') = 'annullata', 'il capo spiaggia annulla anche una prenotazione pagata');
select public.beach_add_payment(:'bk_gialli', -30, 'contanti');
select pg_temp.assert((select paid_amount from public.beach_bookings where id = :'bk_gialli') = 0, 'rimborso registrato');
select pg_temp.expect_error(format($q$select public.beach_day_revenue(%L, %L)$q$, :'fac_s', :'today'), 'senza finance.view niente incassi del giorno');

-- Abbonato multi-giorno: check-in oggi, uscita → resta prenotato per i giorni seguenti
select public.beach_checkin(:'bk_abb');
select public.beach_checkout(:'bk_abb');
select pg_temp.assert((select status from public.beach_bookings where id = :'bk_abb') = 'prenotata', 'l''abbonato che esce resta titolare della postazione');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Sopra abbonato')$q$, :'p_a8', :'tomorrow', :'tomorrow'),
  'non si prenota sulla postazione di un abbonato');

-- ---------------------------------------------------------------------------
-- Dati personali e finanza
-- ---------------------------------------------------------------------------
select pg_temp.as_user('barista@beach-test.it');
select pg_temp.assert((select count(*) from public.beach_bookings) = 0, 'il barista non vede prenotazioni e dati dei clienti');
select pg_temp.assert((select count(*) from public.beach_rates) = 0, 'il barista non vede il listino');
select pg_temp.expect_error(format($q$select public.beach_checkin(%L)$q$, :'bk_walk'), 'il barista non fa check-in');
select pg_temp.expect_error(format($q$select public.beach_book(%L, 'giornata', %L, %L, 'Barista')$q$, :'p_a3', :'tomorrow', :'tomorrow'), 'il barista non prenota');

select pg_temp.as_user('altro@beach-test.it');
select pg_temp.assert((select count(*) from public.beach_bookings) = 0, 'un''altra azienda non vede le prenotazioni');
select pg_temp.assert((select count(*) from public.beach_moves) = 0, 'un''altra azienda non vede i cambi postazione');
select pg_temp.expect_error(format($q$select public.beach_checkin(%L)$q$, :'bk_walk'), 'un''altra azienda non fa check-in');
select pg_temp.expect_error(format($q$select public.beach_cancel(%L)$q$, :'bk_walk'), 'un''altra azienda non annulla');

select pg_temp.as_user('titolare@beach-test.it');
select * from public.beach_day_revenue(:'fac_s', :'today') \gset rev_
select pg_temp.assert(:'rev_collected'::numeric = 10 + 20 + 30 + 500 - 30, 'incassato del giorno al netto dei rimborsi (530 €)');
select pg_temp.assert(:'rev_collected_card'::numeric = 20, 'incassato con carta');
select pg_temp.assert(:'rev_sold_count'::int = 6, 'prenotazioni vendute oggi (escluse le annullate)');

-- Audit
select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.audit_log where entity = 'beach_bookings' and entity_id = :'bk_rossi') >= 4, 'prenotazione, check-in, spostamento e uscita in audit');
select pg_temp.assert((select count(*) from public.audit_log where entity = 'beach_moves') = 1, 'cambio postazione in audit');

do $$ begin raise notice '✓ Test spiaggia superati'; end $$;
