"use client";

import { useEffect } from "react";

/** Svuota il carrello salvato nel browser dopo un ordine andato a buon fine. */
export function ClearCart({ token }: { token: string }) {
  useEffect(() => {
    try {
      window.localStorage.removeItem(`ordivia-cart-${token}`);
    } catch {
      // archiviazione non disponibile
    }
  }, [token]);
  return null;
}
