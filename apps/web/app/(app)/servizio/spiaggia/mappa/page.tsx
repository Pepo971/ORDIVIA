import { mapLayout, BEACH_KIND_LABEL, type BeachKind } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, cx } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getBeachPoints, pointName } from "@/lib/beach-queries";
import { createGrid, renameZone, setZoneActive, updatePoint } from "../actions";
import { BeachTabs } from "../beach-ui";

export const metadata = { title: "Mappa spiaggia" };
export const dynamic = "force-dynamic";

export default async function MappaPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const ctx = await requirePerm("beach.manage");
  const sp = await searchParams;
  const points = await getBeachPoints(ctx.facility.id, true);
  const layout = mapLayout(points);
  const editing = points.find((p) => p.id === sp.e) ?? null;

  return (
    <div>
      <PageHeader title="Mappa della spiaggia" subtitle="Settori, file e postazioni. La fila 1 è la più vicina al mare." />
      <BeachTabs ctx={ctx} active="mappa" />

      <div className="grid gap-5 lg:grid-cols-[22rem_1fr] lg:items-start">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Crea un settore" hint="Es. settore A, file 1–6, 20 ombrelloni per fila, 2 lettini ciascuno" />
            <ActionForm action={createGrid} className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Elemento">
                  <Select name="kind" defaultValue="ombrellone">
                    {(Object.keys(BEACH_KIND_LABEL) as BeachKind[]).map((k) => (
                      <option key={k} value={k}>{BEACH_KIND_LABEL[k]}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Settore">
                  <Input name="zone" required maxLength={40} placeholder="A" />
                </Field>
                <Field label="Dalla fila">
                  <Input name="row_from" type="number" min={1} max={99} defaultValue={1} inputMode="numeric" required />
                </Field>
                <Field label="Alla fila">
                  <Input name="row_to" type="number" min={1} max={99} defaultValue={6} inputMode="numeric" required />
                </Field>
                <Field label="Per fila">
                  <Input name="per_row" type="number" min={1} max={100} defaultValue={20} inputMode="numeric" required />
                </Field>
                <Field label="Lettini ciascuno">
                  <Input name="seats" type="number" min={0} max={20} defaultValue={2} inputMode="numeric" required />
                </Field>
                <Field label="Numerazione">
                  <Select name="numbering" defaultValue="progressivo">
                    <option value="progressivo">Progressiva (1, 2, 3…)</option>
                    <option value="per_fila">Per fila (1-01, 1-02…)</option>
                  </Select>
                </Field>
                <Field label="Prefisso" hint="Facoltativo, es. A → A1">
                  <Input name="prefix" maxLength={6} />
                </Field>
              </div>
              <p className="text-xs text-muted">La numerazione progressiva continua dall'ultimo numero esistente; le etichette già usate vengono saltate.</p>
              <SubmitButton full pendingText="Creo…">Crea postazioni</SubmitButton>
            </ActionForm>
          </Card>

          {editing && (
            <Card>
              <CardHeader title={`Modifica ${pointName(editing)}`} />
              <ActionForm action={updatePoint} className="space-y-3 p-4">
                <input type="hidden" name="id" value={editing.id} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Etichetta">
                    <Input name="label" defaultValue={editing.label} required maxLength={40} />
                  </Field>
                  <Field label="Settore">
                    <Input name="zone" defaultValue={editing.zone ?? ""} required maxLength={40} />
                  </Field>
                  <Field label="Fila">
                    <Input name="row_label" defaultValue={editing.row_label ?? ""} maxLength={20} />
                  </Field>
                  <Field label="Posizione nella fila">
                    <Input name="pos_x" type="number" min={0} max={999} step="1" defaultValue={editing.pos_x ?? 1} />
                  </Field>
                  <Field label="Lettini">
                    <Input name="seats" type="number" min={0} max={20} defaultValue={editing.seats ?? 0} />
                  </Field>
                  <label className="flex items-end gap-2 pb-3 text-sm font-bold text-night">
                    <input type="checkbox" name="active" defaultChecked={editing.active} className="h-5 w-5" /> Attiva
                  </label>
                </div>
                <SubmitButton full>Salva</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          {layout.length === 0 ? (
            <Card>
              <EmptyState title="Ancora nessuna postazione" text="Crea il primo settore con il modulo qui accanto: ombrelloni, file e lettini in un colpo solo. Poi aggiungi cabine e gazebo." />
            </Card>
          ) : (
            layout.map((z) => {
              const all = z.rows.flatMap((r) => r.points);
              const activeCount = all.filter((p) => p.active).length;
              return (
                <Card key={z.zone}>
                  <CardHeader
                    title={`Settore ${z.zone}`}
                    hint={`${activeCount} attive su ${all.length} · ${z.rows.length} file`}
                    action={
                      <form action={setZoneActive}>
                        <input type="hidden" name="zone" value={z.zone} />
                        <input type="hidden" name="active" value={activeCount > 0 ? "0" : "1"} />
                        <button className="min-h-11 rounded-lg px-3 text-sm font-bold text-night hover:bg-sand">{activeCount > 0 ? "Disattiva settore" : "Riattiva settore"}</button>
                      </form>
                    }
                  />
                  <div className="overflow-x-auto p-4">
                    {z.rows.map((r) => (
                      <div key={r.row} className="mb-1.5 flex items-center gap-1.5">
                        <form action={setZoneActive} className="shrink-0">
                          <input type="hidden" name="zone" value={z.zone} />
                          <input type="hidden" name="row_label" value={r.row} />
                          <input type="hidden" name="active" value={r.points.some((p) => p.active) ? "0" : "1"} />
                          <button
                            className="w-14 rounded-md py-1 text-left text-xs font-bold text-muted hover:bg-sand"
                            title={r.points.some((p) => p.active) ? `Disattiva fila ${r.row}` : `Riattiva fila ${r.row}`}
                          >
                            Fila {r.row || "—"}
                          </button>
                        </form>
                        <div className="flex gap-1">
                          {r.points.map((p) => (
                            <a
                              key={p.id}
                              href={`/servizio/spiaggia/mappa?e=${p.id}`}
                              className={cx(
                                "flex h-10 min-w-10 items-center justify-center rounded-md px-1 text-xs font-bold",
                                p.active ? "bg-teal-soft text-teal-deep" : "bg-sand text-muted line-through",
                                editing?.id === p.id && "ring-2 ring-night",
                              )}
                              title={`${pointName(p)} · ${p.seats ?? 0} lettini${p.active ? "" : " · disattivata"}`}
                            >
                              {p.label}
                            </a>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <details className="border-t border-sand px-4 py-3">
                    <summary className="cursor-pointer text-sm font-bold text-night">Rinomina settore</summary>
                    <ActionForm action={renameZone} className="mt-2 flex gap-2">
                      <input type="hidden" name="from" value={z.zone} />
                      <Input name="to" required maxLength={40} placeholder="Nuovo nome" />
                      <SubmitButton variant="secondary">Rinomina</SubmitButton>
                    </ActionForm>
                    <p className="mt-1 text-xs text-muted">Le tariffe del settore vengono aggiornate con il nuovo nome.</p>
                  </details>
                </Card>
              );
            })
          )}
          {points.length > 0 && (
            <p className="text-sm text-muted">
              <Badge tone="teal">Attiva</Badge> <Badge tone="neutral">Disattivata</Badge> Tocca una postazione per modificarla; tocca «Fila» per disattivare o riattivare l'intera fila.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
