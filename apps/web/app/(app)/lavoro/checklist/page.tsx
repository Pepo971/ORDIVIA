import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, LinkButton, PageHeader, Select, Textarea } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDate, WEEKDAY_LABELS } from "@/lib/format";
import { TASK_STATUS } from "@/lib/labels";
import { getFacilityPeople, hm } from "@/lib/shifts-queries";
import { createClient } from "@/lib/supabase/server";
import { checklistRunsOn, todayIn } from "@ordivia/domain";
import { generateToday, saveTemplate, toggleTemplate } from "./actions";

export const metadata = { title: "Checklist" };
export const dynamic = "force-dynamic";

interface Template {
  id: string;
  title: string;
  items: string[];
  department_id: string | null;
  weekdays: number[];
  due_time: string;
  assignee_mode: "in_turno" | "persona";
  assignee_id: string | null;
  requires_photo: boolean;
  requires_verification: boolean;
  active: boolean;
}

export default async function ChecklistPage({ searchParams }: { searchParams: Promise<{ modifica?: string }> }) {
  const ctx = await requirePerm("tasks.manage");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const supabase = await createClient();

  // Generazione automatica all'apertura (idempotente: non crea duplicati).
  const { error: genError } = await supabase.rpc("generate_daily_checklists", { p_facility: ctx.facility.id, p_date: today });

  const [{ data: tplData }, { data: runData }, people] = await Promise.all([
    supabase
      .from("checklist_templates")
      .select("id, title, items, department_id, weekdays, due_time, assignee_mode, assignee_id, requires_photo, requires_verification, active")
      .eq("facility_id", ctx.facility.id)
      .order("active", { ascending: false })
      .order("due_time"),
    supabase.from("checklist_runs").select("template_id, task_id, assignee_id, tasks(status)").eq("facility_id", ctx.facility.id).eq("run_date", today),
    getFacilityPeople(ctx),
  ]);
  const templates = (tplData ?? []) as Template[];
  const runs = new Map(
    (runData ?? []).map((r) => [r.template_id as string, { assignee: r.assignee_id as string | null, status: (r.tasks as unknown as { status: string } | null)?.status ?? null }]),
  );
  const nameOf = new Map(people.map((p) => [p.userId, p.name]));
  const depName = (id: string | null) => (id ? ctx.departments.find((d) => d.id === id)?.name ?? "—" : "Tutti i reparti");
  const editing = sp.modifica ? templates.find((t) => t.id === sp.modifica) : undefined;
  const todayList = templates.filter((t) => t.active && checklistRunsOn(t.weekdays, today));

  return (
    <div>
      <PageHeader
        title="Checklist ricorrenti"
        subtitle="Aperture, chiusure, pulizie: diventano attività ogni giorno, assegnate a chi è in turno."
        action={
          <ActionForm action={generateToday}>
            <input type="hidden" name="date" value={today} />
            <SubmitButton variant="secondary" pendingText="Genero…">Genera le checklist di oggi</SubmitButton>
          </ActionForm>
        }
      />
      {genError && <p className="mb-4 rounded-xl bg-danger-soft px-3 py-2 text-sm font-bold text-danger">Generazione automatica non riuscita: riprova con il pulsante.</p>}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <CardHeader title={`Oggi, ${formatDate(today, tz)}`} hint="Le attività generate le trovi in Attività → Team." action={<LinkButton variant="ghost" href="/lavoro/attivita?vista=team">Apri</LinkButton>} />
            {todayList.length === 0 ? (
              <EmptyState title="Nessuna checklist per oggi" text={templates.length ? "Nessun modello attivo per questo giorno della settimana." : "Crea la prima checklist dal modulo."} />
            ) : (
              <ul>
                {todayList.map((t) => {
                  const run = runs.get(t.id);
                  const st = run?.status ? TASK_STATUS[run.status] : null;
                  return (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-sand px-4 py-3 last:border-b-0">
                      <div>
                        <p className="font-bold text-night">{t.title}</p>
                        <p className="text-sm text-muted">
                          entro le {hm(t.due_time)} · {run ? (run.assignee ? nameOf.get(run.assignee) ?? "Collega" : "Nessuno in turno: da assegnare") : "non ancora generata"}
                        </p>
                      </div>
                      {st ? <Badge tone={st.tone}>{st.label}</Badge> : run ? <Badge tone="warn">Senza assegnatario</Badge> : <Badge>In attesa</Badge>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Modelli" />
            {templates.length === 0 ? (
              <EmptyState title="Nessun modello" text="Esempio: «Apertura bar» ogni giorno alle 9, a chi è in turno al bar, con foto." />
            ) : (
              <ul>
                {templates.map((t) => (
                  <li key={t.id} className="border-b border-sand px-4 py-3 last:border-b-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-bold text-night">{t.title} {!t.active && <Badge>Sospesa</Badge>}</p>
                        <p className="text-sm text-muted">
                          {depName(t.department_id)} · {t.weekdays.length === 7 ? "ogni giorno" : t.weekdays.map((w) => WEEKDAY_LABELS[w - 1]).join(", ")} · entro le {hm(t.due_time)} ·{" "}
                          {t.assignee_mode === "in_turno" ? "chi è in turno" : nameOf.get(t.assignee_id ?? "") ?? "persona non più attiva"}
                        </p>
                        <p className="mt-1 text-xs text-muted">{t.items.length} voci{t.requires_photo ? " · foto" : ""}{t.requires_verification ? " · da verificare" : ""}</p>
                      </div>
                      <div className="flex gap-2">
                        <LinkButton variant="ghost" href={`/lavoro/checklist?modifica=${t.id}#modulo`}>Modifica</LinkButton>
                        <ActionForm action={toggleTemplate}>
                          <input type="hidden" name="id" value={t.id} />
                          <input type="hidden" name="active" value={t.active ? "0" : "1"} />
                          <SubmitButton variant="secondary" pendingText="…">{t.active ? "Sospendi" : "Riattiva"}</SubmitButton>
                        </ActionForm>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="h-fit overflow-hidden" id="modulo">
          <CardHeader
            title={editing ? "Modifica checklist" : "Nuova checklist"}
            hint={editing ? "Le modifiche valgono dalle prossime generazioni." : undefined}
            action={editing ? <LinkButton variant="ghost" href="/lavoro/checklist">Annulla</LinkButton> : undefined}
          />
          <ActionForm action={saveTemplate} resetOnSuccess={!editing} className="space-y-3 p-4" key={editing?.id ?? "nuova"}>
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="Titolo">
              <Input name="title" defaultValue={editing?.title} placeholder="Es. Apertura bar" required maxLength={200} />
            </Field>
            <Field label="Voci" hint="Una per riga.">
              <Textarea name="items" rows={5} defaultValue={editing?.items.join("\n")} placeholder={"Accendere macchina caffè\nControllare temperature frigo\nRifornire banco"} required />
            </Field>
            <Field label="Reparto">
              <Select name="department_id" defaultValue={editing?.department_id ?? ""}>
                <option value="">—</option>
                {ctx.departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            </Field>
            <fieldset>
              <legend className="mb-1 text-sm font-bold text-night">Giorni</legend>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_LABELS.map((l, i) => (
                  <label key={l} className="flex min-h-11 items-center gap-1.5 rounded-lg border border-sand-deep px-2.5 text-sm font-bold text-night has-[:checked]:border-night has-[:checked]:bg-night has-[:checked]:text-warm">
                    <input type="checkbox" name="weekdays" value={i + 1} defaultChecked={editing ? editing.weekdays.includes(i + 1) : true} className="sr-only" />
                    {l}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Entro le">
              <Input type="time" name="due_time" defaultValue={editing ? hm(editing.due_time) : "10:00"} required />
            </Field>
            <Field label="A chi" hint="«Chi è in turno» usa i turni pubblicati del reparto in quel giorno.">
              <Select name="assignee_mode" defaultValue={editing?.assignee_mode ?? "in_turno"}>
                <option value="in_turno">Chi è in turno nel reparto</option>
                <option value="persona">Una persona precisa</option>
              </Select>
            </Field>
            <Field label="Persona (se precisa)">
              <Select name="assignee_id" defaultValue={editing?.assignee_id ?? ""}>
                <option value="">—</option>
                {people.map((p) => (
                  <option key={p.userId} value={p.userId}>{p.name}</option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm font-bold text-night">
              <input type="checkbox" name="requires_photo" defaultChecked={editing?.requires_photo} className="h-5 w-5 min-h-0 accent-teal" /> Richiedi foto
            </label>
            <label className="flex items-center gap-2 text-sm font-bold text-night">
              <input type="checkbox" name="requires_verification" defaultChecked={editing?.requires_verification ?? true} className="h-5 w-5 min-h-0 accent-teal" /> Da verificare
            </label>
            <SubmitButton full>{editing ? "Salva" : "Crea checklist"}</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
