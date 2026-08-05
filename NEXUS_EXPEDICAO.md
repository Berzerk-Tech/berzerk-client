# PROMPT — Endpoints de Expedição no nexus (berzerk-industrial)

> **Para o agente que vai implementar a Expedição no nexus (monólito NestJS).**
> Leia inteiro antes de escrever código. O cliente da mesa de expedição
> (`berzerk-client`, Tauri desktop) já está pronto e consome estes endpoints —
> os shapes abaixo são o CONTRATO e precisam bater exatamente com
> `src/services/expedicao.ts` do app. A Separação já migrou pro nexus; a
> Expedição segue **o mesmo padrão** (auth, RBAC, WS, estilo dos endpoints).

---

## 1. Contexto

A **mesa de expedição** é o último posto da fábrica: as peças de um pedido já
separado chegam nela, o operador lê as etiquetas RFID, o sistema identifica o
pedido, imprime a **etiqueta da transportadora (J&T)** e (quando há) a **DANFE
simplificada**, o pedido é embalado e marcado como **expedido**.

Hoje quem faz isso é o posvenda (`minhaconta bzk`, webapp React+Supabase/Lovable,
rota `/operacao/impressao-nf`). Estamos migrando essa etapa pro app desktop +
nexus, do mesmo jeito que a Separação migrou. **A fonte da verdade do
comportamento é o posvenda** — replique os guards dele.

### Ciclo de vida do pedido (já existe no nexus)

```
received → processing → invoiced → ready → separating → awaiting_pickup → shipped
```
(+ `cancelled`)

O que importa pra Expedição:

- Ao concluir a Separação (`POST /separacao/:orderId/complete` com
  `rfidTags: string[]`), o nexus **já persiste os EPCs das peças no pedido**
  (`Order.rfidTags`, unicidade global — uma tag só num pedido) e move o pedido
  pra **`awaiting_pickup`**.
- **A Expedição consome isso:** lê EPCs na mesa → acha o pedido `awaiting_pickup`
  cujo `rfidTags` contém aqueles EPCs → confere que TODAS as tags do pedido
  foram lidas → imprime → marca `shipped`.

---

## 2. Autenticação, permissão e convenções

Idênticas à Separação:

- **Bearer** = o próprio access token da sessão Supabase do app (bridge HS256 no
  nexus). Sem segundo login.
- **RBAC por email.** Crie a permissão **`expedicao:operate`** (o ator com `*`
  também passa). O app checa via `GET /separacao/me` (já existe — retorna
  `{ actorId, email, permissions[] }`) e reflete o que a API responder. Basta
  garantir que os endpoints de expedição exijam `expedicao:operate` (ou `*`) e
  devolvam **403** quando faltar.
- **Prefixo global `/api`** (setGlobalPrefix). Todas as rotas abaixo são sob
  `/api`.
- **Erros de negócio** = `{ error: 'codigo_snake_case' }` com status 4xx. O app
  trata **por código**, não por mensagem. Erros de infra/validação podem seguir
  o padrão NestJS (`{ message }`).
- **WebSocket:** emita `queue.changed` (mesmo canal da Separação) quando um
  pedido for expedido — é gatilho de refetch das telas, não fonte de verdade.

---

## 3. Endpoints a criar

### 3.1 `POST /expedicao/resolve`

Cruza os EPCs lidos na mesa com pedidos `awaiting_pickup`.

**Request body**
```json
{ "epcs": ["E28011...", "E28011..."] }
```
- O app manda em **chunks de no máximo 80 EPCs** por chamada (limite prático
  herdado do posvenda) e mescla no cliente. Aceite qualquer tamanho, mas o
  contrato prático é ≤80.
- Normalize os EPCs (trim + uppercase) antes de comparar.

**Response 200**
```json
{
  "matches": [
    {
      "order": { /* Order — MESMO shape do /separacao (ver §4) */ },
      "tagsLidas": ["E28...A", "E28...B"],
      "tagsFaltantes": ["E28...C"]
    }
  ],
  "intrusos": ["E28...Z"]
}
```

**Regras (replicar posvenda):**
- Para cada EPC, ache o pedido onde `rfid_tags` **contém** o EPC **e**
  `status = 'awaiting_pickup'`. Se um EPC casar com mais de um pedido (não
  deveria, unicidade global), retorne todos os pedidos casados em `matches` —
  o app mostra um modal de escolha.
- `tagsLidas` = interseção dos EPCs recebidos com o `rfidTags` do pedido.
- `tagsFaltantes` = `rfidTags` do pedido **menos** `tagsLidas` (o que ainda não
  foi lido — o app trava a impressão enquanto houver faltante).
- `intrusos` = EPCs recebidos que **não** casaram com nenhum pedido
  `awaiting_pickup` (peça de outro pedido / tag desconhecida / pedido já
  expedido). O app avisa visualmente.
