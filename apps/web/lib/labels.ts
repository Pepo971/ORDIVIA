export type Tone = "neutral" | "teal" | "warn" | "danger" | "ok" | "night";

export const PO_STATUS: Record<string, { label: string; tone: Tone }> = {
  bozza: { label: "Bozza", tone: "neutral" },
  approvato: { label: "Approvato", tone: "teal" },
  inviato: { label: "Inviato", tone: "night" },
  parziale: { label: "Arrivato in parte", tone: "warn" },
  ricevuto: { label: "Ricevuto", tone: "ok" },
  annullato: { label: "Annullato", tone: "danger" },
};

export const REQ_STATUS: Record<string, { label: string; tone: Tone }> = {
  bozza: { label: "Bozza", tone: "neutral" },
  inviata: { label: "Da valutare", tone: "warn" },
  approvata: { label: "Approvata", tone: "teal" },
  rifiutata: { label: "Rifiutata", tone: "danger" },
  convertita: { label: "In ordine", tone: "ok" },
};

export const TASK_STATUS: Record<string, { label: string; tone: Tone }> = {
  assegnata: { label: "Da vedere", tone: "warn" },
  vista: { label: "Vista", tone: "neutral" },
  iniziata: { label: "In corso", tone: "teal" },
  completata: { label: "Completata", tone: "ok" },
  verificata: { label: "Verificata", tone: "night" },
  annullata: { label: "Annullata", tone: "danger" },
};

export const MOVEMENT_LABEL: Record<string, string> = {
  carico: "Carico",
  scarico: "Scarico",
  trasferimento: "Trasferimento",
  rettifica: "Rettifica inventario",
  spreco: "Spreco",
  reso: "Reso",
  scaduto: "Scaduto",
};

export const UNITS = ["pz", "kg", "g", "l", "ml"] as const;
