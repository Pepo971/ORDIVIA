import { todayIn, zonedTimeToUtc } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, cx, EmptyState, Field, Input, PageHeader, Select, Tabs } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDateTime } from "@/lib/format";
import { getEquipment, getPeopleNames, getTempLogs, type Equipment } from "@/lib/menu-queries";
import { createEquipment, recordTemperatures, setCorrectiveAction, updateEquipment } from "../actions";
import { EQUIPMENT_DEFAULTS, EQUIPMENT_KIND_LABEL, fmtTemp, MenuNav } from "../../menu-nav";

export const metadata = { title: "Temperature HACCP" };
export const dynamic = "force-dynamic";

export default async function TemperaturePage({ searchParams }: { searchParams: Promise<{ attrezzatura?: string; giorni?: string }> }) {
  const ctx = await requirePerm("haccp.record", "menu.manage", "pos.kitchen");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const days = [1, 7, 30].includes(Number(sp.giorni)) ? Number(sp.giorni) : 7;
  const [y, m, d] = todayIn(tz).split("-").map(Number) as [number, number, number];
  const since = new Date(zonedTimeToUtc(y, m, d, 0, 0, tz).getTime() - (days - 1) * 86_400_000).toISOString();

  const equipment = await getEquipment(ctx.facility.id);
  const eq = equipment.find((e) => e.id === sp.attrezzatura);
  const logs = await getTempLogs(ctx.facility.id, { equipmentId: eq?.id, since, limit: 500 });
  const people = await getPeopleNames(logs.map((l) => l.recorded_by));
  const eqName = new Map(equipment.map((e) => [e.id, e.name]));
  const active = equipment.filter((e) => e.active);
  const canRecord = can(ctx, "haccp.record");
  const canConfigure = can(ctx, "menu.manage", "org.manage");
  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ attrezzatura: eq?.id, giorni: String(days), ...o }).filter(([, v]) => v) as [string, string][]);
    return `/servizio/menu/haccp/temperature?${p}`;
  };

  return (
    <div>
      <PageHeader title="Temperature" subtitle="Registro delle temperature: il fuori range è calcolato dal sistema sui limiti dell'attrezzatura." />
      <MenuNav ctx={ctx} active="temperature" />

      {canRecord && active.length > 0 && (
        <Card className="mb-5 overflow-hidden">
          <CardHeader title="Giro di rilevazione" hint="Compila solo le attrezzature che stai controllando." />
          <ActionForm action={recordTemperatures} resetOnSuccess>
            <ul className="divide-y divide-sand">
              {active.map((e) => (
                <li key={e.id} className="grid grid-cols-[1fr_7rem] items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:grid-cols-[1fr_7rem_1fr]">
                  <input type="hidden" name="equipment_id" value={e.id} />
                  <div>
                    <p className="font-bold text-night">{e.name}</p>
                    <p className="text-xs text-muted">{EQUIPMENT_KIND_LABEL[e.kind] ?? e.kind} · {fmtTemp(e.min_temp)} / {fmtTemp(e.max_temp)}</p>
                  </div>
                  <label className="flex items-center gap-1 text-sm text-muted">
                    <Input aria-label={`Temperatura ${e.name}`} name="value" type="number" step="0.1" min={-60} max={120} inputMode="decimal" className="text-right text-lg font-extrabold" />
                    °C
                  </label>
                  <Input aria-label={`Azione correttiva ${e.name}`} name="corrective_action" placeholder="Azione correttiva (se fuori range)" maxLength={500} className="col-span-2 sm:col-span-1" />
                </li>
              ))}
            </ul>
            <div className="flex justify-end bg-warm px-4 py-3">
              <SubmitButton pendingText="Registrazione…">Registra temperature</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}

      <Tabs
        active={eq?.id ?? "tutte"}
        items={[{ key: "tutte", label: "Tutte", href: qs({ attrezzatura: undefined }) }, ...equipment.map((e) => ({ key: e.id, label: e.name, href: qs({ attrezzatura: e.id }) }))]}
      />
      <Card className="mb-5 overflow-hidden">
        <CardHeader
          title={`Registro · ${days === 1 ? "oggi" : `ultimi ${days} giorni`}`}
          action={
            <div className="flex gap-1 text-sm font-bold">
              {[1, 7, 30].map((g) => (
                <a key={g} href={qs({ giorni: String(g) })} className={cx("rounded-lg px-2 py-1", g === days ? "bg-night text-warm" : "text-muted hover:text-night")}>{g === 1 ? "Oggi" : `${g} gg`}</a>
              ))}
            </div>
          }
        />
        {logs.length === 0 ? (
          <EmptyState title="Nessuna rilevazione nel periodo" />
        ) : (
          <ul className="divide-y divide-sand">
            {logs.map((l) => (
              <li key={l.id} className={cx("px-4 py-2.5", l.out_of_range && !l.corrective_action && "bg-danger-soft/40")}>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <p className="font-bold text-night">{eqName.get(l.equipment_id)}</p>
                    <p className="text-xs text-muted">{formatDateTime(l.recorded_at, tz)} · {people.get(l.recorded_by) ?? "—"} · limiti {fmtTemp(l.min_temp)}/{fmtTemp(l.max_temp)}</p>
                  </div>
                  <p className={cx("text-lg font-extrabold", l.out_of_range ? "text-danger" : "text-ok")}>{fmtTemp(l.value)}</p>
                  {l.out_of_range && <Badge tone="danger">Fuori range</Badge>}
                </div>
                {l.corrective_action && <p className="mt-1 text-sm text-ink"><strong>Azione correttiva:</strong> {l.corrective_action}</p>}
                {l.out_of_range && !l.corrective_action && canRecord && (
                  <ActionForm action={setCorrectiveAction} className="mt-2 flex gap-2">
                    <input type="hidden" name="id" value={l.id} />
                    <Input name="action" placeholder="Cosa hai fatto? Es. merce spostata, tecnico chiamato" required minLength={3} maxLength={500} aria-label="Azione correttiva" />
                    <SubmitButton variant="secondary" pendingText="…">Registra</SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card id="attrezzature" className="overflow-hidden">
        <CardHeader title="Attrezzature" hint="Frigoriferi, congelatori e abbattitori con i limiti di temperatura." />
        {equipment.length === 0 && <EmptyState title="Nessuna attrezzatura" text={canConfigure ? "Aggiungi la prima qui sotto." : "Chiedi a chi gestisce il menu di aggiungerle."} />}
        {canConfigure ? (
          <>
            <ul className="divide-y divide-sand">
              {equipment.map((e) => (
                <li key={e.id} className="p-4">
                  <ActionForm action={updateEquipment}>
                    <input type="hidden" name="id" value={e.id} />
                    <EquipmentFields eq={e} departments={ctx.departments} />
                    <div className="mt-3 flex items-center justify-between">
                      <label className="flex items-center gap-2 text-sm font-bold text-night">
                        <input type="checkbox" name="active" defaultChecked={e.active} className="h-5 w-5 min-h-0 accent-teal" /> In uso
                      </label>
                      <SubmitButton variant="secondary">Salva</SubmitButton>
                    </div>
                  </ActionForm>
                </li>
              ))}
            </ul>
            <div className="border-t border-sand bg-warm p-4">
              <h3 className="mb-3 font-bold text-night">Nuova attrezzatura</h3>
              <ActionForm action={createEquipment} resetOnSuccess>
                <EquipmentFields departments={ctx.departments} />
                <div className="mt-3 flex justify-end">
                  <SubmitButton>Aggiungi</SubmitButton>
                </div>
              </ActionForm>
            </div>
          </>
        ) : (
          <ul className="divide-y divide-sand">
            {equipment.map((e) => (
              <li key={e.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="font-bold text-night">{e.name}</span>
                <span className="text-muted">{fmtTemp(e.min_temp)} / {fmtTemp(e.max_temp)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function EquipmentFields({ eq, departments }: { eq?: Equipment; departments: { id: string; name: string }[] }) {
  const [dmin, dmax] = EQUIPMENT_DEFAULTS[eq?.kind ?? "frigorifero"]!;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_10rem_6rem_6rem_10rem]">
      <Field label="Nome">
        <Input name="name" defaultValue={eq?.name} placeholder="Es. Frigo carni" required maxLength={80} />
      </Field>
      <Field label="Tipo">
        <Select name="kind" defaultValue={eq?.kind ?? "frigorifero"}>
          {Object.entries(EQUIPMENT_KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
      </Field>
      <Field label="Min °C">
        <Input name="min_temp" type="number" step="0.5" min={-60} max={100} inputMode="decimal" defaultValue={eq?.min_temp ?? dmin} required />
      </Field>
      <Field label="Max °C">
        <Input name="max_temp" type="number" step="0.5" min={-60} max={100} inputMode="decimal" defaultValue={eq?.max_temp ?? dmax} required />
      </Field>
      <Field label="Reparto">
        <Select name="department_id" defaultValue={eq?.department_id ?? ""}>
          <option value="">—</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </Select>
      </Field>
      <input type="hidden" name="sort" value={eq?.sort ?? 0} />
    </div>
  );
}
