# Pocket Dashboard Technical Design

## Stato Attuale della Codebase

Questa codebase e il prodotto Pocket analytics gestito da **Kleomedes**. Il progetto non e piu supervisionato da Pocket Network Foundation e i precedenti vincoli PNF su neutralita, naming dei provider o separazione obbligatoria public/private non sono requisiti correnti.

Le decisioni di prodotto possono quindi includere ranking, provider detail, staking intelligence o altri insight nominali quando utili. Restano invece vincolanti i requisiti tecnici: correttezza rispetto al protocollo, provenienza e freschezza dei dati, sicurezza, semantica onesta delle metriche e operabilita.

Il branch `main` e il prodotto canonico. Il branch `provider` e materiale legacy/reference da cui si puo portare funzionalita senza trattarlo come un confine di policy.

In particolare oggi:

- l'applicazione e una app Next.js servita separatamente da un indexer Node.js persistente
- l'indexer segue i nuovi blocchi via WebSocket CometBFT e usa HTTP RPC per recuperare `/block_results` e colmare gap
- la persistenza locale e un SQLite leggero usato per settlement facts, metadata e snapshot della dashboard
- il modello interno puo raggruppare supplier e provider domain; il livello di identita esposto e una decisione del prodotto
- il legacy worker Poktscan/RPC rimane fallback temporaneo finche il percorso indexer-first non e completamente ritirato

Questo documento e la fonte per protocol facts, data semantics e invarianti tecnici. Per stato prodotto/governance fa fede il README; per lavoro approvato fanno fede issue e PR GitHub.

## Scopo

Definire l'architettura tecnica della dashboard Kleomedes per Pocket Network, inclusi ingestion, persistenza, metriche, API e superfici provider/service.

Le scelte su quali insight rendere pubblici o nominali non sono vincoli di protocollo e vanno prese come decisioni prodotto esplicite.

## Mappa Concettuale del Protocollo

### Provider = Supplier

Nel codice Shannon il provider e modellato come `Supplier`.

Riferimento principale:

- `proto/pocket/shared/supplier.proto:13-36`

Campi importanti per la dashboard:

- `owner_address`: soggetto economico di default
- `operator_address`: identita operativa del nodo/provider
- `services`: elenco dei service supportati dal supplier
- `service_config_history`: storico configurazioni lato supplier

### Chain = Service

La "chain" da mostrare in UI corrisponde pragmaticamente a `Service`.

Riferimento principale:

- `proto/pocket/shared/service.proto:13-37`

Campi importanti:

- `id`: identificatore univoco del service, da usare come dimensione primaria
- `name`: label leggibile per la UI
- `compute_units_per_relay`: utile per capire la monetizzazione del service
- `owner_address`: proprietario del service, rilevante per il reward split

### Sessione, claim, proof, settlement

La pipeline economica rilevante e:

1. un supplier serve relays in una sessione
2. crea una claim
3. eventualmente sottomette una proof
4. la claim viene settlata in `x/tokenomics` durante l'`EndBlocker`

Riferimenti chiave:

- creazione claim: `x/proof/keeper/msg_server_create_claim.go`
- calcolo relays / compute units / claimed upokt: `x/proof/types/claim.go`
- settlement: `x/tokenomics/keeper/settle_pending_claims.go`
- end blocker tokenomics: `x/tokenomics/module/abci.go`

## Perche la Dashboard deve essere Event-Driven

### Mancano query aggregate native per RC1

`x/tokenomics` espone praticamente solo la query dei params.

Riferimento:

- `proto/pocket/tokenomics/query.proto`

Questo significa che il chain state non offre direttamente:

- revenue per supplier
- relays per supplier per service
- aggregati per finestre temporali

Servono quindi:

- indicizzazione degli eventi
- persistenza locale
- aggregazioni applicative
- materializzazione aggressiva delle cache JSON consumate dalla UI

### L'evento corretto e `EventClaimSettled`

L'evento piu importante per RC1 e:

