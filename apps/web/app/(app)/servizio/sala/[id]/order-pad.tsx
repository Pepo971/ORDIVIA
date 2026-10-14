"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui";
import { formatEur } from "@/lib/format";
import type { MenuItemLite } from "@/lib/pos-queries";
import { sendLines } from "../actions";

interface CartLine {
  key: number;
  itemId: string;
  qty: number;
  course: number;
  notes: string;
  without: string;
  allergyNote: string;
  allergy: boolean;
  open: boolean;
}

let seq = 0;

/** Presa comanda dal palmare: categorie, piatti a tocco, quantità, varianti, allergie, uscita; invio tutto-o-niente. */
export function OrderPad({
  orderId,
  categories,
  items,
}: {
  orderId: string;
  categories: { id: string; name: string }[];
  items: MenuItemLite[];
}) {
  const router = useRouter();
  const usedCats = categories.filter((c) => items.some((i) => i.category_id === c.id));
  const hasOther = items.some((i) => !i.category_id || !categories.some((c) => c.id === i.category_id));
  const [cat, setCat] = useState<string>(usedCats[0]?.id ?? "__altro");
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const shown = query.trim()
    ? items.filter((i) => i.name.toLowerCase().includes(query.trim().toLowerCase()))
    : items.filter((i) => (cat === "__altro" ? !i.category_id || !categories.some((c) => c.id === i.category_id) : i.category_id === cat));

  const inCart = (id: string) => cart.filter((c) => c.itemId === id).reduce((s, c) => s + c.qty, 0);
  const isPlain = (c: CartLine) => !c.notes && !c.without && !c.allergyNote && !c.allergy;

  function add(item: MenuItemLite) {
    setMessage(null);
    setError(null);
    if (item.portions_left != null && inCart(item.id) >= item.portions_left) {
      setError(`«${item.name}»: ${item.portions_left === 0 ? "esaurito" : `restano solo ${item.portions_left} porzioni`}`);
      return;
    }
    setCart((cs) => {
      const i = cs.findIndex((c) => c.itemId === item.id && isPlain(c) && c.course === item.course);
      if (i >= 0) return cs.map((c, j) => (j === i ? { ...c, qty: Math.min(99, c.qty + 1) } : c));
      return [...cs, { key: ++seq, itemId: item.id, qty: 1, course: item.course, notes: "", without: "", allergyNote: "", allergy: false, open: false }];
    });
  }
  const patch = (key: number, p: Partial<CartLine>) => setCart((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));
  const remove = (key: number) => setCart((cs) => cs.filter((c) => c.key !== key));

  const total = cart.reduce((s, c) => s + (byId.get(c.itemId)?.price ?? 0) * c.qty, 0);
  const count = cart.reduce((s, c) => s + c.qty, 0);

  function send() {
    setError(null);
    start(async () => {
      const res = await sendLines({
        order_id: orderId,
        lines: cart.map((c) => ({
          menu_item_id: c.itemId,
          qty: c.qty,
          course: c.course,
          notes: c.notes.trim() || undefined,
          without: c.without
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          allergy: c.allergy || !!c.allergyNote.trim(),
          allergy_note: c.allergyNote.trim() || undefined,
        })),
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setCart([]);
      setMessage(res.message ?? "Inviato.");
      router.refresh();
    });
  }

  return (
    <div className="pb-28">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Cerca un piatto…"
        aria-label="Cerca un piatto"
        className="mb-3 w-full rounded-xl border border-sand-deep bg-white px-4 py-3 text-base focus:border-teal focus:outline-none"
      />
      {!query.trim() && (
        <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Categorie">
          {usedCats.map((c) => (
            <Chip key={c.id} active={cat === c.id} onClick={() => setCat(c.id)}>{c.name}</Chip>
          ))}
          {hasOther && <Chip active={cat === "__altro"} onClick={() => setCat("__altro")}>Altro</Chip>}
        </div>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl bg-sand px-4 py-6 text-center text-sm text-muted">Il menu è vuoto: chi gestisce il menu deve aggiungere i piatti.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shown.map((i) => {
            const out = !i.available || i.portions_left === 0;
            const qty = inCart(i.id);
            return (
              <button
                key={i.id}
                type="button"
                disabled={out}
                onClick={() => add(i)}
                className={cx(
                  "relative flex min-h-20 flex-col items-start justify-between rounded-xl border p-3 text-left active:scale-[0.98]",
                  out ? "border-sand bg-sand/60 text-muted" : qty > 0 ? "border-teal bg-teal-soft" : "border-sand-deep bg-white",
                )}
              >
                <span className={cx("leading-tight font-bold", out ? "line-through" : "text-night")}>{i.name}</span>
                <span className="mt-1 flex w-full items-end justify-between gap-1 text-sm">
                  <span className={out ? "" : "text-muted"}>{formatEur(i.price)}</span>
                  {out ? (
                    <span className="rounded bg-danger-soft px-1.5 text-xs font-bold text-danger">Esaurito</span>
                  ) : i.portions_left != null ? (
                    <span className={cx("rounded px-1.5 text-xs font-bold", i.portions_left <= 3 ? "bg-warn-soft text-warn" : "bg-sand text-ink")}>
                      {i.portions_left} rim.
                    </span>
                  ) : null}
                </span>
                {qty > 0 && <span className="absolute -top-2 -right-2 grid h-7 min-w-7 place-items-center rounded-full bg-night px-1.5 text-sm font-bold text-warm">{qty}</span>}
              </button>
            );
          })}
          {shown.length === 0 && <p className="col-span-full py-4 text-center text-sm text-muted">Nessun piatto.</p>}
        </div>
      )}

      {cart.length > 0 && (
        <section className="mt-5 rounded-[var(--radius-card)] border border-sand-deep bg-white">
          <h2 className="border-b border-sand px-4 py-3 text-[0.95rem] font-bold text-night">Da inviare</h2>
          <ul className="divide-y divide-sand">
            {cart.map((c) => {
              const item = byId.get(c.itemId);
              if (!item) return null;
              return (
                <li key={c.key} className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold text-night">{item.name}</p>
                      <p className="text-xs text-muted">
                        Uscita {c.course}
                        {c.without && ` · senza ${c.without}`}
                        {c.notes && ` · ${c.notes}`}
                        {(c.allergy || c.allergyNote) && <span className="font-bold text-danger"> · ALLERGIA {c.allergyNote}</span>}
                      </p>
                    </div>
                    <Stepper
                      value={c.qty}
                      onChange={(v) => (v <= 0 ? remove(c.key) : patch(c.key, { qty: Math.min(v, 99, item.portions_left == null ? 99 : item.portions_left - (inCart(item.id) - c.qty)) }))}
                    />
                  </div>
                  <button type="button" onClick={() => patch(c.key, { open: !c.open })} className="mt-1 min-h-9 text-sm font-bold text-teal-deep">
                    {c.open ? "Chiudi varianti" : "Varianti, allergie, uscita"}
                  </button>
                  {c.open && (
                    <div className="mt-2 grid gap-2">
                      <div>
                        <span className="mb-1 block text-xs font-bold text-night">Uscita</span>
                        <div className="flex gap-1.5">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => patch(c.key, { course: n })}
                              className={cx("h-11 w-11 rounded-lg border text-base font-bold", c.course === n ? "border-night bg-night text-warm" : "border-sand-deep bg-white text-night")}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className="block">
                        <span className="mb-1 block text-xs font-bold text-night">Senza (separati da virgola)</span>
                        <input value={c.without} onChange={(e) => patch(c.key, { without: e.target.value })} placeholder="es. aglio, prezzemolo" maxLength={200} className="w-full rounded-lg border border-sand-deep px-3 py-2.5" />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-bold text-night">Note</span>
                        <input value={c.notes} onChange={(e) => patch(c.key, { notes: e.target.value })} placeholder="es. ben cotta, per bambino" maxLength={300} className="w-full rounded-lg border border-sand-deep px-3 py-2.5" />
                      </label>
                      <label className="flex min-h-11 items-center gap-2 text-sm font-bold text-danger">
                        <input type="checkbox" checked={c.allergy} onChange={(e) => patch(c.key, { allergy: e.target.checked })} className="h-5 w-5" />
                        Allergia / intolleranza
                      </label>
                      {(c.allergy || c.allergyNote) && (
                        <input
                          value={c.allergyNote}
                          onChange={(e) => patch(c.key, { allergyNote: e.target.value })}
                          placeholder="Quale? es. glutine, frutta a guscio"
                          maxLength={300}
                          className="w-full rounded-lg border border-danger/50 bg-danger-soft px-3 py-2.5"
                        />
                      )}
                      {item.allergens.length > 0 && <p className="text-xs text-muted">Allergeni del piatto: {item.allergens.join(", ")}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(error || message) && (
        <p role={error ? "alert" : "status"} className={cx("mt-3 rounded-xl px-3 py-2 text-sm font-bold", error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok")}>
          {error ?? message}
        </p>
      )}

      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-sand-deep bg-white/95 p-3 backdrop-blur lg:bottom-0 lg:left-[15.5rem]">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <button type="button" onClick={() => setCart([])} className="min-h-14 rounded-xl px-3 text-sm font-bold text-muted">
              Svuota
            </button>
            <button
              type="button"
              onClick={send}
              disabled={pending}
              className="flex min-h-14 flex-1 items-center justify-between rounded-xl bg-night px-5 text-lg font-bold text-warm disabled:opacity-70"
            >
              <span>{pending ? "Invio…" : `Invia ${count} ${count === 1 ? "piatto" : "piatti"}`}</span>
              <span>{formatEur(total)}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx("min-h-11 shrink-0 rounded-full border px-4 text-sm font-bold whitespace-nowrap", active ? "border-night bg-night text-warm" : "border-sand-deep bg-white text-night")}
    >
      {children}
    </button>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" aria-label="Meno" onClick={() => onChange(value - 1)} className="h-11 w-11 rounded-lg border border-sand-deep text-xl font-bold text-night active:bg-sand">
        −
      </button>
      <span className="w-8 text-center text-lg font-bold text-night">{value}</span>
      <button type="button" aria-label="Più" onClick={() => onChange(value + 1)} className="h-11 w-11 rounded-lg bg-night text-xl font-bold text-warm active:bg-night-2">
        +
      </button>
    </div>
  );
}
