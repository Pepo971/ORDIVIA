export interface ActionState {
  ok?: boolean;
  error?: string;
  message?: string;
  /** Errori per campo (validazione) */
  fields?: Record<string, string>;
}

export const initialState: ActionState = {};

interface PgLikeError {
  code?: string;
  message?: string;
}

/** Traduce un errore del database in un messaggio comprensibile per chi è in servizio. */
export function humanError(e: PgLikeError | null | undefined, fallback = "Operazione non riuscita. Riprova."): string {
  if (!e) return fallback;
  switch (e.code) {
    case "42501":
      return e.message && !e.message.startsWith("new row violates") && !e.message.startsWith("permission denied")
        ? e.message
        : "Non hai i permessi per questa operazione.";
    case "23505":
      return "Esiste già un elemento con questi dati.";
    case "23503":
      return "Riferimento non valido: l'elemento collegato non esiste più.";
    case "23514":
    case "22P02":
      return "Alcuni valori non sono validi.";
    case "PGRST116":
      return "Elemento non trovato.";
    case "P0001":
    case "P0002":
    case "22023":
    case "28000":
      return e.message ?? fallback;
    default:
      if (e.message?.includes("row-level security")) return "Non hai i permessi per questa operazione.";
      return fallback;
  }
}
