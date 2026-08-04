# PROMPT — Módulo Expedição (mesa de embalagem)

> **Para o agente que abrir este repo no PC da mesa de expedição.** Leia este
> documento inteiro antes de escrever código. Você está num PC Windows no chão
> de fábrica, dentro do repo `berzerk-client`, e **não tem acesso ao código do
> nexus (berzerk-industrial) nem do posvenda (minhacontabzk)** — todo o
> contexto sobre esses dois sistemas que você precisa está aqui.

---

## 1. O que é este app

**Berzerk Client** — app desktop Tauri 2 + React 19 + TypeScript + Vite + Bun,
instalado nos PCs do chão de fábrica da Berzerk (moda, Brasil). Login só com
Google Workspace `@berzerk.com.br` via Supabase (PKCE + loopback local, ver
`src-tauri/src/oauth_loopback.rs`). UI e comentários em **português**.

Módulos hoje:

- **Etiquetagem** (produção) — aplica identidade RFID em lotes confirmados.
- **Separação** — fila de pedidos servida pela API do nexus; operadora bipa
  peças com leitor RFID até bater com os itens do pedido e completa.
- **Expedição** — **é o que você vai construir.** Hoje existe só um preview
  mockado: `src/components/NotaFiscalPlaceholder.tsx` (tela `"nf"` no
  `src/App.tsx`, entrada "Expedição" no `HomeMenu`).

## 2. O fluxo físico da mesa (hardware real)

