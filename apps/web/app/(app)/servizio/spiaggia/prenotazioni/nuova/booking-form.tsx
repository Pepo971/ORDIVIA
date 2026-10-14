"use client";

import { useMemo, useState } from "react";
import { BEACH_PERIODS, defaultEndDate, quotePrice, validatePeriodRange, type BeachPeriod, type BeachRate } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { formatEur } from "@/lib/format";
import { createBooking } from "../../actions";

interface PointOpt {
  id: string;
  kind: string;
  label: string;
  zone: string | null;
  row_label: string | null;
  seats: number | null;
}

export function BookingForm({
  points,
  rates,
  initialPoint,
  initialDate,
  today,
  manage,
}: {
  points: PointOpt[];
  rates: BeachRate[];
  initialPoint: string | null;
  initialDate: string;
  today: string;
  manage: boolean;
}) {
  const periods = (Object.keys(BEACH_PERIODS) as BeachPeriod[]).filter((p) => manage || !BEACH_PERIODS[p].flat);
  const [pointId, setPointId] = useState(initialPoint ?? points[0]?.id ?? "");
  const [period, setPeriod] = useState<BeachPeriod>("giornata");
  const [start, setStart] = useState(initialDate);
  const point = points.find((p) => p.id === pointId);
  const [lettini, setLettini] = useState(point?.seats ?? 2);
  const seasonEnd = useMemo(() => {
    const r = rates.filter((x) => x.active && x.period === "stagione" && x.valid_from <= start && start <= x.valid_to && x.kind === point?.kind);
    return r.length ? r.map((x) => x.valid_to).sort().at(-1)! : null;
  }, [rates, start, point?.kind]);
  const [endEdited, setEndEdited] = useState<string | null>(null);
  const autoEnd = defaultEndDate(period, start, seasonEnd);
  const end = BEACH_PERIODS[period].flat && period !== "stagione" ? autoEnd : (endEdited ?? autoEnd);
  const rangeError = validatePeriodRange(period, start, end);
  const quote = point && !rangeError ? quotePrice(rates, point, period, start, end, lettini) : null;

  return (
    <ActionForm action={createBooking} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Postazione">
          <Select name="point_id" value={pointId} onChange={(e) => setPointId(e.target.value)} required>
            {points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.kind} {p.label}
                {p.zone ? ` — settore ${p.zone}` : ""}
                {p.row_label ? `, fila ${p.row_label}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Periodo">
          <Select
            name="period"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value as BeachPeriod);
              setEndEdited(null);
            }}
          >
            {periods.map((p) => (
              <option key={p} value={p}>{BEACH_PERIODS[p].label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Dal">
          <Input
            name="start_date"
            type="date"
            value={start}
            min={manage ? undefined : today}
            onChange={(e) => {
              setStart(e.target.value);
              setEndEdited(null);
            }}
            required
          />
        </Field>
        <Field label="Al" hint={BEACH_PERIODS[period].flat && period !== "stagione" ? "Calcolata dal periodo" : undefined}>
          <Input
            name="end_date"
            type="date"
            value={end}
            min={start}
            readOnly={BEACH_PERIODS[period].flat && period !== "stagione"}
            onChange={(e) => setEndEdited(e.target.value)}
            required
          />
        </Field>
        <Field label="Lettini">
          <Input name="lettini" type="number" min={0} max={20} value={lettini} onChange={(e) => setLettini(Math.max(0, Number(e.target.value) || 0))} inputMode="numeric" />
        </Field>
      </div>

      <div className="rounded-xl bg-sand px-4 py-3" aria-live="polite">
        {rangeError ? (
          <p className="font-bold text-danger">{rangeError}</p>
        ) : quote?.ok ? (
          <p className="font-bold text-night">
            Prezzo di listino: <span className="text-xl">{formatEur(quote.total)}</span>
            {quote.lines.length > 1 && <span className="ml-2 text-sm font-semibold text-muted">{quote.lines.length} giorni</span>}
          </p>
        ) : (
          <p className="font-bold text-warn">{quote ? quote.error : "Scegli una postazione"}{manage ? " — puoi indicare un prezzo qui sotto." : ""}</p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cliente">
          <Input name="customer_name" required maxLength={120} placeholder="Nome e cognome" />
        </Field>
        <Field label="Telefono">
          <Input name="customer_phone" type="tel" maxLength={40} />
        </Field>
        <Field label="Email">
          <Input name="customer_email" type="email" maxLength={160} />
        </Field>
        <Field label="Note">
          <Textarea name="notes" rows={1} maxLength={1000} />
        </Field>
      </div>

      {manage && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Prezzo diverso dal listino €" hint="Lascia vuoto per il listino">
            <Input name="price" type="number" min={0} step="0.01" inputMode="decimal" />
          </Field>
          <Field label="Motivo del prezzo">
            <Input name="price_reason" maxLength={300} placeholder="Es. cliente storico" />
          </Field>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Acconto / incassato €">
          <Input name="paid" type="number" min={0} step="0.01" inputMode="decimal" placeholder="0" />
        </Field>
        <Field label="Metodo">
          <Select name="method" defaultValue="contanti">
            <option value="contanti">Contanti</option>
            <option value="carta">Carta</option>
            <option value="bonifico">Bonifico</option>
            <option value="altro">Altro</option>
          </Select>
        </Field>
      </div>

      <SubmitButton full className="min-h-12" pendingText="Prenoto…">
        Conferma prenotazione
      </SubmitButton>
    </ActionForm>
  );
}
