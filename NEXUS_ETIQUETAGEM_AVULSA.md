# Etiquetagem avulsa (por produto, sem lote)

Spec do lado CLIENT. O lado Nexus (API) está sendo implementado em paralelo no
repo `nexus` (branch `feat/etiquetagem-avulsa`); o contrato abaixo é o que ele
vai entregar. Não mexer na API daqui.

## Por quê (incidente 18–21/09)

Touca e boné (peça COMPRADA PRONTA, tamanho único) foram vendidos sem SKU. Na
hora de etiquetar, descobriu-se que o client só imprime a partir de LOTE de
produção (fila `enviado_recebimento`, grade P/M/G…). Peça que não nasceu de
enfesto/corte não tem lote, então não tem como imprimir — a saída foi clonar
uma camiseta na Shopify e imprimir "no tamanho P". Esta tela dá o caminho
certo: buscar o produto no catálogo, informar quantidade, imprimir.

## Decisão que simplifica tudo: tamanho único = `"U"`

`tamanho` CONTINUA obrigatório em todo item de job. Variante sem tamanho chega
da API com `tamanho: "U"` (é o canônico que o Nexus já usa: `UN`/`UNICO`/
`ÚNICO` → `U`). Nada no client deve tratar tamanho como opcional. Na tela,
exibir `U` como "Único".

## Contrato da API (novo / alterado)

Todas as rotas exigem `etiquetagem:operate` (o mesmo papel da fila de lotes).

### `GET /etiquetagem/produtos?busca=<texto>&limite=20` — NOVA
Busca no catálogo por nome (sem acento, parcial) ou por EAN/SKU exato.
```json
{ "itens": [ { "produtoId": "uuid", "nome": "Touca de lã - Rux - cinza",
               "imagemUrl": "https://… | null", "variantes": 1,
               "imprimivel": true, "ean": "7892315225864 | null" } ] }
```
`imprimivel: false` = nenhuma variante com EAN (mostrar desabilitado, com o
motivo "sem EAN cadastrado"). `ean` (revisão 21/09) é o EAN da primeira
variante com EAN do produto — usar pra desambiguar produto duplicado no
catálogo (mesmo nome, dois cadastros) direto na lista, sem abrir a grade.
`busca` com menos de 2 caracteres devolve `{ "itens": [] }` com **200**, não
400 — o client pode chamar a cada tecla do debounce sem tratar erro.

### `GET /etiquetagem/produtos/:id/eans` — JÁ EXISTE, muda o comportamento
Mesmo shape de `GET /etiquetagem/lotes/:id/eans` (`EansDto`, já tipado em
`src/services/batches.ts`). Mudança: produto cujas variantes NÃO têm tamanho
passa a devolver uma entrada `{ "tamanho": "U", "ean": "…", "sku": "…" }` em
vez de lista vazia/`sem_ean`. Produto com grade devolve a grade normal — a
tela avulsa serve pros dois (reimpressão avulsa de camiseta também vale).

### `POST /etiquetagem/print-jobs` — ALTERADA
`loteId` deixa de ser obrigatório; entra `produtoId`. EXATAMENTE um dos dois.
```json
{ "produtoId": "uuid", "ehManual": true, "estacaoId": "…",
  "itens": [ { "tamanho": "U", "quantidade": 70, "ean13": "7892315225864",
               "sku": "7892315225864", "descricao": "Touca de lã - Rux - cinza" } ] }
```
Resposta: `RfidPrintJobDto` com `loteId: null`, `loteCodigo: "AVULSO · Touca
de lã - Rux - cinza"` (nome do produto anexado, truncado a 160 chars — é o
que distingue um job avulso do outro pro client ANTIGO, que só mostra
`loteCodigo` na barra), `estampa` = nome do produto (idem, pro 0.9.43 não
mostrar "AVULSO —" igual pra todo job), e dois campos novos `produtoId` /
`produtoNome` (null nos jobs por lote). **A UI 0.9.44 deve preferir
`produtoNome` a `loteCodigo`/`estampa` sempre que `produtoId != null`** — os
dois últimos são só o retrato pro client antigo, não a fonte da verdade.

Mandar `loteId`+`produtoId` juntos ou nenhum dos dois = **400**
`{ "error": "validation_error", "issues": [{ "message":
"lote_ou_produto_obrigatorio", … }] }` — é o shape padrão do
`ZodValidationPipe` da API (mesmo formato de qualquer 400 de validação nela),
não um erro plano `{ "error": "lote_ou_produto_obrigatorio" }`.

**`ehTeste: true` não é aceito com `produtoId`** (revisão 21/09) — 400
`{ "error": "validation_error", "issues": [{ "message":
"teste_nao_suportado_em_avulso", … }] }`. Não existe "Descartar teste" por
produto (`descartarTeste`/`lotesComTeste` partem de `loteId`), e um EPC de
teste avulso órfão viraria peça de verdade na separação — a tela avulsa NÃO
deve ter botão de impressão de teste.

