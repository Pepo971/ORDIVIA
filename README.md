# Ordivia

**Hospitality, in order.** Il sistema operativo per lidi, ristoranti, hotel, camping e strutture con più servizi: tutta la struttura lavora nello stesso sistema, ognuno vede solo ciò che gli serve.

Questo repository contiene la **release v1 — Fondamenta + Acquisti e Magazzino** (vedi `docs/`).

## Cosa fa oggi

| Area | Funzioni |
| --- | --- |
| Fondamenta | Multi-azienda, multi-struttura, reparti; ruoli di sistema con permessi granulari; inviti con link; PIN personali per postazioni condivise; registro operazioni append-only |
| Oggi | Lista unica e ordinata per priorità: ordini da inviare prima del cut-off, consegne attese, richieste dei reparti, sotto scorta, attività in ritardo o da verificare |
| Acquisti | Fornitori con giorni di consegna, ora limite e minimi; listini a confezione con storico prezzi e segnalazione aumenti; richieste dei reparti → ordini per fornitore; riordino suggerito; approvazione e invio (email, WhatsApp, testo) |
| Ricezione | Spunta da ordine, quantità ricevute, prezzo del documento, lotto, scadenza, anomalie; conferma atomica che carica il magazzino, aggiorna costo medio ponderato e storico prezzi; consegne parziali |
| Magazzino | Magazzini per reparto, registro movimenti immutabile, scarichi, sprechi, resi, scaduti, trasferimenti atomici, carichi senza ordine, inventario alla cieca con rettifiche, scorte minime e livello di riordino |
| Lavoro | Attività assegnate con stati tracciati (assegnata → vista → iniziata → completata → verificata), foto obbligatoria, verifica del responsabile |

## Architettura

- `supabase/migrations` — schema PostgreSQL con **Row-Level Security** su ogni tabella: l'isolamento tra aziende è nel database, non nel codice. Le operazioni con più passaggi (ricezione, ordini, inventario, trasferimenti, attività) sono RPC transazionali che verificano i permessi.
- `supabase/tests` — test SQL di sicurezza e dei flussi (isolamento, permessi, costi, ordini, inventario, PIN, audit).
- `packages/domain` — logica pura e testata: finestre d'ordine con fuso orario e ora legale, riordino, variazioni di prezzo, priorità di «Oggi», navigazione per ruolo.
- `apps/web` — Next.js 15 (App Router, Server Components, Server Actions), PWA installabile, mobile first.

## Sviluppo

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # URL e chiave pubblica Supabase
pnpm dev                                      # http://localhost:3000

pnpm test        # test di dominio (vitest)
pnpm test:db     # migrazioni + test di sicurezza su un Postgres locale usa-e-getta
pnpm build
```

`pnpm test:db` richiede i binari di PostgreSQL 15+ (`initdb`, `pg_ctl`, `psql`).

## Deploy

1. Applica le migrazioni in ordine sul progetto Supabase (UE).
2. In Supabase Auth imposta l'URL del sito e aggiungi `https://<dominio>/auth/callback` ai redirect consentiti.
3. Su Vercel imposta `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` e usa `apps/web` come root del progetto.

## Limiti dichiarati di questa release

- Gli inviti generano un link da condividere: l'invio email automatico arriverà con il provider transazionale.
- La schermata kiosk per le postazioni condivise usa già PIN e permessi (`verify_station_pin`), l'interfaccia arriva con Sala e Cassa (v2).
- OCR dei DDT e fatture SDI: previsti in v1.1; oggi numero, data, prezzi, lotti e scadenze si inseriscono in spunta.
- Nessuna funzione fiscale: Ordivia non è un registratore telematico.
