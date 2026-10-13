-- Test di isolamento tra aziende, permessi e flussi Acquisti/Magazzino.
-- Esecuzione: scripts/db-test.sh (Postgres locale) — ogni assert fallito interrompe con errore.
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
-- Utenti
-- ---------------------------------------------------------------------------
insert into auth.users (email) values ('anna@lidoazzurro.it'), ('bruno@trattoria.it'), ('carla@lidoazzurro.it'), ('dario@lidoazzurro.it');
select id as u_dario from auth.users where email = 'dario@lidoazzurro.it' \gset

-- Anna crea il Lido Azzurro, Bruno la Trattoria
select pg_temp.as_user('anna@lidoazzurro.it');
select public.create_organization('Lido Azzurro srl', 'Lido Azzurro', 'lido') as org_a \gset
select pg_temp.as_user('bruno@trattoria.it');
select public.create_organization('Trattoria da Bruno', 'Trattoria', 'ristorante') as org_b \gset

select pg_temp.as_admin();
select id as fac_a from public.facilities where org_id = :'org_a' \gset
select id as fac_b from public.facilities where org_id = :'org_b' \gset
select id as wh_a from public.warehouses where org_id = :'org_a' and name = 'Magazzino Bar' \gset
select id as wh_b from public.warehouses where org_id = :'org_b' and name = 'Magazzino centrale' \gset

select pg_temp.assert((select count(*) from public.departments where org_id = :'org_a') = 4, 'il template lido crea 4 reparti');
select pg_temp.assert((select count(*) from public.warehouses where org_id = :'org_a') = 3, 'magazzini creati per bar, cucina, magazzino');
select pg_temp.assert((select count(*) from public.profiles) = 4, 'profilo creato alla registrazione');

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
select pg_temp.as_user('anna@lidoazzurro.it');
select pg_temp.assert((select count(*) from public.organizations) = 1, 'Anna vede solo la propria organizzazione');
select pg_temp.assert((select count(*) from public.facilities where org_id = :'org_b') = 0, 'Anna non vede strutture di Bruno');
select pg_temp.assert((select count(*) from public.warehouses where org_id = :'org_b') = 0, 'Anna non vede magazzini di Bruno');
select pg_temp.expect_error(format($q$insert into public.products (org_id, name) values (%L, 'Intruso')$q$, :'org_b'),
  'Anna non può creare prodotti nell''organizzazione di Bruno');
select pg_temp.expect_error(format($q$insert into public.departments (org_id, facility_id, name) values (%L, %L, 'X')$q$, :'org_a', :'fac_b'),
  'un reparto non può puntare a una struttura di un''altra organizzazione');

-- Anna prepara catalogo e fornitore
insert into public.products (org_id, name, base_unit) values (:'org_a', 'Acqua naturale 50 cl', 'pz') returning id as p_acqua \gset
insert into public.products (org_id, name, base_unit) values (:'org_a', 'Limoni', 'kg') returning id as p_limoni \gset
insert into public.suppliers (org_id, name, email, delivery_weekdays, cutoff_time, lead_days)
  values (:'org_a', 'Bevande Sud', 'ordini@bevandesud.it', '{2,5}', '11:00', 1) returning id as sup_a \gset
insert into public.supplier_products (org_id, supplier_id, product_id, pack_label, pack_qty, price, preferred)
  values (:'org_a', :'sup_a', :'p_acqua', 'fardello 24 pz', 24, 6.00, true) returning id as sp_acqua \gset
insert into public.suppliers (org_id, name) values (:'org_a', 'Ortofrutta Rossi') returning id as sup_b \gset
insert into public.supplier_products (org_id, supplier_id, product_id, pack_label, pack_qty, price)
  values (:'org_a', :'sup_b', :'p_limoni', 'cassa 5 kg', 5, 9.50);
insert into public.stock_settings (org_id, warehouse_id, product_id, min_qty, par_qty) values (:'org_a', :'wh_a', :'p_acqua', 48, 144);

select pg_temp.assert((select count(*) from public.supplier_price_history where supplier_product_id = :'sp_acqua') = 1, 'il listino registra lo storico prezzi');
update public.supplier_products set price = 6.60 where id = :'sp_acqua';
select pg_temp.assert((select count(*) from public.supplier_price_history where supplier_product_id = :'sp_acqua') = 2, 'variazione prezzo storicizzata');

