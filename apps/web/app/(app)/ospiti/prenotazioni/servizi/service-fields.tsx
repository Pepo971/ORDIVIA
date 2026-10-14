import { SERVICE_KIND_LABEL, SERVICE_KINDS } from "@ordivia/domain";
import { Field, Input, Select, Textarea } from "@/components/ui";
import type { ResService } from "@/lib/reservations-queries";

/** Campi del servizio prenotabile (nuovo o modifica). */
export function ServiceFields({ s }: { s?: ResService }) {
  return (
    <div className="space-y-3">
      {s && <input type="hidden" name="id" value={s.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome">
          <Input name="name" required maxLength={80} defaultValue={s?.name} placeholder="Cena, Aperitivo al tramonto, Spa…" />
        </Field>
        <Field label="Tipo">
          <Select name="kind" defaultValue={s?.kind ?? "ristorante"}>
            {SERVICE_KINDS.map((k) => (
              <option key={k} value={k}>{SERVICE_KIND_LABEL[k]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Capacità in">
          <Select name="capacity_unit" defaultValue={s?.capacity_unit ?? "coperti"}>
            <option value="coperti">Coperti</option>
            <option value="posti">Posti</option>
          </Select>
        </Field>
        <Field label="Durata (minuti)" hint="Per quanto tempo una prenotazione occupa i posti">
          <Input name="duration_min" type="number" min={10} max={720} required defaultValue={s?.duration_min ?? 120} />
        </Field>
        <Field label="Gruppo massimo">
          <Input name="max_party_size" type="number" min={1} max={500} required defaultValue={s?.max_party_size ?? 10} />
        </Field>
        <Field label="Preavviso minimo online (minuti)">
          <Input name="booking_notice_min" type="number" min={0} max={10080} required defaultValue={s?.booking_notice_min ?? 60} />
        </Field>
        <Field label="Acconto per prenotazione (€)" hint="Vuoto = nessun acconto">
          <Input name="deposit_amount" inputMode="decimal" defaultValue={s?.deposit_amount ?? ""} />
        </Field>
        <Field label="Prezzo a persona (€)" hint="Per eventi, degustazioni e pacchetti">
          <Input name="price_per_person" inputMode="decimal" defaultValue={s?.price_per_person ?? ""} />
        </Field>
      </div>
      <Field label="Descrizione (visibile online)">
        <Textarea name="description" maxLength={1000} rows={2} defaultValue={s?.description ?? ""} />
      </Field>
      <Field label="Politica di cancellazione">
        <Textarea name="cancellation_policy" maxLength={1000} rows={2} defaultValue={s?.cancellation_policy ?? ""} placeholder="Cancellazione gratuita fino a 24 ore prima." />
      </Field>
      <fieldset className="rounded-xl border border-sand-deep p-3">
        <legend className="px-1 text-sm font-bold text-night">Evento a data unica (facoltativo)</legend>
        <p className="mb-2 text-xs text-muted">Serata, degustazione, concerto: una sola data e ora con posti limitati. In questo caso gli orari settimanali non servono.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Data">
            <Input name="event_date" type="date" defaultValue={s?.event_date ?? ""} />
          </Field>
          <Field label="Ora">
            <Input name="event_time" type="time" defaultValue={s?.event_time ?? ""} />
          </Field>
          <Field label="Posti">
            <Input name="event_capacity" type="number" min={1} max={5000} defaultValue={s?.event_capacity ?? ""} />
          </Field>
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Ordine">
          <Input name="sort_order" type="number" min={0} max={999} defaultValue={s?.sort_order ?? 0} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-3 text-sm font-bold text-night">
          <input type="checkbox" name="public_bookable" defaultChecked={s?.public_bookable ?? true} className="h-5 w-5" /> Prenotabile online
        </label>
        {s && (
          <label className="flex items-center gap-2 self-end pb-3 text-sm font-bold text-night">
            <input type="checkbox" name="active" defaultChecked={s.active} className="h-5 w-5" /> Attivo
          </label>
        )}
      </div>
    </div>
  );
}
