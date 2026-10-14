-- Ordivia v3 — basi comuni: ospiti/CRM, richieste ospiti, permessi e ruoli per prenotazioni,
-- portale QR, camere/housekeeping, manutenzione, numeri.

insert into public.permissions (key, description, sensitive) values
  ('reservations.manage', 'Gestire prenotazioni di ristorante, eventi e servizi', false),
  ('crm.view',            'Vedere le schede clienti', false),
  ('crm.manage',          'Modificare, esportare e cancellare dati dei clienti (GDPR)', true),
  ('portal.manage',       'Configurare il portale QR per gli ospiti', false),
  ('rooms.operate',       'Housekeeping: aggiornare lo stato delle camere', false),
  ('rooms.manage',        'Gestire camere, arrivi, partenze e addebiti in camera', false),
  ('maintenance.report',  'Segnalare guasti e problemi', false),
  ('maintenance.manage',  'Gestire e chiudere gli interventi di manutenzione', false),
  ('analytics.view',      'Vedere andamento operativo (senza dati economici)', false)
on conflict (key) do nothing;

create or replace function app.seed_system_roles(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.roles (org_id, key, name, is_system, permissions) values
    (p_org, 'owner',        'Titolare',                true, (select array_agg(key) from public.permissions)),
    (p_org, 'admin',        'Amministratore',          true, (select array_agg(key) from public.permissions)),
    (p_org, 'manager',      'Manager',                 true, array['tasks.manage','tasks.perform','suppliers.manage','purchasing.request','purchasing.approve','purchasing.send','receiving.perform','inventory.view','inventory.move','inventory.count','finance.view','audit.view','menu.manage','pos.operate','pos.kitchen','pos.supervise','beach.operate','beach.manage','shifts.manage','shifts.view','haccp.record','stations.manage','reservations.manage','crm.view','crm.manage','portal.manage','rooms.operate','rooms.manage','maintenance.report','maintenance.manage','analytics.view']),
    (p_org, 'dept_lead',    'Responsabile di reparto', true, array['tasks.manage','tasks.perform','purchasing.request','receiving.perform','inventory.view','inventory.move','inventory.count','pos.operate','pos.kitchen','shifts.view','haccp.record','maintenance.report','analytics.view']),
    (p_org, 'receptionist', 'Receptionist',            true, array['tasks.perform','reservations.manage','crm.view','rooms.manage','rooms.operate','maintenance.report','pos.operate','shifts.view']),
    (p_org, 'warehouse',    'Magazziniere',            true, array['tasks.perform','receiving.perform','inventory.view','inventory.move','inventory.count','shifts.view','haccp.record','maintenance.report']),
    (p_org, 'cashier',      'Cassiere',                true, array['tasks.perform','pos.operate','pos.supervise','shifts.view','maintenance.report','crm.view']),
    (p_org, 'waiter',       'Cameriere',               true, array['tasks.perform','pos.operate','shifts.view','maintenance.report']),
    (p_org, 'cook',         'Cuoco / Pizzaiolo',       true, array['tasks.perform','pos.kitchen','inventory.view','haccp.record','shifts.view','maintenance.report']),
    (p_org, 'bartender',    'Bartender',               true, array['tasks.perform','pos.operate','pos.kitchen','inventory.view','shifts.view','maintenance.report']),
    (p_org, 'beach',        'Spiaggino',               true, array['tasks.perform','beach.operate','pos.operate','shifts.view','maintenance.report']),
    (p_org, 'housekeeping', 'Housekeeping',            true, array['tasks.perform','rooms.operate','inventory.view','shifts.view','maintenance.report']),
    (p_org, 'maintenance',  'Manutentore',             true, array['tasks.perform','maintenance.report','maintenance.manage','shifts.view','inventory.view']),
    (p_org, 'staff',        'Collaboratore',           true, array['tasks.perform','inventory.view','shifts.view','maintenance.report'])
  on conflict (org_id, key) do update set permissions = excluded.permissions, name = excluded.name;
end $$;

do $$ declare r record; begin
  for r in select id from public.organizations loop
    perform app.seed_system_roles(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Clienti (CRM): a livello di organizzazione, condivisi tra le strutture
-- ---------------------------------------------------------------------------
create table public.customers (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  full_name          text not null check (length(trim(full_name)) between 1 and 160),
  email              text,
  phone              text,
  language           text not null default 'it',
  birthday           date,
  allergies          text[] not null default '{}',
  preferences        text,
  notes              text,
  tags               text[] not null default '{}',
  privacy_consent_at timestamptz,
  marketing_consent  boolean not null default false,
  marketing_consent_at timestamptz,
  consent_source     text,            -- portale, reception, telefono, importazione…
  anonymized_at      timestamptz,     -- GDPR: dati personali rimossi, storico economico conservato
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, org_id)
);
create index on public.customers (org_id, lower(full_name));
create index on public.customers (org_id, lower(email)) where email is not null;
create index on public.customers (org_id, phone) where phone is not null;

-- Chi lavora con gli ospiti vede le schede; la modifica dei consensi e la cancellazione richiedono crm.manage.
create or replace function app.can_see_customers(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_perm(p_org, 'crm.view') or app.has_perm(p_org, 'reservations.manage') or app.has_perm(p_org, 'rooms.manage')
      or app.has_perm(p_org, 'beach.operate') or app.has_perm(p_org, 'beach.manage') or app.has_perm(p_org, 'crm.manage')
$$;
grant execute on function app.can_see_customers(uuid) to authenticated;

alter table public.customers enable row level security;
create policy cust_select on public.customers for select to authenticated using (app.can_see_customers(org_id));
create policy cust_insert on public.customers for insert to authenticated with check (app.can_see_customers(org_id));
create policy cust_update on public.customers for update to authenticated using (app.can_see_customers(org_id) and anonymized_at is null)
  with check (app.can_see_customers(org_id));
-- Nessun delete diretto: si anonimizza (vedi modulo CRM).
select app.enable_audit('public.customers');

-- ---------------------------------------------------------------------------
-- Richieste degli ospiti (dal portale QR o registrate dallo staff)
-- ---------------------------------------------------------------------------
create table public.guest_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  facility_id      uuid not null,
  service_point_id uuid,
  customer_id      uuid,
  source           text not null default 'staff' check (source in ('portale','staff','telefono','whatsapp','email')),
  category         text not null default 'assistenza' check (category in ('assistenza','pulizia','manutenzione','room_service','informazioni','reclamo','altro')),
  message          text not null check (length(trim(message)) between 1 and 1000),
  guest_name       text,
  guest_contact    text,
  status           text not null default 'nuova' check (status in ('nuova','presa_in_carico','risolta','annullata')),
  assigned_to      uuid references auth.users(id),
  created_by       uuid,
  taken_at         timestamptz,
  resolved_at      timestamptz,
  resolution_note  text,
  created_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (service_point_id, org_id) references public.service_points(id, org_id) on delete set null (service_point_id),
  foreign key (customer_id, org_id) references public.customers(id, org_id) on delete set null (customer_id)
);
create index on public.guest_requests (org_id, facility_id, status, created_at desc);

create or replace function app.can_handle_guest_requests(p_org uuid, p_facility uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_facility_perm(p_org, p_facility, 'rooms.operate') or app.has_facility_perm(p_org, p_facility, 'rooms.manage')
      or app.has_facility_perm(p_org, p_facility, 'pos.operate') or app.has_facility_perm(p_org, p_facility, 'beach.operate')
      or app.has_facility_perm(p_org, p_facility, 'reservations.manage') or app.has_facility_perm(p_org, p_facility, 'maintenance.manage')
$$;
grant execute on function app.can_handle_guest_requests(uuid, uuid) to authenticated;

alter table public.guest_requests enable row level security;
create policy gr_select on public.guest_requests for select to authenticated
  using (app.can_handle_guest_requests(org_id, facility_id) or created_by = auth.uid());
create policy gr_insert on public.guest_requests for insert to authenticated
  with check (app.can_access_facility(org_id, facility_id) and source <> 'portale' and created_by = auth.uid());
create policy gr_update on public.guest_requests for update to authenticated
  using (app.can_handle_guest_requests(org_id, facility_id)) with check (app.can_handle_guest_requests(org_id, facility_id));
select app.enable_audit('public.guest_requests');

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'guest_requests') then
      alter publication supabase_realtime add table public.guest_requests;
    end if;
  end if;
end $$;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