### `POST /etiquetagem/epcs` — SEM mudança de contrato
`{ jobId, epcs[], mapeamento?, codigoInventarioItag? }` igual. O Nexus grava
`rfid_epc_inventory` com `lote_id = null`. Mandar o `mapeamento` da iTAG como
hoje (client ≥ 0.9.39).

### NÃO chamar em job avulso
`POST /etiquetagem/lotes/:id/impresso` — não há lote pra carimbar.

## O que construir no client

1. **Entrada**: na tela de Impressão (`BatchBrowser`), um botão "Imprimir
   avulso" no cabeçalho (não um card novo no `HomeMenu` — é o mesmo módulo).
2. **Tela/modal "Impressão avulsa"**:
   - campo de busca com debounce (~300 ms) → `GET /etiquetagem/produtos`
     (chamar mesmo com 0–1 char não quebra — a API devolve vazio);
   - lista com foto, nome, selo "sem EAN" quando `imprimivel=false`, e o
     `ean` do item pequeno/secundário — desambigua produto duplicado no
     catálogo (mesmo nome, dois cadastros) sem precisar abrir cada um;
   - ao escolher: `GET /etiquetagem/produtos/:id/eans` → uma linha por tamanho
     com campo de quantidade (default 0; produto `U` = uma linha só, "Único").
     Tamanho sem EAN aparece desabilitado;
   - **SEM botão/toggle de impressão de teste** — `ehTeste` não é aceito em
     job avulso (ver contrato acima); esconder o controle que a tela de lote
     tem;
   - botão Imprimir habilita com soma > 0. Confirmação com o total ("Imprimir
     70 etiquetas de Touca de lã - Rux - cinza?") — impressão gasta etiqueta
     física, não tem desfazer.
3. **Impressão**: reaproveitar o pipeline existente SEM bifurcar
   `itag_iprint.rs`:
   `createPrintJob({ produtoId, itens })` → `printJob(...)` (iPrint
   `gerarRFID`) → `saveEpcInventory({ jobId, epcs, mapeamento })` →
   concluir/falhar o job como hoje. Pular só o `markBatchPrinted`.
   - `PrintJobInput.batchId`/`batchCode` (`src/lib/itag/iprint.ts:28–38`) são
     auditoria: tornar `batchId` opcional e mandar `batchCode: "AVULSO"`.
   - Payload pra iTAG: `tamanho: "U"`, `cor` vazia se não houver, `descricao`
     = nome do produto (sem sufixo de tamanho quando `U`).
   - `buildPrintItems` (`src/services/batches.ts:357`) assume `ResolvedBatch`;
     extrair o núcleo (eans+quantidades → `PrintJobItem[]`) pra uma função que
     as duas telas usem, em vez de fabricar um `ProductionBatch` falso.
4. **Tipos**: `createPrintJob` aceita `{ batchId } | { produtoId }` (união
   discriminada, não dois opcionais soltos, e SEM `ehTeste` no branch
   `produtoId` — a API recusa). `RfidPrintJobDto` ganha `produtoId`/
   `produtoNome`; onde a UI mostra `loteCodigo`/`estampa` de um job (lista de
   jobs ativos, histórico), **preferir `produtoNome`** quando `produtoId !=
   null` — `loteCodigo`/`estampa` já vêm com o nome do produto embutido (pro
   client antigo), mas a 0.9.44 tem o campo estruturado e não precisa do
   `"AVULSO · "` na tela.
5. **`compareSizes`**: garantir que `"U"` não quebra a ordenação (vai pro fim
   ou sozinho) — hoje a régua é PP→XXG.

## O que NÃO pode mudar

- Fluxo por lote idêntico (fila, resolução de EAN, carimbo, reimpressão,
  descarte de teste). Nenhuma chamada existente muda de payload.
- Guard de versão/headers (`X-Berzerk-Client-Version`) e o WebSocket de
  `print-jobs.changed` seguem como estão; job avulso também chega por ele.
- Nada de fallback "distribuição por posição" novo: job avulso manda o
  `mapeamento` da iTAG como o por lote.

## Critérios de aceite

- `bun run typecheck`/lint/testes do repo verdes; teste unitário da função
  extraída de itens (grade normal, `U`, tamanho sem EAN, quantidade 0 fora).
- Contra a API de dev/prod com o lado Nexus publicado: buscar "touca",
  escolher, 2 etiquetas, imprimir, e conferir que `GET /etiquetagem/epcs`
  devolve os 2 EPCs com `size = "U"` e `loteId = null`.
- Imprimir um lote normal em seguida continua funcionando.
- Release: bump nos 3 lugares (`package.json`, `tauri.conf.json`,
  `Cargo.toml`) → **0.9.44**, `bun install`, tag `v0.9.44`.

## Ordem

O client só consegue testar ponta a ponta depois do deploy do Nexus. Dá pra
construir a tela e os tipos antes; a validação final espera o aviso de que
`feat/etiquetagem-avulsa` está em prod.
