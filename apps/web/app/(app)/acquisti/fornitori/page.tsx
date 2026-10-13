import { Badge, Card, EmptyState, LinkButton, PageHeader, Row } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatTime, WEEKDAY_LABELS } from "@/lib/format";
import { getSuppliers, supplierWindow } from "@/lib/queries";

export const metadata = { title: "Fornitori" };
export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const ctx = await requirePerm("suppliers.manage", "purchasing.approve");
  const suppliers = await getSuppliers(ctx.org.id);
  const tz = ctx.facility.timezone;
  return (
    <div>
      <PageHeader
        title="Fornitori"
        subtitle="Listini, giorni di consegna e ora limite: la base per ricordarti quando ordinare."
        action={can(ctx, "suppliers.manage") ? <LinkButton href="/acquisti/fornitori/nuovo">Nuovo fornitore</LinkButton> : undefined}
      />
      <Card className="overflow-hidden">
        {suppliers.length === 0 ? (
          <EmptyState title="Nessun fornitore" text="Inizia da quello a cui ordini più spesso." action={<LinkButton href="/acquisti/fornitori/nuovo">Aggiungi fornitore</LinkButton>} />
        ) : (
          suppliers.map((s) => {
            const w = s.active ? supplierWindow(s, tz) : null;
            return (
              <Row key={s.id} href={`/acquisti/fornitori/${s.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-night">{s.name}</p>
                  <p className="text-sm text-muted">
                    Consegna {s.delivery_weekdays.map((d) => WEEKDAY_LABELS[d - 1]).join(", ")} · ordine entro le {s.cutoff_time.slice(0, 5)}
                  </p>
                </div>
                {!s.active ? (
                  <Badge tone="danger">Non attivo</Badge>
                ) : w ? (
                  <span className="text-right text-sm">
                    <span className="block font-bold text-night">{formatDate(w.orderBy, tz)} {formatTime(w.orderBy, tz)}</span>
                    <span className="text-xs text-muted">prossimo cut-off</span>
                  </span>
                ) : null}
              </Row>
            );
          })
        )}
      </Card>
    </div>
  );
}
