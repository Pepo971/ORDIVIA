"use client";

import { Button, Card } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card className="mx-auto max-w-lg p-6 text-center">
      <h1 className="font-display text-xl font-semibold text-night">Qualcosa non ha funzionato</h1>
      <p className="mt-2 text-sm text-muted">
        {error.message?.startsWith("Configurazione") || error.message?.startsWith("Nessuna struttura") ? error.message : "Non siamo riusciti a caricare questa pagina. I tuoi dati non sono stati modificati."}
      </p>
      {error.digest && <p className="mt-2 text-xs text-muted">Codice: {error.digest}</p>}
      <Button className="mt-4" onClick={reset}>Riprova</Button>
    </Card>
  );
}
