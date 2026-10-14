"use client";

import { useEffect, useMemo, useState } from "react";
import { ALLERGEN_LABEL, EU_ALLERGENS, labelExpiry } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { createLabel } from "./actions";

export interface LabelSubject {
  key: string; // item:<id> | product:<id>
  name: string;
  group: "Menu" | "Prodotti";
  allergens: string[];
}
export interface LotOption {
  product_id: string;
  product_name: string;
  lot: string;
  expires_on: string | null;
}

const STORAGE = ["0–4 °C", "≤ −18 °C", "Temperatura ambiente", "Sottovuoto 0–3 °C", "Abbattuto, poi 0–4 °C"];

/** Formato per input datetime-local nel fuso della struttura. */
function localInput(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return p.replace(" ", "T");
}

export function LabelForm({ subjects, lots, timeZone, nowIso }: { subjects: LabelSubject[]; lots: LotOption[]; timeZone: string; nowIso: string }) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [kind, setKind] = useState<"preparazione" | "apertura">("preparazione");
  const [subject, setSubject] = useState("");
  const [days, setDays] = useState("3");
  const [prepared, setPrepared] = useState(localInput(now, timeZone));
  const [opened, setOpened] = useState(localInput(now, timeZone));
  const [allergens, setAllergens] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [lotFilter, setLotFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    const s = subjects.find((x) => x.key === subject);
    setAllergens(new Set(s?.allergens ?? []));
  }, [subject, subjects]);

  const lotKey = (l: LotOption) => `${l.product_id}|${l.lot}|${l.expires_on ?? ""}|${l.product_name}`;
  const shownLots = lots.filter((l) => !lotFilter || `${l.product_name} ${l.lot}`.toLowerCase().includes(lotFilter.toLowerCase())).slice(0, 40);

  const preview = useMemo(() => {
    const d = Number(days.replace(",", "."));
    if (!Number.isFinite(d) || d < 0) return null;
    const parse = (v: string) => (v ? new Date(`${v}:00`) : now); // anteprima: ora locale del dispositivo
    try {
      return labelExpiry({
        kind,
        preparedAt: parse(prepared),
        openedAt: parse(opened),
        shelfLifeDays: d,
        sourceExpiries: lots.filter((l) => picked.has(lotKey(l))).map((l) => l.expires_on),
        timeZone,
      });
    } catch {
      return null;
    }
  }, [days, kind, prepared, opened, picked, lots, now, timeZone]);

  return (
    <ActionForm action={createLabel} className="space-y-4">
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-sand p-1">
        {(["preparazione", "apertura"] as const).map((k) => (
          <label key={k} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg text-sm font-bold ${kind === k ? "bg-white text-night shadow-sm" : "text-muted"}`}>
            <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
            {k === "preparazione" ? "Preparazione" : "Apertura confezione"}
          </label>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cosa" hint="Una voce del menu, un prodotto, oppure scrivi il nome qui accanto">
          <Select name="subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">— Testo libero —</option>
            {(["Menu", "Prodotti"] as const).map((g) => (
              <optgroup key={g} label={g}>
                {subjects.filter((s) => s.group === g).map((s) => (
                  <option key={s.key} value={s.key}>{s.name}</option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label={subject ? "Nome sull'etichetta (facoltativo)" : "Nome della preparazione"}>
          <Input name="name" placeholder={subject ? "Uguale alla voce scelta" : "Es. Ragù di cinghiale"} maxLength={120} required={!subject} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Preparato il">
          <Input name="prepared_at" type="datetime-local" value={prepared} onChange={(e) => setPrepared(e.target.value)} />
        </Field>
        {kind === "apertura" ? (
          <Field label="Aperto il">
            <Input name="opened_at" type="datetime-local" value={opened} onChange={(e) => setOpened(e.target.value)} />
          </Field>
        ) : (
          <Field label="Quantità" hint="Facoltativa">
            <Input name="quantity" placeholder="Es. 2 kg, 6 porzioni" maxLength={60} />
          </Field>
        )}
        <Field label={kind === "apertura" ? "Giorni dopo l'apertura" : "Giorni di conservazione"}>
          <Input name="shelf_life_days" type="number" min={0} max={730} step="0.5" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} required className="font-bold" />
        </Field>
        <Field label="Conservazione">
          <Input name="storage" list="storage-presets" defaultValue="0–4 °C" maxLength={80} />
          <datalist id="storage-presets">
            {STORAGE.map((s) => <option key={s} value={s} />)}
          </datalist>
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-bold text-night">Allergeni</legend>
        {/* Senza JavaScript il campo non viene inviato e il database usa gli allergeni della voce o del prodotto */}
        {hydrated && <input type="hidden" name="allergens_explicit" value="1" />}
        <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-4">
          {EU_ALLERGENS.map((a) => (
            <label key={a} className="flex min-h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="allergens"
                value={a}
                checked={allergens.has(a)}
                onChange={(e) => {
                  const n = new Set(allergens);
                  if (e.target.checked) n.add(a);
                  else n.delete(a);
                  setAllergens(n);
                }}
                className="h-5 w-5 min-h-0 accent-teal"
              />
              {ALLERGEN_LABEL[a]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="rounded-xl border border-sand-deep p-3">
        <legend className="px-1 text-sm font-bold text-night">Lotti delle materie prime</legend>
        {lots.length > 0 ? (
          <>
            <Input value={lotFilter} onChange={(e) => setLotFilter(e.target.value)} placeholder="Cerca prodotto o lotto…" aria-label="Cerca lotto" className="mb-2" />
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {shownLots.map((l) => {
                const k = lotKey(l);
                return (
                  <label key={k} className="flex min-h-10 items-center gap-2 rounded-lg px-1 text-sm hover:bg-warm">
                    <input
                      type="checkbox"
                      name="source_lot"
                      value={k}
                      checked={picked.has(k)}
                      onChange={(e) => {
                        const n = new Set(picked);
                        if (e.target.checked) n.add(k);
                        else n.delete(k);
                        setPicked(n);
                      }}
                      className="h-5 w-5 min-h-0 accent-teal"
                    />
                    <span className="font-bold text-night">{l.product_name}</span>
                    <span className="text-muted">lotto {l.lot}{l.expires_on ? ` · scad. ${l.expires_on.split("-").reverse().join("/")}` : ""}</span>
                  </label>
                );
              })}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted">Nessun lotto registrato nelle ricezioni recenti. Puoi scriverlo a mano.</p>
        )}
        <div className="mt-2 grid grid-cols-[1fr_10rem] gap-2">
          <Input name="manual_lot" placeholder="Altro lotto (a mano)" maxLength={60} aria-label="Lotto scritto a mano" />
          <Input name="manual_lot_expires" type="date" aria-label="Scadenza del lotto scritto a mano" />
        </div>
      </fieldset>

      <Field label="Note">
        <Textarea name="note" rows={2} maxLength={500} />
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {preview ? (
            <>
              Scade il{" "}
              <strong className="text-night">
                {new Intl.DateTimeFormat("it-IT", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(preview.expiresAt)}
              </strong>
              {preview.capped && " (limitata dalla scadenza di un lotto)"}
            </>
          ) : (
            "Indica la durata di conservazione"
          )}
        </p>
        <SubmitButton pendingText="Creazione…">Crea e stampa</SubmitButton>
      </div>
    </ActionForm>
  );
}
