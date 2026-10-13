-- Ordivia — Fondamenta: tenancy, strutture, reparti, ruoli, permessi, membri, postazioni, audit.
-- Principio: ogni riga di dominio porta org_id; l'isolamento è garantito da RLS, non dal codice applicativo.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
grant usage on schema app to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Tipi
-- ---------------------------------------------------------------------------
create type public.facility_type as enum ('lido', 'ristorante', 'hotel', 'camping', 'resort', 'ibrida');

-- ---------------------------------------------------------------------------
-- Organizzazioni e strutture
-- ---------------------------------------------------------------------------
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 2 and 120),
  plan        text not null default 'trial',
  trial_ends_at timestamptz default now() + interval '30 days',
  created_at  timestamptz not null default now()
);

create table public.facilities (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(trim(name)) between 2 and 120),
  type        public.facility_type not null,
  timezone    text not null default 'Europe/Rome',
  address     text,
  modules     text[] not null default array['core','team','purchasing','inventory']::text[],
  created_at  timestamptz not null default now(),
  unique (id, org_id)
);
create index on public.facilities (org_id);

create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  facility_id uuid not null,
  name        text not null check (length(trim(name)) between 1 and 80),
  kind        text not null default 'altro', -- cucina, bar, sala, spiaggia, housekeeping, manutenzione, reception, magazzino, altro
  created_at  timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);
create index on public.departments (org_id, facility_id);

-- ---------------------------------------------------------------------------
-- Persone, ruoli, permessi
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Catalogo dei permessi: è codice, non dato del cliente.
create table public.permissions (
  key         text primary key,
  description text not null,
  sensitive   boolean not null default false
);

insert into public.permissions (key, description, sensitive) values
  ('org.manage',          'Gestire organizzazione, strutture e moduli', false),
  ('members.manage',      'Invitare persone, assegnare ruoli e PIN', false),
  ('roles.manage',        'Creare e modificare ruoli', false),
  ('finance.view',        'Vedere costi, prezzi, margini e valori di magazzino', true),
  ('audit.view',          'Consultare il registro delle operazioni', false),
  ('tasks.manage',        'Creare, assegnare e verificare attività', false),
  ('tasks.perform',       'Eseguire le attività assegnate', false),
  ('suppliers.manage',    'Gestire fornitori e listini', false),
  ('purchasing.request',  'Creare richieste d''acquisto', false),
  ('purchasing.approve',  'Approvare richieste e ordini', false),
  ('purchasing.send',     'Inviare ordini ai fornitori', false),
  ('receiving.perform',   'Registrare la ricezione merce', false),
  ('inventory.view',      'Vedere giacenze', false),
  ('inventory.move',      'Registrare carichi, scarichi, trasferimenti e sprechi', false),
  ('inventory.count',     'Eseguire inventari e rettifiche', false),
  ('stations.manage',     'Gestire le postazioni condivise', false);

create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  key         text not null,
  name        text not null,
  is_system   boolean not null default false,
  permissions text[] not null default '{}',
  created_at  timestamptz not null default now(),
  unique (org_id, key),
  unique (id, org_id)
);

create table public.memberships (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role_id       uuid not null,
  all_facilities boolean not null default false,
  facility_ids  uuid[] not null default '{}',
  department_ids uuid[] not null default '{}',
  pin_hash      text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (org_id, user_id),
  foreign key (role_id, org_id) references public.roles(id, org_id)
);
create index on public.memberships (user_id) where active;

create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role_id     uuid not null,
  all_facilities boolean not null default false,
  facility_ids uuid[] not null default '{}',
  department_ids uuid[] not null default '{}',
  token       text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  invited_by  uuid references auth.users(id),
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (role_id, org_id) references public.roles(id, org_id)
);
create index on public.invitations (org_id);

-- ---------------------------------------------------------------------------
-- Postazioni condivise (cassa, KDS, bar, pass, magazzino)
-- ---------------------------------------------------------------------------
create table public.stations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  facility_id   uuid not null,
  department_id uuid,
  name          text not null,
  kind          text not null default 'generica', -- cassa, kds, pass, bar, magazzino, generica
  allowed_permissions text[] not null default array['tasks.perform','inventory.view']::text[],
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Audit (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigserial primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  facility_id uuid,
  actor_id    uuid,
  station_id  uuid,
  action      text not null,          -- insert | update | delete | <evento di dominio>
  entity      text not null,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default now()
);
create index on public.audit_log (org_id, at desc);
create index on public.audit_log (org_id, entity, entity_id);

