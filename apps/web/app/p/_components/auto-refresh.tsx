"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Ricarica periodicamente la pagina (stato dell'ordine) finché è visibile. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
