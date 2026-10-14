import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, cx, EmptyState, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatDateTime, formatTime } from "@/lib/format";
import { getFacilityPeople, LEAVE_KIND, LEAVE_STATUS, SHIFT_COLUMNS, SWAP_STATUS, type ShiftRow } from "@/lib/shifts-queries";
import { createClient } from "@/lib/supabase/server";
import { todayIn } from "@ordivia/domain";
import { acceptSwap, cancelLeave, cancelSwap, decideLeave, decideSwap, offerSwap, requestLeave } from "./actions";

export const metadata = { title: "Ferie e cambi turno" };
export const dynamic = "force-dynamic";

interface Leave {
  id: string;
  user_id: string;
  kind: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  note: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  cancelled_at: string | null;
}

interface Swap {
  id: string;
  shift_id: string;
  department_id: string | null;
  from_user: string;
  to_user: string | null;
  note: string | null;
  status: string;
  offered_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  cancelled_at: string | null;
}

export default async function RichiestePage() {
  const ctx = await requirePerm("shifts.view", "shifts.manage");
  const isManager = can(ctx, "shifts.manage");
  const tz = ctx.facility.timezone;
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();

  const [people, { data: leaveData }, { data: swapData }, { data: myShiftData }] = await Promise.all([
    getFacilityPeople(ctx),
    // RLS: il collaboratore riceve solo le proprie richieste; il responsabile quelle della struttura
    supabase
      .from("leave_requests")
      .select("id, user_id, kind, starts_at, ends_at, all_day, note, status, created_at, decided_at, decision_note, cancelled_at")
      .eq("facility_id", ctx.facility.id)
      .or(`status.eq.in_attesa,ends_at.gte.${since}`)
      .order("starts_at", { ascending: true })
      .limit(200),
    supabase
      .from("shift_swaps")
      .select("id, shift_id, department_id, from_user, to_user, note, status, offered_at, accepted_by, accepted_at, decided_at, decision_note, cancelled_at")
      .eq("facility_id", ctx.facility.id)
      .gte("offered_at", since)
      .order("offered_at", { ascending: false })
      .limit(200),
    supabase.from("shifts").select(SHIFT_COLUMNS).eq("facility_id", ctx.facility.id).eq("user_id", ctx.userId).eq("status", "pubblicato").gt("starts_at", nowIso).order("starts_at").limit(30),
  ]);
  const leaves = (leaveData ?? []) as Leave[];
  const swaps = (swapData ?? []) as Swap[];
  const myShifts = (myShiftData ?? []) as ShiftRow[];

  const shiftIds = [...new Set(swaps.map((s) => s.shift_id))];
  const { data: swapShiftData } = shiftIds.length ? await supabase.from("shifts").select(SHIFT_COLUMNS).in("id", shiftIds) : { data: [] };
  const shiftById = new Map(((swapShiftData ?? []) as ShiftRow[]).map((s) => [s.id, s]));

  const nameIds = [...new Set([...leaves.map((l) => l.user_id), ...swaps.flatMap((s) => [s.from_user, s.to_user, s.accepted_by])].filter(Boolean))] as string[];
  const known = new Map(people.map((p) => [p.userId, p.name]));
  const missing = nameIds.filter((id) => !known.has(id));
  if (missing.length) {
    const { data: extra } = await supabase.from("profiles").select("id, full_name").in("id", missing);
    (extra ?? []).forEach((p) => known.set(p.id as string, (p.full_name as string) || "Collega"));
  }
  const nameOf = (id: string | null) => (id ? known.get(id) ?? "Collega" : "—");
  const depName = (id: string | null) => (id ? ctx.departments.find((d) => d.id === id)?.name ?? "reparto" : null);

  const shiftLabel = (s: ShiftRow | undefined) =>
    s ? `${formatDate(s.starts_at, tz)} ${formatTime(s.starts_at, tz)}–${formatTime(s.ends_at, tz)}${s.department_id ? ` · ${depName(s.department_id)}` : ""}` : "Turno non più visibile";
  const periodLabel = (l: Leave) =>
    l.all_day
      ? `${formatDate(l.starts_at, tz)} → ${formatDate(new Date(new Date(l.ends_at).getTime() - 1), tz)}`
      : `${formatDateTime(l.starts_at, tz)} → ${formatDateTime(l.ends_at, tz)}`;

  const pendingLeaves = isManager ? leaves.filter((l) => l.status === "in_attesa" && l.user_id !== ctx.userId) : [];
  const pendingSwaps = isManager ? swaps.filter((s) => s.status === "accettato") : [];
  const myLeaves = leaves.filter((l) => l.user_id === ctx.userId);
  const forMe = swaps.filter((s) => s.status === "offerto" && s.from_user !== ctx.userId && (s.to_user === ctx.userId || s.to_user === null));
  const myOffers = swaps.filter((s) => s.from_user === ctx.userId || s.accepted_by === ctx.userId);
  const openShiftIds = new Set(swaps.filter((s) => ["offerto", "accettato"].includes(s.status)).map((s) => s.shift_id));
  const colleagues = people.filter((p) => p.userId !== ctx.userId);
  const teamHistory = isManager ? leaves.filter((l) => l.status !== "in_attesa" && l.user_id !== ctx.userId).slice(-20).reverse() : [];
  const today = todayIn(tz);

  return (
    <div>
      <PageHeader title="Ferie e cambi turno" subtitle={isManager ? "Richieste del team da decidere e le tue." : "Chiedi ferie o permessi, segnala la malattia, proponi un cambio turno."} />

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          {isManager && (
            <Card className="overflow-hidden">
              <CardHeader title="Da decidere" hint="Ogni decisione è registrata con autore e orario." action={<Badge tone={pendingLeaves.length + pendingSwaps.length ? "warn" : "ok"}>{pendingLeaves.length + pendingSwaps.length}</Badge>} />
              {pendingLeaves.length + pendingSwaps.length === 0 && <EmptyState title="Niente in attesa" text="Le nuove richieste del team compaiono qui." />}
              {pendingLeaves.map((l) => (
                <div key={l.id} className="border-b border-sand p-4 last:border-b-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-bold text-night">{nameOf(l.user_id)} · {LEAVE_KIND[l.kind]}</p>
                      <p className="text-sm text-muted">{periodLabel(l)} · chiesta {formatDateTime(l.created_at, tz)}</p>
                      {l.note && <p className="mt-1 text-sm text-ink">“{l.note}”</p>}
                    </div>
                    {l.kind === "malattia" && <Badge tone="danger">Dato riservato</Badge>}
                  </div>
                  <ActionForm action={decideLeave} className="mt-3 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="id" value={l.id} />
                    <Input name="note" placeholder="Nota (obbligatoria per rifiutare)" maxLength={1000} className="min-w-[12rem] flex-1" />
                    <SubmitButton name="decision" value="approva" pendingText="…">Approva</SubmitButton>
                    <SubmitButton name="decision" value="rifiuta" variant="danger" pendingText="…">Rifiuta</SubmitButton>
                  </ActionForm>
                </div>
              ))}
              {pendingSwaps.map((s) => (
                <div key={s.id} className="border-b border-sand p-4 last:border-b-0">
                  <p className="font-bold text-night">Cambio turno: {nameOf(s.from_user)} → {nameOf(s.accepted_by)}</p>
                  <p className="text-sm text-muted">{shiftLabel(shiftById.get(s.shift_id))}</p>
                  <SwapTimeline s={s} tz={tz} nameOf={nameOf} />
                  {s.note && <p className="mt-1 text-sm text-ink">“{s.note}”</p>}
                  <ActionForm action={decideSwap} className="mt-3 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="id" value={s.id} />
                    <Input name="note" placeholder="Nota (facoltativa)" maxLength={500} className="min-w-[12rem] flex-1" />
                    <SubmitButton name="decision" value="approva" pendingText="…">Approva e riassegna</SubmitButton>
                    <SubmitButton name="decision" value="rifiuta" variant="danger" pendingText="…">Rifiuta</SubmitButton>
                  </ActionForm>
                </div>
              ))}
            </Card>
          )}

          <Card className="overflow-hidden">
            <CardHeader title="Turni offerti a te" hint="Se accetti, il responsabile deve ancora approvare." />
            {forMe.length === 0 ? (
              <EmptyState title="Nessuna proposta" text="Quando un collega ti offre un turno, o lo offre al tuo reparto, lo trovi qui." />
            ) : (
              forMe.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-sand p-4 last:border-b-0">
                  <div>
                    <p className="font-bold text-night">{shiftLabel(shiftById.get(s.shift_id))}</p>
                    <p className="text-sm text-muted">
                      Da {nameOf(s.from_user)} · {s.to_user ? "a te" : `a tutto il reparto ${depName(s.department_id) ?? ""}`} · {formatDateTime(s.offered_at, tz)}
                    </p>
                    {s.note && <p className="text-sm text-ink">“{s.note}”</p>}
                  </div>
                  <ActionForm action={acceptSwap}>
                    <input type="hidden" name="id" value={s.id} />
                    <SubmitButton pendingText="…" confirm="Accetti di prendere questo turno?">Accetto</SubmitButton>
                  </ActionForm>
                </div>
              ))
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="I miei cambi turno" />
            {myOffers.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">Nessun cambio negli ultimi 60 giorni.</p>
            ) : (
              myOffers.map((s) => {
                const st = SWAP_STATUS[s.status]!;
                return (
                  <div key={s.id} className="border-b border-sand p-4 last:border-b-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-bold text-night">{shiftLabel(shiftById.get(s.shift_id))}</p>
                        <p className="text-sm text-muted">
                          {s.from_user === ctx.userId
                            ? `Offerto a ${s.to_user ? nameOf(s.to_user) : `reparto ${depName(s.department_id) ?? ""}`}`
                            : `Preso da ${nameOf(s.from_user)}`}
                        </p>
                      </div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <SwapTimeline s={s} tz={tz} nameOf={nameOf} />
                    {s.decision_note && <p className="mt-1 text-sm text-ink">Responsabile: “{s.decision_note}”</p>}
                    {s.from_user === ctx.userId && ["offerto", "accettato"].includes(s.status) && (
                      <ActionForm action={cancelSwap} className="mt-2">
                        <input type="hidden" name="id" value={s.id} />
                        <SubmitButton variant="ghost" pendingText="…">Ritira proposta</SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                );
              })
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Le mie assenze" />
            {myLeaves.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">Nessuna richiesta recente.</p>
            ) : (
              myLeaves.map((l) => {
                const st = LEAVE_STATUS[l.status]!;
                const canCancel = l.status === "in_attesa" || (l.status === "approvata" && new Date(l.starts_at) > new Date());
                return (
                  <div key={l.id} className="border-b border-sand p-4 last:border-b-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-bold text-night">{LEAVE_KIND[l.kind]} · {periodLabel(l)}</p>
                        <p className="text-xs text-muted">
                          Chiesta {formatDateTime(l.created_at, tz)}
                          {l.decided_at && ` · decisa ${formatDateTime(l.decided_at, tz)}`}
                          {l.cancelled_at && ` · annullata ${formatDateTime(l.cancelled_at, tz)}`}
                        </p>
                        {l.decision_note && <p className="mt-1 text-sm text-ink">Responsabile: “{l.decision_note}”</p>}
                      </div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    {canCancel && (
                      <ActionForm action={cancelLeave} className="mt-2">
                        <input type="hidden" name="id" value={l.id} />
                        <SubmitButton variant="ghost" pendingText="…" confirm="Annullare la richiesta?">Annulla richiesta</SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                );
              })
            )}
          </Card>

          {isManager && teamHistory.length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader title="Decisioni recenti del team" />
              {teamHistory.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-sand px-4 py-2.5 text-sm last:border-b-0">
                  <span>
                    <span className="font-bold text-night">{nameOf(l.user_id)}</span> · {LEAVE_KIND[l.kind]} · {periodLabel(l)}
                  </span>
                  <Badge tone={LEAVE_STATUS[l.status]!.tone}>{LEAVE_STATUS[l.status]!.label}</Badge>
                </div>
              ))}
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card className="h-fit overflow-hidden">
            <CardHeader title="Chiedi un'assenza" hint="La malattia la vede solo il responsabile: i colleghi vedono solo «non disponibile»." />
            <ActionForm action={requestLeave} resetOnSuccess className="space-y-3 p-4">
              <Field label="Tipo">
                <Select name="kind" defaultValue="ferie" required>
                  {Object.entries(LEAVE_KIND).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Dal">
                  <Input type="date" name="from_date" defaultValue={today} required />
                </Field>
                <Field label="Al">
                  <Input type="date" name="to_date" defaultValue={today} required />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm font-bold text-night">
                <input type="checkbox" name="all_day" defaultChecked className="h-5 w-5 min-h-0 accent-teal" /> Giornate intere
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Dalle ore" hint="Solo per permessi a ore">
                  <Input type="time" name="from_time" />
                </Field>
                <Field label="Alle ore">
                  <Input type="time" name="to_time" />
                </Field>
              </div>
              <Field label="Nota">
                <Textarea name="note" rows={2} maxLength={1000} placeholder="Facoltativa" />
              </Field>
              <SubmitButton full>Invia richiesta</SubmitButton>
            </ActionForm>
          </Card>

          <Card className="h-fit overflow-hidden">
            <CardHeader title="Cedi un turno" hint="Scegli un collega o offrilo a tutto il reparto." />
            {myShifts.filter((s) => !openShiftIds.has(s.id)).length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">Non hai turni futuri pubblicati da cedere.</p>
            ) : (
              <ActionForm action={offerSwap} resetOnSuccess className="space-y-3 p-4">
                <Field label="Turno">
                  <Select name="shift_id" defaultValue="" required>
                    <option value="">Scegli…</option>
                    {myShifts.filter((s) => !openShiftIds.has(s.id)).map((s) => (
                      <option key={s.id} value={s.id}>{shiftLabel(s)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="A chi" hint="«Tutto il reparto» richiede che il turno abbia un reparto.">
                  <Select name="to_user" defaultValue="">
                    <option value="">Tutto il reparto</option>
                    {colleagues.map((p) => (
                      <option key={p.userId} value={p.userId}>{p.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Nota">
                  <Input name="note" maxLength={500} placeholder="Es. ho un esame" />
                </Field>
                <SubmitButton full>Proponi cambio</SubmitButton>
              </ActionForm>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function SwapTimeline({ s, tz, nameOf }: { s: Swap; tz: string; nameOf: (id: string | null) => string }) {
  return (
    <ol className={cx("mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted")}>
      <li>Offerto {formatDateTime(s.offered_at, tz)}</li>
      {s.accepted_at && <li>Accettato da {nameOf(s.accepted_by)} {formatDateTime(s.accepted_at, tz)}</li>}
      {s.decided_at && <li className={cx("font-bold", s.status === "approvato" ? "text-ok" : "text-danger")}>{s.status === "approvato" ? "Approvato" : "Rifiutato"} {formatDateTime(s.decided_at, tz)}</li>}
      {s.cancelled_at && <li>Annullato {formatDateTime(s.cancelled_at, tz)}</li>}
    </ol>
  );
}