-- ---------------------------------------------------------------------------
-- Funzioni di autorizzazione (security definer: leggono memberships senza ricorsione RLS)
-- ---------------------------------------------------------------------------
create or replace function app.current_station() returns uuid
language sql stable as $$
  select case when h ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then h::uuid end
  from (select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-ordivia-station' as h) s
$$;

create or replace function app.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.active
  )
$$;

create or replace function app.has_perm(p_org uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = p_org and m.user_id = auth.uid() and m.active
      and (p_perm = any(r.permissions) or r.key = 'owner')
  )
$$;

create or replace function app.can_access_facility(p_org uuid, p_facility uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = p_org and m.user_id = auth.uid() and m.active
      and (m.all_facilities or r.key = 'owner' or p_facility is null or p_facility = any(m.facility_ids))
  )
$$;

create or replace function app.has_facility_perm(p_org uuid, p_facility uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_perm(p_org, p_perm) and app.can_access_facility(p_org, p_facility)
$$;

grant execute on all functions in schema app to authenticated;

-- ---------------------------------------------------------------------------
-- Trigger di audit generico
-- ---------------------------------------------------------------------------
create or replace function app.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb;
  v_org uuid;
  v_fac uuid;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_org := coalesce((v_row ->> 'org_id')::uuid, case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid end);
  if v_org is null then return null; end if;
  v_fac := case when tg_table_name = 'facilities' then (v_row ->> 'id')::uuid else (v_row ->> 'facility_id')::uuid end;
  insert into public.audit_log (org_id, facility_id, actor_id, station_id, action, entity, entity_id, before, after)
  values (
    v_org, v_fac, auth.uid(), app.current_station(), lower(tg_op), tg_table_name, v_row ->> 'id',
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) - 'pin_hash' end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) - 'pin_hash' end
  );
  return null;
end $$;

create or replace function app.enable_audit(p_table regclass) returns void
language plpgsql as $$
begin
  execute format('create trigger audit_%s after insert or update or delete on %s for each row execute function app.audit_trigger()',
                 replace(p_table::text, 'public.', ''), p_table);
end $$;

select app.enable_audit('public.organizations');
select app.enable_audit('public.facilities');
select app.enable_audit('public.departments');
select app.enable_audit('public.roles');
select app.enable_audit('public.memberships');
select app.enable_audit('public.invitations');
select app.enable_audit('public.stations');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.facilities    enable row level security;
alter table public.departments   enable row level security;
alter table public.profiles      enable row level security;
alter table public.permissions   enable row level security;
alter table public.roles         enable row level security;
alter table public.memberships   enable row level security;
alter table public.invitations   enable row level security;
alter table public.stations      enable row level security;
alter table public.audit_log     enable row level security;

create policy org_select on public.organizations for select to authenticated using (app.is_member(id));
create policy org_update on public.organizations for update to authenticated using (app.has_perm(id, 'org.manage')) with check (app.has_perm(id, 'org.manage'));

create policy fac_select on public.facilities for select to authenticated using (app.can_access_facility(org_id, id));
create policy fac_write  on public.facilities for all    to authenticated using (app.has_perm(org_id, 'org.manage')) with check (app.has_perm(org_id, 'org.manage'));

create policy dep_select on public.departments for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy dep_write  on public.departments for all    to authenticated using (app.has_perm(org_id, 'org.manage')) with check (app.has_perm(org_id, 'org.manage'));

-- Un profilo è visibile a sé stessi e ai colleghi della stessa organizzazione.
create policy prof_select on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.memberships m where m.user_id = profiles.id and app.is_member(m.org_id)
  )
);
create policy prof_upsert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy prof_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy perm_select on public.permissions for select to authenticated using (true);

create policy role_select on public.roles for select to authenticated using (app.is_member(org_id));
create policy role_write  on public.roles for all    to authenticated
  using (app.has_perm(org_id, 'roles.manage') and not is_system)
  with check (app.has_perm(org_id, 'roles.manage') and not is_system);

create policy mem_select on public.memberships for select to authenticated using (user_id = auth.uid() or app.is_member(org_id));
create policy mem_update on public.memberships for update to authenticated using (app.has_perm(org_id, 'members.manage')) with check (app.has_perm(org_id, 'members.manage'));

create policy inv_select on public.invitations for select to authenticated using (app.has_perm(org_id, 'members.manage'));
create policy inv_write  on public.invitations for all    to authenticated using (app.has_perm(org_id, 'members.manage')) with check (app.has_perm(org_id, 'members.manage'));

