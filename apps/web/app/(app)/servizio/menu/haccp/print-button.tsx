"use client";

import { useEffect } from "react";
import { buttonClass } from "@/components/ui";

/** Stampa la pagina (etichetta termica). Con `auto` apre subito la finestra di stampa. */
export function PrintButton({ auto = false, label = "Stampa etichetta" }: { auto?: boolean; label?: string }) {
  useEffect(() => {
    if (!auto) return;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [auto]);
  return (
    <button type="button" onClick={() => window.print()} className={buttonClass("primary")}>
      {label}
    </button>
  );
}