- **Ordene `matches` por `createdAt` ascendente** (mais antigo primeiro).
- **Pedido já expedido:** se um EPC pertence a um pedido que já está `shipped`,
  NÃO o coloque em `matches`; coloque o EPC em `intrusos` **e** (opcional, útil)
  inclua um bloco à parte pra o app poder avisar "pedido #X já foi expedido em
  <quando> por <quem>". Se quiser, adicione um campo opcional
  `jaExpedidos: Array<{ epc, orderId, numero, shippedAt, shippedByEmail }>` — o
  app já está preparado pra ignorar campos extras; se implementar, avise que
  existe pra a gente plugar o aviso.
- **Somente leitura** — este endpoint NÃO altera estado.

---

### 3.2 `GET /expedicao/:orderId/documentos`

Devolve o que precisa ser impresso.

**Response 200**
```json
{
  "danfe": { /* NfData — ver §5 — ou null */ },
  "etiqueta": { "base64": "JVBERi0...", "formato": "pdf" },
  "trackingCode": "JT0001234567"
}
```
- `etiqueta` = **etiqueta da transportadora (J&T)** em base64 (`formato: "pdf"`
  ou `"png"`), ou `null` se ainda não chegou. **De onde o posvenda tira:** a
  etiqueta chega por webhook (N8N) numa tabela tipo `jt_shipping_labels`
  (`tiny_order_number`, `tiny_account 'FM'|'JT'`, `label_base64` pdf/png,
  `metadata.tracking_code`, `printed_at`). Traga o `label_base64` mais recente
  do pedido. **No desktop mande o PDF direto** — o app imprime PDF/PNG
  silenciosamente, NÃO precisa converter PDF→PNG (o hack do browser não se
  aplica aqui).
- `trackingCode` = código de rastreio (do `metadata.tracking_code` da etiqueta,
  ou do campo de tracking do pedido), ou `null`.
- `danfe` = dados da NF pra renderizar a **DANFE simplificada** (o app gera o PDF
  100×150mm com código de barras CODE128 da chave de acesso). `null` quando não
  há NF. **De onde o posvenda tira:** não existe PDF pronto — a edge
  `fetch-danfe` busca o **XML da NF no Tiny** (`pedido.obter` → `id_nota_fiscal`
  → `nota.fiscal.obter.xml`), parseia e cacheia. Faça o mesmo no nexus e devolva
  no shape `NfData` (§5). Pode cachear (ex.: coluna `danfe_data` no pedido) pra
  não bater no Tiny toda vez.
- **Somente leitura** (buscar/cachear a NF não muda o estado do pedido).
- **404** se o pedido não existir; o app degrada com aviso.

---

### 3.3 `POST /expedicao/:orderId/ship`

Marca o pedido como `shipped`. **É o ÚNICO endpoint que altera estado.**

**Request body**
```json
{ "rfidTags": ["E28...A", "E28...B", "E28...C"], "override": { "motivo": "..." } }
```
- `rfidTags` = as tags lidas/confirmadas na mesa.
- `override` (opcional) = liberação de impressão/expedição forçada com tags
  incompletas (espelha o `manual_print_override` do posvenda — **auditável**).

**Response 200** = o `Order` atualizado (status `shipped`).

**Guards (replicar os do posvenda `complete-separation target_status: shipped`),
retornando `{ error: 'codigo' }`:**
- `tracking_number`/rastreio ausente → **`rastreio_obrigatorio`** (409).
- Etiqueta J&T sem `printed_at` (não impressa) → **`etiqueta_nao_impressa`**
  (409). Obs.: como a impressão agora é no cliente, defina COMO o nexus sabe que
  imprimiu — sugestão: o app chama este `ship` só DEPOIS de imprimir com
  sucesso, e o `ship` marca `printed_at` na etiqueta nesse momento (ou aceita um
  flag `etiquetaImpressa: true` no body). **Decida e me avise** qual sinal você
  espera — ajusto o app. (Hoje o app manda o `ship` só após imprimir a J&T.)
- Tags incompletas (nem todas as `rfidTags` do pedido foram lidas) **e sem
  `override`** → **`tags_incompletas`** (409). Com `override`, grava a liberação
  e segue.
- Status de origem fora de `invoiced|ready|awaiting_pickup` → trate como
  **`pedido_ja_expedido`** (409) se já `shipped` (idempotência: ver abaixo).

**Efeitos:**
1. `status = 'shipped'`, grava **ator + timestamp** (`shipped_by`, `shipped_at`).
2. **Replica pro Tiny ERP** em background: `pedido.alterar.situacao → enviado`
   (token conforme a conta `tiny_account 'FM'|'JT'`). Grava `audit_log`.
3. **Idempotente:** repetir o `ship` do mesmo pedido não duplica movimentação —
   se já `shipped`, devolva o pedido como está (200) OU `pedido_ja_expedido`
   conforme o padrão da Separação; **prefira 200 idempotente** pra não travar a
   mesa em retry de rede.
4. Emita `queue.changed` no WS.