- `proto/pocket/tokenomics/event.proto:77-180`

Campi cruciali presenti gia nell'evento:

- `num_relays`
- `service_id`
- `supplier_operator_address`
- `supplier_owner_address`
- `reward_distribution`
- `reward_distribution_detailed`
- `settled_upokt`
- `minted_upokt`
- `overservicing_loss_upokt`
- `deflation_loss_upokt`
- `session_id`
- `session_end_block_height`

### Insight critico: non usare tx events come sorgente primaria

`EventClaimSettled` viene emesso durante settlement in `EndBlocker`:

- `x/tokenomics/module/abci.go:15-27`
- `x/tokenomics/keeper/settle_pending_claims.go:914-926`

Conseguenza pratica:

- l'indicizzazione non deve basarsi solo su tx search o sugli eventi delle tx utente
- il worker deve leggere i `block_results` e gli `end_block_events` blocco per blocco

Questo e il punto implementativo piu importante dell'intero progetto. L'indexer deve salvare facts compatti e coerenti; eventuale hashing, naming o dettaglio per-provider deve essere una scelta esplicita del modello dati e del serializer, non una conseguenza di vecchi vincoli di governance.

## Indexer Runtime Corrente

Il processo `npm run indexer`:

- apre subito il WebSocket live, senza attendere backfill o repair storici
- sincronizza la dimensione `service_dim` via REST in background durante lo startup live
- legge il checkpoint `indexer_state.last_processed_height`
- recupera piccoli gap live via HTTP RPC con catchup bounded e best-effort
- sottoscrive `tm.event='NewBlock'` via WebSocket
- processa ogni height in modo idempotente
- registra coverage per height in `indexed_heights`, con stato `indexed`, `empty` o `failed`
- usa backfill concorrente newest-first per comandi manuali/debug, dando priorita ai blocchi recenti
- ritenta le chiamate RPC fallite su tutto il pool, con backoff configurabile
- ritenta anche a livello di height, così un timeout su `/block_results` o `/block` non interrompe il range
- espone nei log del backfill successi, fallimenti, timeout e latenza media per nodo RPC
- in live mode evita catchup enormi da checkpoint obsoleti e riparte dal tip quando il gap supera la soglia configurata
- in produzione esegue live WebSocket e repair loop in parallelo: il repair trova buchi negli ultimi 45 giorni newest-first e li riempie autonomamente senza bloccare la sync dell'altezza corrente
- rigenera le cache una sola volta a fine catchup/backfill, evitando rebuild costosi ogni pochi blocchi
- scrive `settlement_facts` con retention predefinita di 45 giorni
- rigenera cache UI per `24h`, `7d`, `30d` e history principali

Il vecchio `npm run worker` resta fallback legacy finche il nuovo indexer non e completamente validato in produzione.

## Origine dei Numeri Economici

### Relay count

Il numero di relay associato a una claim deriva dal Merkle sum tree della claim.

Riferimenti:

- `x/proof/types/claim.go:24-34`
- `x/tokenomics/types/settlement_result.go:10-12`

Attenzione:

- `num_relays` non rappresenta necessariamente tutte le request offchain brute-force
- riflette i relay inclusi nella session tree secondo la relay mining difficulty
- il protocollo espone anche `num_estimated_relays` in `EventClaimSettled`

Riferimento:

- `proto/pocket/tokenomics/event.proto:160-180`

Per RC1 e consigliato mostrare `num_relays`, perche e il dato direttamente richiesto e gia esplicito nell'evento.

### Formula del valore economico lordo della claim

`claimed_upokt` deriva da:

- claimed compute units
- relay mining difficulty del service alla session start height
- `compute_units_to_tokens_multiplier`
- `compute_unit_cost_granularity`

Riferimenti:

- `x/proof/types/claim.go:52-91`
- `proto/pocket/shared/params.proto:52-85`
- `x/shared/keeper/params.go:58-86`
- `x/service/keeper/query_relay_mining_difficulty.go:65-92`