select pg_temp.as_user('bruno@trattoria.it');
select pg_temp.assert((select count(*) from public.products) = 0, 'Bruno non vede i prodotti di Anna');
select pg_temp.assert((select count(*) from public.suppliers) = 0, 'Bruno non vede i fornitori di Anna');
select pg_temp.assert((select count(*) from public.supplier_price_history) = 0, 'Bruno non vede lo storico prezzi di Anna');
select pg_temp.expect_error(format($q$select public.po_transition(%L, 'approvato')$q$, gen_random_uuid()), 'ordine inesistente');

-- ---------------------------------------------------------------------------
-- Inviti e ruoli
-- ---------------------------------------------------------------------------
select pg_temp.as_user('anna@lidoazzurro.it');
select id as role_staff from public.roles where org_id = :'org_a' and key = 'staff' \gset
select id as role_wh from public.roles where org_id = :'org_a' and key = 'warehouse' \gset
select id as role_lead from public.roles where org_id = :'org_a' and key = 'dept_lead' \gset
insert into public.invitations (org_id, email, role_id, facility_ids) values (:'org_a', 'carla@lidoazzurro.it', :'role_lead', array[:'fac_a']::uuid[]) returning token as tok_c \gset
insert into public.invitations (org_id, email, role_id, facility_ids) values (:'org_a', 'dario@lidoazzurro.it', :'role_staff', array[:'fac_a']::uuid[]) returning token as tok_d \gset

select pg_temp.as_user('bruno@trattoria.it');
select pg_temp.expect_error(format($q$select public.accept_invitation(%L)$q$, :'tok_c'), 'un invito non può essere usato da un''altra email');
select pg_temp.assert((select count(*) from public.invitations) = 0, 'Bruno non vede gli inviti di Anna');

select pg_temp.as_user('carla@lidoazzurro.it');
select pg_temp.assert(public.accept_invitation(:'tok_c') = :'org_a'::uuid, 'Carla accetta l''invito');
select pg_temp.as_user('dario@lidoazzurro.it');
select public.accept_invitation(:'tok_d');
select pg_temp.expect_error(format($q$select public.accept_invitation(%L)$q$, :'tok_d'), 'invito non riutilizzabile');

-- Dario (collaboratore) non vede prezzi né costi
select pg_temp.assert((select count(*) from public.supplier_products) = 0, 'il collaboratore non vede i listini');
select pg_temp.assert((select count(*) from public.suppliers) = 0, 'il collaboratore non vede i fornitori');
select pg_temp.expect_error($q$select pin_hash from public.memberships$q$, 'pin_hash mai leggibile dai client');
update public.memberships set role_id = :'role_lead' where user_id = auth.uid(); -- RLS: 0 righe
select pg_temp.as_admin();
select pg_temp.assert((select r.key from public.memberships m join public.roles r on r.id = m.role_id
  where m.user_id = (select id from auth.users where email = 'dario@lidoazzurro.it')) = 'staff', 'un collaboratore non può promuoversi');

-- Un amministratore non può declassare il titolare; il titolare non può lasciare l'azienda senza titolari
select pg_temp.as_admin();
select id as role_admin from public.roles where org_id = :'org_a' and key = 'admin' \gset
update public.memberships set role_id = :'role_admin' where user_id = (select id from auth.users where email = 'carla@lidoazzurro.it');
select pg_temp.as_user('carla@lidoazzurro.it');
select pg_temp.expect_error(format($q$update public.memberships set role_id = %L where org_id = %L and user_id <> auth.uid() and role_id = (select id from public.roles where org_id = %L and key = 'owner')$q$, :'role_staff', :'org_a', :'org_a'),
  'un amministratore non declassa il titolare');
select pg_temp.as_user('anna@lidoazzurro.it');
select pg_temp.expect_error(format($q$update public.memberships set active = false where user_id = auth.uid() and org_id = %L$q$, :'org_a'), 'resta almeno un titolare attivo');
select pg_temp.as_admin();
update public.memberships set role_id = :'role_lead' where user_id = (select id from auth.users where email = 'carla@lidoazzurro.it');

