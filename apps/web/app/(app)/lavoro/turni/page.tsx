import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, cx, EmptyState, Field, Input, LinkButton, Notice, PageHeader, Select, Tabs } from "@/components/ui";
import { can, requirePerm, type AppContext } from "@/lib/context";
import { formatDate, formatEur, formatTime, WEEKDAY_LABELS } from "@/lib/format";
import {
  getAbsences,
  getFacilityPeople,
  getShifts,
  getShiftSettings,
  hm,
  isCivilDate,
  LEAVE_KIND,
  toShiftLike,
  type AbsenceRow,
  type ShiftRow,
  type UnavailabilityRow,
} from "@/lib/shifts-queries";
import { createClient } from "@/lib/supabase/server";
import {
  addDays,
  coverageByDepartmentDay,
  currentWeekStart,
  formatHours,
  hitsUnavailability,
  hoursByUser,
  localDateOf,
  localTimeOf,
  shiftHours,
  shiftWarnings,
  startOfCivilDay,
  todayIn,
  warningsByShift,
  weekDays,
  weekStartOf,
  weeklyCost,
} from "@ordivia/domain";
import { addUnavailability, copyPreviousWeek, deleteUnavailability, publishWeek, removeShift, saveShift, saveShiftSettings, setHourlyCost } from "./actions";

export const metadata = { title: "Turni" };
export const dynamic = "force-dynamic";

interface SP {
  settimana?: string;
  vista?: string;
  turno?: string;
  persona?: string;
  giorno?: string;
  salvato?: string;
  rimosso?: string;
}

