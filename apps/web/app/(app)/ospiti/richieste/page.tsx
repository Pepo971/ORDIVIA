import Link from "next/link";
import {
  compareRoomLabels,
  elapsedLabel,
  GUEST_REQUEST_CATEGORY,
  GUEST_REQUEST_SOURCE,
  GUEST_REQUEST_STATUS,
  requestConversions,
  TICKET_CATEGORIES,
  TICKET_PRIORITY,
  type GuestRequestCategory,
  type GuestRequestStatus,
} from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Textarea, Tabs, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDateTime } from "@/lib/format";
import { getNames, nameMap } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { createGuestRequest, requestToHousekeeping, requestToTicket, setGuestRequestStatus } from "./actions";

export const metadata = { title: "Richieste ospiti" };
export const dynamic = "force-dynamic";

interface GuestRequest {
  id: string;
  service_point_id: string | null;
  customer_id: string | null;
  source: string;
  category: GuestRequestCategory;
  message: string;
  guest_name: string | null;
  guest_contact: string | null;
  status: GuestRequestStatus;
  assigned_to: string | null;
  created_by: string | null;
  taken_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

type View = "aperte" | "mie" | "chiuse";
const CATEGORY_KEYS = Object.keys(GUEST_REQUEST_CATEGORY) as GuestRequestCategory[];

/** Chi gestisce le richieste: stessi permessi di app.can_handle_guest_requests() nel database. */
const HANDLE_PERMS = ["rooms.operate", "rooms.manage", "pos.operate", "beach.operate", "reservations.manage", "maintenance.manage"];

export default async function RichiestePage({ searchParams }: { searchParams: Promise<{ vista?: string; cat?: string; punto?: string; r?: string }> }) {
  const ctx = await requirePerm(...HANDLE_PERMS);
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const view: View = sp.vista === "mie" || sp.vista === "chiuse" ? sp.vista : "aperte";
  const cat = CATEGORY_KEYS.includes(sp.cat as GuestRequestCategory) ? (sp.cat as GuestRequestCategory) : null;
  const point = sp.punto && /^[0-9a-f-]{36}$/i.test(sp.punto) ? sp.punto : null;
  const focus = sp.r && /^[0-9a-f-]{36}$/i.test(sp.r) ? sp.r : null;
  const canHk = can(ctx, "rooms.operate", "rooms.manage");
  const supabase = await createClient();

  let q = supabase
    .from("guest_requests")
    .select("id, service_point_id, customer_id, source, category, message, guest_name, guest_contact, status, assigned_to, created_by, taken_at, resolved_at, resolution_note, created_at")
    .eq("facility_id", ctx.facility.id);
  if (focus) q = q.eq("id", focus);
  else {
    if (view === "aperte") q = q.in("status", ["nuova", "presa_in_carico"]);
    if (view === "mie") q = q.eq("assigned_to", ctx.userId).in("status", ["nuova", "presa_in_carico"]);
    if (view === "chiuse") q = q.in("status", ["risolta", "annullata"]);
    if (cat) q = q.eq("category", cat);
    if (point) q = q.eq("service_point_id", point);
  }
  const [{ data }, { data: pointsData }, { data: openCounts }, { data: tickets }] = await Promise.all([
    q.order("created_at", { ascending: view === "chiuse" ? false : true }).limit(200),
    supabase.from("service_points").select("id, kind, label").eq("facility_id", ctx.facility.id).eq("active", true),
    supabase.from("guest_requests").select("status, assigned_to").eq("facility_id", ctx.facility.id).in("status", ["nuova", "presa_in_carico"]),
    supabase.from("maintenance_tickets").select("id, number, guest_request_id, status").eq("facility_id", ctx.facility.id).not("guest_request_id", "is", null),
  ]);
  const requests = (data ?? []) as GuestRequest[];
  // Le nuove in cima, poi quelle in carico; ognuna dalla più vecchia
  if (view !== "chiuse") requests.sort((a, b) => Number(a.status !== "nuova") - Number(b.status !== "nuova") || a.created_at.localeCompare(b.created_at));
  const points = ((pointsData ?? []) as { id: string; kind: string; label: string }[]).sort((a, b) => a.kind.localeCompare(b.kind) || compareRoomLabels(a.label, b.label));
  const pointBy = new Map(points.map((p) => [p.id, p]));
  const ticketBy = new Map((tickets ?? []).map((t) => [t.guest_request_id as string, t as { id: string; number: number; status: string }]));
  const names = nameMap(await getNames(requests.flatMap((r) => [r.assigned_to, r.created_by])));
  const oc = openCounts ?? [];
  const kinds = [...new Set(points.map((p) => p.kind))];
  const href = (v: View) => `/ospiti/richieste?vista=${v}${cat ? `&cat=${cat}` : ""}${point ? `&punto=${point}` : ""}`;

  return (
    <div>
      <LiveRefresh tables={["guest_requests"]} facilityId={ctx.facility.id} intervalMs={20000} />
      <PageHeader title="Richieste degli ospiti" subtitle="Dal portale QR o registrate dallo staff. Prendi in carico, risolvi o inoltra a manutenzione e housekeeping." />

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div>
          <Tabs
            active={focus ? "" : view}
            items={[
              { key: "aperte", label: "Aperte", href: href("aperte"), count: oc.length },
              { key: "mie", label: "In carico a me", href: href("mie"), count: oc.filter((r) => r.assigned_to === ctx.userId).length },
              { key: "chiuse", label: "Chiuse", href: href("chiuse") },
            ]}
          />
          <form action="/ospiti/richieste" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input type="hidden" name="vista" value={view} />
            <Select name="cat" defaultValue={cat ?? ""} aria-label="Categoria" className="min-h-11 py-2">
              <option value="">Tutte le categorie</option>
              {CATEGORY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {GUEST_REQUEST_CATEGORY[k]}
                </option>
              ))}
            </Select>
            <Select name="punto" defaultValue={point ?? ""} aria-label="Punto" className="min-h-11 py-2">
              <option value="">Tutti i punti</option>
              {points.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.kind} {p.label}
                </option>
              ))}
            </Select>
            <button className="col-span-2 min-h-11 rounded-xl bg-night px-4 text-sm font-bold text-warm sm:col-span-1">Filtra</button>
          </form>
          {focus && (
            <Link href="/ospiti/richieste" className="mb-3 inline-block text-sm font-bold text-teal-deep">
              ← Tutte le richieste
            </Link>
          )}

          {requests.length === 0 ? (
            <Card>
              <EmptyState title={view === "chiuse" ? "Nessuna richiesta chiusa" : "Nessuna richiesta aperta"} text={view === "aperte" ? "Le richieste dal portale QR arrivano qui in tempo reale." : undefined} />
            </Card>
          ) : (
            <div className="space-y-3">
              {requests.map((r) => {
                const p = r.service_point_id ? pointBy.get(r.service_point_id) : null;
                const st = GUEST_REQUEST_STATUS[r.status];
                const open = r.status === "nuova" || r.status === "presa_in_carico";
                const conv = requestConversions(r.category, r.status);
                const ticket = ticketBy.get(r.id);
                return (
                  <Card key={r.id} id={r.id} className={cx("p-4", r.status === "nuova" && "border-warn/60", r.category === "reclamo" && open && "border-danger/50")}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {p && <span className="rounded-lg bg-night px-2 py-0.5 text-sm font-extrabold text-warm">{p.label}</span>}
                      <span className="font-bold text-night">{GUEST_REQUEST_CATEGORY[r.category]}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      <Badge>{GUEST_REQUEST_SOURCE[r.source] ?? r.source}</Badge>
                    </div>
                    <p className="mt-2 text-[1.05rem] whitespace-pre-line text-ink">{r.message}</p>
                    <p className="mt-1 text-xs text-muted">
                      {r.guest_name && `${r.guest_name} · `}
                      {r.guest_contact && `${r.guest_contact} · `}
                      {open ? `${elapsedLabel(r.created_at)} fa` : formatDateTime(r.created_at, tz)}
                      {r.assigned_to && ` · in carico a ${names.get(r.assigned_to) ?? "—"}`}
                      {r.resolved_at && ` · chiusa ${formatDateTime(r.resolved_at, tz)}`}
                    </p>
                    {r.resolution_note && <p className="mt-1 text-sm font-semibold text-night">«{r.resolution_note}»</p>}
                    {ticket && (
                      <Link href={`/servizio/manutenzione/${ticket.id}`} className="mt-1 inline-block text-sm font-bold text-teal-deep">
                        Intervento #{ticket.number} ({ticket.status.replace(/_/g, " ")})
                      </Link>
                    )}

                    {open && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(r.status === "nuova" || r.assigned_to !== ctx.userId) && (
                          <ActionForm action={setGuestRequestStatus}>
                            <input type="hidden" name="request_id" value={r.id} />
                            <input type="hidden" name="to" value="presa_in_carico" />
                            <SubmitButton variant={r.status === "nuova" ? "primary" : "secondary"} pendingText="…">
                              {r.status === "nuova" ? "Prendo io" : "Prendo in carico io"}
                            </SubmitButton>
                          </ActionForm>
                        )}
                        <details className="w-full sm:w-auto">
                          <summary className="flex min-h-11 cursor-pointer items-center rounded-xl bg-ok px-4 font-bold text-white">Risolvi…</summary>
                          <ActionForm action={setGuestRequestStatus} className="mt-2 flex gap-2">
                            <input type="hidden" name="request_id" value={r.id} />
                            <input type="hidden" name="to" value="risolta" />
                            <Input name="note" maxLength={1000} placeholder="Cosa è stato fatto (facoltativo)" className="min-w-0 flex-1" />
                            <SubmitButton pendingText="…">Fatto</SubmitButton>
                          </ActionForm>
                        </details>
                        {conv.includes("intervento") && !ticket && (
                          <details className="w-full sm:w-auto">
                            <summary className="flex min-h-11 cursor-pointer items-center rounded-xl border border-sand-deep bg-white px-4 font-bold text-night">Alla manutenzione…</summary>
                            <ActionForm action={requestToTicket} className="mt-2 grid grid-cols-2 gap-2">
                              <input type="hidden" name="request_id" value={r.id} />
                              <Select name="category" defaultValue="altro" aria-label="Tipo di guasto">
                                {Object.entries(TICKET_CATEGORIES).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                              </Select>
                              <Select name="priority" defaultValue={r.category === "reclamo" ? "alta" : "media"} aria-label="Priorità">
                                {Object.entries(TICKET_PRIORITY).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v.label}
                                  </option>
                                ))}
                              </Select>
                              <div className="col-span-2">
                                <SubmitButton full variant="secondary" pendingText="…">
                                  Crea intervento
                                </SubmitButton>
                              </div>
                            </ActionForm>
                          </details>
                        )}
                        {conv.includes("housekeeping") && canHk && (
                          <ActionForm action={requestToHousekeeping}>
                            <input type="hidden" name="request_id" value={r.id} />
                            <SubmitButton variant="secondary" pendingText="…">
                              All&apos;housekeeping
                            </SubmitButton>
                          </ActionForm>
                        )}
                        <details className="w-full sm:w-auto">
                          <summary className="flex min-h-11 cursor-pointer items-center px-2 text-sm font-bold text-danger">Annulla…</summary>
                          <ActionForm action={setGuestRequestStatus} className="mt-2 flex gap-2">
                            <input type="hidden" name="request_id" value={r.id} />
                            <input type="hidden" name="to" value="annullata" />
                            <Input name="note" required maxLength={1000} placeholder="Motivo" className="min-w-0 flex-1" />
                            <SubmitButton variant="danger" pendingText="…">
                              Annulla
                            </SubmitButton>
                          </ActionForm>
                        </details>
                      </div>
                    )}
                    {!open && (
                      <ActionForm action={setGuestRequestStatus} className="mt-2">
                        <input type="hidden" name="request_id" value={r.id} />
                        <input type="hidden" name="to" value="presa_in_carico" />
                        <SubmitButton variant="ghost" pendingText="…">
                          Riapri
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        <Card className="overflow-hidden lg:sticky lg:top-4">
          <CardHeader title="Registra una richiesta" hint="Per conto dell'ospite (telefono, banco, WhatsApp)" />
          <ActionForm action={createGuestRequest} resetOnSuccess className="space-y-3 p-4">
            <Field label="Richiesta">
              <Textarea name="message" required maxLength={1000} rows={3} placeholder="Es. servono due cuscini in più" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Categoria">
                <Select name="category" defaultValue="assistenza">
                  {CATEGORY_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {GUEST_REQUEST_CATEGORY[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Canale">
                <Select name="source" defaultValue="telefono">
                  <option value="telefono">Telefono</option>
                  <option value="staff">Di persona</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                </Select>
              </Field>
            </div>
            <Field label="Camera / punto">
              <Select name="service_point_id" defaultValue="">
                <option value="">—</option>
                {kinds.map((k) => (
                  <optgroup key={k} label={k.charAt(0).toUpperCase() + k.slice(1)}>
                    {points
                      .filter((p) => p.kind === k)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Ospite">
                <Input name="guest_name" maxLength={160} placeholder="Nome" />
              </Field>
              <Field label="Contatto">
                <Input name="guest_contact" maxLength={160} placeholder="Telefono" />
              </Field>
            </div>
            <SubmitButton full pendingText="Registro…">
              Registra
            </SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
