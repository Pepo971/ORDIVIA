-- Ordivia — Turni e personale: turni settimanali, disponibilità, ferie/permessi, cambi turno,
-- checklist ricorrenti che generano attività (public.tasks).
--
-- Principi:
--  * le bozze dei turni le vede solo chi pianifica (shifts.manage); i collaboratori vedono i turni pubblicati;
--  * il motivo di un'assenza (es. malattia = dato sanitario) lo vedono solo la persona e chi gestisce i turni:
--    i colleghi vedono solo «non disponibile» tramite team_absences();
--  * ogni passaggio di ferie e cambi è una RPC con timestamp, l'audit lo scrive il trigger generico;
--  * i costi orari sono in una tabella separata leggibile solo con finance.view.

-- ---------------------------------------------------------------------------
-- Tipi
-- ---------------------------------------------------------------------------
create type public.shift_status as enum ('bozza', 'pubblicato', 'annullato');
create type public.leave_kind as enum ('ferie', 'permesso', 'malattia', 'altro');
create type public.leave_status as enum ('in_attesa', 'approvata', 'rifiutata', 'annullata');
create type public.shift_swap_status as enum ('offerto', 'accettato', 'approvato', 'rifiutato', 'annullato');

-- ---------------------------------------------------------------------------
-- Funzioni di supporto
-- ---------------------------------------------------------------------------
-- La persona (non l'utente corrente) è membro attivo con accesso alla struttura?
create or replace function app.member_has_facility(p_org uuid, p_user uuid, p_facility uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = p_org and m.user_id = p_user and m.active
      and (m.all_facilities or r.key = 'owner' or p_facility = any(m.facility_ids))
  )
$$;

-- La persona appartiene al reparto? (nessun reparto assegnato = tutti i reparti)
create or replace function app.member_in_department(p_org uuid, p_user uuid, p_department uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = p_user and m.active
      and (p_department is null or cardinality(m.department_ids) = 0 or p_department = any(m.department_ids))
  )
$$;

create or replace function app.facility_tz(p_facility uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select timezone from public.facilities where id = p_facility), 'Europe/Rome')
$$;

grant execute on function app.member_has_facility(uuid, uuid, uuid) to authenticated;
grant execute on function app.member_in_department(uuid, uuid, uuid) to authenticated;
grant execute on function app.facility_tz(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Impostazioni per struttura (soglie degli avvisi)
-- ---------------------------------------------------------------------------
create table public.shift_settings (
  facility_id     uuid primary key,
  org_id          uuid not null references public.organizations(id) on delete cascade,
  max_week_hours  numeric(5,2) not null default 48 check (max_week_hours > 0 and max_week_hours <= 120),
  min_rest_hours  numeric(4,2) not null default 11 check (min_rest_hours >= 0 and min_rest_hours <= 24),
  updated_at      timestamptz not null default now(),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Turni
-- ---------------------------------------------------------------------------
create table public.shifts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  facility_id    uuid not null,
  department_id  uuid,
  user_id        uuid not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  break_minutes  int not null default 0 check (break_minutes between 0 and 240),
  role_label     text check (role_label is null or length(role_label) <= 80),   -- ruolo / postazione (es. «Banco», «Chiusura»)
  note           text check (note is null or length(note) <= 500),
  status         public.shift_status not null default 'bozza',
  published_at   timestamptz,
  changed_at     timestamptz,   -- modificato dopo la pubblicazione → badge «modificato»
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, org_id),
  check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours'),
  check (break_minutes * interval '1 minute' < ends_at - starts_at),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (department_id, org_id) references public.departments(id, org_id) on delete set null (department_id),
  foreign key (org_id, user_id) references public.memberships(org_id, user_id) on delete cascade
);
create index on public.shifts (org_id, facility_id, starts_at);
create index on public.shifts (user_id, starts_at);

