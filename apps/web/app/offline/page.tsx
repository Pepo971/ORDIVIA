import { Logo } from "@/components/logo";

export const metadata = { title: "Offline" };

export default function Offline() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo />
      <h1 className="font-display text-2xl font-semibold text-night">Sei offline</h1>
      <p className="text-muted">Ordivia non riesce a raggiungere il server. Le modifiche non sono state inviate: riprova quando torna la connessione.</p>
    </main>
  );
}
