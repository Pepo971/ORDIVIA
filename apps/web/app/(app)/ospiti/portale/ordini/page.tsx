import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, EmptyState, Input, PageHeader } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatEur, formatTime, relativeFromNow } from "@/lib/format";
import { getPortalSubmissions } from "@/lib/portal-queries";
import { acceptSubmission, rejectSubmission } from "../actions";
import { PortalNav } from "../portal-nav";

export const metadata = { title: "Ordini dal QR" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "warn" | "ok" | "danger" }> = {
  da_confermare: { label: "Da confermare", tone: "warn" },
  accettato: { label: "Accettato", tone: "ok" },
  rifiutato: { label: "Rifiutato", tone: "danger" },
};

export default async function PortalOrdersPage() {
  const ctx = await requirePerm("pos.operate", "portal.manage");
  const subs = await getPortalSubmissions(ctx.facility.id, 40);
  const tz = ctx.facility.timezone;
  const pending = subs.filter((s) => s.status === "da_confermare");
  const done = subs.filter((s) => s.status !== "da_confermare").slice(0, 15);
  const canOperate = can(ctx, "pos.operate");

  return (
    <div>
      <LiveRefresh tables={["portal_submissions"]} facilityId={ctx.facility.id} intervalMs={20000} />
      <PageHeader title="Ordini dal QR" subtitle="Gli ospiti ordinano dal QR del punto: controlla e accetta per mandare in cucina e al bar. Il conto si paga in sala o in cassa." />
      <PortalNav active="ordini" pending={pending.length} canManage={can(ctx, "portal.manage")} />

      {pending.length === 0 ? (
        <Card className="mb-6">
          <EmptyState title="Nessun ordine da confermare" text="Quando un ospite ordina dal QR lo vedi qui (e nella comanda del suo tavolo o ombrellone)." />
        </Card>
      ) : (
        <div className="mb-6 space-y-3">
          {pending.map((s) => (
            <Card key={s.id} className="border-warn/50">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-sand px-4 py-3">
                <div>
                  <p className="text-lg font-bold text-night">
                    {s.destination_label ?? "Punto non più disponibile"} <Badge tone="teal">online</Badge>
                  </p>
                  <p className="text-sm text-muted">
                    {formatTime(s.created_at, tz)} · {relativeFromNow(new Date(s.created_at))}
                    {s.guest_name && <> · {s.guest_name}</>}
                    {s.lang === "en" && <> · in inglese</>}
                  </p>
                </div>
                <p className="text-lg font-bold text-night">{formatEur(s.total)}</p>
              </div>
              <ul className="px-4 py-2 text-sm">
                {s.lines.map((l) => (
                  <li key={l.id} className="py-1">
                    <strong>{l.qty}×</strong> {l.name}
                    {l.notes && <span className="block pl-6 text-muted">«{l.notes}»</span>}
                  </li>
                ))}
              </ul>
              {(s.allergies || s.notes) && (
                <div className="space-y-1 px-4 pb-3 text-sm">
                  {s.allergies && <p className="rounded-lg bg-danger-soft px-3 py-2 font-bold text-danger">Allergie: {s.allergies}</p>}
                  {s.notes && <p className="rounded-lg bg-sand px-3 py-2">Note: {s.notes}</p>}
                </div>
              )}
              {canOperate && (
                <div className="flex flex-wrap items-start gap-2 border-t border-sand px-4 py-3">
                  <ActionForm action={acceptSubmission}>
                    <input type="hidden" name="id" value={s.id} />
                    <SubmitButton pendingText="Invio…">Accetta e invia</SubmitButton>
                  </ActionForm>
                  <details className="min-w-0 flex-1">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center px-2 font-bold text-danger">Rifiuta…</summary>
                    <ActionForm action={rejectSubmission} className="mt-2 flex flex-wrap gap-2">
                      <input type="hidden" name="id" value={s.id} />
                      <Input name="reason" required minLength={3} maxLength={300} placeholder="Motivo (es. cucina chiusa)" className="min-w-0 flex-1" />
                      <SubmitButton variant="danger" pendingText="…">Rifiuta</SubmitButton>
                    </ActionForm>
                  </details>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <Card className="overflow-hidden">
          <h2 className="border-b border-sand px-4 py-3 text-[0.95rem] font-bold text-night">Gestiti di recente</h2>
          <ul className="divide-y divide-sand text-sm">
            {done.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="font-bold text-night">{s.destination_label ?? "—"}</span>
                <span className="text-muted">{formatTime(s.created_at, tz)}</span>
                <span className="text-muted">{s.lines.reduce((n, l) => n + l.qty, 0)} pz · {formatEur(s.total)}</span>
                <span className="ml-auto"><Badge tone={STATUS[s.status]?.tone ?? "warn"}>{STATUS[s.status]?.label ?? s.status}</Badge></span>
                {s.reject_reason && <span className="w-full text-xs text-muted">Motivo: {s.reject_reason}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
