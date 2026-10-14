import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Card, CardHeader, EmptyState, LinkButton, PageHeader, cx } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatEur } from "@/lib/format";
import { getMenu, getPrepStations } from "@/lib/pos-queries";
import { setAvailability } from "../actions";

export const metadata = { title: "Esauriti e porzioni" };
export const dynamic = "force-dynamic";

export default async function DisponibilitaPage({ searchParams }: { searchParams: Promise<{ centro?: string }> }) {
  const ctx = await requirePerm("pos.kitchen", "menu.manage");
  const sp = await searchParams;
  const [{ items, categories }, stations] = await Promise.all([getMenu(ctx.facility.id), getPrepStations(ctx.facility.id)]);
  const station = sp.centro === "tutti" ? undefined : stations.find((s) => s.id === sp.centro);
  const shown = station ? items.filter((i) => i.prep_station_id === station.id) : items;
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const groups = new Map<string, typeof shown>();
  for (const i of shown) {
    const k = (i.category_id && catName.get(i.category_id)) || "Altro";
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const outCount = shown.filter((i) => !i.available || i.portions_left === 0).length;

  return (
    <div>
      <LiveRefresh tables={["menu_items"]} facilityId={ctx.facility.id} intervalMs={0} />
      <PageHeader
        title="Esauriti e porzioni"
        subtitle={`${outCount} esauriti. La sala vede i cambiamenti in tempo reale.`}
        action={<LinkButton href={`/servizio/cucina${station ? `?centro=${station.id}` : ""}`} variant="secondary">Torna al KDS</LinkButton>}
      />
      {stations.length > 1 && (
        <nav className="mb-4 flex gap-2 overflow-x-auto" aria-label="Centro di produzione">
          <Pill href="/servizio/cucina/disponibilita?centro=tutti" active={!station}>Tutti</Pill>
          {stations.map((s) => (
            <Pill key={s.id} href={`/servizio/cucina/disponibilita?centro=${s.id}`} active={s.id === station?.id}>{s.name}</Pill>
          ))}
        </nav>
      )}
      {shown.length === 0 ? (
        <Card><EmptyState title="Nessun piatto" text="Non ci sono piatti attivi per questo centro di produzione." /></Card>
      ) : (
        [...groups].map(([name, list]) => (
          <Card key={name} className="mb-4 overflow-hidden">
            <CardHeader title={name} />
            <ul className="divide-y divide-sand">
              {list.map((i) => {
                const out = !i.available || i.portions_left === 0;
                return (
                  <li key={i.id} className={cx("px-4 py-3", out && "bg-danger-soft/50")}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className={cx("font-bold", out ? "text-danger line-through" : "text-night")}>{i.name}</p>
                      <span className="text-sm text-muted">
                        {formatEur(i.price)} · {out ? <strong className="text-danger">esaurito</strong> : i.portions_left != null ? <strong className="text-warn">{i.portions_left} porzioni</strong> : "senza limite"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionForm action={setAvailability}>
                        <input type="hidden" name="item_id" value={i.id} />
                        <input type="hidden" name="mode" value={out ? "disponibile" : "esaurito"} />
                        <SubmitButton variant={out ? "primary" : "danger"} pendingText="…" className="min-h-11">
                          {out ? "Disponibile" : "Esaurito"}
                        </SubmitButton>
                      </ActionForm>
                      <ActionForm action={setAvailability} className="flex items-center gap-2">
                        <input type="hidden" name="item_id" value={i.id} />
                        <input type="hidden" name="mode" value="porzioni" />
                        <input
                          name="portions"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={10000}
                          defaultValue={i.portions_left ?? ""}
                          placeholder="porz."
                          aria-label={`Porzioni rimaste di ${i.name}`}
                          className="h-11 w-20 rounded-xl border border-sand-deep px-2 text-center font-bold"
                        />
                        <SubmitButton variant="secondary" pendingText="…" className="min-h-11">Imposta</SubmitButton>
                      </ActionForm>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}

function Pill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cx("flex min-h-11 items-center rounded-full border px-4 text-sm font-bold whitespace-nowrap", active ? "border-night bg-night text-warm" : "border-sand-deep bg-white text-night")}>
      {children}
    </Link>
  );
}
