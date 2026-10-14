"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  PORTAL_LIMITS,
  addToCart,
  allergenLabel,
  cartIssueText,
  cartTotals,
  formatPortalPrice,
  portalText,
  sanitizeCart,
  setCartQty,
  validateCart,
  type CartLine,
  type PortalLang,
} from "@ordivia/domain";
import type { ActionState } from "@/lib/action-state";
import { placeOrder } from "../actions";

export interface OrderMenuCategory {
  name: string;
  items: { id: string; name: string; description: string | null; price: number; allergens: string[]; sold_out: boolean }[];
}

/** Menu con carrello: il carrello resta nel browser (per QR) finché l'ordine non viene inviato. */
export function OrderMenu({ token, lang, menu }: { token: string; lang: PortalLang; menu: OrderMenuCategory[] }) {
  const t = portalText(lang);
  const items = useMemo(() => menu.flatMap((c) => c.items), [menu]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const storageKey = `ordivia-cart-${token}`;
  const [cart, setCart] = useState<CartLine[]>([]);
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(placeOrder, {} as ActionState);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) setCart(sanitizeCart(JSON.parse(raw), items));
    } catch {
      // archiviazione non disponibile: carrello solo in memoria
    }
  }, [storageKey, items]);
  useEffect(() => {
    try {
      if (cart.length) window.localStorage.setItem(storageKey, JSON.stringify(cart));
      else window.localStorage.removeItem(storageKey);
    } catch {
      // ignorato
    }
  }, [cart, storageKey]);
  useEffect(() => {
    if (state.error) setOpen(true);
  }, [state]);

  const totals = cartTotals(cart, items);
  const issues = validateCart(cart, items);
  const qtyOf = (id: string) => cart.filter((l) => l.menu_item_id === id).reduce((n, l) => n + l.qty, 0);

  return (
    <>
      {menu.map((cat) => (
        <section key={cat.name} className="mb-6">
          <h3 className="mb-2 font-display text-xl font-semibold text-night">{cat.name}</h3>
          <ul className="divide-y divide-sand overflow-hidden rounded-2xl border border-sand-deep/70 bg-white">
            {cat.items.map((i) => {
              const q = qtyOf(i.id);
              return (
                <li key={i.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className={i.sold_out ? "font-bold text-muted line-through" : "font-bold text-night"}>{i.name}</p>
                    {i.description && <p className="text-sm text-muted">{i.description}</p>}
                    {i.allergens.length > 0 && (
                      <p className="mt-1 text-xs text-muted">
                        {t.allergens}: {i.allergens.map((a) => allergenLabel(lang, a)).join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className="font-bold text-night">{formatPortalPrice(lang, i.price)}</span>
                    {i.sold_out ? (
                      <span className="rounded-full bg-sand px-2.5 py-1 text-xs font-bold text-muted">{t.soldOut}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setCart((c) => addToCart(c, i.id))}
                        className="min-h-10 rounded-full px-4 text-sm font-bold text-white"
                        style={{ background: "var(--accent)" }}
                        aria-label={`${t.add} ${i.name}`}
                      >
                        {q > 0 ? `${t.add} · ${q}` : t.add}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {/* Barra del carrello */}
      {totals.pieces > 0 && !open && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 px-4 pt-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mx-auto flex min-h-14 w-full max-w-xl items-center justify-between rounded-2xl px-5 font-bold text-white shadow-lg"
            style={{ background: "var(--accent)" }}
          >
            <span>
              {t.viewCart} · {totals.pieces} {totals.pieces === 1 ? t.item : t.items}
            </span>
            <span>{formatPortalPrice(lang, totals.total)}</span>
          </button>
        </div>
      )}

      {/* Foglio del carrello */}
      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-night/50" role="dialog" aria-modal="true" aria-labelledby="cart-title" onClick={() => setOpen(false)}>
          <div className="safe-bottom max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-warm px-4 pt-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 id="cart-title" className="font-display text-2xl font-semibold text-night">{t.cart}</h2>
              <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-full px-3 font-bold text-muted" aria-label="Chiudi / Close">
                ✕
              </button>
            </div>

            {cart.length === 0 ? (
              <p className="py-6 text-center text-muted">{t.cartEmpty}</p>
            ) : (
              <ul className="mb-4 divide-y divide-sand rounded-2xl border border-sand-deep/70 bg-white">
                {cart.map((l, idx) => {
                  const item = byId.get(l.menu_item_id);
                  if (!item) return null;
                  return (
                    <li key={`${l.menu_item_id}-${idx}`} className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-bold text-night">{item.name}</p>
                          <p className="text-sm text-muted">{formatPortalPrice(lang, item.price * l.qty)}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button type="button" className="h-10 w-10 rounded-full border border-sand-deep bg-white text-lg font-bold" onClick={() => setCart((c) => setCartQty(c, idx, l.qty - 1))} aria-label={`− ${item.name}`}>
                            −
                          </button>
                          <span className="w-7 text-center font-bold" aria-live="polite">{l.qty}</span>
                          <button
                            type="button"
                            className="h-10 w-10 rounded-full border border-sand-deep bg-white text-lg font-bold disabled:opacity-40"
                            disabled={l.qty >= PORTAL_LIMITS.maxQty}
                            onClick={() => setCart((c) => setCartQty(c, idx, l.qty + 1))}
                            aria-label={`+ ${item.name}`}
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <input
                        type="text"
                        value={l.notes ?? ""}
                        maxLength={PORTAL_LIMITS.maxLineNote}
                        placeholder={t.lineNote}
                        onChange={(e) => setCart((c) => c.map((x, j) => (j === idx ? { ...x, notes: e.target.value || undefined } : x)))}
                        className="mt-2 w-full rounded-xl border border-sand-deep bg-warm px-3 py-2 text-sm"
                      />
                    </li>
                  );
                })}
              </ul>
            )}

            <form action={action} className="space-y-3 pb-4">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="lang" value={lang} />
              <input type="hidden" name="lines" value={JSON.stringify(cart.map((l) => ({ menu_item_id: l.menu_item_id, qty: l.qty, ...(l.notes?.trim() ? { notes: l.notes.trim() } : {}) })))} />
              <label className="block">
                <span className="mb-1 block text-sm font-bold text-night">{t.guestName}</span>
                <input name="guest_name" maxLength={PORTAL_LIMITS.maxGuestName} autoComplete="given-name" className="w-full rounded-xl border border-sand-deep bg-white px-3 py-2.5" />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-bold text-night">{t.allergies}</span>
                <input name="allergies" maxLength={PORTAL_LIMITS.maxAllergies} className="w-full rounded-xl border border-sand-deep bg-white px-3 py-2.5" />
                <span className="mt-1 block text-xs text-muted">{t.allergiesHint}</span>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-bold text-night">{t.notes}</span>
                <textarea name="notes" rows={2} maxLength={PORTAL_LIMITS.maxNotes} className="w-full rounded-xl border border-sand-deep bg-white px-3 py-2.5" />
              </label>

              {cart.length > 0 && issues.length > 0 && (
                <ul className="rounded-xl bg-danger-soft px-3 py-2 text-sm font-bold text-danger">
                  {issues.map((i, k) => (
                    <li key={k}>{cartIssueText(lang, i)}</li>
                  ))}
                </ul>
              )}
              {state.error && (
                <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm font-bold text-danger">
                  {state.error}
                </p>
              )}

              <div className="flex items-center justify-between pt-1 text-lg font-bold text-night">
                <span>{t.total}</span>
                <span>{formatPortalPrice(lang, totals.total)}</span>
              </div>
              <p className="text-xs text-muted">{t.payAtTable}</p>
              <SendButton disabled={cart.length === 0 || issues.length > 0} label={t.send} pending={t.sending} />
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function SendButton({ disabled, label, pending }: { disabled: boolean; label: string; pending: string }) {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || status.pending}
      aria-busy={status.pending}
      className="min-h-14 w-full rounded-2xl text-lg font-bold text-white disabled:opacity-50"
      style={{ background: "var(--accent)" }}
    >
      {status.pending ? pending : label}
    </button>
  );
}