-- ---------------------------------------------------------------------------
-- Flusso: richiesta reparto → ordine → approvazione → invio → ricezione → giacenza e costo
-- ---------------------------------------------------------------------------
select pg_temp.as_user('carla@lidoazzurro.it');
select id as dep_bar from public.departments where org_id = :'org_a' and kind = 'bar' \gset
insert into public.purchase_requests (org_id, facility_id, department_id, status, requested_by)
  values (:'org_a', :'fac_a', :'dep_bar', 'bozza', auth.uid()) returning id as req1 \gset
insert into public.purchase_request_lines (org_id, request_id, product_id, qty) values (:'org_a', :'req1', :'p_acqua', 60);
update public.purchase_requests set status = 'inviata' where id = :'req1';
select pg_temp.expect_error(format($q$select public.orders_from_requests(array[%L]::uuid[])$q$, :'req1'),
  'il responsabile di reparto non può convertire in ordine');

select pg_temp.as_user('anna@lidoazzurro.it');
select public.orders_from_requests(array[:'req1']::uuid[]) as po1 \gset
select pg_temp.assert((select qty_packs from public.purchase_order_lines where order_id = :'po1') = 3, '60 pz → 3 fardelli da 24 (arrotondato per eccesso)');
select pg_temp.assert((select status from public.purchase_requests where id = :'req1') = 'convertita', 'richiesta convertita');
select pg_temp.expect_error(format($q$select public.po_transition(%L, 'inviato')$q$, :'po1'), 'non si invia un ordine non approvato');
select public.po_transition(:'po1', 'approvato');
update public.purchase_order_lines set qty_packs = 99 where order_id = :'po1'; -- RLS: 0 righe
select pg_temp.assert((select qty_packs from public.purchase_order_lines where order_id = :'po1') = 3, 'un ordine approvato non è modificabile');
select public.po_transition(:'po1', 'inviato');

-- Ricezione parziale: arrivano 2 fardelli su 3, prezzo in fattura 6.90
select pg_temp.as_user('carla@lidoazzurro.it');
select public.start_receipt(:'po1', :'wh_a') as rc1 \gset
update public.receipt_lines set qty_packs = 2, unit_price = 6.90, lot = 'L2410', issue = 'mancante' where receipt_id = :'rc1';
select public.confirm_receipt(:'rc1');
select pg_temp.assert((select qty from public.stock_on_hand where warehouse_id = :'wh_a' and product_id = :'p_acqua') = 48, 'giacenza 48 pz dopo carico');
select pg_temp.assert((select status from public.purchase_orders where id = :'po1') = 'parziale', 'ordine parzialmente ricevuto');
select pg_temp.expect_error(format($q$select public.confirm_receipt(%L)$q$, :'rc1'), 'ricezione non confermabile due volte');
select pg_temp.expect_error($q$select unit_cost from public.stock_movements$q$, 'costo unitario non leggibile senza finance.view');
select pg_temp.assert((select count(*) from public.product_costs) = 0, 'il responsabile di reparto non vede i costi');

select pg_temp.as_user('anna@lidoazzurro.it');
select pg_temp.assert((select round(avg_cost, 4) from public.product_costs where product_id = :'p_acqua') = 0.2875, 'costo medio = 6.90 / 24');
select pg_temp.assert((select count(*) from public.supplier_price_history where supplier_product_id = :'sp_acqua' and source = 'ricezione') = 1, 'prezzo da documento storicizzato');

-- Seconda consegna con il fardello mancante a 6.60 → costo medio ponderato
select pg_temp.as_user('carla@lidoazzurro.it');
select public.start_receipt(:'po1', :'wh_a') as rc2 \gset
select pg_temp.assert((select qty_packs from public.receipt_lines where receipt_id = :'rc2') = 1, 'la seconda ricezione propone solo il residuo');
update public.receipt_lines set unit_price = 6.60 where receipt_id = :'rc2';
select public.confirm_receipt(:'rc2');
select pg_temp.as_user('anna@lidoazzurro.it');
select pg_temp.assert((select status from public.purchase_orders where id = :'po1') = 'ricevuto', 'ordine completato');
select pg_temp.assert((select round(avg_cost, 4) from public.product_costs where product_id = :'p_acqua') = round((6.90*2 + 6.60) / 72, 4), 'costo medio ponderato');