create policy sta_select on public.stations for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy sta_write  on public.stations for all    to authenticated using (app.has_perm(org_id, 'stations.manage')) with check (app.has_perm(org_id, 'stations.manage'));

create policy aud_select on public.audit_log for select to authenticated using (app.has_perm(org_id, 'audit.view'));
-- Nessuna policy di insert/update/delete: l'audit si scrive solo dai trigger.

-- La colonna pin_hash non deve mai uscire verso i client.
revoke select on public.memberships from authenticated, anon;
grant select (id, org_id, user_id, role_id, all_facilities, facility_ids, department_ids, active, created_at)
  on public.memberships to authenticated;
revoke update on public.memberships from authenticated, anon;
grant update (role_id, all_facilities, facility_ids, department_ids, active) on public.memberships to authenticated;

-- Il titolare può essere modificato solo da un titolare, e deve restarne almeno uno attivo.
create or replace function app.protect_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_owner_role uuid;
begin
  if auth.uid() is null then return new; end if; -- operazioni di sistema
  select id into v_owner_role from public.roles where org_id = old.org_id and key = 'owner';
  if (old.role_id = v_owner_role or new.role_id = v_owner_role)
     and not exists (select 1 from public.memberships m where m.org_id = old.org_id and m.user_id = auth.uid() and m.role_id = v_owner_role and m.active) then
    raise exception 'Solo un titolare può assegnare o modificare il ruolo di titolare' using errcode = '42501';
  end if;
  if old.role_id = v_owner_role and (new.role_id <> v_owner_role or not new.active)
     and not exists (select 1 from public.memberships m where m.org_id = old.org_id and m.role_id = v_owner_role and m.active and m.id <> old.id) then
    raise exception 'Deve restare almeno un titolare attivo' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger memberships_protect_owner before update on public.memberships
  for each row execute function app.protect_owner();

-- ---------------------------------------------------------------------------
-- Profilo automatico alla registrazione
-- ---------------------------------------------------------------------------
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

do $$ begin
  create trigger on_auth_user_created after insert on auth.users
    for each row execute function app.handle_new_user();
exception when insufficient_privilege then
  raise warning 'Impossibile creare il trigger su auth.users: i profili vengono creati al primo accesso';
end $$;

