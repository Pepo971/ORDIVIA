// «Oggi»: trasforma segnali operativi eterogenei in una lista unica, ordinata per priorità.
// Regola: prima ciò che scade e non è recuperabile (cut-off ordini), poi ciò che blocca altri, poi il resto.

export type TodayKind =
  | "ordine_da_inviare"   // c'è un cut-off fornitore vicino e prodotti sotto scorta
  | "ordine_da_approvare" // ordine in bozza o richieste reparto in attesa
  | "richiesta_reparto"
  | "consegna_attesa"
  | "sotto_scorta"
  | "attivita_scaduta"
  | "attivita_oggi"
  | "attivita_da_verificare"
  | "haccp"                // temperature da registrare, etichette in scadenza
  | "richiesta_personale" // ferie e cambi turno da decidere o accettare
  | "richiesta_ospite"    // richieste dal portale QR o registrate dallo staff
  | "manutenzione";       // guasti aperti urgenti o ad alta priorità

export interface TodayItem {
  id: string;
  kind: TodayKind;
  title: string;
  detail?: string;
  /** Istante entro cui agire, se esiste */
  deadline?: Date;
  href: string;
  /** Peso aggiuntivo (es. numero di prodotti coinvolti) */
  weight?: number;
}

const BASE: Record<TodayKind, number> = {
  ordine_da_inviare: 90,
  attivita_scaduta: 80,
  ordine_da_approvare: 70,
  consegna_attesa: 60,
  richiesta_reparto: 55,
  attivita_da_verificare: 45,
  attivita_oggi: 40,
  sotto_scorta: 35,
  haccp: 65,
  richiesta_personale: 50,
  richiesta_ospite: 75,
  manutenzione: 58,
};

export function todayScore(item: TodayItem, now: Date = new Date()): number {
  let score = BASE[item.kind];
  if (item.deadline) {
    const hours = (item.deadline.getTime() - now.getTime()) / 3600_000;
    if (hours <= 0) score += 25;
    else if (hours <= 2) score += 20;
    else if (hours <= 6) score += 10;
    else if (hours <= 24) score += 4;
  }
  score += Math.min(item.weight ?? 0, 10);
  return score;
}

export function rankToday(items: TodayItem[], now: Date = new Date()): TodayItem[] {
  return [...items].sort((a, b) => {
    const d = todayScore(b, now) - todayScore(a, now);
    if (d !== 0) return d;
    const da = a.deadline?.getTime() ?? Infinity;
    const db = b.deadline?.getTime() ?? Infinity;
    return da - db;
  });
}
