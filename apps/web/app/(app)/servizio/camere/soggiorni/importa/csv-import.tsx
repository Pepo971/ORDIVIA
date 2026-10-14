"use client";

import { useMemo, useState } from "react";
import { parseStaysCsv } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, Textarea } from "@/components/ui";
import { importStays } from "../../actions";

const EXAMPLE = "camera;nome;arrivo;partenza;adulti\n101;Rossi Mario;14/10/2026;17/10/2026;2\n102;Bianchi Anna;15/10/2026;16/10/2026;1";

/** Anteprima con validazione riga per riga: si importa solo quando non ci sono errori. */
export function CsvImport({ rooms }: { rooms: string[] }) {
  const [text, setText] = useState("");
  const res = useMemo(() => (text.trim() ? parseStaysCsv(text, rooms) : null), [text, rooms]);
  const canImport = !!res && res.errors.length === 0 && res.rows.length > 0;

  return (
    <div className="space-y-4">
      <ActionForm action={importStays} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-bold text-night">Righe da importare</span>
          <Textarea
            name="csv"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={EXAMPLE}
            className="font-mono text-sm"
            spellCheck={false}
          />
          <span className="mt-1 block text-xs text-muted">
            Una riga per soggiorno: camera; nome; arrivo; partenza; adulti (facoltativi: bambini; riferimento PMS). Separatore «;», tab o «,». Date gg/mm/aaaa o aaaa-mm-gg.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingText="Importo…">{canImport ? `Importa ${res!.rows.length} soggiorni` : "Importa"}</SubmitButton>
          {!text && (
            <button type="button" className="text-sm font-bold text-teal-deep" onClick={() => setText(EXAMPLE)}>
              Inserisci un esempio
            </button>
          )}
          {res && res.errors.length > 0 && <span className="text-sm font-bold text-danger">Correggi le righe in rosso per importare.</span>}
        </div>
      </ActionForm>

      {res && (
        <Card className="overflow-hidden">
          <CardHeader
            title="Anteprima"
            hint={`${res.rows.length} righe valide · ${res.errors.length} con errori${res.skippedHeader ? " · intestazione ignorata" : ""}`}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="bg-warm text-left text-xs text-muted uppercase">
                <tr>
                  <th className="px-3 py-2">Riga</th>
                  <th className="px-3 py-2">Camera</th>
                  <th className="px-3 py-2">Ospite</th>
                  <th className="px-3 py-2">Arrivo</th>
                  <th className="px-3 py-2">Partenza</th>
                  <th className="px-3 py-2">Ospiti</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand">
                {[...res.rows.map((r) => ({ line: r.line, row: r, err: null as string | null, raw: "" })), ...res.errors.map((e) => ({ line: e.line, row: null, err: e.error, raw: e.raw }))]
                  .sort((a, b) => a.line - b.line)
                  .map((x) =>
                    x.row ? (
                      <tr key={x.line}>
                        <td className="px-3 py-2 text-muted">{x.line}</td>
                        <td className="px-3 py-2 font-bold">{x.row.room}</td>
                        <td className="px-3 py-2">{x.row.guest_name}</td>
                        <td className="px-3 py-2">{x.row.arrival.split("-").reverse().join("/")}</td>
                        <td className="px-3 py-2">{x.row.departure.split("-").reverse().join("/")}</td>
                        <td className="px-3 py-2">
                          {x.row.adults}
                          {x.row.children ? ` + ${x.row.children}` : ""}
                        </td>
                      </tr>
                    ) : (
                      <tr key={x.line} className="bg-danger-soft/60">
                        <td className="px-3 py-2 text-muted">{x.line}</td>
                        <td colSpan={5} className="px-3 py-2">
                          <Badge tone="danger">{x.err}</Badge> <span className="font-mono text-xs text-muted">{x.raw.slice(0, 80)}</span>
                        </td>
                      </tr>
                    ),
                  )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
