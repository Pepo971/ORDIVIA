-- Test modulo Turni e personale: isolamento, bozze, riservatezza delle assenze, cambi turno, checklist.
-- Esecuzione: scripts/db-test.sh
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
-- Orario locale Europe/Rome → timestamptz
create or replace function pg_temp.rome(p text) returns timestamptz language sql as $$
  select (p::timestamp) at time zone 'Europe/Rome'
$$;

set client_min_messages = notice;
select pg_temp.as_admin();

-- ---------------------------------------------------------------------------
-- Utenti e organizzazioni
-- ---------------------------------------------------------------------------
insert into auth.users (email) values
  ('mara@shifts-test.it'),   -- titolare Hotel Mare
  ('luca@shifts-test.it'),   -- manager (shifts.manage)
  ('sara@shifts-test.it'),   -- staff bar
  ('tino@shifts-test.it'),   -- staff bar
  ('ugo@shifts-test.it'),    -- staff cucina
  ('vera@shifts-test.it');   -- titolare di un'altra azienda

select pg_temp.as_user('mara@shifts-test.it');
select public.create_organization('Hotel Mare srl', 'Hotel Mare', 'hotel') as s_org \gset
select pg_temp.as_user('vera@shifts-test.it');
select public.create_organization('Camping Pini', 'Camping Pini', 'camping') as s_org2 \gset

select pg_temp.as_admin();
select id as s_fac from public.facilities where org_id = :'s_org' \gset
select id as s_fac2 from public.facilities where org_id = :'s_org2' \gset
select id as s_bar from public.departments where org_id = :'s_org' and kind = 'bar' \gset
select id as s_cucina from public.departments where org_id = :'s_org' and kind = 'cucina' \gset
select id as s_u_mara from auth.users where email = 'mara@shifts-test.it' \gset
select id as s_u_luca from auth.users where email = 'luca@shifts-test.it' \gset
select id as s_u_sara from auth.users where email = 'sara@shifts-test.it' \gset
select id as s_u_tino from auth.users where email = 'tino@shifts-test.it' \gset
select id as s_u_ugo from auth.users where email = 'ugo@shifts-test.it' \gset
select id as s_u_vera from auth.users where email = 'vera@shifts-test.it' \gset
select id as s_dep_other from public.departments where org_id = :'s_org2' limit 1 \gset

insert into public.memberships (org_id, user_id, role_id, facility_ids, department_ids)
select :'s_org', u.id, r.id, array[:'s_fac']::uuid[], d.deps
from (values ('luca@shifts-test.it', 'manager', '{}'::uuid[]),
             ('sara@shifts-test.it', 'staff', array[:'s_bar']::uuid[]),
             ('tino@shifts-test.it', 'staff', array[:'s_bar']::uuid[]),
             ('ugo@shifts-test.it',  'staff', array[:'s_cucina']::uuid[])) d(email, role_key, deps)
join auth.users u on u.email = d.email
join public.roles r on r.org_id = :'s_org' and r.key = d.role_key;

select pg_temp.assert((select count(*) from public.roles where org_id = :'s_org' and key = 'staff' and 'shifts.view' = any(permissions)) = 1,
  'il ruolo collaboratore ha shifts.view');

-- ---------------------------------------------------------------------------
-- Pianificazione (settimana del 19/10/2026)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('luca@shifts-test.it');
insert into public.shifts (org_id, facility_id, department_id, user_id, starts_at, ends_at, break_minutes, role_label)
values (:'s_org', :'s_fac', :'s_bar', :'s_u_sara', pg_temp.rome('2026-10-19 07:00'), pg_temp.rome('2026-10-19 15:00'), 30, 'Apertura')
returning id as sh_sara_mon \gset
insert into public.shifts (org_id, facility_id, department_id, user_id, starts_at, ends_at)
values (:'s_org', :'s_fac', :'s_bar', :'s_u_tino', pg_temp.rome('2026-10-19 15:00'), pg_temp.rome('2026-10-19 23:00'))
returning id as sh_tino_mon \gset
insert into public.shifts (org_id, facility_id, department_id, user_id, starts_at, ends_at)
values (:'s_org', :'s_fac', :'s_bar', :'s_u_sara', pg_temp.rome('2026-10-20 07:00'), pg_temp.rome('2026-10-20 15:00'))
returning id as sh_sara_tue \gset
insert into public.shifts (org_id, facility_id, department_id, user_id, starts_at, ends_at)
values (:'s_org', :'s_fac', :'s_cucina', :'s_u_ugo', pg_temp.rome('2026-10-19 10:00'), pg_temp.rome('2026-10-19 16:00'))
returning id as sh_ugo_mon \gset

