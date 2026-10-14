import { headers } from "next/headers";
import { PORTAL_ACCENTS, PORTAL_ACCENT_KEYS, PORTAL_ORDER_KINDS, pointKindLabel } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, Notice, PageHeader, Textarea } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDate, formatEur } from "@/lib/format";
import { getFacilityPublicToken, getPortalInfoBlocks, getPortalOffers, getPortalSettings } from "@/lib/portal-queries";
import { deleteInfo, deleteOffer, saveInfo, saveOffer, saveSettings } from "./actions";
import { PortalNav } from "./portal-nav";

export const metadata = { title: "Portale QR" };
export const dynamic = "force-dynamic";

const SECTIONS = [
  { key: "show_menu", label: "Menu", hint: "Piatti con prezzi e allergeni" },
  { key: "show_order", label: "Ordina", hint: "Ordine dal QR del punto (richiede il menu)" },
  { key: "show_booking", label: "Prenota", hint: "Pulsanti per prenotare via WhatsApp, telefono o email" },
  { key: "show_assistance", label: "Richiedi assistenza", hint: "Le richieste arrivano in Ospiti › Richieste" },
  { key: "show_offers", label: "Offerte e pacchetti", hint: "" },
  { key: "show_info", label: "Servizi e informazioni", hint: "Wi-Fi, regolamento, orari dei servizi…" },
] as const;