create or replace function app.shifts_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.facility_id <> old.facility_id) then
    raise exception 'Un turno non può cambiare struttura' using errcode = '22023';
  end if;
  if not app.member_has_facility(new.org_id, new.user_id, new.facility_id) then
    raise exception 'La persona non ha accesso a questa struttura' using errcode = 'P0001';
  end if;
  if new.department_id is not null and not exists (
    select 1 from public.departments d where d.id = new.department_id and d.facility_id = new.facility_id
  ) then
    raise exception 'Il reparto non appartiene a questa struttura' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'pubblicato' then new.published_at := coalesce(new.published_at, now()); end if;
    if new.status = 'annullato' then raise exception 'Non si crea un turno già annullato' using errcode = '22023'; end if;
    new.changed_at := null;
  else
    new.updated_at := now();
    if old.status = 'annullato' and new.status <> 'annullato' then
      raise exception 'Un turno annullato non si riattiva: creane uno nuovo' using errcode = 'P0001';
    end if;
    if old.status = 'pubblicato' and new.status = 'bozza' then
      raise exception 'Un turno pubblicato non torna in bozza' using errcode = 'P0001';
    end if;
    if new.status = 'pubblicato' and old.status = 'bozza' then
      new.published_at := now();
    end if;
    if old.status = 'pubblicato' and (
         (old.user_id, old.starts_at, old.ends_at, old.break_minutes, old.department_id, old.role_label, old.status)
         is distinct from
         (new.user_id, new.starts_at, new.ends_at, new.break_minutes, new.department_id, new.role_label, new.status)) then
      new.changed_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger shifts_before_write before insert or update on public.shifts
  for each row execute function app.shifts_before_write();

-- ---------------------------------------------------------------------------
-- Costo orario (solo finance.view)
-- ---------------------------------------------------------------------------
create table public.member_hourly_costs (
  org_id       uuid not null references public.organizations(id) on delete cascade,
  user_id      uuid not null,
  hourly_cost  numeric(8,2) not null check (hourly_cost >= 0 and hourly_cost < 1000),
  updated_at   timestamptz not null default now(),
  primary key (org_id, user_id),
  foreign key (org_id, user_id) references public.memberships(org_id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Indisponibilità dichiarate dal collaboratore
-- ---------------------------------------------------------------------------
create table public.shift_unavailability (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null default auth.uid(),
  weekday     smallint check (weekday between 1 and 7),  -- ricorrente: 1 = lunedì … 7 = domenica
  on_date     date,                                      -- oppure una data precisa
  from_time   time,                                      -- null = tutto il giorno
  to_time     time,
  note        text check (note is null or length(note) <= 200),
  created_at  timestamptz not null default now(),
  unique (id, org_id),
  check ((weekday is null) <> (on_date is null)),
  check ((from_time is null) = (to_time is null)),
  check (from_time is null or to_time > from_time),
  foreign key (org_id, user_id) references public.memberships(org_id, user_id) on delete cascade
);
create index on public.shift_unavailability (org_id, user_id);

-- ---------------------------------------------------------------------------
-- Ferie, permessi, malattia
-- ---------------------------------------------------------------------------
create table public.leave_requests (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  facility_id    uuid not null,     -- struttura il cui responsabile decide
  user_id        uuid not null,
  kind           public.leave_kind not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  all_day        boolean not null default true,
  note           text check (note is null or length(note) <= 1000),
  status         public.leave_status not null default 'in_attesa',
  created_at     timestamptz not null default now(),
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 1000),
  cancelled_at   timestamptz,
  unique (id, org_id),
  check (ends_at > starts_at),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (org_id, user_id) references public.memberships(org_id, user_id) on delete cascade
);
create index on public.leave_requests (org_id, facility_id, status);
create index on public.leave_requests (user_id, starts_at);

-- ---------------------------------------------------------------------------
-- Cambi turno
-- ---------------------------------------------------------------------------
create table public.shift_swaps (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  facility_id    uuid not null,
  shift_id       uuid not null,
  department_id  uuid,
  from_user      uuid not null,
  to_user        uuid,             -- null = chiunque del reparto
  note           text check (note is null or length(note) <= 500),
  status         public.shift_swap_status not null default 'offerto',
  offered_at     timestamptz not null default now(),
  accepted_by    uuid,
  accepted_at    timestamptz,
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 500),
  cancelled_at   timestamptz,
  unique (id, org_id),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (shift_id, org_id) references public.shifts(id, org_id) on delete cascade,
  foreign key (department_id, org_id) references public.departments(id, org_id) on delete set null (department_id),
  foreign key (org_id, from_user) references public.memberships(org_id, user_id) on delete cascade,
  foreign key (org_id, to_user) references public.memberships(org_id, user_id) on delete cascade
);
create unique index shift_swaps_one_active on public.shift_swaps (shift_id) where status in ('offerto', 'accettato');
create index on public.shift_swaps (org_id, facility_id, status);

