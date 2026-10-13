import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { getProducts, getStock } from "@/lib/queries";
import { RequestForm } from "./request-form";

export const metadata = { title: "Nuova richiesta" };
export const dynamic = "force-dynamic";

export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ da?: string }> }) {
  const ctx = await requirePerm("purchasing.request");
  const sp = await searchParams;
  const products = await getProducts(ctx.org.id);
  const prefill =
    sp.da === "scorte" && can(ctx, "inventory.view")
      ? (await getStock(ctx)).filter((s) => s.belowMin).map((s) => ({ product_id: s.product.id, qty: s.suggestedBase }))
      : [];
  const myDeps = ctx.myDepartmentIds.length ? ctx.departments.filter((d) => ctx.myDepartmentIds.includes(d.id)) : ctx.departments;

  return (
    <div>
      <PageHeader title="Nuova richiesta d’acquisto" subtitle="Indica cosa serve al reparto. Il responsabile acquisti la unisce agli altri ordini." />
      {products.length === 0 ? (
        <Card>
          <EmptyState title="Nessun prodotto a catalogo" text="Prima di fare richieste serve almeno un prodotto." action={<LinkButton href="/scorte/prodotti">Crea prodotti</LinkButton>} />
        </Card>
      ) : (
        <RequestForm
          products={products.map((p) => ({ id: p.id, name: p.name, unit: p.base_unit }))}
          departments={myDeps.map((d) => ({ id: d.id, name: d.name }))}
          prefill={prefill}
        />
      )}
    </div>
  );
}
