import { Field, Input, Select, Textarea } from "@/components/ui";
import { WEEKDAY_LABELS } from "@/lib/format";
import type { Supplier } from "@/lib/queries";

export function SupplierFields({ s }: { s?: Supplier }) {
  const days = s?.delivery_weekdays ?? [1, 2, 3, 4, 5];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Nome fornitore">
          <Input name="name" defaultValue={s?.name} required maxLength={160} />
        </Field>
      </div>
      <Field label="Referente">
        <Input name="contact_name" defaultValue={s?.contact_name ?? ""} />
      </Field>
      <Field label="Canale d’ordine">
        <Select name="order_channel" defaultValue={s?.order_channel ?? "email"}>
          <option value="email">Email</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="telefono">Telefono</option>
          <option value="portale">Portale del fornitore</option>
        </Select>
      </Field>
      <Field label="Email ordini">
        <Input name="email" type="email" defaultValue={s?.email ?? ""} inputMode="email" />
      </Field>
      <Field label="Telefono / WhatsApp">
        <Input name="phone" type="tel" defaultValue={s?.phone ?? ""} inputMode="tel" />
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-sm font-bold text-night">Giorni di consegna</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAY_LABELS.map((label, i) => (
            <label key={label} className="cursor-pointer">
              <input type="checkbox" name="delivery_weekdays" value={i + 1} defaultChecked={days.includes(i + 1)} className="peer sr-only" />
              <span className="flex h-11 min-w-12 items-center justify-center rounded-xl border border-sand-deep bg-white px-3 text-sm font-bold text-muted peer-checked:border-night peer-checked:bg-night peer-checked:text-warm peer-focus-visible:ring-2 peer-focus-visible:ring-teal">
                {label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Ora limite per ordinare" hint="Entro quest’ora del giorno d’ordine.">
        <Input name="cutoff_time" type="time" defaultValue={(s?.cutoff_time ?? "12:00").slice(0, 5)} required />
      </Field>
      <Field label="Giorni di preavviso" hint="1 = ordini oggi, consegna domani.">
        <Input name="lead_days" type="number" min={0} max={30} defaultValue={s?.lead_days ?? 1} required />
      </Field>
      <Field label="Minimo d’ordine (€)">
        <Input name="min_order_amount" type="number" min={0} step="0.01" defaultValue={s?.min_order_amount ?? 0} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Condizioni e note">
          <Textarea name="notes" defaultValue={s?.notes ?? ""} placeholder="Pagamento a 30 gg, resi entro 48 h…" />
        </Field>
      </div>
    </div>
  );
}