-- Scarichi e sprechi: segno forzato, permessi
select pg_temp.as_user('dario@lidoazzurro.it');
select pg_temp.expect_error(format($q$insert into public.stock_movements (org_id, warehouse_id, product_id, qty, kind) values (%L, %L, %L, 5, 'spreco')$q$, :'org_a', :'wh_a', :'p_acqua'),
  'il collaboratore non registra movimenti');
select pg_temp.as_user('carla@lidoazzurro.it');
insert into public.stock_movements (org_id, warehouse_id, product_id, qty, kind, note) values (:'org_a', :'wh_a', :'p_acqua', 6, 'spreco', 'bottiglie rotte');
select pg_temp.expect_error(format($q$insert into public.stock_movements (org_id, warehouse_id, product_id, qty, kind) values (%L, %L, %L, 100, 'carico')$q$, :'org_a', :'wh_a', :'p_acqua'),
  'i carichi passano solo da ricezione o carico manuale');
select pg_temp.assert((select qty from public.stock_on_hand where warehouse_id = :'wh_a' and product_id = :'p_acqua') = 66, 'spreco scalato: 72 - 6 = 66');
select pg_temp.expect_error(format($q$delete from public.stock_movements where warehouse_id = %L$q$, :'wh_a'), 'i movimenti sono immutabili (delete)');
select pg_temp.expect_error(format($q$update public.stock_movements set qty = 1 where warehouse_id = %L$q$, :'wh_a'), 'i movimenti sono immutabili (update)');

select pg_temp.expect_error(format($q$insert into public.stock_movements (org_id, warehouse_id, product_id, qty, kind) values (%L, %L, %L, 500, 'trasferimento')$q$, :'org_a', :'wh_a', :'p_acqua'),
  'un trasferimento diretto (senza contropartita) è bloccato');
select id as wh_a2 from public.warehouses where org_id = :'org_a' and name = 'Magazzino centrale' \gset
select public.transfer_stock(:'wh_a', :'wh_a2', :'p_acqua', 10, null);
select pg_temp.assert((select qty from public.stock_on_hand where warehouse_id = :'wh_a2' and product_id = :'p_acqua') = 10
  and (select qty from public.stock_on_hand where warehouse_id = :'wh_a' and product_id = :'p_acqua') = 56, 'trasferimento atomico 66 → 56 + 10');
select public.transfer_stock(:'wh_a2', :'wh_a', :'p_acqua', 10, null);

-- Inventario
select public.apply_inventory_count(:'wh_a', jsonb_build_array(jsonb_build_object('product_id', :'p_acqua', 'qty', 60))) as n_adj \gset
select pg_temp.assert(:n_adj = 1, 'una rettifica creata');
select pg_temp.assert((select qty from public.stock_on_hand where warehouse_id = :'wh_a' and product_id = :'p_acqua') = 60, 'giacenza allineata alla conta');

-- Bruno non può operare sul magazzino di Anna
select pg_temp.as_user('bruno@trattoria.it');
select pg_temp.expect_error(format($q$select public.apply_inventory_count(%L, '[]'::jsonb)$q$, :'wh_a'), 'inventario cross-tenant bloccato');
select pg_temp.expect_error(format($q$select public.manual_load(%L, %L, 10, 1, null)$q$, :'wh_a', :'p_acqua'), 'carico cross-tenant bloccato');
select pg_temp.expect_error(format($q$select * from public.inventory_valuation(%L)$q$, :'fac_a'), 'valorizzazione cross-tenant bloccata');
select pg_temp.assert((select count(*) from public.stock_on_hand) = 0, 'Bruno non vede giacenze di Anna');
select pg_temp.assert((select count(*) from public.audit_log) > 0, 'Bruno vede il proprio audit');
select pg_temp.assert((select count(*) from public.audit_log where org_id = :'org_a') = 0, 'Bruno non vede l''audit di Anna');