-- ---------------------------------------------------------------------------
-- Checklist ricorrenti
-- ---------------------------------------------------------------------------
create table public.checklist_templates (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organizations(id) on delete cascade,
  facility_id           uuid not null,
  department_id         uuid,
  title                 text not null check (length(trim(title)) between 2 and 200),
  items                 text[] not null default '{}' check (cardinality(items) between 1 and 60),
  weekdays              smallint[] not null default '{1,2,3,4,5,6,7}' check (cardinality(weekdays) between 1 and 7 and weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]),
  due_time              time not null default '10:00',
  assignee_mode         text not null default 'in_turno' check (assignee_mode in ('in_turno', 'persona')),
  assignee_id           uuid,
  requires_photo        boolean not null default false,
  requires_verification boolean not null default true,
  active                boolean not null default true,
  created_by            uuid default auth.uid(),
  created_at            timestamptz not null default now(),
  unique (id, org_id),
  check (assignee_mode <> 'in_turno' or department_id is not null),
  check (assignee_mode <> 'persona' or assignee_id is not null),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (department_id, org_id) references public.departments(id, org_id),
  foreign key (org_id, assignee_id) references public.memberships(org_id, user_id)
);
create index on public.checklist_templates (org_id, facility_id) where active;

create table public.checklist_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  facility_id  uuid not null,
  template_id  uuid not null,
  run_date     date not null,
  task_id      uuid,
  assignee_id  uuid,
  created_at   timestamptz not null default now(),
  unique (template_id, run_date),
  foreign key (facility_id, org_id) references public.facilities(id, org_id) on delete cascade,
  foreign key (template_id, org_id) references public.checklist_templates(id, org_id) on delete cascade,
  foreign key (task_id, org_id) references public.tasks(id, org_id) on delete set null (task_id)
);
create index on public.checklist_runs (org_id, facility_id, run_date);

create or replace function app.checklist_templates_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.department_id is not null and not exists (
    select 1 from public.departments d where d.id = new.department_id and d.facility_id = new.facility_id
  ) then
    raise exception 'Il reparto non appartiene a questa struttura' using errcode = '22023';
  end if;
  if new.assignee_id is not null and not app.member_has_facility(new.org_id, new.assignee_id, new.facility_id) then
    raise exception 'La persona non ha accesso a questa struttura' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger checklist_templates_check before insert or update on public.checklist_templates
  for each row execute function app.checklist_templates_check();

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
select app.enable_audit('public.shift_settings');
select app.enable_audit('public.shifts');
select app.enable_audit('public.member_hourly_costs');
select app.enable_audit('public.shift_unavailability');
select app.enable_audit('public.leave_requests');
select app.enable_audit('public.shift_swaps');
select app.enable_audit('public.checklist_templates');
select app.enable_audit('public.checklist_runs');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.shift_settings        enable row level security;
alter table public.shifts                enable row level security;
alter table public.member_hourly_costs   enable row level security;
alter table public.shift_unavailability  enable row level security;
alter table public.leave_requests        enable row level security;
alter table public.shift_swaps           enable row level security;
alter table public.checklist_templates   enable row level security;
alter table public.checklist_runs        enable row level security;

create policy shset_select on public.shift_settings for select to authenticated using (app.can_access_facility(org_id, facility_id));
create policy shset_write  on public.shift_settings for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'shifts.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'shifts.manage'));

-- Bozze: solo chi pianifica. Pubblicati/annullati: chiunque abbia shifts.view sulla struttura.
create policy sh_select on public.shifts for select to authenticated using (
  app.has_facility_perm(org_id, facility_id, 'shifts.manage')
  or (status <> 'bozza' and app.has_facility_perm(org_id, facility_id, 'shifts.view'))
);
create policy sh_insert on public.shifts for insert to authenticated
  with check (app.has_facility_perm(org_id, facility_id, 'shifts.manage'));
create policy sh_update on public.shifts for update to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'shifts.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'shifts.manage'));
-- Un turno pubblicato non si cancella: si annulla (resta traccia per chi lo aveva in calendario).
create policy sh_delete on public.shifts for delete to authenticated
  using (status = 'bozza' and app.has_facility_perm(org_id, facility_id, 'shifts.manage'));

