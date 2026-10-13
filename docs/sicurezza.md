# Modello di sicurezza

## Principi

1. **L'isolamento tra aziende è nel database.** Ogni tabella di dominio ha `org_id` e una policy RLS. Le chiavi esterne composite `(id, org_id)` impediscono di collegare righe di aziende diverse anche a chi ha permessi di scrittura.
2. **L'interfaccia nasconde, il database decide.** I permessi in `lib/context.ts` servono solo a mostrare o nascondere; ogni scrittura passa da RLS o da una RPC che ricontrolla `app.has_facility_perm()`.
3. **I passaggi critici sono atomici.** Ricezione, conversione richieste → ordini, transizioni d'ordine, inventario, trasferimenti e avanzamento attività sono funzioni PL/pgSQL transazionali.
4. **I registri sono immutabili.** `stock_movements` e `audit_log` non hanno permessi di update/delete per i client; l'audit è scritto solo da trigger.
5. **I dati economici sono separati.** `stock_movements.unit_cost` non è leggibile dai client; costi medi, storico prezzi e valorizzazione richiedono `finance.view` (o `purchasing.approve` per i costi).

## Permessi

| Permesso | Sensibile | Note |
| --- | --- | --- |
| `org.manage` | | strutture, reparti, moduli |
| `members.manage` | | inviti, ruoli, PIN |
| `roles.manage` | | ruoli personalizzati (i ruoli di sistema non sono modificabili) |
| `finance.view` | sì | costi, valorizzazione, storico prezzi |
| `audit.view` | | registro operazioni |
| `tasks.manage` / `tasks.perform` | | assegnare e verificare / eseguire |
| `suppliers.manage` | | fornitori e listini |
| `purchasing.request` / `.approve` / `.send` | | richieste, approvazione e conversione, invio |
| `receiving.perform` | | ricezione e carichi senza ordine |
| `inventory.view` / `.move` / `.count` | | giacenze, movimenti, inventario |
| `stations.manage` | | postazioni condivise |

Il titolare ha sempre tutti i permessi; deve restare almeno un titolare attivo e solo un titolare può assegnare o togliere quel ruolo.

## Postazioni condivise

`verify_station_pin(postazione, pin)` restituisce la persona e i permessi effettivi = permessi del ruolo ∩ permessi consentiti alla postazione. Il PIN è salvato con bcrypt, non è mai leggibile dai client e non finisce nell'audit.

## Test

`supabase/tests/10_isolation_and_flows.sql` verifica, tra gli altri: che un'azienda non veda né modifichi dati di un'altra (catalogo, fornitori, prezzi, giacenze, audit, RPC), che un collaboratore non possa promuoversi o leggere prezzi, che i movimenti siano immutabili, che i carichi passino solo da ricezione o carico manuale, che i trasferimenti non possano creare merce, che gli inviti funzionino solo per l'email destinataria.
