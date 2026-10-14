import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { elapsedLabel, ticketActions, TICKET_CATEGORIES } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Card, CardHeader, Field, Input, Notice, PageHeader, Select, Textarea } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatDateTime } from "@/lib/format";
import { getNames, getPeopleWith, nameMap } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { addTicketPhoto, ticketTransition } from "../actions";
import { MaintenanceTabs, PriorityBadge, SOURCE_LABEL, TICKET_COLUMNS, TicketStatusBadge, pointLabel, type TicketRow } from "../maintenance-ui";

export const metadata = { title: "Intervento" };
export const dynamic = "force-dynamic";

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ nuovo?: string }> }) {
  const ctx = await requirePerm("maintenance.report", "maintenance.manage");
  const { id } = await params;
  const sp = await searchParams;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const manage = can(ctx, "maintenance.manage");
  const tz = ctx.facility.timezone;
  const supabase = await createClient();
  const { data } = await supabase.from("maintenance_tickets").select(TICKET_COLUMNS).eq("id", id).eq("facility_id", ctx.facility.id).maybeSingle();
  if (!data) notFound();
  const t = data as TicketRow;

  const [{ data: point }, { data: asset }, techs] = await Promise.all([
    t.service_point_id ? supabase.from("service_points").select("id, kind, label").eq("id", t.service_point_id).maybeSingle() : Promise.resolve({ data: null }),
    t.asset_id ? supabase.from("assets").select("id, name, location, warranty_until").eq("id", t.asset_id).maybeSingle() : Promise.resolve({ data: null }),
    manage ? getPeopleWith(ctx, ["maintenance.manage"]) : Promise.resolve([]),
  ]);
  const names = nameMap(await getNames([t.reported_by, t.assigned_to, t.resolved_by, t.verified_by]));
  let photoUrl: string | null = null;
  if (t.photo_path) {
    const { data: signed } = await supabase.storage.from("ordivia-files").createSignedUrl(t.photo_path, 600);
    photoUrl = signed?.signedUrl ?? null;
  }
  const actions = ticketActions(t.status, { manage, reporter: t.reported_by === ctx.userId });
  const where = point ? pointLabel(point as { kind: string; label: string }) : t.location_text;

  const steps: [string, string | null, string | null][] = [
    ["Segnalato", t.created_at, t.reported_by],
    ["Assegnato", t.assigned_at, t.assigned_to],
    ["Iniziato", t.started_at, null],
    ["In attesa ricambi", t.waiting_parts_at, null],
    ["Risolto", t.resolved_at, t.resolved_by],
    ["Verificato", t.verified_at, t.verified_by],
    ["Annullato", t.cancelled_at, null],
  ];

  return (
    <div>
      <LiveRefresh tables={["maintenance_tickets"]} facilityId={ctx.facility.id} />
      <PageHeader
        title={`#${t.number} · ${where ?? "Intervento"}`}
        subtitle={`${TICKET_CATEGORIES[t.category] ?? t.category} · ${SOURCE_LABEL[t.source] ?? t.source}${t.planned_for ? ` del ${formatDate(t.planned_for, tz)}` : ""}`}
        action={
          <div className="flex gap-2">
            <PriorityBadge priority={t.priority} />
            <TicketStatusBadge status={t.status} />
          </div>
        }
      />
      <MaintenanceTabs ctx={ctx} active="interventi" />
      {sp.nuovo && (
        <div className="mb-4">
          <Notice tone="ok">Segnalazione inviata: la manutenzione la vede subito.</Notice>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          <Card className="p-4">
            <p className="whitespace-pre-line text-[1.05rem] text-ink">{t.description}</p>
            {asset && (
              <p className="mt-2 text-sm text-muted">
                Impianto: <span className="font-bold text-night">{asset.name as string}</span>
                {asset.location ? ` · ${asset.location as string}` : ""}
                {asset.warranty_until ? ` · garanzia fino al ${formatDate(asset.warranty_until as string, tz)}` : ""}
              </p>
            )}
            {t.guest_request_id && (
              <Link href={`/ospiti/richieste?r=${t.guest_request_id}`} className="mt-2 inline-block text-sm font-bold text-teal-deep">
                Vai alla richiesta dell'ospite
              </Link>
            )}
            {photoUrl && (
              <a href={photoUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl} alt="Foto del guasto" className="max-h-72 rounded-xl object-cover" />
              </a>
            )}
            {t.resolution_note && (
              <div className="mt-3 rounded-xl bg-warm p-3 text-sm">
                <p className="text-xs font-bold text-muted uppercase">Note dell'intervento</p>
                <p className="whitespace-pre-line text-ink">{t.resolution_note}</p>
              </div>
            )}
            {!t.photo_path && (t.reported_by === ctx.userId || manage) && !["verificato", "annullato"].includes(t.status) && (
              <ActionForm action={addTicketPhoto} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="ticket_id" value={t.id} />
                <Field label="Aggiungi una foto">
                  <Input name="photo" type="file" accept="image/*" capture="environment" required className="py-2" />
                </Field>
                <SubmitButton variant="secondary" pendingText="Carico…">
                  Carica
                </SubmitButton>
              </ActionForm>
            )}
          </Card>

          {actions.length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader title="Avanza" />
              <div className="space-y-3 p-4">
                {actions.includes("assegna") && (
                  <ActionForm action={ticketTransition} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="ticket_id" value={t.id} />
                    <input type="hidden" name="action" value="assegna" />
                    <Field label={t.assigned_to ? "Riassegna a" : "Assegna a"}>
                      <Select name="assignee" defaultValue={t.assigned_to ?? ""} required className="min-w-48">
                        <option value="" disabled>
                          Scegli…
                        </option>
                        {techs.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.id === ctx.userId ? " (io)" : ""}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <SubmitButton variant="secondary" pendingText="…">
                      Assegna
                    </SubmitButton>
                  </ActionForm>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  {(["inizia", "riprendi"] as const)
                    .filter((a) => actions.includes(a))
                    .map((a) => (
                      <ActionForm key={a} action={ticketTransition}>
                        <input type="hidden" name="ticket_id" value={t.id} />
                        <input type="hidden" name="action" value={a} />
                        <SubmitButton full className="min-h-12" pendingText="…">
                          {a === "inizia" ? "Inizia intervento" : "Riprendi intervento"}
                        </SubmitButton>
                      </ActionForm>
                    ))}
                  {actions.includes("attesa_ricambi") && (
                    <ActionForm action={ticketTransition} className="space-y-2">
                      <input type="hidden" name="ticket_id" value={t.id} />
                      <input type="hidden" name="action" value="attesa_ricambi" />
                      <Input name="note" maxLength={2000} placeholder="Ricambio ordinato (facoltativo)" />
                      <SubmitButton full variant="secondary" pendingText="…">
                        In attesa ricambi
                      </SubmitButton>
                    </ActionForm>
                  )}
                </div>
                {actions.includes("risolvi") && (
                  <ActionForm action={ticketTransition} className="space-y-2 rounded-xl border border-sand p-3">
                    <input type="hidden" name="ticket_id" value={t.id} />
                    <input type="hidden" name="action" value="risolvi" />
                    <Field label="Cosa è stato fatto">
                      <Textarea name="note" required maxLength={2000} rows={2} placeholder="Es. sostituita guarnizione" />
                    </Field>
                    <SubmitButton full className="min-h-12 bg-ok hover:bg-ok/90" pendingText="…">
                      Segna come risolto
                    </SubmitButton>
                  </ActionForm>
                )}
                {actions.includes("verifica") && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <ActionForm action={ticketTransition}>
                      <input type="hidden" name="ticket_id" value={t.id} />
                      <input type="hidden" name="action" value="verifica" />
                      <SubmitButton full className="min-h-12" pendingText="…">
                        Funziona: chiudi
                      </SubmitButton>
                    </ActionForm>
                    <ActionForm action={ticketTransition} className="flex gap-2">
                      <input type="hidden" name="ticket_id" value={t.id} />
                      <input type="hidden" name="action" value="riapri" />
                      <Input name="note" maxLength={2000} placeholder="Cosa non va ancora" className="min-w-0 flex-1" />
                      <SubmitButton variant="secondary" pendingText="…">
                        Riapri
                      </SubmitButton>
                    </ActionForm>
                  </div>
                )}
                {actions.includes("annulla") && (
                  <details>
                    <summary className="cursor-pointer text-sm font-bold text-danger">Annulla intervento</summary>
                    <ActionForm action={ticketTransition} className="mt-2 flex gap-2">
                      <input type="hidden" name="ticket_id" value={t.id} />
                      <input type="hidden" name="action" value="annulla" />
                      <Input name="note" maxLength={2000} placeholder="Motivo" className="min-w-0 flex-1" />
                      <SubmitButton variant="danger" pendingText="…" confirm="Annullare l'intervento?">
                        Annulla
                      </SubmitButton>
                    </ActionForm>
                  </details>
                )}
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit overflow-hidden">
          <CardHeader title="Passaggi" hint={["verificato", "annullato"].includes(t.status) ? undefined : `Aperto da ${elapsedLabel(t.created_at)}`} />
          <ol className="space-y-2 p-4 text-sm">
            {steps
              .filter(([, at]) => at)
              .map(([label, at, who]) => (
                <li key={label} className="flex justify-between gap-3">
                  <span className="font-bold text-night">
                    {label}
                    {who && <span className="block text-xs font-normal text-muted">{names.get(who) ?? "—"}</span>}
                  </span>
                  <span className="text-right text-muted">{formatDateTime(at, tz)}</span>
                </li>
              ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
