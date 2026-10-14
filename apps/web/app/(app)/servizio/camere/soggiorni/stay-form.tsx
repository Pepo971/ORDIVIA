import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui";
import type { RoomStay, RoomUnit } from "@/lib/rooms-queries";
import { saveStay } from "../actions";

/** Modulo soggiorno (nuovo o modifica). I controlli definitivi (sovrapposizioni, date) sono nel database. */
export function StayForm({
  rooms,
  customers,
  stay,
  defaultRoom,
  defaultArrival,
  defaultDeparture,
}: {
  rooms: RoomUnit[];
  customers: { id: string; full_name: string }[];
  stay?: RoomStay;
  defaultRoom?: string;
  defaultArrival: string;
  defaultDeparture: string;
}) {
  const inHouse = stay?.status === "in_casa";
  return (
    <ActionForm action={saveStay} className="space-y-3">
      {stay && <input type="hidden" name="stay_id" value={stay.id} />}
      {inHouse && <input type="hidden" name="point_id" value={stay.service_point_id} />}
      {inHouse && <input type="hidden" name="arrival_date" value={stay.arrival_date} />}
      <Field label="Camera" hint={inHouse ? "Ospite già in casa: la camera non si cambia da qui." : undefined}>
        <Select name="point_id" required defaultValue={stay?.service_point_id ?? defaultRoom ?? ""} disabled={inHouse}>
          <option value="" disabled>
            Scegli…
          </option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.kind === "piazzola" ? "Piazzola" : "Camera"} {r.label}
              {r.floor ? ` · piano ${r.floor}` : ""}
              {r.room_type ? ` · ${r.room_type}` : ""}
              {r.capacity != null ? ` · ${r.capacity} posti` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Ospite">
        <Input name="guest_name" required maxLength={160} defaultValue={stay?.guest_name ?? ""} placeholder="Nome e cognome" autoComplete="off" />
      </Field>
      {customers.length > 0 && (
        <Field label="Scheda cliente (facoltativa)" hint="Collega il soggiorno a un cliente già in archivio.">
          <Select name="customer_id" defaultValue={stay?.customer_id ?? ""}>
            <option value="">Nessuna</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Arrivo">
          <Input type="date" name="arrival_date" required defaultValue={stay?.arrival_date ?? defaultArrival} disabled={inHouse} />
        </Field>
        <Field label="Partenza">
          <Input type="date" name="departure_date" required defaultValue={stay?.departure_date ?? defaultDeparture} />
        </Field>
        <Field label="Adulti">
          <Input type="number" name="adults" min={0} max={50} defaultValue={stay?.adults ?? 2} inputMode="numeric" />
        </Field>
        <Field label="Bambini">
          <Input type="number" name="children" min={0} max={50} defaultValue={stay?.children ?? 0} inputMode="numeric" />
        </Field>
        <Field label="Ora di arrivo (facoltativa)">
          <Input type="time" name="eta" defaultValue={stay?.eta?.slice(0, 5) ?? ""} />
        </Field>
        <Field label="Rif. PMS (facoltativo)">
          <Input name="external_ref" maxLength={80} defaultValue={stay?.external_ref ?? ""} />
        </Field>
      </div>
      <Field label="Note">
        <Textarea name="notes" maxLength={1000} rows={2} defaultValue={stay?.notes ?? ""} placeholder="Es. culla, piano basso, allergie" />
      </Field>
      <SubmitButton full pendingText="Salvataggio…">
        {stay ? "Salva modifiche" : "Crea soggiorno"}
      </SubmitButton>
    </ActionForm>
  );
}
