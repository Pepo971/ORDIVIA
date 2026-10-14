import { Card, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getMenuItems } from "@/lib/menu-queries";
import { createClient } from "@/lib/supabase/server";
import { LabelForm, type LabelSubject, type LotOption } from "../../label-form";

export const metadata = { title: "Nuova etichetta" };
export const dynamic = "force-dynamic";

export default async function NewLabelPage() {
  const ctx = await requirePerm("haccp.record");
  const supabase = await createClient();
  const [items, { data: products }, { data: lots }] = await Promise.all([
    getMenuItems(ctx.facility.id),
    supabase.from("products").select("id, name, allergens").eq("org_id", ctx.org.id).eq("active", true).order("name"),
    supabase.rpc("haccp_available_lots", { p_facility: ctx.facility.id, p_days: 120 }),
  ]);
  const subjects: LabelSubject[] = [
    ...items.filter((i) => i.active).map((i) => ({ key: `item:${i.id}`, name: i.name, group: "Menu" as const, allergens: i.allergens })),
    ...(products ?? []).map((p) => ({ key: `product:${p.id}`, name: p.name, group: "Prodotti" as const, allergens: (p.allergens as string[]) ?? [] })),
  ];
  const lotOptions: LotOption[] = ((lots ?? []) as LotOption[]).map((l) => ({ product_id: l.product_id, product_name: l.product_name, lot: l.lot, expires_on: l.expires_on }));

  return (
    <div>
      <PageHeader
        title="Nuova etichetta"
        subtitle="Il lotto interno viene assegnato automaticamente; la scadenza non supera mai quella dei lotti di origine."
        action={<LinkButton href="/servizio/menu/haccp/etichette" variant="secondary">Etichette</LinkButton>}
      />
      <Card className="p-4 sm:p-5">
        <LabelForm subjects={subjects} lots={lotOptions} timeZone={ctx.facility.timezone} nowIso={new Date().toISOString()} />
      </Card>
    </div>
  );
}
