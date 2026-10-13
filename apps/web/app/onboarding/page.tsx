import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Logo } from "@/components/logo";
import { Card, Field, Input } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { FACILITY_TYPES } from "@/lib/format";
import { createOrganization } from "./actions";

export const metadata = { title: "Configura la struttura" };

const TYPE_HINTS: Record<string, string> = {
  lido: "Bar, cucina, spiaggia, magazzino",
  ristorante: "Cucina, sala, bar, magazzino",
  hotel: "Reception, housekeeping, cucina, bar, manutenzione",
  camping: "Reception, market, bar, ristorante, manutenzione",
  resort: "Tutti i reparti, spiaggia inclusa",
  ibrida: "Cucina, bar, sala: poi aggiungi tu",
};

export default async function Onboarding() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { count } = await supabase.from("memberships").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("active", true);
  if ((count ?? 0) > 0) redirect("/oggi");

  return (
    <main className="mx-auto max-w-xl px-5 py-10">
      <Logo />
      <h1 className="mt-8 font-display text-[2rem] leading-tight font-semibold text-night">Configuriamo la tua struttura</h1>
      <p className="mt-2 text-muted">
        Il tipo di struttura decide reparti, magazzini e terminologia iniziali. Potrai cambiare tutto dopo. Se un collega ti ha invitato, apri invece il link
        dell’invito.
      </p>
      <Card className="mt-6 p-5">
        <ActionForm action={createOrganization} className="space-y-5">
          <Field label="Azienda" hint="La società che acquista Ordivia: potrà gestire più strutture.">
            <Input name="org_name" placeholder="Es. Azzurro Hospitality srl" required />
          </Field>
          <Field label="Prima struttura">
            <Input name="facility_name" placeholder="Es. Lido Azzurro" required />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-bold text-night">Che tipo di struttura è?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(FACILITY_TYPES).map(([key, label], i) => (
                <label
                  key={key}
                  className="flex cursor-pointer flex-col rounded-xl border border-sand-deep bg-white p-3 has-[:checked]:border-teal has-[:checked]:bg-teal-soft/50 has-[:checked]:ring-2 has-[:checked]:ring-teal/30"
                >
                  <span className="flex items-center gap-2 font-bold text-night">
                    <input type="radio" name="facility_type" value={key} defaultChecked={i === 0} className="min-h-0 accent-teal" />
                    {label}
                  </span>
                  <span className="mt-1 pl-6 text-xs text-muted">{TYPE_HINTS[key]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <SubmitButton full pendingText="Creazione in corso…">
            Crea e inizia
          </SubmitButton>
        </ActionForm>
      </Card>
    </main>
  );
}