create policy mhc_select on public.member_hourly_costs for select to authenticated using (app.has_perm(org_id, 'finance.view'));
create policy mhc_write  on public.member_hourly_costs for all to authenticated
  using (app.has_perm(org_id, 'finance.view') and app.has_perm(org_id, 'shifts.manage'))
  with check (app.has_perm(org_id, 'finance.view') and app.has_perm(org_id, 'shifts.manage'));

create policy una_select on public.shift_unavailability for select to authenticated
  using (user_id = auth.uid() or app.has_perm(org_id, 'shifts.manage'));
create policy una_write on public.shift_unavailability for all to authenticated
  using (user_id = auth.uid() and app.is_member(org_id))
  with check (user_id = auth.uid() and (app.has_perm(org_id, 'shifts.view') or app.has_perm(org_id, 'shifts.manage')));

-- Motivo e note di un'assenza: solo la persona e chi gestisce i turni della struttura. Scritture solo via RPC.
create policy lv_select on public.leave_requests for select to authenticated
  using (user_id = auth.uid() or app.has_facility_perm(org_id, facility_id, 'shifts.manage'));

create policy sw_select on public.shift_swaps for select to authenticated using (
  from_user = auth.uid() or to_user = auth.uid() or accepted_by = auth.uid()
  or app.has_facility_perm(org_id, facility_id, 'shifts.manage')
  or (to_user is null and status = 'offerto'
      and app.has_facility_perm(org_id, facility_id, 'shifts.view')
      and app.member_in_department(org_id, auth.uid(), department_id))
);

create policy clt_select on public.checklist_templates for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'tasks.manage'));
create policy clt_write on public.checklist_templates for all to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'tasks.manage'))
  with check (app.has_facility_perm(org_id, facility_id, 'tasks.manage'));

create policy clr_select on public.checklist_runs for select to authenticated
  using (app.has_facility_perm(org_id, facility_id, 'tasks.manage'));
-- checklist_runs si scrive solo da generate_daily_checklists().

-- ---------------------------------------------------------------------------
-- RPC: turni
-- ---------------------------------------------------------------------------
-- Pubblica tutte le bozze della settimana (lunedì p_week_start, data locale della struttura).
create or replace function public.publish_shift_week(p_facility uuid, p_week_start date) returns int
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_tz text; v_n int;
begin
  select org_id, timezone into v_org, v_tz from public.facilities where id = p_facility;
  if v_org is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_org, p_facility, 'shifts.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if extract(isodow from p_week_start) <> 1 then raise exception 'La settimana deve iniziare di lunedì' using errcode = '22023'; end if;
  update public.shifts s set status = 'pubblicato'
  where s.facility_id = p_facility and s.status = 'bozza'
    and (s.starts_at at time zone v_tz)::date between p_week_start and p_week_start + 6;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Copia i turni di una settimana su un'altra (come bozze), mantenendo l'orario locale anche col cambio d'ora.