A mesa é uma **máquina de embalagem chinesa** ("BC Intelligent packing
machine", Guangzhou Bingcheng, HMI/PLC Xinje). Ela sela o pedido num saco
plástico automaticamente. No fim da mesa há este PC Windows com uma
impressora térmica 100×150 mm. O fluxo do operador, que o preview já modela:

1. **LER** — as etiquetas RFID das peças do pedido são lidas na mesa → o app
   identifica QUAL pedido é e confere se as peças estão completas.
2. **IMPRIMIR** — a **etiqueta da transportadora (J&T)** — e, quando for o
   caso, a DANFE simplificada — sai automaticamente na impressora.
3. **EMBALAR** — o saco desce, o operador coloca pedido + documentos dentro.
4. **FECHAR** — operador aperta o botão físico vermelho da máquina; o pacote
   sela e rola pro chão.

**Limitação importante:** o botão vermelho é hardware do PLC da mesa — não
emite nenhum evento capturável pelo Windows. Por isso o estado "embalando" do
preview é puramente visual (timeout + auto-confirmação quando chega a próxima
leitura). Mantenha esse modelo — está documentado nos comentários do
`NotaFiscalPlaceholder.tsx` e foi decisão consciente.

## 3. Como a leitura RFID chega no app

O leitor da estação é um **Cykeo CKD1L** ligado ao **iTAG Monitor** (app
Windows da iTAG) que expõe um REST local em `http://127.0.0.1:9093`
(`/ItagRFIDMonitor/...`). O app fala com ele **pelo backend Rust** (Tauri
`invoke`), nunca por fetch direto:

- `src/lib/rfid.ts` — `pingItag`, `sendItagCommand("iniciar"|"parar"|"limparLeitura")`,
  `pollItagTags` (EPCs hex acumulados), `reInventory` (parar→limpar→iniciar,
  necessário pra detectar remoção — o monitor só acumula).
- Resolução EPC → peça: **sempre pela nuvem** (não decodifique SGTIN
  localmente — as tags em campo não seguem o padrão GS1 à risca).
- Sem hardware por perto, use o mock: `tools/itag-mock/` (servidor Bun que
  imita o iTAG Monitor em :9093 — ver README dele).
- A tela também deve aceitar **digitação manual do EPC + Enter** (fallback e
  leitores keyboard-wedge), como o preview já faz.

## 4. Integração com o nexus (a API que você vai consumir)

O nexus é o monolito NestJS da Berzerk (repo separado, você NÃO tem o código).
A Separação já migrou pra ele, e **a Expedição deve seguir o mesmo caminho**
— nada de falar com o Supabase do posvenda direto.

- **Cliente HTTP:** `src/lib/api.ts`. Base = `VITE_SEPARACAO_API_URL`
  (prod `https://api-nexus.cloud.berzerk.com.br/api` — o sufixo `/api` é
  obrigatório). Bearer = **o próprio access token da sessão Supabase do app**
  (bridge HS256 no nexus). Não existe segundo login.
- **Permissões:** RBAC do nexus por email. `GET /separacao/me` →
  `{ actorId, email, permissions[] }`. A Separação exige
  `separacao:operate` (ou `*`). A Expedição deve seguir o mesmo padrão com
  uma permissão própria (ex.: `expedicao:operate`) — cheque via `/me` e
  reflita o que a API responder, sem lógica de permissão local.
- **Contratos:** os tipos são **duplicados** em `src/services/orders.ts`
  (o app é repo separado do nexus; espelhamos os shapes do
  `@berzerk/contracts`). Siga esse padrão: um `src/services/expedicao.ts`
  com tipos + wrappers `apiRequest`.
- **Degradação graciosa:** quando o endpoint ainda não existe no nexus
  deployado, a API devolve 404 — o app degrada com aviso em vez de quebrar
  (ver `claimOrder` e `getQueueProducts` como exemplos). Erros de negócio vêm
  como `{ error: 'codigo_snake_case' }` com status 4xx (ex.:
  `pedido_indisponivel` 409) — trate por código, não por mensagem.
- **Push:** WebSocket do nexus (`VITE_SEPARACAO_WS_URL`, API Gateway WS)
  empurra `queue.changed`; é gatilho de refetch, não fonte de verdade
  (`src/lib/realtime.ts`). Polling lento de fallback sempre existe.

### Ciclo de vida do pedido

`received → processing → invoiced → ready → separating → awaiting_pickup → shipped`
(+ `cancelled`). O que importa pra você:

- Ao completar a Separação (`POST /separacao/:orderId/complete` com
  `rfidTags: string[]`), o nexus **persiste os EPCs das peças no pedido**
  (`Order.rfidTags`, com unicidade global — uma tag só pode estar num pedido)
  e o pedido vai pra `awaiting_pickup`.
- **A Expedição é o consumidor disso:** bipar EPCs na mesa → encontrar o
  pedido `awaiting_pickup` cujo `rfidTags` contém aqueles EPCs → conferir que
  TODAS as tags do pedido foram lidas → imprimir etiqueta/DANFE → marcar
  `shipped`.

### Contrato proposto (a desenvolver no nexus por outro agente)

Você define o contrato aqui (tipos + wrappers em `src/services/expedicao.ts`),
desenvolve o app contra o mock/404-degradação, e o agente do nexus implementa
do lado de lá. Proposta mínima, no estilo dos endpoints existentes:

- `POST /expedicao/resolve` body `{ epcs: string[] }` →
  `{ matches: Array<{ order: Order; tagsLidas: string[]; tagsFaltantes: string[] }> }`
  — cruza EPCs com `rfidTags` de pedidos `awaiting_pickup`. Erros/casos:
  EPC sem pedido (vem fora de `matches`), `pedido_ja_expedido` (409 com
  quando/por quem). Mandar EPCs em chunks (≤80 por chamada — limite prático
  herdado do posvenda).
- `GET /expedicao/:orderId/documentos` → dados pra impressão:
  `{ danfe: NfData | null, etiqueta: { base64: string; formato: 'pdf'|'png' } | null, trackingCode: string | null }`
  (ver §5 pro shape de `NfData` e de onde o nexus tira cada coisa).
- `POST /expedicao/:orderId/ship` body `{ rfidTags: string[], override?: { motivo: string } }`
  → marca `shipped`, grava ator + timestamp, replica a situação pro Tiny.
  Idempotente. Erros esperados (códigos, espelhando os guards do posvenda):
  `rastreio_obrigatorio`, `etiqueta_nao_impressa`, `tags_incompletas`
  (a menos que venha `override`), `pedido_ja_expedido`.
- `GET /expedicao/history` — espelho do `/separacao/history` (pedidos
  expedidos pelo ator, busca + período) pra tela de histórico.

## 5. Como o posvenda (minhacontabzk) faz isso hoje — fonte de verdade

O posvenda é o webapp React+Supabase (Lovable) que roda hoje na estação de
expedição, na rota `/operacao/impressao-nf` (`src/pages/ImpressaoNF.tsx`,
~4000 linhas, role `nf_printer`). É ELE que este módulo substitui na mesa.
O que você precisa saber do comportamento dele:

### Loop de leitura e conferência

1. Poll do leitor a cada 1s; cada EPC resolvido vira `{ epc, ean13, nome, tamanho, cor }`.
2. **Filtro anti-fantasma:** um EPC só é "confirmado" depois de aparecer em
   N polls consecutivos (threshold cai pra 2 logo após uma impressão). Avisa
   quando o buffer passa de ~12 tags. **Porte essa lógica** — é o que evita
   despachar pedido errado por leitura espúria de peça vizinha.
3. Lookup do pedido: `orders` onde `rfid_tags` contém o EPC **e**
   `status = 'awaiting_pickup'` (mais antigo primeiro).
4. **Trava de completude:** o pedido só libera impressão quando **TODAS** as
   `rfid_tags` gravadas na separação foram lidas. Enquanto falta, a UI mostra
   progresso `lidas/total` por item (EPC→item casado via catálogo de EPCs +
   SKU). Existe um botão **"Forçar impressão"** que registra override
   (`manual_print_override`) — auditável.
5. Mesma tag em múltiplos pedidos → modal de escolha. Tag sem pedido → aviso
   visível ("intrusa").

### Impressão e despacho (ordem estrita)

1. **Etiqueta J&T primeiro** — se não imprimir, o pedido NÃO avança. A
   etiqueta chega por webhook (N8N → tabela `jt_shipping_labels`:
   `tiny_order_number`, `tiny_account 'FM'|'JT'`, `label_base64` pdf/png,
   `metadata.tracking_code`, `printed_at`). No browser eles convertem
   PDF→PNG via pdf.js (300dpi) e imprimem num iframe 100×150 mm.
2. Depois chama a edge function `complete-separation` com
   `target_status: "shipped"`. Guards do lado servidor (replique no nexus):
   - `tracking_number` preenchido → senão erro `TRACKING_REQUIRED`;
   - etiqueta J&T com `printed_at != null` → senão `JT_LABEL_REQUIRED`;
   - status de origem ∈ `invoiced|ready|awaiting_pickup`.
3. Em background o servidor replica pro **Tiny ERP**
   (`pedido.alterar.situacao` → `enviado`, token conforme `tiny_account`) e
   grava `audit_log`.
4. Sucesso → som de sucesso, limpa a tag do cache de sessão, atualiza
   histórico. "Embalados hoje" no telão = etiquetas J&T impressas hoje.

### DANFE

- Não existe PDF de DANFE pronto: a edge function `fetch-danfe` busca o
  **XML da NF no Tiny** (`pedido.obter` → `id_nota_fiscal` →
  `nota.fiscal.obter.xml`), parseia e cacheia um `NfData` em
  `orders.danfe_data`:
  `{ numero, serie, data_emissao, natureza_operacao, chave_acesso, protocolo,
  data_protocolo, emitente{...}, cliente{...}, itens[{codigo, descricao, ncm,
  cfop, unidade, quantidade, valor_unitario, valor_total}], valor_produtos,
  valor_frete, valor_desconto, valor_nota, transportador{...}, volumes{...},
  informacoes_adicionais }`.
- A impressão é uma **DANFE simplificada renderizada em HTML** (100×150 mm,
  máx. 8 itens, código de barras CODE128 da `chave_acesso` via JsBarcode) —
  ver `printDanfeSimplificada` no posvenda. Reproduza o template no app.

### O que fica FORA do escopo (por ora)

- **Agrupamento de expedição Tiny/Correios** (`create-expedition-group`) —
  fluxo gerencial em lote, sem RFID. Não é da mesa.
- **Romaneio/malote** (`shipping_manifests`) e a conferência RFID do malote
  fechado (`rfid-order-conference`, presentes/ausentes/intrusos) — segunda
  fase; anote no design mas não implemente sem pedido.

## 6. O que precisa ser desenvolvido (escopo)

1. **`src/services/expedicao.ts`** — contrato + wrappers (§4).
2. **Trocar o mock do `NotaFiscalPlaceholder.tsx` por dados reais**, mantendo
   a UX aprovada (stepper LER→IMPRIMIR→EMBALAR→FECHAR, estado `packing`
   visual com timeout, prefetch do próximo pedido durante o packing, dedupe
   de EPCs relidos, histórico da sessão) e somando a **trava de completude**
   com progresso por item (§5). Renomeie pra `Expedicao.tsx` quando deixar de
   ser placeholder e tire o badge "preview".
3. **Leitura contínua do leitor da mesa** — `src/lib/rfid.ts` (poll 1s +
   `reInventory`) + filtro anti-fantasma portado do posvenda. Input manual
   continua como fallback.
4. **Impressão silenciosa no Windows** — etiqueta J&T (base64 pdf/png) e
   DANFE simplificada (HTML→PDF), direto na impressora térmica padrão sem
   diálogo. Investigar: comando Rust + `SumatraPDF -print-to-default`
   embarcado, ou API de impressão nativa. No desktop dá pra mandar o PDF
   direto — não porte o hack PDF→PNG do browser. Decisão em aberto: escolha
   o caminho mais robusto e documente.
5. **Ship com tolerância a falha** — se o `POST /ship` falhar por rede,
   enfileirar retry local; a mesa não pode travar com pedido embalado.
6. **Override de impressão forçada** (tags incompletas) com motivo,
   espelhando o `manual_print_override` do posvenda.
7. **Erros operacionais visíveis de longe** — peça sem pedido, pedido já
   expedido, etiqueta ausente, DANFE indisponível: tela cheia, cor forte,
   mensagem em português simples (operador olha de ~2m de distância).

## 7. Convenções do repo (siga à risca)

- **Português** em UI, comentários e mensagens de commit.
- Estilo visual: inline styles com `CSSProperties` + CSS vars do tema
  (`var(--text)`, `var(--warning-bg)`, ...) — ver qualquer componente. Nada
  de CSS framework novo.
- Sem framework de estado — hooks + refs; TanStack Query não é usado aqui.
- Beeps de feedback: `src/lib/beep.ts`. Log de ações: `src/services/actionLog.ts`.
- ESC fecha modais; telas navegam pelo state machine simples do `App.tsx`
  (`screen`), sem router.
- Commits: `git commit -m "v0.X.Y — resumo"` quando for release (bump em
  `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`,
  depois `bun install`, tag `v0.X.Y`, `git push --follow-tags`). Trabalho
  incremental sem release = commit normal descritivo em português.
- **Não renomeie nem refatore nada fora do escopo** sem pedido explícito.

## 8. Ambiente de dev nesta máquina

- `bun install && bun run tauri dev` (primeira build ~5–10min, depois <10s).
- `.env` já configurado no PC (Supabase anon key + `VITE_SEPARACAO_API_URL`).
  Pra apontar pra um nexus local: `http://localhost:3010/api`.
- Mock do leitor: `tools/itag-mock/` (ver README de lá) — mas nesta mesa o
  leitor real deve estar disponível via iTAG Monitor em :9093.
- **Este PC também opera a produção** — o app instalado (release) e o
  posvenda no browser continuam sendo o que o operador usa. Não desinstale
  nada, não mexa no iTAG Monitor além de leitura, e teste o `tauri dev` sem
  monopolizar o leitor durante o expediente.
