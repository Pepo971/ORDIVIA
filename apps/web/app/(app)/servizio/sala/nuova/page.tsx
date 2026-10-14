import { redirect } from "next/navigation";
import { destinationLabel } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getOpenOrders, getServicePoints } from "@/lib/pos-queries";
import { openOrder } from "../actions";
import { CoversStepper } from "./covers-stepper";

export const metadata = { title: "Nuova comanda" };
export const dynamic = "force-dynamic";

export default async function NuovaComandaPage({ searchParams }: { searchParams: Promise<{ punto?: string; tipo?: string }> }) {
  const ctx = await requirePerm("pos.operate");
  const sp = await searchParams;
  const [points, open] = await Promise.all([getServicePoints(ctx.facility.id), getOpenOrders(ctx.facility.id)]);
  const point = sp.punto ? points.find((p) => p.id === sp.punto) : undefined;
  if (point) {
    const existing = open.find((o) => o.service_point_id === point.id);
    if (existing) redirect(`/servizio/sala/${existing.id}`);
  }
  const kind = point ? null : sp.tipo === "asporto" ? "asporto" : sp.tipo === "banco" ? "banco" : null;
  if (!point && !kind) redirect("/servizio/sala");

  const title = point ? destinationLabel(point.kind, point.label) : destinationLabel(kind!);
  const askCovers = point ? ["tavolo", "camera", "gazebo", "piscina", "altro"].includes(point.kind) : false;

  return (
    <div className="mx-auto max-w-md">
      <PageHeader title={title} subtitle={point?.zone ?? "Nuova comanda"} action={<LinkButton href="/servizio/sala" variant="ghost">Annulla</LinkButton>} />
      <ActionForm action={openOrder}>
        {point && <input type="hidden" name="service_point_id" value={point.id} />}
        {kind && <input type="hidden" name="kind" value={kind} />}
        {askCovers ? (
          <Card className="mb-4 p-4">
            <p className="mb-3 text-sm font-bold text-night">Coperti</p>
            <CoversStepper initial={point?.seats ?? 2} />
          </Card>
        ) : (
          <input type="hidden" name="covers" value="0" />
        )}
        <SubmitButton full pendingText="Apertura…" className="min-h-14 text-lg">
          Apri comanda
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
