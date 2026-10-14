import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getMenuItems, getPrepStations, type PrepStation } from "@/lib/menu-queries";
import { getWarehouses, type Warehouse } from "@/lib/queries";
import { createPrepStation, updatePrepStation } from "../actions";
import { MenuNav, PREP_KIND_LABEL } from "../menu-nav";

export const metadata = { title: "Centri di produzione" };
export const dynamic = "force-dynamic";

export default async function StationsPage() {
  const ctx = await requirePerm("menu.manage");
  const [stations, warehouses, items] = await Promise.all([getPrepStations(ctx.facility.id), getWarehouses(ctx.facility.id), getMenuItems(ctx.facility.id)]);
  const count = new Map<string, number>();
  for (const i of items) if (i.prep_station_id) count.set(i.prep_station_id, (count.get(i.prep_station_id) ?? 0) + 1);
  const departments = ctx.departments;

  return (
    <div>
      <PageHeader title="Centri di produzione" subtitle="Dove arrivano le comande (cucina, pizzeria, bar…) e da quale magazzino si scaricano gli ingredienti." />
      <MenuNav ctx={ctx} active="centri" />

      <Card className="mb-5 overflow-hidden">
        {stations.length === 0 ? (
          <EmptyState title="Nessun centro di produzione" text="Aggiungi la cucina, il bar o la pizzeria qui sotto." />
        ) : (
          <ul className="divide-y divide-sand">
            {stations.map((s) => (
              <li key={s.id} className="p-4">
                <p className="mb-3 flex flex-wrap items-center gap-2 font-bold text-night">
                  {s.name}
                  <Badge tone="teal">{PREP_KIND_LABEL[s.kind] ?? s.kind}</Badge>
                  {!s.active && <Badge>Non attivo</Badge>}
                  <span className="text-xs font-normal text-muted">{count.get(s.id) ?? 0} voci di menu</span>
                </p>
                <ActionForm action={updatePrepStation}>
                  <input type="hidden" name="id" value={s.id} />
                  <StationFields station={s} warehouses={warehouses} departments={departments} />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm font-bold text-night">
                      <input type="checkbox" name="active" defaultChecked={s.active} className="h-5 w-5 min-h-0 accent-teal" /> Attivo
                    </label>
                    <SubmitButton variant="secondary">Salva</SubmitButton>
                  </div>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Nuovo centro di produzione" />
        <ActionForm action={createPrepStation} resetOnSuccess className="p-4">
          <StationFields warehouses={warehouses} departments={departments} />
          <div className="mt-3 flex justify-end">
            <SubmitButton>Aggiungi</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}

function StationFields({ station, warehouses, departments }: { station?: PrepStation; warehouses: Warehouse[]; departments: { id: string; name: string }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_10rem_1fr_1fr_5rem]">
      <Field label="Nome">
        <Input name="name" defaultValue={station?.name} placeholder="Es. Pizzeria" required maxLength={60} />
      </Field>
      <Field label="Tipo">
        <Select name="kind" defaultValue={station?.kind ?? "cucina"}>
          {Object.entries(PREP_KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
      </Field>
      <Field label="Scarica da magazzino">
        <Select name="warehouse_id" defaultValue={station?.warehouse_id ?? ""}>
          <option value="">Nessuno</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Reparto">
        <Select name="department_id" defaultValue={station?.department_id ?? ""}>
          <option value="">Nessuno</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Ordine">
        <Input name="sort" type="number" min={0} max={999} defaultValue={station?.sort ?? 0} />
      </Field>
    </div>
  );
}
