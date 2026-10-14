import Link from "next/link";
import { redirect } from "next/navigation";
import { ALLERGEN_LABEL, isAllergen, MENU_COURSES } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, cx, EmptyState, Field, Input, LinkButton, PageHeader } from "@/components/ui";
import { can, getContext } from "@/lib/context";
import { formatEur } from "@/lib/format";
import { getCategories, getFoodCost, getMenuItems, getPrepStations, type FoodCostRow } from "@/lib/menu-queries";
import { createCategory, deleteCategory, updateCategory } from "./actions";
import { fmtPct, MenuNav } from "./menu-nav";

export const metadata = { title: "Menu e ricette" };
export const dynamic = "force-dynamic";

export default async function MenuPage({ searchParams }: { searchParams: Promise<{ categoria?: string }> }) {
  const ctx = await getContext();
  if (!can(ctx, "menu.manage")) {
    if (can(ctx, "finance.view")) redirect("/servizio/menu/food-cost");
    if (can(ctx, "haccp.record", "pos.kitchen")) redirect("/servizio/menu/haccp");
    redirect("/oggi?negato=1");
  }
  const sp = await searchParams;
  const [categories, items, stations, costs] = await Promise.all([
    getCategories(ctx.facility.id),
    getMenuItems(ctx.facility.id),
    getPrepStations(ctx.facility.id),
    getFoodCost(ctx.facility.id).catch(() => new Map<string, FoodCostRow>()),
  ]);
  const stationName = new Map(stations.map((s) => [s.id, s.name]));
  const courseName = new Map(MENU_COURSES.map((c) => [c.value, c.label]));
  const filter = sp.categoria;
  const shown = filter === "nessuna" ? items.filter((i) => !i.category_id) : filter ? items.filter((i) => i.category_id === filter) : items;

  const groups = [
    ...categories.map((c) => ({ id: c.id, name: c.name, items: shown.filter((i) => i.category_id === c.id) })),
    { id: "nessuna", name: "Senza categoria", items: shown.filter((i) => !i.category_id) },
  ].filter((g) => g.items.length > 0);

  const over = items.filter((i) => i.active && costs.get(i.id)?.over_target).length;
  const noRecipe = items.filter((i) => i.active && (costs.get(i.id)?.ingredients ?? 0) === 0).length;

  return (
    <div>
      <PageHeader
        title="Menu e ricette"
        subtitle={
          items.length === 0
            ? "Crea le categorie e le voci che vendi: prezzo, IVA, allergeni, centro di produzione e ricetta."
            : `${items.filter((i) => i.active).length} voci attive · ${over} sopra il food cost obiettivo · ${noRecipe} senza ricetta`
        }
        action={<LinkButton href={`/servizio/menu/nuova${filter && filter !== "nessuna" ? `?categoria=${filter}` : ""}`}>Nuova voce</LinkButton>}
      />
      <MenuNav ctx={ctx} active="menu" />

      <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-5">
          {categories.length > 0 && (
            <nav className="flex flex-wrap gap-2" aria-label="Filtra per categoria">
              <FilterChip href="/servizio/menu" active={!filter}>Tutte</FilterChip>
              {categories.map((c) => (
                <FilterChip key={c.id} href={`/servizio/menu?categoria=${c.id}`} active={filter === c.id}>{c.name}</FilterChip>
              ))}
            </nav>
          )}
          {groups.length === 0 ? (
            <Card>
              <EmptyState
                title={items.length === 0 ? "Il menu è vuoto" : "Nessuna voce in questa categoria"}
                text="Aggiungi le voci con prezzo e allergeni; poi inserisci la ricetta per conoscerne il food cost."
                action={<LinkButton href="/servizio/menu/nuova">Nuova voce</LinkButton>}
              />
            </Card>
          ) : (
            groups.map((g) => (
              <Card key={g.id} className="overflow-hidden">
                <CardHeader title={g.name} hint={`${g.items.length} ${g.items.length === 1 ? "voce" : "voci"}`} />
                <ul className="divide-y divide-sand">
                  {g.items.map((i) => {
                    const c = costs.get(i.id);
                    return (
                      <li key={i.id}>
                        <Link href={`/servizio/menu/${i.id}`} className={cx("flex items-start gap-3 px-4 py-3 hover:bg-warm", !i.active && "opacity-60")}>
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                              {i.name}
                              {!i.active && <Badge>Non attiva</Badge>}
                              {i.active && !i.available && <Badge tone="warn">Esaurita</Badge>}
                              {c && c.ingredients === 0 && <Badge tone="neutral">Senza ricetta</Badge>}
                              {c && c.missing_costs > 0 && <Badge tone="warn">{c.missing_costs} senza costo</Badge>}
                              {c?.over_target && <Badge tone="danger">Food cost {fmtPct(c.food_cost_pct)}</Badge>}
                            </p>
                            <p className="mt-0.5 text-xs text-muted">
                              {courseName.get(i.course) ?? `Uscita ${i.course}`}
                              {i.prep_station_id && ` · ${stationName.get(i.prep_station_id) ?? ""}`}
                              {i.allergens.length > 0 && ` · ${i.allergens.map((a) => (isAllergen(a) ? ALLERGEN_LABEL[a] : a)).join(", ")}`}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-extrabold text-night">{formatEur(i.price)}</p>
                            {c && c.ingredients > 0 && !c.over_target && <p className="text-xs text-muted">FC {fmtPct(c.food_cost_pct)}</p>}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit overflow-hidden">
          <CardHeader title="Categorie" hint="L'ordine decide come appaiono in sala." />
          {categories.length > 0 && (
            <ul className="divide-y divide-sand">
              {categories.map((c) => (
                <li key={c.id} className="flex items-start gap-2 px-4 py-2">
                  <ActionForm action={updateCategory} className="flex flex-1 items-center gap-2">
                    <input type="hidden" name="id" value={c.id} />
                    <Input aria-label="Ordine" name="sort" type="number" min={0} max={999} defaultValue={c.sort} className="w-16 px-2 text-center" />
                    <Input aria-label="Nome categoria" name="name" defaultValue={c.name} maxLength={60} />
                    <SubmitButton variant="ghost" pendingText="…" className="px-2">Salva</SubmitButton>
                  </ActionForm>
                  <form action={deleteCategory}>
                    <input type="hidden" name="id" value={c.id} />
                    <button aria-label={`Elimina ${c.name}`} title="Elimina (le voci restano senza categoria)" className="h-11 w-9 rounded-xl text-xl text-muted hover:bg-danger-soft hover:text-danger">×</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={createCategory} resetOnSuccess className="border-t border-sand bg-warm p-4">
            <Field label="Nuova categoria">
              <Input name="name" placeholder="Es. Antipasti" required maxLength={60} />
            </Field>
            <input type="hidden" name="sort" value={categories.length ? Math.max(...categories.map((c) => c.sort)) + 1 : 0} />
            <SubmitButton full variant="secondary" className="mt-3">Aggiungi categoria</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx("flex min-h-10 items-center rounded-full border px-3.5 text-sm font-bold", active ? "border-night bg-night text-warm" : "border-sand-deep bg-white text-night hover:border-night-3")}
    >
      {children}
    </Link>
  );
}
