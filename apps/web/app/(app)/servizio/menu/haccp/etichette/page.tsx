import Link from "next/link";
import { ALLERGEN_LABEL, expiryState, isAllergen } from "@ordivia/domain";
import { Badge, Card, cx, EmptyState, Input, LinkButton, PageHeader, Tabs } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDateTime, relativeFromNow } from "@/lib/format";
import { getLabels } from "@/lib/menu-queries";
import { MenuNav } from "../../menu-nav";

export const metadata = { title: "Etichette e lotti" };
export const dynamic = "force-dynamic";

export default async function LabelsPage({ searchParams }: { searchParams: Promise<{ stato?: string; lotto?: string }> }) {
  const ctx = await requirePerm("haccp.record", "menu.manage", "pos.kitchen");
  const sp = await searchParams;
  const lot = sp.lotto?.trim().slice(0, 60) || undefined;
  const status = lot ? undefined : sp.stato === "chiuse" ? "chiuse" : "attiva";
  const all = await getLabels(ctx.facility.id, { status: status === "attiva" ? "attiva" : undefined, lot, limit: 300 });
  const labels = status === "chiuse" ? all.filter((l) => l.status !== "attiva") : all;
  const now = new Date();
  const tz = ctx.facility.timezone;

  return (
    <div>
      <PageHeader
        title="Etichette e lotti"
        subtitle="Etichette di preparazione e apertura con lotto interno, scadenza e lotti delle materie prime."
        action={can(ctx, "haccp.record") ? <LinkButton href="/servizio/menu/haccp/etichette/nuova">Nuova etichetta</LinkButton> : undefined}
      />
      <MenuNav ctx={ctx} active="etichette" />

      <form className="mb-4 flex gap-2" action="/servizio/menu/haccp/etichette">
        <Input name="lotto" defaultValue={lot} placeholder="Rintraccia un lotto fornitore (es. VONG-778)" aria-label="Lotto da rintracciare" />
        <button className="rounded-xl bg-night px-4 font-bold text-warm">Cerca</button>
      </form>

      {lot ? (
        <p className="mb-3 text-sm text-muted">
          Preparazioni che contengono il lotto <strong className="text-night">{lot}</strong> · <Link href="/servizio/menu/haccp/etichette" className="font-bold underline">annulla</Link>
        </p>
      ) : (
        <Tabs
          active={status!}
          items={[
            { key: "attiva", label: "Attive", href: "/servizio/menu/haccp/etichette" },
            { key: "chiuse", label: "Consumate o scartate", href: "/servizio/menu/haccp/etichette?stato=chiuse" },
          ]}
        />
      )}

      <Card className="overflow-hidden">
        {labels.length === 0 ? (
          <EmptyState title={lot ? "Nessuna preparazione con questo lotto" : "Nessuna etichetta"} text={lot ? undefined : "Crea un'etichetta quando prepari o apri un prodotto."} />
        ) : (
          <ul className="divide-y divide-sand">
            {labels.map((l) => {
              const st = l.status === "attiva" ? expiryState(new Date(l.expires_at), now) : null;
              return (
                <li key={l.id}>
                  <Link href={`/servizio/menu/haccp/etichette/${l.id}`} className={cx("flex items-start gap-3 px-4 py-3 hover:bg-warm", st === "scaduta" && "bg-danger-soft/40")}>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                        {l.name}
                        <Badge tone="neutral">{l.kind === "apertura" ? "Apertura" : "Preparazione"}</Badge>
                        {l.status !== "attiva" && <Badge tone={l.status === "scartata" ? "danger" : "ok"}>{l.status === "scartata" ? "Scartata" : "Consumata"}</Badge>}
                      </p>
                      <p className="text-xs text-muted">
                        {l.lot_code} · {formatDateTime(l.kind === "apertura" ? l.opened_at : l.prepared_at, tz)} · {l.operator_name ?? "—"}
                        {l.allergens.length > 0 && ` · ${l.allergens.map((a) => (isAllergen(a) ? ALLERGEN_LABEL[a] : a)).join(", ")}`}
                      </p>
                      {l.source_lots.length > 0 && <p className="text-xs text-muted">Lotti: {l.source_lots.map((s) => s.lot).join(", ")}</p>}
                    </div>
                    <div className="text-right">
                      {st && <Badge tone={st === "scaduta" ? "danger" : st === "oggi" ? "warn" : st === "presto" ? "neutral" : "ok"}>{st === "scaduta" ? "Scaduta" : `Scade ${relativeFromNow(new Date(l.expires_at), now)}`}</Badge>}
                      <p className="mt-0.5 text-xs text-muted">{formatDateTime(l.expires_at, tz)}</p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
