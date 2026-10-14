"use client";

import { useState } from "react";

export function CopyText({ text, label = "Copia testo" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex min-h-11 items-center rounded-xl border border-sand-deep bg-white px-4 text-sm font-bold text-night hover:border-night-3"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Copiato" : label}
    </button>
  );
}