create or replace function public.copy_shift_week(p_facility uuid, p_from date, p_to date) returns int
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_tz text; v_n int; v_delta int;
begin
  select org_id, timezone into v_org, v_tz from public.facilities where id = p_facility;
  if v_org is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_org, p_facility, 'shifts.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if extract(isodow from p_from) <> 1 or extract(isodow from p_to) <> 1 then
    raise exception 'Le settimane devono iniziare di lunedì' using errcode = '22023';
  end if;
  if p_from = p_to then raise exception 'Scegli una settimana diversa' using errcode = '22023'; end if;
  v_delta := p_to - p_from;

  insert into public.shifts (org_id, facility_id, department_id, user_id, starts_at, ends_at, break_minutes, role_label, note, status, created_by)
  select s.org_id, s.facility_id, s.department_id, s.user_id,
         ((s.starts_at at time zone v_tz) + make_interval(days => v_delta)) at time zone v_tz,
         ((s.ends_at at time zone v_tz) + make_interval(days => v_delta)) at time zone v_tz,
         s.break_minutes, s.role_label, s.note, 'bozza', auth.uid()
  from public.shifts s
  where s.facility_id = p_facility and s.status <> 'annullato'
    and (s.starts_at at time zone v_tz)::date between p_from and p_from + 6
    and app.member_has_facility(s.org_id, s.user_id, s.facility_id)
    and not exists (
      select 1 from public.shifts t
      where t.facility_id = s.facility_id and t.user_id = s.user_id and t.status <> 'annullato'
        and t.starts_at = ((s.starts_at at time zone v_tz) + make_interval(days => v_delta)) at time zone v_tz
    );
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Toglie un turno: la bozza si elimina, il pubblicato si annulla (il collaboratore lo vede come annullato).
create or replace function public.remove_shift(p_shift uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_s public.shifts;
begin
  select * into v_s from public.shifts where id = p_shift for update;
  if not found then raise exception 'Turno non trovato' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_s.org_id, v_s.facility_id, 'shifts.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_s.status = 'bozza' then
    delete from public.shifts where id = p_shift;
    return 'eliminato';
  elsif v_s.status = 'pubblicato' then
    update public.shifts set status = 'annullato' where id = p_shift;
    update public.shift_swaps set status = 'annullato', cancelled_at = now()
      where shift_id = p_shift and status in ('offerto', 'accettato');
    return 'annullato';
  end if;
  return 'annullato';
end $$;

-- Assenze approvate delle persone della struttura nel periodo. Il motivo è restituito solo a chi gestisce i turni:
-- per i colleghi è solo «non disponibile».
create or replace function public.team_absences(p_facility uuid, p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, starts_at timestamptz, ends_at timestamptz, all_day boolean, kind public.leave_kind)
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid; v_manager boolean;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  v_manager := app.has_facility_perm(v_org, p_facility, 'shifts.manage');
  if not (v_manager or app.has_facility_perm(v_org, p_facility, 'shifts.view')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if p_to <= p_from or p_to - p_from > interval '62 days' then
    raise exception 'Periodo non valido' using errcode = '22023';
  end if;
  return query
    select l.user_id, l.starts_at, l.ends_at, l.all_day,
           case when v_manager or l.user_id = auth.uid() then l.kind end
    from public.leave_requests l
    where l.org_id = v_org and l.status = 'approvata'
      and l.starts_at < p_to and l.ends_at > p_from
      and app.member_has_facility(v_org, l.user_id, p_facility);
end $$;

-- ---------------------------------------------------------------------------
-- RPC: ferie, permessi, malattia
-- ---------------------------------------------------------------------------
create or replace function public.request_leave(p_facility uuid, p_kind public.leave_kind, p_starts timestamptz, p_ends timestamptz,
                                                p_all_day boolean default true, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Autenticazione richiesta' using errcode = '28000'; end if;
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not (app.has_facility_perm(v_org, p_facility, 'shifts.view') or app.has_facility_perm(v_org, p_facility, 'shifts.manage')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if p_starts is null or p_ends is null or p_ends <= p_starts then
    raise exception 'La fine deve essere dopo l''inizio' using errcode = '22023';
  end if;
  if p_ends - p_starts > interval '366 days' then raise exception 'Periodo troppo lungo' using errcode = '22023'; end if;
  if p_kind <> 'malattia' and p_ends < now() - interval '30 days' then
    raise exception 'Non si chiedono ferie per periodi già passati' using errcode = '22023';
  end if;
  insert into public.leave_requests (org_id, facility_id, user_id, kind, starts_at, ends_at, all_day, note)
  values (v_org, p_facility, auth.uid(), p_kind, p_starts, p_ends, coalesce(p_all_day, true), nullif(trim(p_note), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.decide_leave(p_request uuid, p_approve boolean, p_note text default null)
returns public.leave_requests
language plpgsql security definer set search_path = public as $$
declare v_l public.leave_requests;
begin
  select * into v_l from public.leave_requests where id = p_request for update;
  if not found then raise exception 'Richiesta non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_l.org_id, v_l.facility_id, 'shifts.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_l.user_id = auth.uid() and not app.has_perm(v_l.org_id, 'org.manage') then
    raise exception 'Una tua richiesta la decide un altro responsabile' using errcode = '42501';
  end if;
  if v_l.status <> 'in_attesa' then raise exception 'Richiesta già gestita' using errcode = 'P0001'; end if;
  if not p_approve and nullif(trim(p_note), '') is null then
    raise exception 'Scrivi il motivo del rifiuto' using errcode = '22023';
  end if;
  update public.leave_requests
     set status = case when p_approve then 'approvata'::public.leave_status else 'rifiutata'::public.leave_status end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
   where id = p_request returning * into v_l;
  return v_l;
end $$;

create or replace function public.cancel_leave(p_request uuid) returns public.leave_requests
language plpgsql security definer set search_path = public as $$
declare v_l public.leave_requests; v_manager boolean;
begin
  select * into v_l from public.leave_requests where id = p_request for update;
  if not found then raise exception 'Richiesta non trovata' using errcode = 'P0002'; end if;
  v_manager := app.has_facility_perm(v_l.org_id, v_l.facility_id, 'shifts.manage');
  if not (v_l.user_id = auth.uid() or v_manager) then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_l.status not in ('in_attesa', 'approvata') then raise exception 'Richiesta già chiusa' using errcode = 'P0001'; end if;
  if v_l.status = 'approvata' and v_l.starts_at <= now() and not v_manager then
    raise exception 'L''assenza è già iniziata: chiedi al responsabile' using errcode = 'P0001';
  end if;
  update public.leave_requests set status = 'annullata', cancelled_at = now() where id = p_request returning * into v_l;
  return v_l;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: cambi turno (offerta → accettazione del collega → approvazione del responsabile)
-- ---------------------------------------------------------------------------
create or replace function public.offer_shift_swap(p_shift uuid, p_to_user uuid default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_s public.shifts; v_id uuid;
begin
  select * into v_s from public.shifts where id = p_shift for update;
  if not found then raise exception 'Turno non trovato' using errcode = 'P0002'; end if;
  if v_s.user_id is distinct from auth.uid() then raise exception 'Puoi offrire solo i tuoi turni' using errcode = '42501'; end if;
  if not (app.has_facility_perm(v_s.org_id, v_s.facility_id, 'shifts.view') or app.has_facility_perm(v_s.org_id, v_s.facility_id, 'shifts.manage')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if v_s.status <> 'pubblicato' then raise exception 'Il turno non è pubblicato' using errcode = 'P0001'; end if;
  if v_s.starts_at <= now() then raise exception 'Il turno è già iniziato' using errcode = 'P0001'; end if;
  if p_to_user is not null then
    if p_to_user = auth.uid() then raise exception 'Scegli un collega' using errcode = '22023'; end if;
    if not app.member_has_facility(v_s.org_id, p_to_user, v_s.facility_id) then
      raise exception 'Il collega non lavora in questa struttura' using errcode = 'P0001';
    end if;
  elsif v_s.department_id is null then
    raise exception 'Il turno non ha un reparto: scegli un collega preciso' using errcode = '22023';
  end if;
  begin
    insert into public.shift_swaps (org_id, facility_id, shift_id, department_id, from_user, to_user, note)
    values (v_s.org_id, v_s.facility_id, v_s.id, v_s.department_id, auth.uid(), p_to_user, nullif(trim(p_note), ''))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'C''è già una proposta di cambio aperta per questo turno' using errcode = 'P0001';
  end;
  return v_id;
end $$;

create or replace function public.accept_shift_swap(p_swap uuid) returns public.shift_swaps
language plpgsql security definer set search_path = public as $$
declare v_w public.shift_swaps; v_s public.shifts;
begin
  select * into v_w from public.shift_swaps where id = p_swap for update;
  if not found then raise exception 'Proposta non trovata' using errcode = 'P0002'; end if;
  if v_w.from_user = auth.uid() then raise exception 'Non puoi accettare la tua proposta' using errcode = 'P0001'; end if;
  if not (app.has_facility_perm(v_w.org_id, v_w.facility_id, 'shifts.view') or app.has_facility_perm(v_w.org_id, v_w.facility_id, 'shifts.manage'))
     or not app.member_has_facility(v_w.org_id, auth.uid(), v_w.facility_id) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if v_w.to_user is not null and v_w.to_user <> auth.uid() then
    raise exception 'La proposta è per un altro collega' using errcode = '42501';
  end if;
  if v_w.to_user is null and not app.member_in_department(v_w.org_id, auth.uid(), v_w.department_id) then
    raise exception 'La proposta è per i colleghi del reparto' using errcode = '42501';
  end if;
  if v_w.status <> 'offerto' then raise exception 'Proposta non più disponibile' using errcode = 'P0001'; end if;

  select * into v_s from public.shifts where id = v_w.shift_id for update;
  if v_s.status <> 'pubblicato' or v_s.user_id <> v_w.from_user then
    raise exception 'Il turno è cambiato nel frattempo' using errcode = 'P0001';
  end if;
  if v_s.starts_at <= now() then raise exception 'Il turno è già iniziato' using errcode = 'P0001'; end if;
  if exists (select 1 from public.shifts o where o.user_id = auth.uid() and o.org_id = v_s.org_id and o.status <> 'annullato'
             and o.starts_at < v_s.ends_at and o.ends_at > v_s.starts_at) then
    raise exception 'Hai già un turno che si sovrappone' using errcode = 'P0001';
  end if;

  update public.shift_swaps set status = 'accettato', accepted_by = auth.uid(), accepted_at = now()
   where id = p_swap returning * into v_w;
  return v_w;
end $$;

create or replace function public.decide_shift_swap(p_swap uuid, p_approve boolean, p_note text default null)
returns public.shift_swaps
language plpgsql security definer set search_path = public as $$
declare v_w public.shift_swaps; v_s public.shifts;
begin
  select * into v_w from public.shift_swaps where id = p_swap for update;
  if not found then raise exception 'Proposta non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_w.org_id, v_w.facility_id, 'shifts.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  if v_w.status <> 'accettato' then raise exception 'Il cambio non è in attesa di approvazione' using errcode = 'P0001'; end if;

  if not p_approve then
    update public.shift_swaps set status = 'rifiutato', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
     where id = p_swap returning * into v_w;
    return v_w;
  end if;

  select * into v_s from public.shifts where id = v_w.shift_id for update;
  if v_s.status <> 'pubblicato' or v_s.user_id <> v_w.from_user then
    raise exception 'Il turno è cambiato nel frattempo' using errcode = 'P0001';
  end if;
  if not app.member_has_facility(v_w.org_id, v_w.accepted_by, v_w.facility_id) then
    raise exception 'Il collega non ha più accesso alla struttura' using errcode = 'P0001';
  end if;
  -- riassegnazione atomica: il trigger dei turni segna «modificato»
  update public.shifts set user_id = v_w.accepted_by where id = v_s.id;
  update public.shift_swaps set status = 'approvato', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
   where id = p_swap returning * into v_w;
  return v_w;
end $$;

create or replace function public.cancel_shift_swap(p_swap uuid) returns public.shift_swaps
language plpgsql security definer set search_path = public as $$
declare v_w public.shift_swaps;
begin
  select * into v_w from public.shift_swaps where id = p_swap for update;
  if not found then raise exception 'Proposta non trovata' using errcode = 'P0002'; end if;
  if not (v_w.from_user = auth.uid() or app.has_facility_perm(v_w.org_id, v_w.facility_id, 'shifts.manage')) then
    raise exception 'Permesso negato' using errcode = '42501';
  end if;
  if v_w.status not in ('offerto', 'accettato') then raise exception 'Proposta già chiusa' using errcode = 'P0001'; end if;
  update public.shift_swaps set status = 'annullato', cancelled_at = now() where id = p_swap returning * into v_w;
  return v_w;
end $$;

-- ---------------------------------------------------------------------------
-- Checklist ricorrenti → attività
-- ---------------------------------------------------------------------------
-- Nucleo senza controllo permessi: usato dalla RPC pubblica e dalla pianificazione automatica.
create or replace function app.generate_checklists_core(p_facility uuid, p_date date) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid; v_tz text; v_t record; v_run uuid; v_due timestamptz; v_assignee uuid; v_task uuid; v_n int := 0;
begin
  select org_id, timezone into v_org, v_tz from public.facilities where id = p_facility;
  if v_org is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;

  for v_t in
    select * from public.checklist_templates t
    where t.facility_id = p_facility and t.active and extract(isodow from p_date)::smallint = any(t.weekdays)
    order by t.created_at
  loop
    insert into public.checklist_runs (org_id, facility_id, template_id, run_date)
    values (v_org, p_facility, v_t.id, p_date)
    on conflict (template_id, run_date) do nothing
    returning id into v_run;
    continue when v_run is null;   -- già generata: idempotente

    v_due := (p_date + v_t.due_time) at time zone v_tz;
    if v_t.assignee_mode = 'persona' then
      v_assignee := case when app.member_has_facility(v_org, v_t.assignee_id, p_facility) then v_t.assignee_id end;
    else
      -- chi è in turno nel reparto quel giorno (turni pubblicati): prima chi copre l'ora di scadenza,
      -- poi chi inizia prima; escluso chi è in assenza approvata a quell'ora.
      select s.user_id into v_assignee
      from public.shifts s
      where s.facility_id = p_facility and s.department_id = v_t.department_id and s.status = 'pubblicato'
        and ((s.starts_at at time zone v_tz)::date = p_date or (s.starts_at <= v_due and s.ends_at > v_due))
        and not exists (select 1 from public.leave_requests l where l.user_id = s.user_id and l.org_id = v_org
                        and l.status = 'approvata' and l.starts_at <= v_due and l.ends_at > v_due)
      order by (s.starts_at <= v_due and s.ends_at > v_due) desc, s.starts_at, s.user_id
      limit 1;
    end if;

    insert into public.tasks (org_id, facility_id, department_id, title, description, assignee_id, due_at,
                              requires_photo, requires_verification, created_by)
    values (v_org, p_facility, v_t.department_id, v_t.title,
            (select string_agg('• ' || i, E'\n' order by n) from unnest(v_t.items) with ordinality as x(i, n)),
            v_assignee, v_due, v_t.requires_photo, v_t.requires_verification, coalesce(auth.uid(), v_t.created_by))
    returning id into v_task;

    update public.checklist_runs set task_id = v_task, assignee_id = v_assignee where id = v_run;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke execute on function app.generate_checklists_core(uuid, date) from public, anon, authenticated;

create or replace function public.generate_daily_checklists(p_facility uuid, p_date date default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_date date;
begin
  select org_id into v_org from public.facilities where id = p_facility;
  if v_org is null then raise exception 'Struttura non trovata' using errcode = 'P0002'; end if;
  if not app.has_facility_perm(v_org, p_facility, 'tasks.manage') then raise exception 'Permesso negato' using errcode = '42501'; end if;
  v_date := coalesce(p_date, (now() at time zone app.facility_tz(p_facility))::date);
  if v_date < (now() at time zone app.facility_tz(p_facility))::date - 7 or v_date > (now() at time zone app.facility_tz(p_facility))::date + 14 then
    raise exception 'Si possono generare checklist da 7 giorni fa a 14 giorni avanti' using errcode = '22023';
  end if;
  return app.generate_checklists_core(p_facility, v_date);
end $$;

-- Per la pianificazione automatica (pg_cron o funzione schedulata con ruolo di servizio):
--   select cron.schedule('ordivia-checklist', '5 * * * *', 'select app.generate_all_daily_checklists()');
-- Genera per ogni struttura con modelli attivi la data di oggi nel suo fuso orario. Idempotente.
create or replace function app.generate_all_daily_checklists() returns int
language plpgsql security definer set search_path = public as $$
declare v_f record; v_n int := 0;
begin
  for v_f in
    select distinct f.id, f.timezone from public.facilities f
    join public.checklist_templates t on t.facility_id = f.id and t.active
  loop
    v_n := v_n + app.generate_checklists_core(v_f.id, (now() at time zone v_f.timezone)::date);
  end loop;
  return v_n;
end $$;
revoke execute on function app.generate_all_daily_checklists() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grant
-- ---------------------------------------------------------------------------
grant execute on function public.publish_shift_week(uuid, date) to authenticated;
grant execute on function public.copy_shift_week(uuid, date, date) to authenticated;
grant execute on function public.remove_shift(uuid) to authenticated;
grant execute on function public.team_absences(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.request_leave(uuid, public.leave_kind, timestamptz, timestamptz, boolean, text) to authenticated;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_leave(uuid) to authenticated;
grant execute on function public.offer_shift_swap(uuid, uuid, text) to authenticated;
grant execute on function public.accept_shift_swap(uuid) to authenticated;
grant execute on function public.decide_shift_swap(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_shift_swap(uuid) to authenticated;
grant execute on function public.generate_daily_checklists(uuid, date) to authenticated;

-- Realtime per turni e richieste (RLS applicata)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.shifts, public.leave_requests, public.shift_swaps;
  end if;
end $$;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
