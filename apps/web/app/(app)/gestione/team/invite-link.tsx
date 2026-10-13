"use client";

import { useState } from "react";

/** Il link è relativo se NEXT_PUBLIC_SITE_URL non è impostato: lo completiamo con l'origine corrente. */
export function InviteLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const full = () => (url.startsWith("http") ? url : `${window.location.origin}${url}`);
  return (
    <>
      <button
        type="button"
        className="min-h-9 rounded-lg border border-sand-deep px-2.5 text-xs font-bold text-night"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(full());
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* clipboard non disponibile */
          }
        }}
      >
        {copied ? "Copiato" : "Copia link"}
      </button>
      <button
        type="button"
        className="min-h-9 rounded-lg border border-sand-deep px-2.5 text-xs font-bold text-night"
        onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`Ti ho invitato su Ordivia: ${full()}`)}`, "_blank", "noopener")}
      >
        WhatsApp
      </button>
    </>
  );
}
