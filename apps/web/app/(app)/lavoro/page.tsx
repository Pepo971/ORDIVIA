import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, cx, EmptyState, Field, Input, PageHeader, Select, Tabs, Textarea } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDateTime } from "@/lib/format";
import { TASK_STATUS } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";
import { advanceTask, createTask, rejectTask } from "./actions";
import { MarkSeen } from "./mark-seen";

export const metadata = { title: "Lavoro" };
export const dynamic = "force-dynamic";

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_at: string | null;
  assignee_id: string | null;
  department_id: string | null;
  requires_photo: boolean;
  requires_verification: boolean;
  seen_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  verified_at: string | null;
  completion_note: string | null;
  photo_path: string | null;
  created_at: string;
}

export default async function LavoroPage({ searchParams }: { searchParams: Promise<{ vista?: string }> }) {
  const ctx = await requirePerm("tasks.perform", "tasks.manage");
  const sp = await searchParams;
  const isManager = can(ctx, "tasks.manage");
  const view = isManager && sp.vista === "team" ? "team" : "mie";
  const supabase = await createClient();
  const tz = ctx.facility.timezone;

  const base = supabase
    .from("tasks")
    .select("id, title, description, status, due_at, assignee_id, department_id, requires_photo, requires_verification, seen_at, started_at, completed_at, verified_at, completion_note, photo_path, created_at")
    .eq("facility_id", ctx.facility.id);
  const { data } =
    view === "mie"
      ? await base.eq("assignee_id", ctx.userId).not("status", "in", "(verificata,annullata)").order("due_at", { ascending: true, nullsFirst: false })
      : await base.order("created_at", { ascending: false }).limit(150);
  const tasks = (data ?? []) as Task[];

  // Colleghi assegnabili: membri con accesso a questa struttura
  const { data: members } = isManager
    ? await supabase.from("memberships").select("user_id, all_facilities, facility_ids, active").eq("org_id", ctx.org.id).eq("active", true)
    : { data: [] };
  const eligible = (members ?? []).filter((m) => m.all_facilities || (m.facility_ids as string[]).includes(ctx.facility.id)).map((m) => m.user_id as string);
  const ids = [...new Set([...eligible, ...tasks.map((t) => t.assignee_id).filter(Boolean)])] as string[];
  const { data: people } = ids.length ? await supabase.from("profiles").select("id, full_name").in("id", ids) : { data: [] };
  const name = new Map((people ?? []).map((p) => [p.id, p.full_name ?? "—"]));

  // Foto: link firmati a scadenza breve, solo per chi può già vedere l'attività
  const photoUrls = new Map<string, string>();
  const withPhoto = tasks.filter((t) => t.photo_path);
  if (withPhoto.length) {
    const { data: signed } = await supabase.storage.from("ordivia-files").createSignedUrls(withPhoto.map((t) => t.photo_path!), 600);
    signed?.forEach((s, i) => s.signedUrl && photoUrls.set(withPhoto[i]!.id, s.signedUrl));
  }

  const unseen = tasks.filter((t) => t.status === "assegnata" && t.assignee_id === ctx.userId).map((t) => t.id);
  const now = Date.now();

  return (
    <div>
      <MarkSeen ids={unseen} />
      <PageHeader title="Lavoro" subtitle={view === "mie" ? "Le tue attività, in ordine di scadenza." : "Tutte le attività della struttura, con ogni passaggio tracciato."} />
      {isManager && (
        <Tabs
          active={view}
          items={[
            { key: "mie", label: "Le mie", href: "/lavoro" },
            { key: "team", label: "Team", href: "/lavoro?vista=team", count: tasks.filter((t) => t.status === "completata").length || undefined },
          ]}
        />
      )}

      <div className={cx("grid gap-5", isManager && view === "team" && "lg:grid-cols-[1fr_20rem]")}>
        <div className="space-y-3">
          {tasks.length === 0 && (
            <Card>
              <EmptyState title={view === "mie" ? "Nessuna attività per te" : "Nessuna attività"} text={view === "mie" ? "Quando ti assegnano qualcosa lo trovi qui." : "Assegna la prima attività dal modulo."} />
            </Card>
          )}
          {tasks.map((t) => {
            const st = TASK_STATUS[t.status]!;
            const overdue = t.due_at && new Date(t.due_at).getTime() < now && !["completata", "verificata", "annullata"].includes(t.status);
            const mine = t.assignee_id === ctx.userId;
            return (
              <Card key={t.id} id={t.id} className={cx("p-4", overdue && "border-danger/50")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[1.05rem] font-bold text-night">{t.title}</p>
                    <p className="text-sm text-muted">
                      {t.assignee_id ? name.get(t.assignee_id) : "Non assegnata"}
                      {t.department_id && ` · ${ctx.departments.find((d) => d.id === t.department_id)?.name ?? ""}`}
                      {t.due_at && <span className={cx(overdue && "font-bold text-danger")}> · entro {formatDateTime(t.due_at, tz)}</span>}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    {t.requires_photo && <Badge>Foto</Badge>}
                    <Badge tone={overdue ? "danger" : st.tone}>{overdue ? "In ritardo" : st.label}</Badge>
                  </div>
                </div>
                {t.description && <p className="mt-2 text-sm whitespace-pre-line text-ink">{t.description}</p>}

                <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <li>Assegnata {formatDateTime(t.created_at, tz)}</li>
                  {t.seen_at && <li>Vista {formatDateTime(t.seen_at, tz)}</li>}
                  {t.started_at && <li>Iniziata {formatDateTime(t.started_at, tz)}</li>}
                  {t.completed_at && <li className="font-bold text-ok">Completata {formatDateTime(t.completed_at, tz)}</li>}
                  {t.verified_at && <li className="font-bold text-night">Verificata {formatDateTime(t.verified_at, tz)}</li>}
                </ol>
                {(t.completion_note || photoUrls.get(t.id)) && (
                  <div className="mt-3 flex items-start gap-3 rounded-xl bg-warm p-3">
                    {photoUrls.get(t.id) && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <a href={photoUrls.get(t.id)} target="_blank" rel="noopener noreferrer"><img src={photoUrls.get(t.id)} alt="Foto di completamento" className="h-20 w-20 rounded-lg object-cover" /></a>
                    )}
                    {t.completion_note && <p className="text-sm text-ink">“{t.completion_note}”</p>}
                  </div>
                )}

                {mine && ["assegnata", "vista"].includes(t.status) && (
                  <ActionForm action={advanceTask} className="mt-3">
                    <input type="hidden" name="task_id" value={t.id} />
                    <input type="hidden" name="to" value="iniziata" />
                    <SubmitButton variant="secondary" pendingText="…">Inizia</SubmitButton>
                  </ActionForm>
                )}
                {mine && ["assegnata", "vista", "iniziata"].includes(t.status) && (
                  <ActionForm action={advanceTask} className="mt-3 grid gap-2 rounded-xl border border-sand p-3">
                    <input type="hidden" name="task_id" value={t.id} />
                    <input type="hidden" name="to" value="completata" />
                    {t.requires_photo && (
                      <Field label="Foto (obbligatoria)">
                        <Input name="photo" type="file" accept="image/*" capture="environment" required className="py-2" />
                      </Field>
                    )}
                    <Input name="note" placeholder="Nota (facoltativa)" maxLength={1000} />
                    <SubmitButton pendingText="Invio…">Segna come completata</SubmitButton>
                  </ActionForm>
                )}
                {isManager && t.status === "completata" && !mine && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ActionForm action={advanceTask}>
                      <input type="hidden" name="task_id" value={t.id} />
                      <input type="hidden" name="to" value="verificata" />
                      <SubmitButton pendingText="…">Verifica</SubmitButton>
                    </ActionForm>
                    <ActionForm action={rejectTask} className="flex gap-2">
                      <input type="hidden" name="task_id" value={t.id} />
                      <Input name="note" placeholder="Cosa va rifatto?" className="w-48" />
                      <SubmitButton variant="secondary" pendingText="…">Rimanda</SubmitButton>
                    </ActionForm>
                  </div>
                )}
              </Card>
            );
          })}
        </div>

        {isManager && view === "team" && (
          <Card className="h-fit overflow-hidden">
            <CardHeader title="Assegna un’attività" />
            <ActionForm action={createTask} resetOnSuccess className="space-y-3 p-4">
              <Field label="Cosa va fatto">
                <Input name="title" placeholder="Es. Sanificare il frigo bar" required />
              </Field>
              <Field label="Dettagli">
                <Textarea name="description" rows={2} />
              </Field>
              <Field label="A chi">
                <Select name="assignee_id" defaultValue="">
                  <option value="">Scegli…</option>
                  {eligible.map((id) => (
                    <option key={id} value={id}>{name.get(id) ?? "Collega"}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Reparto">
                <Select name="department_id" defaultValue="">
                  <option value="">—</option>
                  {ctx.departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Entro il">
                  <Input name="due_date" type="date" />
                </Field>
                <Field label="Ore">
                  <Input name="due_time" type="time" />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm font-bold text-night">
                <input type="checkbox" name="requires_photo" className="h-5 w-5 min-h-0 accent-teal" /> Richiedi foto
              </label>
              <label className="flex items-center gap-2 text-sm font-bold text-night">
                <input type="checkbox" name="requires_verification" defaultChecked className="h-5 w-5 min-h-0 accent-teal" /> Da verificare
              </label>
              <SubmitButton full>Assegna</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </div>
  );
}
