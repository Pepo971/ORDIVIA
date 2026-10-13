import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Registro operazioni" };
export const dynamic = "force-dynamic";

const ENTITY: Record<string, string> = {
  organizations: "Azienda", facilities: "Struttura", departments: "Reparto", roles: "Ruolo", memberships: "Membro", invitations: "Invito",
  stations: "Postazione", products: "Prodotto", warehouses: "Magazzino", stock_settings: "Scorta minima", suppliers: "Fornitore",
  supplier_products: "Listino", purchase_requests: "Richiesta", purchase_orders: "Ordine", purchase_order_lines: "Riga ordine",
  receipts: "Ricezione", tasks: "Attività",
};
const ACTION: Record<string, string> = { insert: "creato", update: "modificato", delete: "eliminato" };

function describeChange(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before || !after) {
    const r = after ?? before ?? {};
    return String(r.name ?? r.title ?? r.number ?? r.email ?? "");
  }
  const skip = new Set(["updated_at", "created_at"]);
  const changed = Object.keys(after).filter((k) => !skip.has(k) && JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  const label = String(after.name ?? after.title ?? after.number ?? "");
  return `${label}${label ? " · " : ""}${changed.slice(0, 4).map((k) => `${k}: ${fmt(before[k])} → ${fmt(after[k])}`).join(", ")}`;
}
const fmt = (v: unknown) => (v == null ? "—" : typeof v === "object" ? "…" : String(v).slice(0, 40));

export default async function AuditPage() {
  const ctx = await requirePerm("audit.view");
  const supabase = await createClient();
  const { data } = await supabase
    .from("audit_log")
    .select("id, actor_id, station_id, action, entity, entity_id, before, after, at, facility_id")
    .eq("org_id", ctx.org.id)
    .order("at", { ascending: false })
    .limit(200);
  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))] as string[];
  const { data: people } = ids.length ? await supabase.from("profiles").select("id, full_name").in("id", ids) : { data: [] };
  const who = new Map((people ?? []).map((p) => [p.id, p.full_name]));
  const fac = new Map(ctx.facilities.map((f) => [f.id, f.name]));

  return (
    <div>
      <PageHeader title="Registro operazioni" subtitle="Chi, quando, in quale struttura, da quale postazione, cosa è cambiato. Non modificabile." action={<LinkButton href="/gestione" variant="secondary">Gestione</LinkButton>} />
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title="Nessuna operazione registrata" />
        ) : (
          rows.map((r) => (
            <div key={r.id} className="border-b border-sand px-4 py-3 text-sm last:border-b-0">
              <p>
                <strong className="text-night">{who.get(r.actor_id ?? "") ?? "Sistema"}</strong>{" "}
                <span className="text-muted">ha {ACTION[r.action] ?? r.action}</span> <strong className="text-night">{ENTITY[r.entity] ?? r.entity}</strong>
              </p>
              <p className="truncate text-muted">{describeChange(r.before as Record<string, unknown> | null, r.after as Record<string, unknown> | null)}</p>
              <p className="text-xs text-muted">
                {formatDateTime(r.at, ctx.facility.timezone)}
                {r.facility_id && ` · ${fac.get(r.facility_id) ?? "altra struttura"}`}
                {r.station_id && " · da postazione"}
              </p>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
