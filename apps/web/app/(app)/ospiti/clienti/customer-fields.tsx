import { Field, Input, Select, Textarea } from "@/components/ui";
import { LANGUAGES, type Customer } from "@/lib/reservations-queries";

export function CustomerFields({ c }: { c?: Customer }) {
  return (
    <div className="space-y-3">
      {c && <input type="hidden" name="id" value={c.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome e cognome">
          <Input name="full_name" required maxLength={160} defaultValue={c?.full_name} autoComplete="off" />
        </Field>
        <Field label="Telefono" hint="Salvato in formato +39">
          <Input name="phone" type="tel" maxLength={40} defaultValue={c?.phone ?? ""} autoComplete="off" />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" maxLength={160} defaultValue={c?.email ?? ""} autoComplete="off" />
        </Field>
        <Field label="Lingua">
          <Select name="language" defaultValue={c?.language ?? "it"}>
            {Object.entries(LANGUAGES).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </Select>
        </Field>
        <Field label="Compleanno">
          <Input name="birthday" type="date" defaultValue={c?.birthday ?? ""} />
        </Field>
        <Field label="Tag" hint="Separati da virgola: abituale, vip, aziendale…">
          <Input name="tags" maxLength={600} defaultValue={c?.tags.join(", ") ?? ""} />
        </Field>
      </div>
      <Field label="Allergie e intolleranze" hint="Separate da virgola: compaiono su ogni prenotazione">
        <Input name="allergies" maxLength={600} defaultValue={c?.allergies.join(", ") ?? ""} />
      </Field>
      <Field label="Preferenze" hint="Tavolo preferito, vino, ombrellone in prima fila…">
        <Textarea name="preferences" maxLength={2000} rows={2} defaultValue={c?.preferences ?? ""} />
      </Field>
      <Field label="Note interne">
        <Textarea name="notes" maxLength={2000} rows={2} defaultValue={c?.notes ?? ""} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" name="force" value="1" className="h-4 w-4" /> Salva comunque anche se telefono o email sono già in archivio
      </label>
    </div>
  );
}