-- ---------------------------------------------------------------------------
-- Attività tracciate
-- ---------------------------------------------------------------------------
select pg_temp.as_user('carla@lidoazzurro.it');
insert into public.tasks (org_id, facility_id, title, assignee_id, requires_photo, requires_verification)
  values (:'org_a', :'fac_a', 'Pulizia frigo bar', :'u_dario', true, true)
  returning id as t1 \gset
select pg_temp.as_user('dario@lidoazzurro.it');
select pg_temp.assert((select count(*) from public.tasks) = 1, 'Dario vede la propria attività');
select public.task_transition(:'t1', 'vista');
select public.task_transition(:'t1', 'iniziata');
select pg_temp.expect_error(format($q$select public.task_transition(%L, 'completata')$q$, :'t1'), 'foto obbligatoria');
select pg_temp.expect_error(format($q$select public.task_transition(%L, 'completata', 'x', %L)$q$, :'t1', :'org_b' || '/tasks/x.jpg'), 'foto di un''altra azienda rifiutata');
select public.task_transition(:'t1', 'completata', 'fatto', :'org_a' || '/tasks/' || :'t1' || '/foto.jpg');
select pg_temp.expect_error(format($q$select public.task_transition(%L, 'verificata')$q$, :'t1'), 'l''esecutore non si auto-verifica');
-- Un update diretto senza policy non dà errore ma tocca 0 righe: verificato sotto.
update public.tasks set status = 'verificata' where id = :'t1';
select pg_temp.as_user('carla@lidoazzurro.it');
select pg_temp.assert((select status from public.tasks where id = :'t1') = 'completata', 'update diretto dell''esecutore ignorato');
select public.task_transition(:'t1', 'verificata');
select pg_temp.assert((select seen_at is not null and started_at is not null and completed_at is not null and verified_at is not null
  from public.tasks where id = :'t1'), 'tutti i passaggi hanno timestamp');

-- ---------------------------------------------------------------------------
-- Postazioni condivise con PIN
-- ---------------------------------------------------------------------------
select pg_temp.as_user('anna@lidoazzurro.it');
insert into public.stations (org_id, facility_id, name, kind, allowed_permissions)
  values (:'org_a', :'fac_a', 'Tablet bar', 'bar', array['tasks.perform','inventory.view','inventory.move']) returning id as st1 \gset
select public.set_member_pin((select id from public.memberships where user_id = :'u_dario'), '4821');
select pg_temp.expect_error(format($q$select public.set_member_pin(%L, '12')$q$, (select id from public.memberships where user_id = :'u_dario')), 'PIN troppo corto rifiutato');
select pg_temp.assert((select user_id from public.verify_station_pin(:'st1', '4821')) = :'u_dario'::uuid, 'il PIN identifica Dario sulla postazione');
select pg_temp.assert((select permissions from public.verify_station_pin(:'st1', '4821')) = array['inventory.view','tasks.perform']
  or (select permissions from public.verify_station_pin(:'st1', '4821')) @> array['inventory.view','tasks.perform'] and
     not ((select permissions from public.verify_station_pin(:'st1', '4821')) @> array['inventory.move']),
  'permessi effettivi = ruolo ∩ postazione');
select pg_temp.assert((select count(*) from public.verify_station_pin(:'st1', '0000')) = 0, 'PIN errato non identifica nessuno');
select pg_temp.as_user('bruno@trattoria.it');
select pg_temp.expect_error(format($q$select * from public.verify_station_pin(%L, '4821')$q$, :'st1'), 'postazione di un''altra azienda inaccessibile');
select pg_temp.as_user('dario@lidoazzurro.it');
select pg_temp.expect_error(format($q$select public.set_member_pin(%L, '1111')$q$, (select id from public.memberships where org_id = :'org_a' and user_id <> :'u_dario' limit 1)),
  'un collaboratore non cambia il PIN altrui');

-- Audit con autore
select pg_temp.as_admin();
select pg_temp.assert((select count(*) from public.audit_log where entity = 'tasks' and entity_id = :'t1' and actor_id is not null) >= 5,
  'ogni passaggio dell''attività è in audit con autore');
select pg_temp.assert((select count(*) from public.audit_log where after ? 'pin_hash' or before ? 'pin_hash') = 0, 'il PIN non finisce in audit');

do $$ begin raise notice '✓ Tutti i test superati'; end $$;
