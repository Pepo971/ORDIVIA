import { ALLERGEN_LABEL, EU_ALLERGENS, MENU_COURSES } from "@ordivia/domain";
import { Field, Input, Select, Textarea } from "@/components/ui";
import type { MenuCategory, MenuItem, PrepStation } from "@/lib/menu-queries";

/** Campi di una voce di menu (creazione e modifica). */
export function ItemFields({
  item,
  categories,
  stations,
  defaultCategory,
}: {
  item?: MenuItem;
  categories: MenuCategory[];
  stations: PrepStation[];
  defaultCategory?: string;
}) {
  const allergens = new Set(item?.allergens ?? []);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome">
          <Input name="name" defaultValue={item?.name} placeholder="Es. Spaghetti alle vongole" required maxLength={120} />
        </Field>
        <Field label="Categoria">
          <Select name="category_id" defaultValue={item?.category_id ?? defaultCategory ?? ""}>
            <option value="">Senza categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Descrizione" hint="Facoltativa: compare sul menu e in sala">
        <Textarea name="description" defaultValue={item?.description ?? ""} rows={2} maxLength={500} />
      </Field>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Prezzo (€, IVA incl.)">
          <Input name="price" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={item?.price} required className="font-bold" />
        </Field>
        <Field label="IVA %">
          <Select name="vat_rate" defaultValue={String(item?.vat_rate ?? 10)}>
            {[4, 5, 10, 22].map((v) => (
              <option key={v} value={v}>{v}%</option>
            ))}
          </Select>
        </Field>
        <Field label="Uscita">
          <Select name="course" defaultValue={String(item?.course ?? 1)}>
            {MENU_COURSES.map((c) => (
              <option key={c.value} value={c.value}>{c.value} · {c.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Ordine in lista">
          <Input name="sort" type="number" min={0} max={9999} defaultValue={item?.sort ?? 0} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Centro di produzione" hint="Dove arriva la comanda">
          <Select name="prep_station_id" defaultValue={item?.prep_station_id ?? ""}>
            <option value="">Nessuno (servito al banco)</option>
            {stations
              .filter((s) => s.active || s.id === item?.prep_station_id)
              .map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
          </Select>
        </Field>
        <Field label="Food cost obiettivo %">
          <Input name="target_food_cost_pct" type="number" min={1} max={100} step="0.5" inputMode="decimal" defaultValue={item?.target_food_cost_pct ?? 30} required />
        </Field>
        <Field label="Porzioni per ricetta" hint="La distinta base produce…">
          <Input name="yield_portions" type="number" min={0.001} step="any" inputMode="decimal" defaultValue={item?.yield_portions ?? 1} required />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-bold text-night">Allergeni (Reg. UE 1169/2011)</legend>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
          {EU_ALLERGENS.map((a) => (
            <label key={a} className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="allergens" value={a} defaultChecked={allergens.has(a)} className="h-5 w-5 min-h-0 accent-teal" />
              {ALLERGEN_LABEL[a]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm font-bold text-night">
          <input type="checkbox" name="active" defaultChecked={item?.active ?? true} className="h-5 w-5 min-h-0 accent-teal" /> Attiva nel menu
        </label>
        <label className="flex items-center gap-2 text-sm font-bold text-night">
          <input type="checkbox" name="available" defaultChecked={item?.available ?? true} className="h-5 w-5 min-h-0 accent-teal" /> Disponibile in servizio
        </label>
      </div>
    </div>
  );
}
