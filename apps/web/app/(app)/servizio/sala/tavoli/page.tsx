import { compareLabels, servicePointKindLabel } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, LinkButton, PageHeader, Select } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getServicePoints } from "@/lib/pos-queries";
import { createServicePoints, toggleServicePoint } from "../actions";

export const metadata = { title: "Tavoli e zone" };
export const dynamic = "force-dynamic";

const SALA_KINDS = ["tavolo", "ritiro", "piscina", "camera", "gazebo", "piazzola", "altro"];

export default async function TavoliPage() {
  const ctx = await requirePerm("pos.supervise", "menu.manage", "org.manage");
  const points = (await getServicePoints(ctx.facility.id, true)).filter((p) => SALA_KINDS.includes(p.kind));
  const groups = new Map<string, typeof points>();
  for (const p of points.sort((a, b) => compareLabels(a.label, b.label))) {
    const k = `${servicePointKindLabel(p.kind)} · ${p.zone ?? "Senza zona"}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  return (
    <div>
      <PageHeader
        title="Tavoli e zone"
        subtitle="Punti di servizio della sala. Ombrelloni e lettini si gestiscono dalla Spiaggia."
        action={<LinkButton href="/servizio/sala" variant="secondary">Sala</LinkButton>}
      />
      <Card className="mb-5">
        <CardHeader title="Crea in blocco" hint="Es. «1-20» in Sala, «T1-T8» in Terrazza, oppure «Bar, Bancone»." />
        <ActionForm action={createServicePoints} resetOnSuccess className="p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tavoli">
              <Input name="spec" required placeholder="1-20" maxLength={1000} />
            </Field>
            <Field label="Zona">
              <Input name="zone" placeholder="Sala, Terrazza, Giardino…" maxLength={40} />
            </Field>
            <Field label="Tipo">
              <Select name="kind" defaultValue="tavolo">
                {SALA_KINDS.map((k) => (
                  <option key={k} value={k}>{servicePointKindLabel(k)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Posti per tavolo" hint="Facoltativo">
              <Input name="seats" type="number" inputMode="numeric" min={0} max={500} />
            </Field>
          </div>
          <div className="mt-4">
            <SubmitButton pendingText="Creazione…">Crea</SubmitButton>
          </div>
        </ActionForm>
      </Card>

      {points.length === 0 ? (
        <Card><EmptyState title="Ancora nessun tavolo" text="Crea i tavoli qui sopra: compariranno subito nella sala per i camerieri." /></Card>
      ) : (
        [...groups].map(([title, list]) => (
          <Card key={title} className="mb-4 overflow-hidden">
            <CardHeader title={title} hint={`${list.filter((p) => p.active).length} attivi`} />
            <div className="flex flex-wrap gap-2 p-3">
              {list.map((p) => (
                <ActionForm key={p.id} action={toggleServicePoint}>
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="active" value={p.active ? "0" : "1"} />
                  <button
                    type="submit"
                    title={p.active ? "Tocca per disattivare" : "Tocca per riattivare"}
                    className={`flex min-h-11 min-w-14 items-center justify-center gap-1 rounded-lg border px-3 font-bold ${p.active ? "border-sand-deep bg-white text-night" : "border-dashed border-sand-deep bg-sand text-muted line-through"}`}
                  >
                    {p.label}
                    {p.seats ? <span className="text-xs font-normal text-muted">{p.seats}p</span> : null}
                  </button>
                </ActionForm>
              ))}
            </div>
            {list.some((p) => !p.active) && <p className="px-4 pb-3 text-xs text-muted"><Badge>barrati</Badge> = disattivati, tocca per riattivare.</p>}
          </Card>
        ))
      )}
    </div>
  );
}