### Settlement finale e breakdown economico

Durante il settlement il protocollo puo distinguere fra:

- `claimed_upokt`: valore teorico della claim
- `settled_upokt`: valore dopo cap di overservicing
- `minted_upokt`: valore realmente mintato dopo `mint_ratio`
- `overservicing_loss_upokt`
- `deflation_loss_upokt`

Riferimenti:

- definizione evento: `proto/pocket/tokenomics/event.proto:144-180`
- costruzione evento: `x/tokenomics/types/event_claim_settled.go`
- emissione evento: `x/tokenomics/keeper/settle_pending_claims.go:904-926`

## Come Definire la Revenue del Provider

### Definizione consigliata per RC1

Usare come `provider_revenue_upokt` la somma delle entries in `reward_distribution_detailed` con `op_reason` pari a una distribuzione reward del supplier.

Per il percorso Mint-Equals-Burn oggi rilevante:

- `TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION`

Riferimenti:

- enum op reasons: `proto/pocket/tokenomics/types.proto:63-98`
- reward distribution detailed: `x/tokenomics/types/settlement_result.go:93-107`
- reward supplier: `x/tokenomics/token_logic_module/tlm_relay_burn_equals_mint.go:223-250`
- rev share splitting: `x/tokenomics/token_logic_module/distribution_supplier.go:52-113`

### Perche non usare `minted_upokt`

`minted_upokt` e il valore totale mintato a valle della claim, ma viene poi ripartito tra:

- supplier shareholders
- DAO
- service source owner
- application
- validator/delegator path

Riferimento:

- `x/tokenomics/token_logic_module/tlm_relay_burn_equals_mint.go:186-315`

Quindi `minted_upokt` e utile come metrica diagnostica, ma non come revenue diretta del provider.

### Grain consigliato della metrica

Per RC1:

- chiave primaria provider: `supplier_operator_address`
- dimensione secondaria: `supplier_owner_address`

Motivo:

- il settlement e legato direttamente all'operator address
- i nuovi provider ragionano spesso in termini di supplier node/operator
- owner aggregation multi-operator puo essere aggiunta in RC2

## Temporalita: 24h, 7d, 30d

### Vincoli del protocollo

Pocket Shannon modella il ciclo economico in sessioni e finestre a blocchi:

- session window
- grace period
- claim window
- proof window
- settlement successivo

Riferimenti:

- `proto/pocket/shared/params.proto:15-39`
- `x/shared/types/session.go:3-196`

### Decisione RC1

Per i filtri temporali usare il `block_time` del blocco che contiene `EventClaimSettled`.

Vantaggi:

- semantica unificata per relay e revenue
- i dati sono definitivi e gia arricchiti dal settlement
- niente ambiguita fra attivita operativa e finalizzazione economica

Dato da salvare comunque:

- `session_end_block_height`, per future viste basate sull'esecuzione reale della sessione

### Possibile estensione successiva

Se si vorra una vista "relay realmente eseguiti nel tempo", si potra arricchire ogni settlement con il timestamp del `session_end_block_height` risolvendo l'header del blocco corrispondente.

## Architettura Consigliata

Nota pratica: l'app attuale condensa alcuni di questi ruoli dentro la stessa app Next.js e usa caching locale invece di tabelle analitiche complete. La separazione in componenti qui sotto resta comunque la direzione consigliata se il progetto evolvera oltre la primissima demo pubblica.

## Componenti

### 1. Indexer Worker

Responsabilita:

- legge blocchi in sequenza da una start height
- recupera `block_results` e `block` per ogni height
- estrae `end_block_events`
- filtra `EventClaimSettled`
- salva record raw e record normalizzati

Input esterni:

- CometBFT RPC per `block_results`
- CometBFT RPC per `block`
- LCD/gRPC per arricchimento suppliers/services

### 2. Database analitico-applicativo

Responsabilita:

- persistenza idempotente eventi raw
- query aggregate per finestre temporali
- caching dimensioni supplier e service

