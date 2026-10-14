import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getCategories, getPrepStations } from "@/lib/menu-queries";
import { createMenuItem } from "../actions";
import { ItemFields } from "../item-fields";

export const metadata = { title: "Nuova voce di menu" };
export const dynamic = "force-dynamic";

export default async function NewItemPage({ searchParams }: { searchParams: Promise<{ categoria?: string }> }) {
  const ctx = await requirePerm("menu.manage");
  const sp = await searchParams;
  const [categories, stations] = await Promise.all([getCategories(ctx.facility.id), getPrepStations(ctx.facility.id)]);
  return (
    <div>
      <PageHeader title="Nuova voce di menu" subtitle="Dopo il salvataggio potrai inserire la ricetta e vedere il food cost." action={<LinkButton href="/servizio/menu" variant="secondary">Menu</LinkButton>} />
      <Card className="p-4 sm:p-5">
        <ActionForm action={createMenuItem}>
          <ItemFields categories={categories} stations={stations} defaultCategory={sp.categoria} />
          <div className="mt-5 flex justify-end">
            <SubmitButton>Crea voce</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
