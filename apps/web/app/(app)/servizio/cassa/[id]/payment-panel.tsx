"use client";

import { useState } from "react";
import { cashSuggestions, changeDue, splitByItems, splitEqual } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { cx } from "@/components/ui";
import { formatEur } from "@/lib/format";
import { addPayment } from "../actions";

interface UnpaidLine {
  id: string;
  name: string;
  qty: number;
  gross: number;
}

type Mode = "tutto" | "romana" | "piatti";

/** Incasso: tutto il residuo, alla romana (quote uguali) o per piatti; metodo; contante ricevuto e resto. */
export function PaymentPanel({
  orderId,
  subtotal,
  total,
  remaining,
  lines,
  cashAllowed,
}: {
  orderId: string;
  subtotal: number;
  total: number;
  remaining: number;
  lines: UnpaidLine[];
  cashAllowed: boolean;
}) {
  const [mode, setMode] = useState<Mode>("tutto");
  const [parts, setParts] = useState(2);
  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState<"contanti" | "carta" | "altro">(cashAllowed ? "contanti" : "carta");
  const [tendered, setTendered] = useState<string>("");

  const quotas = splitEqual(remaining, parts);
  const selGross = lines.filter((l) => selected.includes(l.id)).reduce((s, l) => s + l.gross, 0);
  const amount = mode === "tutto" ? remaining : mode === "romana" ? quotas[0]! : splitByItems(selGross, subtotal, total, remaining);
  const tenderedNum = tendered === "" ? null : Number(tendered.replace(",", "."));
  const change = tenderedNum != null && Number.isFinite(tenderedNum) ? changeDue(amount, tenderedNum) : null;

  return (
    <ActionForm action={addPayment} resetOnSuccess>
      {(state) => (
        <>
          <input type="hidden" name="order_id" value={orderId} />
          <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-sand p-1" role="tablist" aria-label="Come si paga">
            {(
              [
                ["tutto", "Tutto"],
                ["romana", "Alla romana"],
                ["piatti", "Per piatti"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={mode === k}
                onClick={() => setMode(k)}
                className={cx("min-h-11 rounded-lg text-sm font-bold", mode === k ? "bg-white text-night shadow-sm" : "text-muted")}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "romana" && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-warm p-3">
              <span className="text-sm font-bold text-night">Diviso in</span>
              <div className="flex items-center gap-2">
                <button type="button" aria-label="Meno parti" onClick={() => setParts((p) => Math.max(2, p - 1))} className="h-11 w-11 rounded-lg border border-sand-deep bg-white text-xl font-bold">−</button>
                <span className="w-8 text-center text-xl font-bold">{parts}</span>
                <button type="button" aria-label="Più parti" onClick={() => setParts((p) => Math.min(50, p + 1))} className="h-11 w-11 rounded-lg bg-night text-xl font-bold text-warm">+</button>
              </div>
              <span className="text-sm text-muted">{quotas.length > 1 && quotas[0] !== quotas[quotas.length - 1] ? `${formatEur(quotas[0])} / ${formatEur(quotas[quotas.length - 1])}` : `${formatEur(quotas[0])} a testa`}</span>
              <input type="hidden" name="amount" value={amount.toFixed(2)} />
              <input type="hidden" name="label" value={`Quota alla romana (1 di ${parts})`} />
            </div>
          )}
          {mode === "tutto" && <input type="hidden" name="amount" value={amount.toFixed(2)} />}
          {mode === "piatti" && (
            <div className="mb-3 rounded-xl border border-sand-deep">
              {lines.length === 0 ? (
                <p className="p-3 text-sm text-muted">Tutti i piatti sono già stati pagati singolarmente.</p>
              ) : (
                <ul className="divide-y divide-sand">
                  {lines.map((l) => (
                    <li key={l.id}>
                      <label className="flex min-h-12 items-center gap-3 px-3 py-2">
                        <input
                          type="checkbox"
                          name="line_id"
                          value={l.id}
                          checked={selected.includes(l.id)}
                          onChange={(e) => setSelected((s) => (e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id)))}
                          className="h-5 w-5"
                        />
                        <span className="flex-1 font-bold text-night">{l.qty}× {l.name}</span>
                        <span className="text-sm text-muted">{formatEur(l.gross)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <input type="hidden" name="label" value="Per piatti" />
            </div>
          )}

          <div className="mb-3 grid grid-cols-3 gap-2">
            {(["contanti", "carta", "altro"] as const).map((m) => (
              <label
                key={m}
                className={cx(
                  "flex min-h-12 cursor-pointer items-center justify-center rounded-xl border text-sm font-bold capitalize",
                  method === m ? "border-night bg-night text-warm" : "border-sand-deep bg-white text-night",
                  m === "contanti" && !cashAllowed && "cursor-not-allowed opacity-50",
                )}
              >
                <input type="radio" name="method" value={m} checked={method === m} disabled={m === "contanti" && !cashAllowed} onChange={() => setMethod(m)} className="sr-only" />
                {m}
              </label>
            ))}
          </div>

          {method === "contanti" && amount > 0 && (
            <div className="mb-3 rounded-xl bg-warm p-3">
              <label className="block">
                <span className="mb-1 block text-sm font-bold text-night">Contante ricevuto</span>
                <input
                  name="tendered"
                  inputMode="decimal"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  placeholder={amount.toFixed(2).replace(".", ",")}
                  className="h-12 w-full rounded-xl border border-sand-deep bg-white px-3 text-lg font-bold"
                />
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                {cashSuggestions(amount).map((v) => (
                  <button key={v} type="button" onClick={() => setTendered(v.toFixed(2))} className="min-h-11 rounded-lg border border-sand-deep bg-white px-3 text-sm font-bold text-night">
                    {formatEur(v)}
                  </button>
                ))}
              </div>
              {change && (
                <p className={cx("mt-3 text-lg font-bold", change.short > 0 ? "text-danger" : "text-ok")}>
                  {change.short > 0 ? `Mancano ${formatEur(change.short)}` : `Resto: ${formatEur(change.change)}`}
                </p>
              )}
            </div>
          )}

          <SubmitButton full pendingText="Incasso…" className="min-h-14 text-lg">
            {amount > 0 ? `Incassa ${formatEur(amount)}` : "Scegli cosa incassare"}
          </SubmitButton>
          {state.ok && <p className="mt-2 text-sm font-bold text-warn">Emetti lo scontrino dal registratore telematico.</p>}
        </>
      )}
    </ActionForm>
  );
}
