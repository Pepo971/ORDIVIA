import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, EmptyState, LinkButton, Notice, PageHeader, Row, Tabs } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatDateTime, formatEur } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { PO_STATUS, REQ_STATUS } from "@/lib/labels";
import { convertRequests, rejectRequest } from "./actions";

export const metadata = { title: "Acquisti" };
export const dynamic = "force-dynamic";

export default async function AcquistiPage({ searchParams }: { searchParams: Promise<{ tab?: string; inviata?: string; creati?: string }> }) {
  const ctx = await requirePerm("purchasing.request", "purchasing.approve", "suppliers.manage", "receiving.perform");
  const sp = await searchParams;
  const supabase = await createClient();
  const tz = ctx.facility.timezone;
  const isApprover = can(ctx, "purchasing.approve");
  const canSeeOrders = isApprover || can(ctx, "purchasing.send", "receiving.perform");
  const canRequest = can(ctx, "purchasing.request");
  const tab = sp.tab ?? (canSeeOrders ? "ordini" : "richieste");

  const [ordersRes, reqRes, totalsRes] = await Promise.all([
    canSeeOrders
      ? supabase
          .from("purchase_orders")
          .select("id, number, status, expected_delivery, created_at, sent_at, suppliers(name)")
          .eq("facility_id", ctx.facility.id)
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [] }),
    supabase
      .from("purchase_requests")
      .select("id, status, created_at, note, needed_by, department_id, requested_by, purchase_request_lines(qty, products(name, base_unit))")
      .eq("facility_id", ctx.facility.id)
      .order("created_at", { ascending: false })
      .limit(100),
    isApprover ? supabase.from("purchase_order_totals").select("order_id, total, lines").eq("org_id", ctx.org.id) : Promise.resolve({ data: [] }),
  ]);

  const orders = (ordersRes.data ?? []) as unknown as { id: string; number: string; status: string; expected_delivery: string | null; created_at: string; suppliers: { name: string } | null }[];
  const totals = new Map(((totalsRes.data ?? []) as { order_id: string; total: number; lines: number }[]).map((t) => [t.order_id, t]));
  const requests = (reqRes.data ?? []) as unknown as {
    id: string; status: string; created_at: string; note: string | null; needed_by: string | null; department_id: string | null;
    purchase_request_lines: { qty: number; products: { name: string; base_unit: string } | null }[];
  }[];
  const pending = requests.filter((r) => r.status === "inviata");
  const openOrders = orders.filter((o) => !["ricevuto", "annullato"].includes(o.status));

  const tabs = [
    ...(canSeeOrders ? [{ key: "ordini", label: "Ordini", href: "/acquisti?tab=ordini", count: openOrders.length }] : []),
    { key: "richieste", label: "Richieste", href: "/acquisti?tab=richieste", count: isApprover ? pending.length : undefined },
    ...(can(ctx, "suppliers.manage", "purchasing.approve") ? [{ key: "fornitori", label: "Fornitori", href: "/acquisti/fornitori" }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Acquisti"
        subtitle="Richieste dei reparti, ordini ai fornitori e consegne."
        action={
          <div className="flex gap-2">
            {canRequest && <LinkButton href="/acquisti/richieste/nuova" variant={isApprover ? "secondary" : "primary"}>Nuova richiesta</LinkButton>}
            {isApprover && <LinkButton href="/acquisti/riordino">Riordino</LinkButton>}
          </div>
        }
      />
      <Tabs items={tabs} active={tab} />
      {sp.inviata && <div className="mb-4"><Notice tone="ok">Richiesta inviata al responsabile acquisti.</Notice></div>}
      {sp.creati && <div className="mb-4"><Notice tone="ok">Creati {sp.creati} ordini in bozza, uno per fornitore.</Notice></div>}

      {tab === "ordini" && canSeeOrders && (
        <Card className="overflow-hidden">
          {orders.length === 0 ? (
            <EmptyState
              title="Nessun ordine"
              text={isApprover ? "Parti dal riordino: Ordivia propone cosa ordinare in base alle scorte minime." : "Qui compaiono gli ordini in arrivo da ricevere."}
              action={isApprover ? <LinkButton href="/acquisti/riordino">Apri il riordino</LinkButton> : undefined}
            />
          ) : (
            orders.map((o) => {
              const st = PO_STATUS[o.status]!;
              const t = totals.get(o.id);
              return (
                <Row key={o.id} href={`/acquisti/ordini/${o.id}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-night">{o.suppliers?.name ?? "Fornitore"}</p>
                    <p className="text-sm text-muted">
                      {o.number} · {o.expected_delivery ? `consegna ${formatDate(o.expected_delivery, tz)}` : `creato ${formatDateTime(o.created_at, tz)}`}
                      {t ? ` · ${t.lines} righe` : ""}
                    </p>
                  </div>
                  {t && <span className="hidden text-sm font-bold text-night sm:block">{formatEur(t.total)}</span>}
                  <Badge tone={st.tone}>{st.label}</Badge>
                </Row>
              );
            })
          )}
        </Card>
      )}

      {tab === "richieste" && (
        <Card className="overflow-hidden">
          {requests.length === 0 ? (
            <EmptyState
              title="Nessuna richiesta"
              text="I reparti chiedono qui ciò che serve; il responsabile acquisti le unisce in ordini ai fornitori."
              action={canRequest ? <LinkButton href="/acquisti/richieste/nuova">Nuova richiesta</LinkButton> : undefined}
            />
          ) : (
            <ActionForm action={convertRequests}>
              {requests.map((r) => {
                const st = REQ_STATUS[r.status]!;
                const dep = ctx.departments.find((d) => d.id === r.department_id)?.name ?? "Senza reparto";
                const selectable = isApprover && r.status === "inviata";
                return (
                  <div key={r.id} className="flex items-start gap-3 border-b border-sand px-4 py-3 last:border-b-0">
                    {selectable ? (
                      <input type="checkbox" name="request_id" value={r.id} defaultChecked className="mt-1 h-5 w-5 min-h-0 accent-teal" aria-label={`Seleziona richiesta ${dep}`} />
                    ) : (
                      <span className="w-5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-night">
                        {dep} <span className="font-normal text-muted">· {formatDateTime(r.created_at, tz)}</span>
                      </p>
                      <p className="text-sm text-muted">
                        {r.purchase_request_lines.map((l) => `${l.products?.name} ${Number(l.qty)} ${l.products?.base_unit}`).join(" · ")}
                      </p>
                      {r.note && <p className="mt-1 text-sm text-ink">“{r.note}”</p>}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {selectable && (
                        <button formAction={rejectRequest} name="id" value={r.id} className="min-h-0 text-xs font-bold text-danger underline-offset-4 hover:underline">
                          Rifiuta
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {isApprover && pending.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 bg-warm px-4 py-3">
                  <p className="text-sm text-muted">Le richieste selezionate diventano ordini in bozza, uno per fornitore (preferito o più conveniente).</p>
                  <SubmitButton pendingText="Creazione ordini…">Crea ordini</SubmitButton>
                </div>
              )}
            </ActionForm>
          )}
        </Card>
      )}
      {tab === "fornitori" && (
        <p className="text-muted">
          Vai a <Link href="/acquisti/fornitori" className="font-bold text-teal-deep underline">Fornitori</Link>.
        </p>
      )}
    </div>
  );
}