### 3. API layer

Responsabilita:

- esporre endpoint semplici per la UI
- convertire `upokt` in formati display-friendly
- applicare filtri `24h`, `7d`, `30d`

### 4. Frontend dashboard

Responsabilita:

- rendere i KPI
- mostrare leaderboard e breakdown
- mantenere UX semplice per utenti non esperti del protocollo

## Schema Dati Consigliato

## Tabella `blocks`

Campi:

- `height bigint primary key`
- `time timestamptz not null`
- `hash text`
- `indexed_at timestamptz`

Uso:

- base per filtri temporali
- join con eventi settlement

## Tabella `claim_settlements`

Grana: una riga per claim settlata.

Chiave naturale consigliata:

- `session_id`
- `supplier_operator_address`

Campi principali:

- `session_id text not null`
- `block_height bigint not null`
- `block_time timestamptz not null`
- `session_end_block_height bigint not null`
- `service_id text not null`
- `application_address text not null`
- `supplier_operator_address text not null`
- `supplier_owner_address text`
- `proof_requirement_int int`
- `claim_proof_status_int int`
- `num_relays numeric(20,0) not null`
- `num_estimated_relays numeric(20,0)`
- `num_claimed_compute_units numeric(20,0)`
- `num_estimated_compute_units numeric(20,0)`
- `claimed_upokt numeric(38,0)`
- `settled_upokt numeric(38,0)`
- `minted_upokt numeric(38,0)`
- `overservicing_loss_upokt numeric(38,0)`
- `deflation_loss_upokt numeric(38,0)`
- `raw_event jsonb not null`

Note:

- salvare i valori monetari come integer `upokt`, non come float
- `raw_event` aiuta debug e reprocessing

## Tabella `claim_settlement_reward_details`

Grana: una riga per elemento di `reward_distribution_detailed`.

Campi:

- `session_id text not null`
- `supplier_operator_address text not null`
- `block_height bigint not null`
- `service_id text not null`
- `recipient_address text not null`
- `op_reason text not null`
- `amount_upokt numeric(38,0) not null`

Uso:

- calcolo preciso della revenue supplier-side
- possibilita di future viste DAO/source owner/application

## Tabella `services_dim`

Campi:

- `service_id text primary key`
- `service_name text`
- `compute_units_per_relay numeric(20,0)`
- `owner_address text`
- `updated_at timestamptz`

Fonte:

- `service.Query/AllServices`
- `service.Query/Service`

Riferimenti:

- `proto/pocket/service/query.proto`
- `x/service/keeper/query_service.go`

## Tabella `suppliers_dim`

Campi:

- `supplier_operator_address text primary key`
- `supplier_owner_address text`
- `stake_upokt numeric(38,0)`
- `services jsonb`
- `updated_at timestamptz`

Fonte:

- `supplier.Query/AllSuppliers`
- `supplier.Query/Supplier`

Riferimenti:

- `proto/pocket/supplier/query.proto`
- `x/supplier/keeper/query_supplier.go`

## Tabella `indexer_state`

Campi:

- `pipeline text primary key`
- `last_indexed_height bigint not null`
- `updated_at timestamptz not null`

Uso:

- resume sicuro del worker

## Pipeline di Ingestion

## Step 1. Scansione blocchi

Per ogni height `h`:

1. leggere header blocco e timestamp
2. leggere `block_results`
3. iterare `end_block_events`
4. filtrare gli eventi `EventClaimSettled`
5. parsare campi e salvare raw payload
6. esplodere `reward_distribution_detailed` in tabella secondaria
7. aggiornare checkpoint `last_indexed_height`

## Step 2. Parsing campi monetari

I campi monetari arrivano come stringhe coin tipo `12345upokt`.

Esempi di campi da parsare:

- `claimed_upokt`
- `settled_upokt`
- `minted_upokt`
- `overservicing_loss_upokt`
- `deflation_loss_upokt`
- `reward_distribution_detailed[].amount`