select pg_temp.expect_error(format($q$insert into public.shifts (org_id, facility_id, user_id, starts_at, ends_at) values (%L, %L, %L, now(), now() - interval '1 hour')$q$,
  :'s_org', :'s_fac', :'s_u_sara'), 'la fine del turno deve essere dopo l''inizio');
select pg_temp.expect_error(format($q$insert into public.shifts (org_id, facility_id, user_id, starts_at, ends_at) values (%L, %L, %L, now(), now() + interval '1 hour')$q$,
  :'s_org', :'s_fac', :'s_u_vera'), 'non si pianifica un turno per chi non è membro');
select pg_temp.expect_error(format($q$insert into public.shifts (org_id, facility_id, department_id, user_id, starts_at, ends_at) values (%L, %L, %L, %L, now(), now() + interval '1 hour')$q$,
  :'s_org', :'s_fac', :'s_dep_other', :'s_u_sara'), 'reparto di un''altra azienda rifiutato');

-- Bozze invisibili ai collaboratori
select pg_temp.as_user('sara@shifts-test.it');
select pg_temp.assert((select count(*) from public.shifts) = 0, 'il collaboratore non vede le bozze');
select pg_temp.expect_error(format($q$insert into public.shifts (org_id, facility_id, user_id, starts_at, ends_at) values (%L, %L, %L, now(), now() + interval '1 hour')$q$,
  :'s_org', :'s_fac', :'s_u_sara'), 'il collaboratore non crea turni');
select pg_temp.expect_error(format($q$select public.publish_shift_week(%L, '2026-10-19')$q$, :'s_fac'), 'il collaboratore non pubblica');

select pg_temp.as_user('luca@shifts-test.it');
select pg_temp.expect_error(format($q$select public.publish_shift_week(%L, '2026-10-20')$q$, :'s_fac'), 'la settimana deve iniziare di lunedì');
select pg_temp.assert(public.publish_shift_week(:'s_fac', '2026-10-19') = 4, 'pubblicati 4 turni della settimana');
select pg_temp.assert((select bool_and(published_at is not null and changed_at is null) from public.shifts where facility_id = :'s_fac'), 'pubblicazione con timestamp, nessun «modificato»');

select pg_temp.as_user('sara@shifts-test.it');
select pg_temp.assert((select count(*) from public.shifts) = 4, 'dopo la pubblicazione il collaboratore vede i turni');
update public.shifts set ends_at = ends_at + interval '1 hour' where id = :'sh_sara_mon';
select pg_temp.as_admin();
select pg_temp.assert((select ends_at from public.shifts where id = :'sh_sara_mon') = pg_temp.rome('2026-10-19 15:00'), 'il collaboratore non modifica il proprio turno');

-- Modifica dopo pubblicazione → «modificato»
select pg_temp.as_user('luca@shifts-test.it');
update public.shifts set ends_at = pg_temp.rome('2026-10-20 16:00') where id = :'sh_sara_tue';
select pg_temp.assert((select changed_at is not null from public.shifts where id = :'sh_sara_tue'), 'turno pubblicato modificato → changed_at');
select pg_temp.expect_error(format($q$update public.shifts set status = 'bozza' where id = %L$q$, :'sh_sara_tue'), 'un turno pubblicato non torna in bozza');
delete from public.shifts where id = :'sh_ugo_mon';
select pg_temp.assert((select count(*) from public.shifts where id = :'sh_ugo_mon') = 1, 'un turno pubblicato non si cancella direttamente');
select pg_temp.assert(public.remove_shift(:'sh_ugo_mon') = 'annullato', 'un turno pubblicato si annulla');

