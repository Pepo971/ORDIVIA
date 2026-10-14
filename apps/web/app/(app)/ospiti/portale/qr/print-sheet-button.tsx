"use client";

import { buttonClass } from "@/components/ui";

export function PrintSheetButton() {
  return (
    <button type="button" onClick={() => window.print()} className={buttonClass("primary")}>
      Stampa foglio A4
    </button>
  );
}
