import { groupByFloor } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatEur } from "@/lib/format";
import { getRooms, getRoomSettings } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { createRooms, saveMinibarPrice, saveRoomSettings, updateRoom } from "../actions";
import { RoomsTabs } from "../rooms-ui";

export const metadata = { title: "Configura camere" };
export const dynamic = "force-dynamic";

export default async function ConfiguraPage() {
  const ctx = await requirePerm("rooms.manage");
  const [rooms, settings] = await Promise.all([getRooms(ctx.facility.id, true), getRoomSettings(ctx.facility.id)]);
  const supabase = await createClient();
  const { data: warehouses } = await supabase.from("warehouses").select("id, name").eq("facility_id", ctx.facility.id).ilike("name", "%minibar%").limit(1);
  const mbWh = warehouses?.[0] as { id: string; name: string } | undefined;
  const { data: mb } = mbWh ? await supabase.rpc("minibar_products", { p_facility: ctx.facility.id, p_warehouse: mbWh.id }) : { data: [] };
  const products = (mb ?? []) as { product_id: string; name: string; price: number | null }[];
  const camping = ctx.facility.type === "camping";

  return (
    <div>
      <PageHeader title="Configura camere" subtitle="Camere e piazzole, orari di check-in/check-out, prezzi del minibar." />
      <RoomsTabs ctx={ctx} active="configura" />

      <div className="grid gap-5 lg:grid-cols-[22rem_1fr] lg:items-start">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <CardHeader title="Crea in blocco" hint="Es. «101-120, piano 1; 201-215, piano 2»" />
            <ActionForm action={createRooms} resetOnSuccess className="space-y-3 p-4">
              <Field label="Tipo">
                <Select name="kind" defaultValue={camping ? "piazzola" : "camera"}>
                  <option value="camera">Camere</option>
                  <option value="piazzola">Piazzole</option>
                </Select>
              </Field>
              <Field label="Numeri" hint="Intervalli o numeri separati da virgola; «;» o a capo per un altro piano.">
                <Input name="spec" required maxLength={4000} placeholder="101-120, piano 1" autoComplete="off" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Piano predefinito">
                  <Input name="floor" maxLength={20} placeholder="—" />
                </Field>
                <Field label="Posti">
                  <Input name="capacity" type="number" min={0} max={50} inputMode="numeric" placeholder="2" />
                </Field>
              </div>
              <Field label="Tipologia">
                <Input name="room_type" maxLength={60} placeholder="Es. Doppia vista mare" />
              </Field>
              <SubmitButton full pendingText="Creo…">
                Crea
              </SubmitButton>
            </ActionForm>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Orari" hint="Servono per le priorità delle pulizie" />
            <ActionForm action={saveRoomSettings} className="grid grid-cols-2 gap-2 p-4">
              <Field label="Check-in dalle">
                <Input type="time" name="checkin_time" defaultValue={settings.checkin_time} required />
              </Field>
              <Field label="Check-out entro le">
                <Input type="time" name="checkout_time" defaultValue={settings.checkout_time} required />
              </Field>
              <div className="col-span-2">
                <SubmitButton variant="secondary" pendingText="…">
                  Salva orari
                </SubmitButton>
              </div>
            </ActionForm>
          </Card>

          {can(ctx, "rooms.manage") && (
            <Card className="overflow-hidden">
              <CardHeader title="Prezzi minibar" hint={mbWh ? `Prodotti di «${mbWh.name}»` : "Crea in Scorte un magazzino con «minibar» nel nome"} />
              {!mbWh ? (
                <p className="px-4 py-4 text-sm text-muted">Senza magazzino minibar si può scaricare da qualunque magazzino; le righe resteranno «da prezzare».</p>
              ) : products.length === 0 ? (
                <p className="px-4 py-4 text-sm text-muted">Nessun prodotto nel magazzino minibar.</p>
              ) : (
                <ul className="divide-y divide-sand">
                  {products.map((p) => (
                    <li key={p.product_id} className="px-4 py-2">
                      <ActionForm action={saveMinibarPrice} className="flex items-center gap-2">
                        <input type="hidden" name="product_id" value={p.product_id} />
                        <span className="min-w-0 flex-1 truncate text-sm font-bold text-night">
                          {p.name}
                          <span className="block text-xs font-normal text-muted">{p.price != null ? formatEur(p.price) : "Senza prezzo"}</span>
                        </span>
                        <Input name="price" type="number" step="0.01" min={0} required defaultValue={p.price ?? ""} className="w-24" inputMode="decimal" aria-label={`Prezzo ${p.name}`} />
                        <SubmitButton variant="secondary" pendingText="…">
                          Salva
                        </SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <Card className="overflow-hidden">
          <CardHeader title={`Unità (${rooms.length})`} />
          {rooms.length === 0 ? (
            <EmptyState title="Nessuna camera" text="Crea le camere con il modulo qui accanto." />
          ) : (
            <div className="divide-y divide-sand">
              {groupByFloor(rooms).map((g) => (
                <section key={g.floor ?? "-"} className="px-4 py-3">
                  <h2 className="mb-2 font-display text-lg font-semibold text-night">{g.floor ? `Piano ${g.floor}` : "Senza piano"}</h2>
                  <div className="space-y-1">
                    {g.rooms.map((r) => (
                      <details key={r.id} className="rounded-xl border border-sand">
                        <summary className="flex min-h-11 cursor-pointer items-center gap-3 px-3">
                          <span className="font-extrabold text-night">{r.label}</span>
                          <span className="text-sm text-muted">
                            {r.kind === "piazzola" ? "Piazzola" : "Camera"}
                            {r.room_type ? ` · ${r.room_type}` : ""}
                            {r.capacity != null ? ` · ${r.capacity} posti` : ""}
                            {!r.active ? " · disattivata" : ""}
                          </span>
                        </summary>
                        <ActionForm action={updateRoom} className="grid grid-cols-2 gap-2 border-t border-sand p-3 sm:grid-cols-4">
                          <input type="hidden" name="point_id" value={r.id} />
                          <Field label="Piano">
                            <Input name="floor" maxLength={20} defaultValue={r.floor ?? ""} />
                          </Field>
                          <Field label="Posti">
                            <Input name="capacity" type="number" min={0} max={50} defaultValue={r.capacity ?? ""} />
                          </Field>
                          <div className="col-span-2">
                            <Field label="Tipologia">
                              <Input name="room_type" maxLength={60} defaultValue={r.room_type ?? ""} />
                            </Field>
                          </div>
                          <div className="col-span-2 sm:col-span-4">
                            <Field label="Note">
                              <Input name="notes" maxLength={500} defaultValue={r.notes ?? ""} />
                            </Field>
                          </div>
                          <label className="flex min-h-11 items-center gap-2 text-sm font-bold text-night">
                            <input type="checkbox" name="active" defaultChecked={r.active} className="h-5 w-5 accent-teal" /> Attiva
                          </label>
                          <div className="col-span-2 sm:col-span-3 sm:text-right">
                            <SubmitButton variant="secondary" pendingText="…">
                              Salva
                            </SubmitButton>
                          </div>
                        </ActionForm>
                      </details>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