-- Copia settimana (nuova settimana: 26/10, attraversa il cambio d'ora del 25/10)
select pg_temp.assert(public.copy_shift_week(:'s_fac', '2026-10-19', '2026-10-26') = 3, 'copiati 3 turni (escluso l''annullato)');
select pg_temp.assert((select count(*) from public.shifts where status = 'bozza' and starts_at = pg_temp.rome('2026-10-26 07:00') and user_id = :'s_u_sara') = 1,
  'la copia mantiene le 07:00 locali dopo il cambio d''ora');
select pg_temp.assert(public.copy_shift_week(:'s_fac', '2026-10-19', '2026-10-26') = 0, 'copiare due volte non duplica');
select pg_temp.assert(public.remove_shift((select id from public.shifts where status = 'bozza' and user_id = :'s_u_tino' limit 1)) = 'eliminato', 'una bozza si elimina');

-- Costi: solo finance.view
select pg_temp.as_user('mara@shifts-test.it');
insert into public.member_hourly_costs (org_id, user_id, hourly_cost) values (:'s_org', :'s_u_sara', 14.50);
select pg_temp.as_user('sara@shifts-test.it');
select pg_temp.assert((select count(*) from public.member_hourly_costs) = 0, 'il collaboratore non vede i costi orari');
select pg_temp.as_user('luca@shifts-test.it');
select pg_temp.assert((select count(*) from public.member_hourly_costs) = 1, 'il manager con finance.view vede i costi orari');

-- ---------------------------------------------------------------------------
-- Isolamento tra aziende
-- ---------------------------------------------------------------------------
select pg_temp.as_user('vera@shifts-test.it');
select pg_temp.assert((select count(*) from public.shifts) = 0, 'un''altra azienda non vede i turni');
select pg_temp.assert((select count(*) from public.member_hourly_costs) = 0, 'un''altra azienda non vede i costi');
select pg_temp.expect_error(format($q$select public.publish_shift_week(%L, '2026-10-26')$q$, :'s_fac'), 'pubblicazione cross-tenant bloccata');
select pg_temp.expect_error(format($q$select public.copy_shift_week(%L, '2026-10-19', '2026-11-02')$q$, :'s_fac'), 'copia cross-tenant bloccata');
select pg_temp.expect_error(format($q$select public.remove_shift(%L)$q$, :'sh_sara_mon'), 'annullamento cross-tenant bloccato');
select pg_temp.expect_error(format($q$select * from public.team_absences(%L, now(), now() + interval '7 days')$q$, :'s_fac'), 'assenze cross-tenant bloccate');
select pg_temp.expect_error(format($q$insert into public.shifts (org_id, facility_id, user_id, starts_at, ends_at) values (%L, %L, %L, now(), now() + interval '1 hour')$q$,
  :'s_org2', :'s_fac', :'s_u_sara'), 'un turno non può puntare a una struttura di un''altra azienda');
select pg_temp.expect_error(format($q$select public.generate_daily_checklists(%L, current_date)$q$, :'s_fac'), 'generazione checklist cross-tenant bloccata');
select pg_temp.expect_error(format($q$select public.request_leave(%L, 'ferie', now() + interval '1 day', now() + interval '2 days')$q$, :'s_fac'), 'richiesta ferie cross-tenant bloccata');

-- ---------------------------------------------------------------------------
-- Disponibilità
-- ---------------------------------------------------------------------------
select pg_temp.as_user('tino@shifts-test.it');
insert into public.shift_unavailability (org_id, weekday, from_time, to_time, note) values (:'s_org', 3, '08:00', '13:00', 'università');
insert into public.shift_unavailability (org_id, on_date) values (:'s_org', '2026-10-31');
select pg_temp.expect_error(format($q$insert into public.shift_unavailability (org_id, user_id, weekday) values (%L, %L, 1)$q$, :'s_org', :'s_u_sara'),
  'non si dichiara indisponibilità per un collega');
select pg_temp.as_user('sara@shifts-test.it');
select pg_temp.assert((select count(*) from public.shift_unavailability) = 0, 'un collega non vede le indisponibilità altrui');
select pg_temp.as_user('luca@shifts-test.it');
select pg_temp.assert((select count(*) from public.shift_unavailability) = 2, 'il manager vede le indisponibilità');

-- ---------------------------------------------------------------------------
-- Ferie, permessi, malattia: riservatezza
-- ---------------------------------------------------------------------------
select pg_temp.as_user('tino@shifts-test.it');
select public.request_leave(:'s_fac', 'malattia', pg_temp.rome('2026-10-21 00:00'), pg_temp.rome('2026-10-23 00:00'), true, 'febbre alta') as lv_tino \gset
select pg_temp.expect_error(format($q$select public.request_leave(%L, 'ferie', now() + interval '2 days', now() + interval '1 day')$q$, :'s_fac'), 'periodo invertito rifiutato');
select pg_temp.expect_error(format($q$insert into public.leave_requests (org_id, facility_id, user_id, kind, starts_at, ends_at, status) values (%L, %L, auth.uid(), 'ferie', now(), now() + interval '1 day', 'approvata')$q$,
  :'s_org', :'s_fac'), 'non si inserisce un''assenza già approvata scavalcando la RPC');
select pg_temp.expect_error(format($q$select public.decide_leave(%L, true)$q$, :'lv_tino'), 'il collaboratore non approva la propria malattia');

select pg_temp.as_user('sara@shifts-test.it');
select public.request_leave(:'s_fac', 'ferie', pg_temp.rome('2026-11-02 00:00'), pg_temp.rome('2026-11-04 00:00'), true, 'matrimonio') as lv_sara \gset
select pg_temp.assert((select count(*) from public.leave_requests) = 1, 'il collaboratore vede solo le proprie richieste');
select pg_temp.assert((select count(*) from public.leave_requests where note = 'febbre alta' or kind = 'malattia') = 0, 'il collega non vede motivo né note della malattia');

select pg_temp.as_user('luca@shifts-test.it');
select pg_temp.assert((select count(*) from public.leave_requests) = 2, 'il manager vede tutte le richieste');
select pg_temp.expect_error(format($q$select public.decide_leave(%L, false)$q$, :'lv_tino'), 'il rifiuto richiede un motivo');
select pg_temp.assert((select status from public.decide_leave(:'lv_tino', true, 'guarisci presto')) = 'approvata', 'il manager approva la malattia');
select pg_temp.assert((select decided_at is not null and decided_by = :'s_u_luca'::uuid from public.leave_requests where id = :'lv_tino'), 'decisione con autore e timestamp');
select pg_temp.expect_error(format($q$select public.decide_leave(%L, false, 'no')$q$, :'lv_tino'), 'una richiesta già gestita non si ridecide');
select pg_temp.assert((select kind from public.team_absences(:'s_fac', pg_temp.rome('2026-10-19 00:00'), pg_temp.rome('2026-10-26 00:00')) where user_id = :'s_u_tino') = 'malattia',
  'il manager vede il motivo dell''assenza');

select pg_temp.as_user('sara@shifts-test.it');
select pg_temp.assert((select count(*) from public.team_absences(:'s_fac', pg_temp.rome('2026-10-19 00:00'), pg_temp.rome('2026-10-26 00:00')) where user_id = :'s_u_tino' and kind is null) = 1,
  'il collega vede solo «non disponibile», senza motivo');
select pg_temp.assert((select status from public.cancel_leave(:'lv_sara')) = 'annullata', 'il collaboratore annulla la propria richiesta in attesa');

-- ---------------------------------------------------------------------------
-- Cambio turno: offerta → accettazione → approvazione (riassegnazione atomica)
-- Usiamo turni futuri rispetto a now()
-- ---------------------------------------------------------------------------
select pg_temp.as_user('luca@shifts-test.it');
insert into public.shifts (org_id, facility_id, department_id, user_id, starts_at, ends_at, status)
values (:'s_org', :'s_fac', :'s_bar', :'s_u_sara', date_trunc('hour', now()) + interval '30 days', date_trunc('hour', now()) + interval '30 days 8 hours', 'pubblicato')
returning id as sh_swap \gset
insert into public.shifts (org_id, facility_id, department_id, user_id, starts_at, ends_at, status)
values (:'s_org', :'s_fac', :'s_bar', :'s_u_sara', date_trunc('hour', now()) + interval '32 days', date_trunc('hour', now()) + interval '32 days 8 hours', 'pubblicato')
returning id as sh_swap2 \gset

select pg_temp.as_user('tino@shifts-test.it');
select pg_temp.expect_error(format($q$select public.offer_shift_swap(%L, null)$q$, :'sh_swap'), 'non si offre il turno di un altro');

select pg_temp.as_user('sara@shifts-test.it');
select public.offer_shift_swap(:'sh_swap', :'s_u_tino', 'ho un esame') as sw1 \gset
select pg_temp.expect_error(format($q$select public.offer_shift_swap(%L, null)$q$, :'sh_swap'), 'una sola proposta aperta per turno');

select pg_temp.as_user('ugo@shifts-test.it');
select pg_temp.assert((select count(*) from public.shift_swaps) = 0, 'una proposta diretta non è visibile a terzi');
select pg_temp.expect_error(format($q$select public.accept_shift_swap(%L)$q$, :'sw1'), 'solo il collega scelto può accettare');

select pg_temp.as_user('tino@shifts-test.it');
select pg_temp.assert((select count(*) from public.shift_swaps where id = :'sw1') = 1, 'il collega destinatario vede la proposta');
select pg_temp.expect_error(format($q$select public.decide_shift_swap(%L, true)$q$, :'sw1'), 'non si approva prima dell''accettazione (e non da collaboratore)');
select pg_temp.assert((select status from public.accept_shift_swap(:'sw1')) = 'accettato', 'Tino accetta');
select pg_temp.expect_error(format($q$select public.decide_shift_swap(%L, true)$q$, :'sw1'), 'il collaboratore non approva il cambio');

select pg_temp.as_user('luca@shifts-test.it');
select pg_temp.assert((select status from public.decide_shift_swap(:'sw1', true, 'ok')) = 'approvato', 'il manager approva il cambio');
select pg_temp.assert((select user_id = :'s_u_tino'::uuid and changed_at is not null from public.shifts where id = :'sh_swap'), 'turno riassegnato a Tino e marcato modificato');
select pg_temp.assert((select offered_at is not null and accepted_at is not null and decided_at is not null and accepted_by = :'s_u_tino'::uuid
  from public.shift_swaps where id = :'sw1'), 'ogni passaggio del cambio ha timestamp');

-- Offerta al reparto: solo colleghi del reparto bar possono accettare
select pg_temp.as_user('sara@shifts-test.it');
select public.offer_shift_swap(:'sh_swap2', null) as sw2 \gset
select pg_temp.as_user('ugo@shifts-test.it');
select pg_temp.assert((select count(*) from public.shift_swaps) = 0, 'un collega di altro reparto non vede l''offerta al reparto');
select pg_temp.expect_error(format($q$select public.accept_shift_swap(%L)$q$, :'sw2'), 'un collega di altro reparto non accetta');
select pg_temp.as_user('tino@shifts-test.it');
select pg_temp.assert((select count(*) from public.shift_swaps where id = :'sw2') = 1, 'il collega del reparto vede l''offerta');
select public.accept_shift_swap(:'sw2');
select pg_temp.as_user('luca@shifts-test.it');
select pg_temp.assert((select status from public.decide_shift_swap(:'sw2', false, 'servono entrambi')) = 'rifiutato', 'il manager rifiuta');
select pg_temp.assert((select user_id from public.shifts where id = :'sh_swap2') = :'s_u_sara'::uuid, 'rifiuto: il turno resta a Sara');

select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.audit_log where entity = 'shift_swaps' and entity_id = :'sw1' and actor_id is not null) >= 3,
  'ogni passaggio del cambio è in audit con autore');