Linee guida:

- validare che il denom sia sempre `upokt`
- salvare integer in micro-unit
- convertire a POKT solo in UI o API

Riferimento denom:

- `app/pocket/constants.go`

Nota utile dalla documentazione:

- `1 upokt = 10^-6 POKT`: `docusaurus/docs/2_explore/2_account_management/4_check_balance.md:37`

## Step 3. Enrichment suppliers e services

Il settlement event contiene gia il minimo indispensabile, ma la UI avra bisogno di label e metadati.

### Services

Recupero da:

- `service.Query/AllServices`

Riferimenti:

- `proto/pocket/service/query.proto:16-53`
- `x/service/keeper/query_service.go:17-75`

Campi necessari per RC1:

- `id`
- `name`
- `compute_units_per_relay`

### Suppliers

Recupero da:

- `supplier.Query/AllSuppliers`
- opzionalmente `dehydrated=false` per rev share completa

Riferimenti:

- `proto/pocket/supplier/query.proto:17-78`
- `x/supplier/keeper/query_supplier.go:17-251`

Campi necessari per RC1:

- `operator_address`
- `owner_address`
- `stake`
- `services`

## Formule Aggregate RC1

## 1. Relay per chain per provider

Formula:

- `SUM(num_relays)`
- grouped by `supplier_operator_address, service_id`
- filtered by `block_time >= now() - interval`

Query mentale:

```sql
select
  supplier_operator_address,
  service_id,
  sum(num_relays) as relays
from claim_settlements
where block_time >= now() - interval '7 days'
group by 1, 2;
```

## 2. Revenue per provider

Formula consigliata:

- `SUM(amount_upokt)`
- dalla tabella `claim_settlement_reward_details`
- filtrando `op_reason` nelle reason supplier-side
- grouped by `supplier_operator_address`

Per l'attuale percorso Mint-Equals-Burn, la reason chiave e:

- `TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION`

Possibile query:

```sql
select
  supplier_operator_address,
  sum(amount_upokt) as revenue_upokt
from claim_settlement_reward_details
where block_time >= now() - interval '7 days'
  and op_reason in (
    'TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION',
    'TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION'
  )
group by 1;
```

Nota:

- includere anche la global mint reason rende il modello piu robusto a eventuali configurazioni future del protocollo

## API Consigliate

## `GET /api/overview?window=24h|7d|30d`

Ritorna:

- total providers attivi
- total relays
- total provider revenue
- top services per relay

## `GET /api/providers?window=24h|7d|30d`

Ritorna una lista di provider con:

- `supplier_operator_address`
- `supplier_owner_address`
- `revenue_upokt`
- `revenue_pokt`
- `relays_total`
- `services_count`

## `GET /api/providers/:operatorAddress/chains?window=24h|7d|30d`

Ritorna il breakdown per service:

- `service_id`
- `service_name`
- `relays`
- `revenue_upokt`

## UI RC1 Consigliata

## Vista overview

Componenti:

- time selector `24h | 7d | 30d`
- KPI `provider revenue`, `relays`, `active providers`, `active chains`
- leaderboard top provider per revenue
- chart top chains per relay

## Vista provider table

Colonne minime:

- provider
- owner
- revenue
- relays
- chains served

## Vista provider detail

Selezionato un provider:

- header con operator e owner
- tabella service breakdown
- eventuali metriche secondarie `minted`, `overservicing loss`, `deflation loss`

## Verifiche da Fare Durante lo Sviluppo

## 1. Verifica evento corretto

Campionare un blocco reale e confermare:

- presenza di `EventClaimSettled` in `end_block_events`
- assenza di dipendenza da tx search per il settlement

## 2. Verifica revenue supplier-side

Per un evento campione controllare che:

- somma delle righe supplier-side in `reward_distribution_detailed`
- coincida con il totale distribuito al supplier nel TLM

Riferimenti:

- `x/tokenomics/token_logic_module/tlm_relay_burn_equals_mint.go:223-250`
- `x/tokenomics/token_logic_module/distribution_supplier.go:52-113`

## 3. Verifica relays vs estimated relays

Assicurarsi che la UI RC1 usi `num_relays`, non `num_estimated_relays`, salvo esplicita scelta di prodotto.

Riferimenti:

- `x/proof/types/claim.go:24-34`
- `proto/pocket/tokenomics/event.proto:160-164`

## 4. Verifica time windows

Assicurarsi che i filtri `24h`, `7d`, `30d` siano applicati su `block_time` del settlement, non su `session_end_block_height` interpretato come tempo.

## Edge Cases Importanti

## Claim create/update non equivalgono a revenue

`EventClaimCreated` e `EventClaimUpdated` sono utili per debug, ma non devono alimentare la dashboard economica.

Riferimento:

- `proto/pocket/proof/event.proto:11-82`

## Claim expired o discarded

Non producono revenue e non devono entrare negli aggregati RC1.

Riferimenti:

- `proto/pocket/tokenomics/event.proto:25-75`
- `proto/pocket/tokenomics/event.proto:258+`
- `x/tokenomics/keeper/settle_pending_claims.go:863-885`
- `x/tokenomics/keeper/settle_pending_claims.go:940-964`

## Reward split multi-shareholder

La quota supplier puo essere distribuita su piu address. Per questo la tabella dei reward details e fondamentale anche se la UI RC1 mostra solo il provider aggregato.

## Dati Storici e Parametri Storici

Il protocollo ha supporto a lookup storici almeno per:

- shared params: `x/shared/keeper/params.go:58-86`
- relay mining difficulty a una height: `x/service/keeper/query_relay_mining_difficulty.go:65-92`

Questo e molto utile se in futuro si vorra:

- ricostruire economicamente le claim offchain
- validare eventi rispetto a parametri storici
- aggiungere simulatori o stime di profitability

Per RC1 non serve ricalcolare i reward: basta fidarsi del settlement event come source of truth.

## Implementazione Minima Consigliata

Ordine pratico di realizzazione:

1. creare schema `blocks`, `claim_settlements`, `claim_settlement_reward_details`, `indexer_state`
2. implementare worker che indicizza `EventClaimSettled` da `end_block_events`
3. implementare parser coin string -> `upokt bigint`
4. aggiungere sync `services_dim` e `suppliers_dim`
5. esporre API `overview`, `providers`, `provider detail`
6. costruire UI con time selector e due viste principali
7. validare i numeri su un set di blocchi reale

## Cosa NON Fare in RC1

- non tentare di calcolare revenue partendo solo da claim create/proof events
- non usare float per salvare importi economici
- non assumere che `minted_upokt` sia la revenue del provider
- non basarsi esclusivamente su query gRPC di state per ottenere aggregati temporali

## Riferimenti Codice Essenziali

Se un agente dovesse riprendere il lavoro da zero, i file da leggere per primi sono:

1. `proto/pocket/tokenomics/event.proto`
2. `x/tokenomics/keeper/settle_pending_claims.go`
3. `x/tokenomics/module/abci.go`
4. `x/tokenomics/types/event_claim_settled.go`
5. `x/tokenomics/types/settlement_result.go`
6. `proto/pocket/tokenomics/types.proto`
7. `x/tokenomics/token_logic_module/tlm_relay_burn_equals_mint.go`
8. `x/tokenomics/token_logic_module/distribution_supplier.go`
9. `x/proof/types/claim.go`
10. `proto/pocket/shared/supplier.proto`
11. `proto/pocket/shared/service.proto`
12. `proto/pocket/shared/params.proto`
13. `x/shared/types/session.go`
14. `proto/pocket/service/query.proto`
15. `proto/pocket/supplier/query.proto`

Questi file sono sufficienti per ricostruire:

- da dove arrivano i relay
- quando una claim produce valore economico
- come il valore viene distribuito
- quali dimensioni servono per la dashboard