-- ---------------------------------------------------------------------------
-- Ruoli di sistema
-- ---------------------------------------------------------------------------
create or replace function app.seed_system_roles(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.roles (org_id, key, name, is_system, permissions) values
    (p_org, 'owner',     'Titolare',                true, (select array_agg(key) from public.permissions)),
    (p_org, 'admin',     'Amministratore',          true, (select array_agg(key) from public.permissions)),
    (p_org, 'manager',   'Manager',                 true, array['tasks.manage','tasks.perform','suppliers.manage','purchasing.request','purchasing.approve','purchasing.send','receiving.perform','inventory.view','inventory.move','inventory.count','finance.view','audit.view']),
    (p_org, 'dept_lead', 'Responsabile di reparto', true, array['tasks.manage','tasks.perform','purchasing.request','receiving.perform','inventory.view','inventory.move','inventory.count']),
    (p_org, 'warehouse', 'Magazziniere',            true, array['tasks.perform','receiving.perform','inventory.view','inventory.move','inventory.count']),
    (p_org, 'staff',     'Collaboratore',           true, array['tasks.perform','inventory.view']);
end $$;

-- ---------------------------------------------------------------------------
-- RPC: creazione organizzazione con template per tipo di struttura
-- ---------------------------------------------------------------------------
create or replace function public.create_organization(p_org_name text, p_facility_name text, p_facility_type public.facility_type)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_fac uuid;
  v_owner uuid;
  v_dep record;
  v_departments text[][];
begin
  if v_uid is null then raise exception 'Autenticazione richiesta' using errcode = '28000'; end if;

  insert into public.organizations (name) values (p_org_name) returning id into v_org;
  perform app.seed_system_roles(v_org);
  select id into v_owner from public.roles where org_id = v_org and key = 'owner';

  insert into public.memberships (org_id, user_id, role_id, all_facilities) values (v_org, v_uid, v_owner, true);

  insert into public.facilities (org_id, name, type) values (v_org, p_facility_name, p_facility_type) returning id into v_fac;

  v_departments := case p_facility_type
    when 'lido'       then array[['Bar','bar'],['Cucina','cucina'],['Spiaggia','spiaggia'],['Magazzino','magazzino']]
    when 'ristorante' then array[['Cucina','cucina'],['Sala','sala'],['Bar','bar'],['Magazzino','magazzino']]
    when 'hotel'      then array[['Reception','reception'],['Housekeeping','housekeeping'],['Cucina','cucina'],['Bar','bar'],['Manutenzione','manutenzione'],['Magazzino','magazzino']]
    when 'camping'    then array[['Reception','reception'],['Market','market'],['Bar','bar'],['Ristorante','cucina'],['Manutenzione','manutenzione'],['Magazzino','magazzino']]
    when 'resort'     then array[['Reception','reception'],['Housekeeping','housekeeping'],['Cucina','cucina'],['Bar','bar'],['Spiaggia','spiaggia'],['Manutenzione','manutenzione'],['Magazzino','magazzino']]
    else                   array[['Cucina','cucina'],['Bar','bar'],['Sala','sala'],['Magazzino','magazzino']]
  end;

  for i in 1 .. array_length(v_departments, 1) loop
    insert into public.departments (org_id, facility_id, name, kind)
    values (v_org, v_fac, v_departments[i][1], v_departments[i][2]);
  end loop;

  return v_org;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: accettazione invito (l'email dell'utente deve coincidere)
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.invitations;
  v_email text;
begin
  if auth.uid() is null then raise exception 'Autenticazione richiesta' using errcode = '28000'; end if;
  select email into v_email from auth.users where id = auth.uid();
  select * into v_inv from public.invitations where token = p_token for update;
  if not found then raise exception 'Invito non valido' using errcode = 'P0002'; end if;
  if v_inv.accepted_at is not null then raise exception 'Invito già utilizzato' using errcode = 'P0001'; end if;
  if v_inv.expires_at < now() then raise exception 'Invito scaduto' using errcode = 'P0001'; end if;
  if lower(v_inv.email) <> lower(v_email) then raise exception 'Questo invito è per un altro indirizzo email' using errcode = '42501'; end if;

  insert into public.memberships (org_id, user_id, role_id, all_facilities, facility_ids, department_ids)
  values (v_inv.org_id, auth.uid(), v_inv.role_id, v_inv.all_facilities, v_inv.facility_ids, v_inv.department_ids)
  on conflict (org_id, user_id) do update set role_id = excluded.role_id, active = true,
    all_facilities = excluded.all_facilities, facility_ids = excluded.facility_ids, department_ids = excluded.department_ids;

  update public.invitations set accepted_at = now() where id = v_inv.id;
  return v_inv.org_id;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: PIN personale per le postazioni condivise
-- ---------------------------------------------------------------------------
create or replace function public.set_member_pin(p_membership uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_m public.memberships;
begin
  select * into v_m from public.memberships where id = p_membership;
  if not found then raise exception 'Membro non trovato' using errcode = 'P0002'; end if;
  if not (v_m.user_id = auth.uid() or app.has_perm(v_m.org_id, 'members.manage')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'Il PIN deve avere da 4 a 6 cifre' using errcode = '22023'; end if;
  update public.memberships set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)) where id = p_membership;
end $$;

-- Verifica PIN su una postazione: restituisce l'utente e i permessi effettivi (intersezione ruolo ∩ postazione).
create or replace function public.verify_station_pin(p_station uuid, p_pin text)
returns table (user_id uuid, full_name text, permissions text[])
language plpgsql security definer set search_path = public, extensions as $$
declare v_st public.stations;
begin
  select * into v_st from public.stations where id = p_station and active;
  if not found then raise exception 'Postazione non trovata' using errcode = 'P0002'; end if;
  if not app.can_access_facility(v_st.org_id, v_st.facility_id) then raise exception 'Permesso negato' using errcode = '42501'; end if;

  return query
  select m.user_id, p.full_name,
         array(select unnest(r.permissions) intersect select unnest(v_st.allowed_permissions))
  from public.memberships m
  join public.roles r on r.id = m.role_id
  left join public.profiles p on p.id = m.user_id
  where m.org_id = v_st.org_id and m.active and m.pin_hash is not null
    and m.pin_hash = extensions.crypt(p_pin, m.pin_hash)
    and (m.all_facilities or r.key = 'owner' or v_st.facility_id = any(m.facility_ids))
  limit 1;
end $$;

grant execute on function public.create_organization(text, text, public.facility_type) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.set_member_pin(uuid, text) to authenticated;
grant execute on function public.verify_station_pin(uuid, text) to authenticated;