select pg_temp.assert((select count(*) from public.audit_log where entity = 'leave_requests' and entity_id = :'lv_tino') >= 2, 'ferie/malattia in audit');

-- ---------------------------------------------------------------------------
-- Checklist ricorrenti
-- ---------------------------------------------------------------------------
select pg_temp.as_user('luca@shifts-test.it');
insert into public.checklist_templates (org_id, facility_id, department_id, title, items, weekdays, due_time, assignee_mode)
values (:'s_org', :'s_fac', :'s_bar', 'Apertura bar', array['Accendere macchina caffè', 'Controllare frigo', 'Rifornire banco'], '{1,2,3,4,5}', '09:00', 'in_turno')
returning id as clt_bar \gset
insert into public.checklist_templates (org_id, facility_id, department_id, title, items, weekdays, due_time, assignee_mode, assignee_id, requires_photo)
values (:'s_org', :'s_fac', :'s_cucina', 'Pulizia cappa', array['Smontare filtri', 'Lavare filtri'], '{1}', '18:00', 'persona', :'s_u_ugo', true)
returning id as clt_cappa \gset
insert into public.checklist_templates (org_id, facility_id, department_id, title, items, weekdays, due_time, assignee_mode)
values (:'s_org', :'s_fac', :'s_bar', 'Chiusura bar (weekend)', array['Cassa'], '{6,7}', '23:00', 'in_turno');
select pg_temp.expect_error(format($q$insert into public.checklist_templates (org_id, facility_id, title, items, assignee_mode) values (%L, %L, 'X prova', array['a'], 'in_turno')$q$,
  :'s_org', :'s_fac'), '«chi è in turno» richiede un reparto');