export default async function PortalePage() {
  const ctx = await requirePerm("portal.manage");
  const [{ settings: s, exists }, offers, info, ftoken] = await Promise.all([
    getPortalSettings(ctx.facility.id),
    getPortalOffers(ctx.facility.id),
    getPortalInfoBlocks(ctx.facility.id),
    getFacilityPublicToken(ctx.facility.id),
  ]);
  const h = await headers();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const previewUrl = ftoken ? `${origin}/p/f/${ftoken}` : null;
  const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");

  return (
    <div>
      <PageHeader
        title="Portale QR"
        subtitle={`La pagina che gli ospiti di ${ctx.facility.name} aprono dal QR: menu, ordini, richieste, offerte e informazioni.`}
        action={
          previewUrl ? (
            <a href={previewUrl} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center rounded-xl border border-sand-deep bg-white px-4 font-bold text-night hover:border-night-3">
              Anteprima ↗
            </a>
          ) : undefined
        }
      />
      <PortalNav active="config" />

      {!s.enabled && (
        <div className="mb-4">
          <Notice tone="warn">
            {exists ? "Il portale è disattivato: gli ospiti vedono un avviso." : "Il portale non è ancora configurato."} Compila i dati, spunta «Portale attivo» e salva.
          </Notice>
        </div>
      )}

      <ActionForm action={saveSettings} className="space-y-5">
        <Card>
          <CardHeader title="Identità" hint="Come appare la struttura agli ospiti" />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <label className="flex min-h-11 items-center gap-3 rounded-xl bg-teal-soft px-3 py-2 font-bold text-teal-deep sm:col-span-2">
              <input type="checkbox" name="enabled" defaultChecked={s.enabled} className="h-5 w-5 min-h-0 accent-[var(--color-teal-deep)]" />
              Portale attivo
            </label>
            <Field label="Nome visualizzato" hint={`Vuoto = «${ctx.facility.name}»`}>
              <Input name="display_name" defaultValue={s.display_name ?? ""} maxLength={80} />
            </Field>
            <Field label="Immagine di copertina" hint="Facoltativa: indirizzo https:// di una foto (orizzontale)">
              <Input name="cover_url" type="url" inputMode="url" defaultValue={s.cover_url ?? ""} placeholder="https://…" maxLength={500} />
            </Field>
            <Field label="Benvenuto (italiano)">
              <Textarea name="welcome_it" defaultValue={s.welcome_it ?? ""} maxLength={400} placeholder="Benvenuti al Lido! Ordina dal tuo ombrellone…" />
            </Field>
            <Field label="Welcome (English)">
              <Textarea name="welcome_en" defaultValue={s.welcome_en ?? ""} maxLength={400} placeholder="Welcome! Order from your umbrella…" />
            </Field>
            <fieldset className="sm:col-span-2">
              <legend className="mb-2 text-sm font-bold text-night">Colore</legend>
              <div className="flex flex-wrap gap-2">
                {PORTAL_ACCENT_KEYS.map((k) => (
                  <label key={k} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-sand-deep bg-white px-3 has-[:checked]:border-night has-[:checked]:ring-2 has-[:checked]:ring-night/20">
                    <input type="radio" name="accent" value={k} defaultChecked={s.accent === k} className="sr-only" />
                    <span className="h-6 w-6 rounded-full" style={{ background: PORTAL_ACCENTS[k].hex }} aria-hidden />
                    <span className="text-sm font-bold">{PORTAL_ACCENTS[k].label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </Card>

        <Card>
          <CardHeader title="Orari e contatti" hint="Telefono e WhatsApp diventano pulsanti per chiamare o scrivere" />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Orari di apertura (italiano)">
              <Textarea name="hours_it" defaultValue={s.hours_it ?? ""} maxLength={300} placeholder="Tutti i giorni 8:30–19:30" />
            </Field>
            <Field label="Opening hours (English)">
              <Textarea name="hours_en" defaultValue={s.hours_en ?? ""} maxLength={300} placeholder="Every day 8:30am–7:30pm" />
            </Field>
            <Field label="Telefono">
              <Input name="phone" type="tel" inputMode="tel" defaultValue={s.phone ?? ""} placeholder="+39 0541 123456" />
            </Field>
            <Field label="WhatsApp">
              <Input name="whatsapp" type="tel" inputMode="tel" defaultValue={s.whatsapp ?? ""} placeholder="+39 333 1234567" />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" inputMode="email" defaultValue={s.email ?? ""} maxLength={120} />
            </Field>
            <Field label="Indirizzo">
              <Input name="address" defaultValue={s.address ?? ""} maxLength={200} />
            </Field>
            <Field label="Link alla mappa" hint="Es. il link «Condividi» di Google Maps">
              <Input name="map_url" type="url" inputMode="url" defaultValue={s.map_url ?? ""} placeholder="https://maps.app.goo.gl/…" maxLength={500} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Sezioni" hint="Cosa vedono gli ospiti" />
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            {SECTIONS.map((sec) => (
              <label key={sec.key} className="flex min-h-11 items-start gap-3 rounded-xl border border-sand-deep px-3 py-2">
                <input type="checkbox" name={sec.key} defaultChecked={s[sec.key]} className="mt-0.5 h-5 w-5 min-h-0 accent-[var(--color-teal-deep)]" />
                <span>
                  <span className="block font-bold text-night">{sec.label}</span>
                  {sec.hint && <span className="block text-xs text-muted">{sec.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Ordini dal QR" hint="Gli ordini arrivano in sala da confermare; si paga al tavolo o in cassa" />
          <div className="space-y-4 p-4">
            <fieldset>
              <legend className="mb-2 text-sm font-bold text-night">Si può ordinare da</legend>
              <div className="flex flex-wrap gap-2">
                {PORTAL_ORDER_KINDS.map((k) => (
                  <label key={k} className="flex min-h-11 items-center gap-2 rounded-xl border border-sand-deep bg-white px-3 has-[:checked]:border-teal has-[:checked]:bg-teal-soft">
                    <input type="checkbox" name="order_kinds" value={k} defaultChecked={s.order_kinds.includes(k)} className="h-4 w-4 min-h-0 accent-[var(--color-teal-deep)]" />
                    <span className="text-sm font-bold">{pointKindLabel("it", k)}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">Dal QR generico della struttura non si ordina mai: serve il QR del punto, così l'ordine arriva al posto giusto.</p>
            </fieldset>
            <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
              <Field label="Ordini dalle">
                <Input name="order_from" type="time" defaultValue={hhmm(s.order_from)} />
              </Field>
              <Field label="alle">
                <Input name="order_to" type="time" defaultValue={hhmm(s.order_to)} />
              </Field>
            </div>
            <p className="text-xs text-muted">Lascia vuoti entrambi per accettare ordini a qualsiasi ora. Fasce oltre la mezzanotte (es. 22:00–02:00) sono ammesse. Ora di {ctx.facility.timezone}.</p>
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton>Salva portale</SubmitButton>
          {s.updated_at && <span className="text-xs text-muted">Ultima modifica {formatDate(s.updated_at, ctx.facility.timezone)}</span>}
        </div>
      </ActionForm>

      {/* Offerte */}
      <Card className="mt-8">
        <CardHeader title="Offerte e pacchetti" hint="Visibili finché attive e non scadute" />
        {offers.length === 0 ? (
          <EmptyState title="Nessuna offerta" text="Aggiungi pacchetti come «Ombrellone + pranzo» o «Aperitivo al tramonto»." />
        ) : (
          <ul className="divide-y divide-sand">
            {offers.map((o) => (
              <li key={o.id} className="px-4 py-3">
                <details>
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
                    <span className="font-bold text-night">{o.title_it}</span>
                    {o.price != null && <span className="text-sm text-muted">{formatEur(o.price)}</span>}
                    {!o.active && <Badge>Spenta</Badge>}
                    {o.valid_to && <Badge tone="neutral">fino al {formatDate(o.valid_to)}</Badge>}
                    <span className="ml-auto text-sm font-bold text-teal-deep">Modifica</span>
                  </summary>
                  <OfferForm offer={o} />
                  <ActionForm action={deleteOffer} className="mt-2">
                    <input type="hidden" name="id" value={o.id} />
                    <SubmitButton variant="danger" pendingText="…" confirm="Eliminare l'offerta?">Elimina</SubmitButton>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
        <details className="border-t border-sand px-4 py-3">
          <summary className="cursor-pointer font-bold text-teal-deep">+ Nuova offerta</summary>
          <OfferForm />
        </details>
      </Card>

      {/* Informazioni */}
      <Card className="mt-5">
        <CardHeader title="Servizi e informazioni" hint="Wi-Fi, regolamento, orari dei servizi, navetta…" />
        {info.length === 0 ? (
          <EmptyState title="Nessuna informazione" text="Aggiungi ciò che gli ospiti chiedono più spesso: risponderai a meno domande." />
        ) : (
          <ul className="divide-y divide-sand">
            {info.map((b) => (
              <li key={b.id} className="px-4 py-3">
                <details>
                  <summary className="flex cursor-pointer list-none items-center gap-2">
                    <span className="font-bold text-night">{b.title_it}</span>
                    {!b.active && <Badge>Nascosta</Badge>}
                    {!b.body_en && <Badge tone="warn">manca EN</Badge>}
                    <span className="ml-auto text-sm font-bold text-teal-deep">Modifica</span>
                  </summary>
                  <InfoForm block={b} />
                  <ActionForm action={deleteInfo} className="mt-2">
                    <input type="hidden" name="id" value={b.id} />
                    <SubmitButton variant="danger" pendingText="…" confirm="Eliminare questa informazione?">Elimina</SubmitButton>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
        <details className="border-t border-sand px-4 py-3">
          <summary className="cursor-pointer font-bold text-teal-deep">+ Nuova informazione</summary>
          <InfoForm />
        </details>
      </Card>
    </div>
  );
}

function OfferForm({ offer }: { offer?: Awaited<ReturnType<typeof getPortalOffers>>[number] }) {
  return (
    <ActionForm action={saveOffer} resetOnSuccess={!offer} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="id" value={offer?.id ?? ""} />
      <Field label="Titolo (italiano)">
        <Input name="title_it" required maxLength={100} defaultValue={offer?.title_it ?? ""} />
      </Field>
      <Field label="Title (English)">
        <Input name="title_en" maxLength={100} defaultValue={offer?.title_en ?? ""} />
      </Field>
      <Field label="Descrizione (italiano)">
        <Textarea name="description_it" maxLength={600} defaultValue={offer?.description_it ?? ""} />
      </Field>
      <Field label="Description (English)">
        <Textarea name="description_en" maxLength={600} defaultValue={offer?.description_en ?? ""} />
      </Field>
      <Field label="Prezzo (€)" hint="Facoltativo">
        <Input name="price" inputMode="decimal" defaultValue={offer?.price != null ? String(offer.price).replace(".", ",") : ""} />
      </Field>
      <Field label="Ordine" hint="Numeri più bassi in alto">
        <Input name="sort" type="number" inputMode="numeric" defaultValue={offer?.sort ?? 0} />
      </Field>
      <Field label="Valida dal">
        <Input name="valid_from" type="date" defaultValue={offer?.valid_from ?? ""} />
      </Field>
      <Field label="Valida fino al">
        <Input name="valid_to" type="date" defaultValue={offer?.valid_to ?? ""} />
      </Field>
      <label className="flex min-h-11 items-center gap-2 font-bold text-night">
        <input type="checkbox" name="active" defaultChecked={offer?.active ?? true} className="h-5 w-5 min-h-0 accent-[var(--color-teal-deep)]" /> Attiva
      </label>
      <div className="sm:col-span-2">
        <SubmitButton>{offer ? "Salva offerta" : "Aggiungi offerta"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

function InfoForm({ block }: { block?: Awaited<ReturnType<typeof getPortalInfoBlocks>>[number] }) {
  return (
    <ActionForm action={saveInfo} resetOnSuccess={!block} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="id" value={block?.id ?? ""} />
      <Field label="Titolo (italiano)">
        <Input name="title_it" required maxLength={100} defaultValue={block?.title_it ?? ""} placeholder="Wi-Fi" />
      </Field>
      <Field label="Title (English)">
        <Input name="title_en" maxLength={100} defaultValue={block?.title_en ?? ""} />
      </Field>
      <Field label="Testo (italiano)">
        <Textarea name="body_it" required maxLength={2000} rows={4} defaultValue={block?.body_it ?? ""} />
      </Field>
      <Field label="Text (English)">
        <Textarea name="body_en" maxLength={2000} rows={4} defaultValue={block?.body_en ?? ""} />
      </Field>
      <Field label="Ordine" hint="Numeri più bassi in alto">
        <Input name="sort" type="number" inputMode="numeric" defaultValue={block?.sort ?? 0} />
      </Field>
      <label className="flex min-h-11 items-center gap-2 self-end font-bold text-night">
        <input type="checkbox" name="active" defaultChecked={block?.active ?? true} className="h-5 w-5 min-h-0 accent-[var(--color-teal-deep)]" /> Visibile
      </label>
      <div className="sm:col-span-2">
        <SubmitButton>{block ? "Salva" : "Aggiungi"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
