import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDateTime, formatQty } from "@/lib/format";
import { MOVEMENT_LABEL } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Movimenti di magazzino" };
export const dynamic = "force-dynamic";

export default async function MovementsPage() {
  const ctx = await requirePerm("inventory.view");
  const supabase = await createClient();
  const { data } = await supabase
    .from("stock_movements")
    .select("id, qty, kind, note, lot, expires_on, created_at, created_by, products(name, base_unit), warehouses(name)")
    .eq("facility_id", ctx.facility.id)
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as unknown as {
    id: number; qty: number; kind: string; note: string | null; lot: string | null; expires_on: string | null; created_at: string; created_by: string | null;
    products: { name: string; base_unit: string } | null; warehouses: { name: string } | null;
  }[];
  const authorIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))] as string[];
  const { data: people } = authorIds.length ? await supabase.from("profiles").select("id, full_name").in("id", authorIds) : { data: [] };
  const who = new Map((people ?? []).map((p) => [p.id, p.full_name]));

  return (
    <div>
      <PageHeader title="Movimenti" subtitle="Registro immutabile: ogni giacenza è la somma di queste righe." action={<LinkButton href="/scorte" variant="secondary">Scorte</LinkButton>} />
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title="Nessun movimento" />
        ) : (
          rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 border-b border-sand px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="font-bold text-night">
                  {r.products?.name} <span className="font-normal text-muted">· {r.warehouses?.name}</span>
                </p>
                <p className="text-sm text-muted">
                  {formatDateTime(r.created_at, ctx.facility.timezone)} · {who.get(r.created_by ?? "") ?? "Sistema"}
                  {r.lot && ` · lotto ${r.lot}`}
                  {r.note && ` · ${r.note}`}
                </p>
              </div>
              <Badge tone={r.kind === "carico" ? "ok" : r.kind === "spreco" || r.kind === "scaduto" ? "danger" : "neutral"}>{MOVEMENT_LABEL[r.kind]}</Badge>
              <span className={`w-24 text-right font-extrabold ${Number(r.qty) < 0 ? "text-danger" : "text-ok"}`}>
                {Number(r.qty) > 0 ? "+" : ""}
                {formatQty(r.qty, r.products?.base_unit)}
              </span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