> ⚠️ **Coordenação com o legado (minhaconta bzk):** o posvenda hoje também faz
> essa movimentação. Enquanto os dois coexistirem, **garanta que a movimentação
> pro Tiny/legado não aconteça em dobro** — ex.: só o sistema que estiver
> "oficialmente" na mesa move, ou use a idempotência do Tiny por situação. **O
> app tem um MODO TESTE que NÃO chama este endpoint** (nenhum efeito colateral);
> só o MODO OFICIAL chama o `ship`. Então do seu lado: assuma que toda chamada a
> `ship` é pra valer. Me diga se prefere um flag `dryRun: true` no body como
> segunda trava — o app pode mandar, mas hoje ele simplesmente não chama `ship`
> em teste.

---

### 3.4 `GET /expedicao/history`

Espelho do `GET /separacao/history`, mas dos pedidos **expedidos pelo ator**.

**Query:** `q?`, `dateFrom?`, `dateTo?` (sobre `shipped_at`), `limit?`, `offset?`.

**Response 200**
```json
{
  "items": [
    {
      "id": "uuid",
      "numero": "12345",
      "clienteNome": "Fulano",
      "dataEmissao": "2026-08-01",
      "shippedAt": "2026-08-04T12:00:00Z",
      "trackingCode": "JT0001234567",
      "channel": "shopify",
      "itemCount": 3,
      "rfidTags": ["E28...A", "E28...B", "E28...C"]
    }
  ],
  "total": 42,
  "totals": { "pedidos": 42, "itens": 128 }
}
```

---

## 4. Shape `Order` (reutilizar o do /separacao — não invente outro)

O app já usa este shape (`src/services/orders.ts`). O `resolve` deve devolver
pedidos **exatamente assim** (o app depende de `rfidTags`, `items`, `numero`,
`createdAt`, `clienteNome`, etc.):

```ts
type Order = {
  id: string;
  tinyOrderId: string | null;
  numero: string | null;
  channel: "shopify" | "yampi" | "manual" | "tiny" | null;
  status: "received" | "processing" | "invoiced" | "ready" | "separating" | "awaiting_pickup" | "shipped" | "cancelled";
  predominantSize: string | null;
  separationMode: "normal" | "total";
  claimedBy: string | null;
  claimedAt: string | null;
  separatedBy: string | null;
  separatedAt: string | null;
  rfidTags: string[] | null;        // <- a Expedição depende disto
  items: Array<{
    id: string;
    ean: string | null;
    sku: string | null;
    nome: string | null;
    tamanho: string | null;
    quantidade: number;
    imagemUrl: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
  clienteNome?: string | null;
  dataEmissao?: string | null;
  prioritario?: boolean;
};
```

---

## 5. Shape `NfData` (DANFE em dados, camelCase)

O posvenda cacheia em snake_case (`orders.danfe_data`); **converta pra camelCase**
alinhado ao resto do contrato do app:

```ts
type NfPessoa = {
  nome: string | null;
  cnpjCpf: string | null;
  ie: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
};

type NfItem = {
  codigo: string | null;
  descricao: string;
  ncm: string | null;
  cfop: string | null;
  unidade: string | null;
  quantidade: number;
  valorUnitario: number;
  valorTotal: number;
};

type NfData = {
  numero: string | null;
  serie: string | null;
  dataEmissao: string | null;         // ISO
  naturezaOperacao: string | null;
  chaveAcesso: string | null;         // 44 dígitos — vira CODE128 na DANFE
  protocolo: string | null;
  dataProtocolo: string | null;       // ISO
  emitente: NfPessoa;
  cliente: NfPessoa;
  itens: NfItem[];
  valorProdutos: number;
  valorFrete: number;
  valorDesconto: number;
  valorNota: number;
  transportador: NfPessoa | null;
  volumes: { quantidade: number | null; especie: string | null; pesoBruto: number | null; pesoLiquido: number | null } | null;
  informacoesAdicionais: string | null;
};
```

---

## 6. Fora de escopo (por ora — anote, não implemente sem pedir)

- **Agrupamento de expedição Tiny/Correios** (`create-expedition-group`) — fluxo
  gerencial em lote, sem RFID.
- **Romaneio/malote** (`shipping_manifests`) e a conferência RFID do malote
  fechado (presentes/ausentes/intrusos) — segunda fase.

---

## 7. Resumo do que entregar

1. `POST /api/expedicao/resolve` — EPC→pedido awaiting_pickup (read-only).
2. `GET  /api/expedicao/:orderId/documentos` — etiqueta J&T + DANFE (read-only).
3. `POST /api/expedicao/:orderId/ship` — marca shipped + replica Tiny (idempotente).
4. `GET  /api/expedicao/history` — histórico do ator.
5. Permissão `expedicao:operate` no RBAC; 403 sem ela.
6. Emitir `queue.changed` no `ship`.
7. Me responder DUAS decisões em aberto: (a) qual sinal de "etiqueta impressa" o
   `ship` espera (chamar após imprimir / flag no body / marcar `printed_at` no
   ship); (b) se quer um `dryRun` no `ship` como segunda trava do modo teste.

Enquanto estes endpoints não sobem, o app degrada com aviso em 404 e tem um modo
mock local pra ensaiar a UX.
