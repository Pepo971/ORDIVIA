"use client";

import { useState } from "react";

export function CoversStepper({ initial = 2, name = "covers" }: { initial?: number; name?: string }) {
  const [n, setN] = useState(Math.max(0, initial));
  return (
    <div className="flex items-center justify-between gap-3">
      <button type="button" aria-label="Meno coperti" onClick={() => setN((v) => Math.max(0, v - 1))} className="h-14 w-14 rounded-xl border border-sand-deep bg-white text-2xl font-bold text-night active:bg-sand">
        −
      </button>
      <input
        name={name}
        type="number"
        inputMode="numeric"
        min={0}
        max={500}
        value={n}
        onChange={(e) => setN(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
        className="h-14 w-24 rounded-xl border border-sand-deep text-center font-display text-3xl font-semibold text-night"
        aria-label="Coperti"
      />
      <button type="button" aria-label="Più coperti" onClick={() => setN((v) => Math.min(500, v + 1))} className="h-14 w-14 rounded-xl bg-night text-2xl font-bold text-warm active:bg-night-2">
        +
      </button>
    </div>
  );
}
