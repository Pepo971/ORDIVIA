import { Logo } from "@/components/logo";
import { LinkButton } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo />
      <h1 className="font-display text-2xl font-semibold text-night">Pagina non trovata</h1>
      <p className="text-muted">L’elemento non esiste o non hai i permessi per vederlo.</p>
      <LinkButton href="/oggi">Torna a Oggi</LinkButton>
    </main>
  );
}