export default async function TurniPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePerm("shifts.view", "shifts.manage");
  const sp = await searchParams;
  const isManager = can(ctx, "shifts.manage");
  const view = isManager && sp.vista !== "miei" ? "piano" : "miei";

  return (
    <div>
      <PageHeader
        title="Turni"
        subtitle={view === "piano" ? "Pianifica la settimana, controlla gli avvisi e pubblica quando è pronta." : "I tuoi turni pubblicati e le tue disponibilità."}
      />
      {isManager && (
        <Tabs
          active={view}
          items={[
            { key: "piano", label: "Pianificazione", href: `/lavoro/turni${isCivilDate(sp.settimana) ? `?settimana=${sp.settimana}` : ""}` },
            { key: "miei", label: "I miei turni", href: "/lavoro/turni?vista=miei" },
          ]}
        />
      )}
      {view === "piano" ? <Planner ctx={ctx} sp={sp} /> : <MyShifts ctx={ctx} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vista collaboratore: i miei turni (settimana corrente e prossima) + disponibilità
// ---------------------------------------------------------------------------
async function MyShifts({ ctx }: { ctx: AppContext }) {
  const tz = ctx.facility.timezone;
  const week = currentWeekStart(tz);
  const nextWeek = addDays(week, 7);
  const supabase = await createClient();
  const [shifts, absences, { data: unav }] = await Promise.all([
    getShifts(ctx, week, addDays(week, 13), { userId: ctx.userId, includeCancelled: true }),
    getAbsences(ctx, week, addDays(week, 13)),
    supabase.from("shift_unavailability").select("id, user_id, weekday, on_date, from_time, to_time, note").eq("user_id", ctx.userId).eq("org_id", ctx.org.id).order("weekday").order("on_date"),
  ]);
  const myAbsences = absences.filter((a) => a.user_id === ctx.userId);
  const today = todayIn(tz);
  const dep = (id: string | null) => (id ? ctx.departments.find((d) => d.id === id)?.name : null);

  const weekBlock = (start: string, label: string) => {
    const list = shifts.filter((s) => {
      const d = localDateOf(new Date(s.starts_at), tz);
      return d >= start && d <= addDays(start, 6);
    });
    const active = list.filter((s) => s.status !== "annullato");
    const total = active.reduce((acc, s) => acc + shiftHours(toShiftLike(s)), 0);
    const abs = myAbsences.filter((a) => new Date(a.starts_at) < startOfCivilDay(addDays(start, 7), tz) && new Date(a.ends_at) > startOfCivilDay(start, tz));
    return (
      <Card key={start} className="overflow-hidden">
        <CardHeader title={label} hint={`${formatDate(start, tz)} – ${formatDate(addDays(start, 6), tz)}`} action={<Badge tone="night">{formatHours(total)}</Badge>} />
        {list.length === 0 && abs.length === 0 && <EmptyState title="Nessun turno pubblicato" text="Quando il responsabile pubblica la settimana, i tuoi turni compaiono qui." />}
        <ul>
          {abs.map((a, i) => (
            <li key={`a${i}`} className="flex items-center gap-3 border-b border-sand px-4 py-3 last:border-b-0">
              <Badge tone="teal">{a.kind ? LEAVE_KIND[a.kind] : "Assenza"}</Badge>
              <span className="text-sm text-ink">
                {formatDate(a.starts_at, tz)} → {formatDate(new Date(new Date(a.ends_at).getTime() - 1), tz)}
              </span>
            </li>
          ))}
          {list.map((s) => {
            const day = localDateOf(new Date(s.starts_at), tz);
            return (
              <li key={s.id} className={cx("flex items-center gap-3 border-b border-sand px-4 py-3 last:border-b-0", day === today && "bg-warm")}>
                <div className="w-16 shrink-0 text-sm font-bold text-night">{formatDate(s.starts_at, tz)}</div>
                <div className="min-w-0 flex-1">
                  <p className={cx("font-bold text-night", s.status === "annullato" && "text-muted line-through")}>
                    {formatTime(s.starts_at, tz)}–{formatTime(s.ends_at, tz)}
                  </p>
                  <p className="text-sm text-muted">
                    {[dep(s.department_id), s.role_label, s.break_minutes ? `pausa ${s.break_minutes} min` : null].filter(Boolean).join(" · ")}
                  </p>
                  {s.note && <p className="text-sm text-ink">{s.note}</p>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {s.status === "annullato" ? <Badge tone="danger">Annullato</Badge> : s.changed_at ? <Badge tone="warn">Modificato</Badge> : null}
                  {s.status !== "annullato" && <span className="text-xs text-muted">{formatHours(shiftHours(toShiftLike(s)))}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    );
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        {weekBlock(week, "Questa settimana")}
        {weekBlock(nextWeek, "Prossima settimana")}
        <p className="text-sm text-muted">
          Vuoi cedere un turno o chiedere ferie? Vai a <a href="/lavoro/richieste" className="font-bold text-teal-deep underline">Ferie e cambi</a>.
        </p>
      </div>
      <Availability rows={(unav ?? []) as UnavailabilityRow[]} tz={tz} />
    </div>
  );
}

function unavLabel(u: UnavailabilityRow, tz: string) {
  const when = u.weekday ? `Ogni ${WEEKDAY_LABELS[u.weekday - 1]?.toLowerCase()}` : formatDate(u.on_date, tz);
  const hours = u.from_time ? `${hm(u.from_time)}–${hm(u.to_time)}` : "tutto il giorno";
  return `${when}, ${hours}`;
}

function Availability({ rows, tz }: { rows: UnavailabilityRow[]; tz: string }) {
  return (
    <Card className="h-fit overflow-hidden">
      <CardHeader title="Quando non sei disponibile" hint="Chi pianifica i turni lo vede. Il motivo non è obbligatorio." />
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">Nessuna indisponibilità segnalata.</p>
      ) : (
        <ul>
          {rows.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 border-b border-sand px-4 py-2.5 last:border-b-0">
              <div>
                <p className="text-sm font-bold text-night">{unavLabel(u, tz)}</p>
                {u.note && <p className="text-xs text-muted">{u.note}</p>}
              </div>
              <ActionForm action={deleteUnavailability}>
                <input type="hidden" name="id" value={u.id} />
                <SubmitButton variant="ghost" pendingText="…">Rimuovi</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={addUnavailability} resetOnSuccess className="space-y-3 border-t border-sand p-4">
        <Field label="Tipo">
          <Select name="mode" defaultValue="ricorrente">
            <option value="ricorrente">Ogni settimana</option>
            <option value="data">Un giorno preciso</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Giorno (ogni settimana)">
            <Select name="weekday" defaultValue="">
              <option value="">—</option>
              {WEEKDAY_LABELS.map((l, i) => (
                <option key={l} value={i + 1}>{l}</option>
              ))}
            </Select>
          </Field>
          <Field label="Oppure data">
            <Input type="date" name="on_date" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Dalle" hint="Vuoto = tutto il giorno">
            <Input type="time" name="from_time" />
          </Field>
          <Field label="Alle">
            <Input type="time" name="to_time" />
          </Field>
        </div>
        <Field label="Nota (facoltativa)">
          <Input name="note" maxLength={200} placeholder="Es. lezione all'università" />
        </Field>
        <SubmitButton full>Segnala</SubmitButton>
      </ActionForm>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Vista responsabile: griglia settimanale persone × giorni
// ---------------------------------------------------------------------------
async function Planner({ ctx, sp }: { ctx: AppContext; sp: SP }) {
  const tz = ctx.facility.timezone;
  const week = isCivilDate(sp.settimana) ? weekStartOf(sp.settimana) : currentWeekStart(tz);
  const days = weekDays(week);
  const today = todayIn(tz);
  const showCosts = can(ctx, "finance.view");
  const supabase = await createClient();

  const [people, rules, around, absences, { data: unavData }, costsRes] = await Promise.all([
    getFacilityPeople(ctx),
    getShiftSettings(ctx.facility.id),
    getShifts(ctx, addDays(week, -1), addDays(week, 7)),
    getAbsences(ctx, week, addDays(week, 6)),
    supabase.from("shift_unavailability").select("id, user_id, weekday, on_date, from_time, to_time, note").eq("org_id", ctx.org.id),
    showCosts ? supabase.from("member_hourly_costs").select("user_id, hourly_cost").eq("org_id", ctx.org.id) : Promise.resolve({ data: [] as { user_id: string; hourly_cost: number }[] }),
  ]);
  const unav = (unavData ?? []) as UnavailabilityRow[];
  const weekFrom = startOfCivilDay(week, tz);
  const weekTo = startOfCivilDay(addDays(week, 7), tz);
  const weekShifts = around.filter((s) => new Date(s.starts_at) >= weekFrom && new Date(s.starts_at) < weekTo);
  const weekIds = new Set(weekShifts.map((s) => s.id));

  const warnings = shiftWarnings(around.map(toShiftLike), {
    tz,
    rules,
    weekShiftIds: weekIds,
    absences: absences.map((a) => ({ userId: a.user_id, startsAt: new Date(a.starts_at), endsAt: new Date(a.ends_at) })),
    unavailability: unav.map((u) => ({ userId: u.user_id, weekday: u.weekday, onDate: u.on_date, fromTime: u.from_time, toTime: u.to_time })),
  }).filter((w) => w.shiftIds.length === 0 || w.shiftIds.some((id) => weekIds.has(id)));
  const byShift = warningsByShift(warnings);
  const hours = hoursByUser(weekShifts.map(toShiftLike));
  const coverage = coverageByDepartmentDay(weekShifts.map(toShiftLike), tz);
  const drafts = weekShifts.filter((s) => s.status === "bozza").length;
  const changed = weekShifts.filter((s) => s.status === "pubblicato" && s.changed_at).length;

  // persone: chi ha accesso alla struttura + chi ha turni questa settimana (anche se nel frattempo è uscito)
  const peopleIds = new Set(people.map((p) => p.userId));
  const rows = [...people, ...[...new Set(weekShifts.map((s) => s.user_id))].filter((id) => !peopleIds.has(id)).map((id) => ({ userId: id, name: "Ex collaboratore", departmentIds: [] }))];
  const nameOf = new Map(rows.map((r) => [r.userId, r.name]));
  const depName = (id: string | null) => (id ? ctx.departments.find((d) => d.id === id)?.name ?? "—" : "Senza reparto");

  const costMap = new Map(((costsRes.data ?? []) as { user_id: string; hourly_cost: number }[]).map((c) => [c.user_id, Number(c.hourly_cost)]));
  const cost = showCosts ? weeklyCost(weekShifts.map(toShiftLike), costMap) : null;

  const editing = sp.turno ? around.find((s) => s.id === sp.turno) ?? (await fetchShift(sp.turno)) : null;
  const formDate = editing ? localDateOf(new Date(editing.starts_at), tz) : isCivilDate(sp.giorno) ? sp.giorno : days.includes(today) ? today : week;

  const cell = (userId: string, day: string) => {
    const list = weekShifts.filter((s) => s.user_id === userId && localDateOf(new Date(s.starts_at), tz) === day);
    const dayFrom = startOfCivilDay(day, tz);
    const dayTo = startOfCivilDay(addDays(day, 1), tz);
    const abs = absences.find((a) => a.user_id === userId && new Date(a.starts_at) < dayTo && new Date(a.ends_at) > dayFrom);
    const un = unav.filter(
      (u) => u.user_id === userId && hitsUnavailability({ id: "", userId, startsAt: dayFrom, endsAt: dayTo }, { userId: u.user_id, weekday: u.weekday, onDate: u.on_date, fromTime: u.from_time, toTime: u.to_time }, tz),
    );
    return (
      <td key={day} className={cx("min-w-[7.5rem] border-b border-l border-sand p-1.5 align-top", day === today && "bg-warm")}>
        <div className="space-y-1">
          {abs && <AbsenceChip a={abs} />}
          {un.map((u) => (
            <div key={u.id} className="rounded-md border border-dashed border-sand-deep px-1.5 py-0.5 text-[0.7rem] text-muted" title={u.note ?? undefined}>
              Non disp. {u.from_time ? `${hm(u.from_time)}–${hm(u.to_time)}` : "tutto il giorno"}
            </div>
          ))}
          {list.map((s) => (
            <ShiftChip key={s.id} s={s} tz={tz} week={week} dep={s.department_id ? depName(s.department_id) : null} warns={byShift.get(s.id)?.map((w) => w.message) ?? []} />
          ))}
          <a
            href={`/lavoro/turni?settimana=${week}&persona=${userId}&giorno=${day}#modulo-turno`}
            className="flex min-h-8 items-center justify-center rounded-md text-sm font-bold text-muted hover:bg-sand hover:text-night"
            aria-label={`Aggiungi turno a ${nameOf.get(userId)} ${formatDate(day, tz)}`}
          >
            +
          </a>
        </div>
      </td>
    );
  };

  return (
    <div className="space-y-5">
      {sp.salvato && <Notice tone="ok">Turno salvato{drafts ? ": ricordati di pubblicare la settimana." : "."}</Notice>}
      {sp.rimosso === "annullato" && <Notice tone="warn">Turno annullato: la persona lo vede come annullato.</Notice>}
      {sp.rimosso === "eliminato" && <Notice tone="ok">Bozza eliminata.</Notice>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LinkButton variant="secondary" href={`/lavoro/turni?settimana=${addDays(week, -7)}`} aria-label="Settimana precedente">←</LinkButton>
          <div className="min-w-[10rem] text-center">
            <p className="font-bold text-night">{formatDate(week, tz)} – {formatDate(addDays(week, 6), tz)}</p>
            <p className="text-xs text-muted">{drafts ? `${drafts} in bozza` : "Tutto pubblicato"}{changed ? ` · ${changed} modificati dopo la pubblicazione` : ""}</p>
          </div>
          <LinkButton variant="secondary" href={`/lavoro/turni?settimana=${addDays(week, 7)}`} aria-label="Settimana successiva">→</LinkButton>
          {!days.includes(today) && <LinkButton variant="ghost" href="/lavoro/turni">Oggi</LinkButton>}
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionForm action={copyPreviousWeek}>
            <input type="hidden" name="week" value={week} />
            <SubmitButton variant="secondary" pendingText="Copia…" confirm="Copiare i turni della settimana precedente come bozze?">Copia settimana precedente</SubmitButton>
          </ActionForm>
          <ActionForm action={publishWeek}>
            <input type="hidden" name="week" value={week} />
            <SubmitButton pendingText="Pubblicazione…" confirm={drafts ? `Pubblicare ${drafts} turni? Il team li vedrà subito.` : undefined}>
              Pubblica settimana{drafts ? ` (${drafts})` : ""}
            </SubmitButton>
          </ActionForm>
        </div>
      </div>

      {warnings.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title={`Avvisi (${warnings.length})`} hint="Non bloccano la pubblicazione: valuta tu se sistemare." />
          <ul className="max-h-60 overflow-y-auto">
            {warnings.map((w, i) => {
              const first = w.shiftIds.map((id) => around.find((s) => s.id === id)).find(Boolean);
              return (
                <li key={i} className="flex items-center gap-2 border-b border-sand px-4 py-2 text-sm last:border-b-0">
                  <Badge tone={w.kind === "sovrapposizione" || w.kind === "assenza" ? "danger" : "warn"}>{WARN_LABEL[w.kind]}</Badge>
                  <span className="font-bold text-night">{nameOf.get(w.userId) ?? "Collega"}</span>
                  <span className="text-muted">{first ? `${formatDate(first.starts_at, tz)} · ` : ""}{w.message}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title="Nessuna persona in questa struttura" text="Invita il team da Gestione → Persone, poi torna qui a pianificare." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[62rem] border-collapse text-left">
              <thead>
                <tr className="bg-sand/60 text-xs text-muted">
                  <th className="sticky left-0 z-10 min-w-[9rem] bg-sand px-3 py-2">Persona</th>
                  {days.map((d) => (
                    <th key={d} className={cx("border-l border-sand px-2 py-2 font-bold", d === today && "text-night")}>
                      {formatDate(d, tz)}
                    </th>
                  ))}
                  <th className="border-l border-sand px-2 py-2">Ore</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const h = hours.get(p.userId) ?? 0;
                  const over = h > rules.maxWeekHours;
                  return (
                    <tr key={p.userId}>
                      <th scope="row" className="sticky left-0 z-10 border-b border-sand bg-white px-3 py-2 align-top text-sm font-bold text-night">
                        {p.name}
                        {p.departmentIds.length > 0 && (
                          <span className="block text-xs font-normal text-muted">{p.departmentIds.map((id) => depName(id)).join(", ")}</span>
                        )}
                      </th>
                      {days.map((d) => cell(p.userId, d))}
                      <td className="border-b border-l border-sand px-2 py-2 align-top text-sm">
                        <span className={cx("font-bold", over ? "text-danger" : "text-night")}>{formatHours(h)}</span>
                        {showCosts && costMap.has(p.userId) && h > 0 && <span className="block text-xs text-muted">{formatEur(h * costMap.get(p.userId)!)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                {[...coverage.entries()].map(([depId, byDay]) => (
                  <tr key={depId || "none"} className="bg-warm text-xs">
                    <th scope="row" className="sticky left-0 z-10 bg-warm px-3 py-1.5 font-bold text-night">Copertura {depName(depId || null)}</th>
                    {days.map((d) => (
                      <td key={d} className="border-l border-sand px-2 py-1.5 text-muted">{byDay.get(d) ? formatHours(byDay.get(d)!) : "—"}</td>
                    ))}
                    <td className="border-l border-sand px-2 py-1.5 font-bold text-night">{formatHours([...byDay.values()].reduce((a, b) => a + b, 0))}</td>
                  </tr>
                ))}
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden" id="modulo-turno">
          <CardHeader
            title={editing ? "Modifica turno" : "Nuovo turno"}
            hint={editing?.status === "pubblicato" ? "Già pubblicato: la persona vedrà il badge «modificato»." : `Orari nel fuso della struttura (${tz}). Se la fine è prima dell'inizio, il turno finisce il giorno dopo.`}
            action={editing ? <LinkButton variant="ghost" href={`/lavoro/turni?settimana=${week}`}>Annulla</LinkButton> : undefined}
          />
          <ActionForm action={saveShift} className="grid gap-3 p-4 sm:grid-cols-2" key={editing?.id ?? `${sp.persona}-${formDate}`}>
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="Persona">
              <Select name="user_id" defaultValue={editing?.user_id ?? sp.persona ?? ""} required>
                <option value="">Scegli…</option>
                {rows.map((p) => (
                  <option key={p.userId} value={p.userId}>{p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Giorno">
              <Input type="date" name="date" defaultValue={formDate} required />
            </Field>
            <Field label="Inizio">
              <Input type="time" name="start" defaultValue={editing ? localTimeOf(new Date(editing.starts_at), tz) : "09:00"} required />
            </Field>
            <Field label="Fine">
              <Input type="time" name="end" defaultValue={editing ? localTimeOf(new Date(editing.ends_at), tz) : "17:00"} required />
            </Field>
            <Field label="Reparto">
              <Select name="department_id" defaultValue={editing?.department_id ?? defaultDept(rows, sp.persona) ?? ""}>
                <option value="">—</option>
                {ctx.departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Pausa (minuti)">
              <Input type="number" name="break_minutes" min={0} max={240} step={5} defaultValue={editing?.break_minutes ?? 0} inputMode="numeric" />
            </Field>
            <Field label="Ruolo / postazione">
              <Input name="role_label" maxLength={80} defaultValue={editing?.role_label ?? ""} placeholder="Es. Banco, Apertura, Chiusura" />
            </Field>
            <Field label="Nota">
              <Input name="note" maxLength={500} defaultValue={editing?.note ?? ""} />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton full>{editing ? "Salva modifiche" : "Aggiungi turno (bozza)"}</SubmitButton>
            </div>
          </ActionForm>
          {editing && editing.status !== "annullato" && (
            <ActionForm action={removeShift} className="border-t border-sand px-4 py-3">
              <input type="hidden" name="id" value={editing.id} />
              <input type="hidden" name="week" value={week} />
              <SubmitButton variant="danger" pendingText="…" confirm={editing.status === "pubblicato" ? "Annullare il turno? La persona lo vedrà annullato." : "Eliminare la bozza?"}>
                {editing.status === "pubblicato" ? "Annulla turno" : "Elimina bozza"}
              </SubmitButton>
            </ActionForm>
          )}
        </Card>

        <div className="space-y-5">
          {showCosts && cost && (
            <Card className="overflow-hidden">
              <CardHeader title="Costo stimato della settimana" hint="Visibile solo a chi ha accesso ai dati economici." action={<Badge tone="night">{formatEur(cost.total)}</Badge>} />
              {cost.missing.length > 0 && (
                <p className="px-4 pt-3 text-sm text-warn">Senza costo orario: {cost.missing.map((id) => nameOf.get(id) ?? "Collega").join(", ")}.</p>
              )}
              <ActionForm action={setHourlyCost} className="flex flex-wrap items-end gap-2 p-4">
                <div className="min-w-[10rem] flex-1">
                  <Field label="Persona">
                    <Select name="user_id" defaultValue="" required>
                      <option value="">Scegli…</option>
                      {rows.map((p) => (
                        <option key={p.userId} value={p.userId}>
                          {p.name}{costMap.has(p.userId) ? ` (${formatEur(costMap.get(p.userId))}/h)` : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="€ / ora">
                    <Input name="hourly_cost" inputMode="decimal" placeholder="es. 14,50" />
                  </Field>
                </div>
                <SubmitButton variant="secondary">Salva</SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Card className="overflow-hidden">
            <CardHeader title="Soglie degli avvisi" hint="Valgono per questa struttura." />
            <ActionForm action={saveShiftSettings} className="grid grid-cols-2 gap-3 p-4">
              <Field label="Ore massime / settimana">
                <Input type="number" name="max_week_hours" min={1} max={120} step="0.5" defaultValue={rules.maxWeekHours} />
              </Field>
              <Field label="Riposo minimo (ore)">
                <Input type="number" name="min_rest_hours" min={0} max={24} step="0.5" defaultValue={rules.minRestHours} />
              </Field>
              <div className="col-span-2">
                <SubmitButton variant="secondary" full>Salva soglie</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        </div>
      </div>
    </div>
  );
}

const WARN_LABEL: Record<string, string> = {
  sovrapposizione: "Sovrapposto",
  assenza: "In assenza",
  riposo: "Riposo breve",
  ore_settimana: "Troppe ore",
  indisponibile: "Non disponibile",
};

function defaultDept(rows: { userId: string; departmentIds: string[] }[], userId?: string) {
  const p = rows.find((r) => r.userId === userId);
  return p?.departmentIds.length === 1 ? p.departmentIds[0] : undefined;
}

async function fetchShift(id: string): Promise<ShiftRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("shifts").select("id, user_id, department_id, starts_at, ends_at, break_minutes, role_label, note, status, published_at, changed_at").eq("id", id).maybeSingle();
  return (data as ShiftRow | null) ?? null;
}

function AbsenceChip({ a }: { a: AbsenceRow }) {
  return (
    <div className="rounded-md bg-teal-soft px-1.5 py-0.5 text-[0.7rem] font-bold text-teal-deep">
      {a.kind ? LEAVE_KIND[a.kind] : "Non disponibile"}
    </div>
  );
}

function ShiftChip({ s, tz, week, dep, warns }: { s: ShiftRow; tz: string; week: string; dep: string | null; warns: string[] }) {
  return (
    <a
      href={`/lavoro/turni?settimana=${week}&turno=${s.id}#modulo-turno`}
      title={warns.join("\n") || undefined}
      className={cx(
        "block rounded-md border px-1.5 py-1 text-xs leading-tight hover:border-night-3",
        s.status === "bozza" ? "border-dashed border-sand-deep bg-white" : "border-transparent bg-night text-warm",
        warns.length > 0 && "ring-2 ring-warn",
      )}
    >
      <span className="block font-bold">
        {formatTime(s.starts_at, tz)}–{formatTime(s.ends_at, tz)}
      </span>
      <span className={cx("block truncate", s.status === "bozza" ? "text-muted" : "text-warm/80")}>
        {[dep, s.role_label].filter(Boolean).join(" · ") || "—"}
      </span>
      <span className="mt-0.5 flex flex-wrap gap-1">
        {s.status === "bozza" && <span className="rounded bg-sand px-1 text-[0.65rem] font-bold text-ink">bozza</span>}
        {s.status === "pubblicato" && s.changed_at && <span className="rounded bg-warn-soft px-1 text-[0.65rem] font-bold text-warn">modificato</span>}
        {warns.length > 0 && <span className="rounded bg-warn-soft px-1 text-[0.65rem] font-bold text-warn">⚠ {warns.length}</span>}
      </span>
    </a>
  );
}