-- Lunedì 19/10: al bar alle 09:00 è in turno Sara (07–15), Tino entra alle 15
select pg_temp.as_admin();
-- rendiamo il 19/10 generabile dalla finestra di date: usiamo il nucleo (come la pianificazione automatica)
select pg_temp.assert(app.generate_checklists_core(:'s_fac', '2026-10-19') = 2, 'lunedì: generate 2 checklist (bar + cappa)');
select pg_temp.assert(app.generate_checklists_core(:'s_fac', '2026-10-19') = 0, 'seconda esecuzione: nessun duplicato (idempotente)');
select pg_temp.assert((select count(*) from public.checklist_runs where run_date = '2026-10-19') = 2, 'una corsa per modello e data');
select pg_temp.assert((select t.assignee_id from public.checklist_runs r join public.tasks t on t.id = r.task_id where r.template_id = :'clt_bar' and r.run_date = '2026-10-19') = :'s_u_sara'::uuid,
  'assegnata a chi è in turno nel reparto all''ora di scadenza');
select pg_temp.assert((select t.description from public.checklist_runs r join public.tasks t on t.id = r.task_id where r.template_id = :'clt_bar' and r.run_date = '2026-10-19')
  = E'• Accendere macchina caffè\n• Controllare frigo\n• Rifornire banco', 'descrizione = punti elenco');
