import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, Field, Input, LinkButton, PageHeader, Select } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { inviteMember, revokeInvitation, setPin, updateMember } from "../actions";
import { InviteLink } from "./invite-link";

export const metadata = { title: "Team" };
export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const ctx = await requirePerm("members.manage");
  const supabase = await createClient();
  const [{ data: members }, { data: roles }, { data: invites }] = await Promise.all([
    supabase.from("memberships").select("id, user_id, role_id, active, all_facilities, facility_ids, created_at").eq("org_id", ctx.org.id).order("created_at"),
    supabase.from("roles").select("id, key, name, permissions").eq("org_id", ctx.org.id).order("is_system", { ascending: false }),
    supabase.from("invitations").select("id, email, role_id, token, expires_at, accepted_at").eq("org_id", ctx.org.id).is("accepted_at", null).order("created_at", { ascending: false }),
  ]);
  const ids = (members ?? []).map((m) => m.user_id);
  const { data: people } = ids.length ? await supabase.from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
  const person = new Map((people ?? []).map((p) => [p.id, p]));
  const roleName = new Map((roles ?? []).map((r) => [r.id, r.name]));
  const isOwner = ctx.role.key === "owner";
  const assignable = (roles ?? []).filter((r) => r.key !== "owner" || isOwner);
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";

  return (
    <div>
      <PageHeader title="Team" subtitle="Ogni persona ha un accesso personale. Il ruolo decide cosa vede." action={<LinkButton href="/gestione" variant="secondary">Gestione</LinkButton>} />
      <div className="grid gap-5 lg:grid-cols-[1fr_21rem]">
        <div className="space-y-3">
          {(members ?? []).map((m) => {
            const p = person.get(m.user_id);
            const self = m.id === ctx.membershipId;
            return (
              <Card key={m.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-night">{p?.full_name ?? "—"} {self && <span className="text-muted">(tu)</span>}</p>
                    <p className="text-sm text-muted">{p?.email} · {m.all_facilities ? "tutte le strutture" : `${(m.facility_ids as string[]).length} struttura/e`}</p>
                  </div>
                  <Badge tone={m.active ? "teal" : "danger"}>{m.active ? roleName.get(m.role_id) : "Disattivato"}</Badge>
                </div>
                {!self && (
                  <ActionForm action={updateMember} className="mt-3 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="membership_id" value={m.id} />
                    <Field label="Ruolo">
                      <Select name="role_id" defaultValue={m.role_id} className="w-52">
                        {assignable.map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </Select>
                    </Field>
                    <label className="flex min-h-11 items-center gap-2 text-sm font-bold text-night">
                      <input type="checkbox" name="active" defaultChecked={m.active} className="h-5 w-5 min-h-0 accent-teal" /> Attivo
                    </label>
                    <SubmitButton variant="secondary">Salva</SubmitButton>
                  </ActionForm>
                )}
                <ActionForm action={setPin} resetOnSuccess className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="membership_id" value={m.id} />
                  <Field label="PIN postazioni (4–6 cifre)">
                    <Input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,6}" autoComplete="new-password" className="w-36" />
                  </Field>
                  <SubmitButton variant="ghost">Imposta PIN</SubmitButton>
                </ActionForm>
              </Card>
            );
          })}
        </div>

        <div className="space-y-5">
          <Card className="overflow-hidden">
            <CardHeader title="Invita una persona" hint={`Accesso a ${ctx.facility.name} o a tutte le strutture.`} />
            <ActionForm action={inviteMember} resetOnSuccess className="space-y-3 p-4">
              {(s) => (
                <>
                  <Field label="Email">
                    <Input name="email" type="email" inputMode="email" required />
                  </Field>
                  <Field label="Ruolo">
                    <Select name="role_id" defaultValue={assignable.find((r) => r.key === "staff")?.id}>
                      {assignable.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Accesso">
                    <Select name="scope" defaultValue="facility">
                      <option value="facility">Solo {ctx.facility.name}</option>
                      <option value="all">Tutte le strutture</option>
                    </Select>
                  </Field>
                  <fieldset>
                    <legend className="mb-1 text-sm font-bold text-night">Reparti</legend>
                    <div className="flex flex-wrap gap-2">
                      {ctx.departments.map((d) => (
                        <label key={d.id} className="flex items-center gap-1.5 rounded-lg bg-warm px-2.5 py-1.5 text-sm">
                          <input type="checkbox" name="department_ids" value={d.id} className="min-h-0 accent-teal" /> {d.name}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <SubmitButton full>Crea invito</SubmitButton>
                  {s.ok && <p className="text-xs text-muted">Il link vale 14 giorni e funziona solo con quell’email.</p>}
                </>
              )}
            </ActionForm>
          </Card>

          {(invites ?? []).length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader title="Inviti in attesa" />
              {(invites ?? []).map((i) => (
                <div key={i.id} className="border-b border-sand px-4 py-3 text-sm last:border-b-0">
                  <p className="font-bold text-night">{i.email}</p>
                  <p className="text-muted">{roleName.get(i.role_id)} · scade {formatDateTime(i.expires_at, ctx.facility.timezone)}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <InviteLink url={`${site}/invito/${i.token}`} />
                    <form action={revokeInvitation}>
                      <input type="hidden" name="id" value={i.id} />
                      <button className="min-h-9 rounded-lg px-2 text-xs font-bold text-danger hover:bg-danger-soft">Revoca</button>
                    </form>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
