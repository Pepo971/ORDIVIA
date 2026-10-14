"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { PORTAL_LIMITS, REQUEST_CATEGORIES, REQUEST_CATEGORY_LABEL, portalText, type PortalLang, type RequestCategory } from "@ordivia/domain";
import type { ActionState } from "@/lib/action-state";
import { sendRequest } from "../actions";

const POINT_CATEGORIES: RequestCategory[] = ["assistenza", "pulizia", "manutenzione", "room_service", "informazioni", "reclamo", "altro"];
const FACILITY_CATEGORIES: RequestCategory[] = ["informazioni", "assistenza", "reclamo", "altro"];

export function RequestForm({ token, lang, isRoom, isFacility }: { token: string; lang: PortalLang; isRoom: boolean; isFacility: boolean }) {
  const t = portalText(lang);
  const [state, action] = useActionState(sendRequest, {} as ActionState);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state]);
  const cats = (isFacility ? FACILITY_CATEGORIES : POINT_CATEGORIES).filter((c) => (REQUEST_CATEGORIES as readonly string[]).includes(c) && (c !== "room_service" || isRoom));

  return (
    <form ref={ref} action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="lang" value={lang} />
      <label className="block">
        <span className="mb-1 block text-sm font-bold text-night">{t.category}</span>
        <select name="category" defaultValue={cats[0]} className="w-full rounded-xl border border-sand-deep bg-white px-3 py-2.5">
          {cats.map((c) => (
            <option key={c} value={c}>{REQUEST_CATEGORY_LABEL[lang][c]}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-bold text-night">{t.message}</span>
        <textarea name="message" required rows={3} minLength={PORTAL_LIMITS.minMessage} maxLength={PORTAL_LIMITS.maxMessage} className="w-full rounded-xl border border-sand-deep bg-white px-3 py-2.5" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-bold text-night">{t.guestName}</span>
          <input name="guest_name" maxLength={PORTAL_LIMITS.maxGuestName} autoComplete="name" className="w-full rounded-xl border border-sand-deep bg-white px-3 py-2.5" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-bold text-night">{t.contact}</span>
          <input name="contact" maxLength={PORTAL_LIMITS.maxContact} autoComplete="tel" className="w-full rounded-xl border border-sand-deep bg-white px-3 py-2.5" />
        </label>
      </div>
      {state.error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm font-bold text-danger">{state.error}</p>
      )}
      {state.ok && state.message && (
        <p role="status" className="rounded-xl bg-ok-soft px-3 py-2 text-sm font-bold text-ok">{state.message}</p>
      )}
      <Submit label={t.sendRequest} pending={t.sending} />
    </form>
  );
}

function Submit({ label, pending }: { label: string; pending: string }) {
  const s = useFormStatus();
  return (
    <button type="submit" disabled={s.pending} className="min-h-12 w-full rounded-2xl border-2 bg-white font-bold disabled:opacity-60" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
      {s.pending ? pending : label}
    </button>
  );
}