select pg_temp.assert((select t.due_at from public.checklist_runs r join public.tasks t on t.id = r.task_id where r.template_id = :'clt_bar' and r.run_date = '2026-10-19')
  = pg_temp.rome('2026-10-19 09:00'), 'scadenza alle 09:00 locali');
select pg_temp.assert((select t.assignee_id = :'s_u_ugo'::uuid and t.requires_photo from public.checklist_runs r join public.tasks t on t.id = r.task_id where r.template_id = :'clt_cappa'), 'persona fissa e foto richiesta');

-- Mercoledì 21/10: nessun turno bar pubblicato → attività senza assegnatario (da assegnare)
select pg_temp.assert(app.generate_checklists_core(:'s_fac', '2026-10-21') = 1, 'mercoledì: solo la checklist bar');
select pg_temp.assert((select t.assignee_id is null from public.checklist_runs r join public.tasks t on t.id = r.task_id where r.template_id = :'clt_bar' and r.run_date = '2026-10-21'),
  'nessuno in turno → attività da assegnare');

-- Bozze non contano: 26/10 Sara ha solo una bozza
select pg_temp.assert(app.generate_checklists_core(:'s_fac', '2026-10-26') = 2, 'lunedì 26: 2 checklist');
select pg_temp.assert((select t.assignee_id is null from public.checklist_runs r join public.tasks t on t.id = r.task_id where r.template_id = :'clt_bar' and r.run_date = '2026-10-26'),
  'i turni in bozza non assegnano checklist');

-- RPC pubblica: permessi e finestra
select pg_temp.as_user('sara@shifts-test.it');
select pg_temp.expect_error(format($q$select public.generate_daily_checklists(%L)$q$, :'s_fac'), 'il collaboratore non genera checklist');
select pg_temp.assert((select count(*) from public.checklist_templates) = 0, 'il collaboratore non vede i modelli');
select pg_temp.assert((select count(*) from public.tasks where assignee_id = auth.uid()) >= 1, 'Sara vede la checklist come attività assegnata');
select pg_temp.as_user('luca@shifts-test.it');
select public.generate_daily_checklists(:'s_fac') as n_today \gset
select pg_temp.assert(public.generate_daily_checklists(:'s_fac') = 0, 'la RPC pubblica è idempotente');
select pg_temp.expect_error(format($q$select public.generate_daily_checklists(%L, current_date + 60)$q$, :'s_fac'), 'data fuori finestra rifiutata');
select pg_temp.expect_error($q$select app.generate_all_daily_checklists()$q$, 'la generazione globale non è richiamabile dai client');
select pg_temp.as_admin();
select pg_temp.assert(app.generate_all_daily_checklists() = 0, 'la generazione automatica rispetta l''idempotenza');

do $$ begin raise notice '✓ Test turni superati'; end $$;
