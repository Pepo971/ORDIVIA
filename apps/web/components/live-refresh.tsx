"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";

/**
 * Ricarica i dati della pagina quando cambiano le tabelle indicate (Supabase Realtime, filtrato per struttura).
 * Le righe che l'utente non può vedere non arrivano: Realtime applica le stesse policy RLS.
 * Con `intervalMs` fa anche un aggiornamento periodico di sicurezza (rete instabile, es. in spiaggia).
 */
export function LiveRefresh({ tables, facilityId, intervalMs = 30000 }: { tables: string[]; facilityId: string; intervalMs?: number }) {
  const router = useRouter();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = tables.join(",");
  useEffect(() => {
    const refresh = () => {
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        router.refresh();
      }, 300);
    };
    const supabase = browserClient();
    const channel = supabase.channel(`live-${facilityId}-${key}`);
    for (const t of key.split(",")) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: t, filter: `facility_id=eq.${facilityId}` }, refresh);
    }
    channel.subscribe();
    const timer = intervalMs > 0 ? setInterval(refresh, intervalMs) : null;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      supabase.removeChannel(channel);
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [key, facilityId, intervalMs, router]);
  return null;
}
