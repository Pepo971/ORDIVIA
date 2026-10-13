"use client";

import { useEffect } from "react";
import { markSeen } from "./actions";

/** Registra «vista» quando la persona apre davvero l'elenco (non al semplice rendering lato server). */
export function MarkSeen({ ids }: { ids: string[] }) {
  const key = ids.join(",");
  useEffect(() => {
    if (key) void markSeen(key.split(","));
  }, [key]);
  return null;
}
