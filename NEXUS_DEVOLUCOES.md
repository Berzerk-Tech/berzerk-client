# Devoluções (Nexus) — contrato e comportamento do app

> Consumido por `src/services/devolucoes.ts` e pela tela `src/components/Devolucao.tsx`
> (módulo **Devolução**, desde a 0.9.48). Base: `VITE_SEPARACAO_API_URL`, bearer e
> header de versão via `apiRequest` (`src/lib/api.ts`). Todas as rotas exigem
> `expedicao:operate` (`canOperateExpedicao()` em `src/services/expedicao.ts`). Sem PIN.

## 1. Fluxo

A operadora passa as peças devolvidas na mesa RFID; o app acumula os EPCs num **lote
aberto** no Nexus (que só **pré-classifica**). **Fechar lote** aplica: desvincula as peças
dos pedidos originais (pra poderem ser lidas de novo na Separação) e, se a trava do
Nexus estiver ligada, reintegra ao estoque da Shopify.

Cada ator tem no máximo UM lote aberto: `POST /lotes` com lote aberto devolve ele com
`retomado: true`.

## 2. Rotas

| Rota | Body / query | Resposta |
|---|---|---|
| `POST /expedicao/devolucoes/lotes` | `{ motivo?, destino? }` | `{ lote, retomado }` |
| `GET /expedicao/devolucoes/lotes` | `?status&de&ate&limit` (`de`/`ate` = `YYYY-MM-DD`) | `{ itens: Lote[] }` |
| `GET /expedicao/devolucoes/lotes/:id` | | `{ lote, resumo, itens, porVariante }` |
| `POST /expedicao/devolucoes/lotes/:id/epcs` | `{ epcs: string[] }` (1..200, ≤64 chars cada) | `{ adicionados, repetidos, invalidos, resumo }` |
| `DELETE /expedicao/devolucoes/lotes/:id/epcs/:epc` | | `{ removido, resumo }` |
| `POST /expedicao/devolucoes/lotes/:id/fechar` | `{ motivo?, destino? }` | `{ lote, resumo, reintegracao }` |
| `POST /expedicao/devolucoes/lotes/:id/reintegrar` | | `{ lote, reintegracao }` |

## 3. Shapes

- `destino`: `'estoque' | 'descarte' | 'troca'`.
- `resumo`: `{ total, devolviveis, naoEncontrados, naoExpedidos, jaDevolvidas }`.
- **Lote**: `{ id, status: 'aberto'|'fechado', abertoEm, abertoPorId, abertoPorNome, fechadoEm, fechadoPorId, fechadoPorNome, motivo, destino, qtdItens, qtdDevolvidas, reintegracao, reintegradoEm }`.
- **Item**: `{ id, epc, situacao, orderId, orderNumber, sku, tamanho, ean13, varianteId, lidoEm, aplicadaEm }`,
  `situacao`: `pendente | devolvida | nao_encontrado | nao_expedido | ja_devolvida`.
  Com o lote ABERTO, `situacao` é a classificação **prevista** (`devolvida` = vai ser devolvida ao fechar).
- `incerto` (por variante) = timeout/rede: pode ter aplicado; o Nexus reenvia com chave idempotente.
- A reintegração roda em **passadas com orçamento de ~12 s**: `fechar` pode voltar com `reintegracao.status = 'pendente'` e `resumo.pendente > 0`.
- **porVariante**: `[{ varianteId, sku, tamanho, ean13, qtd }]`.
- **reintegracao** (ou `null`): `{ status: 'ok'|'parcial'|'erro'|'pendente'|'desligada'|'em_andamento', em, porVariante: [{ varianteId, sku, tamanho, ean13, delta, status: 'ok'|'erro'|'incerto'|'sem_gid'|'sem_variante'|'pendente', erro?, tentativas?, ultimaTentativaEm?, adjustmentGroupId? }], resumo: { total, ok, erro, semGid, semVariante, pendente } }`.

## 4. Erros

Body `{ error: '<codigo>', ... }` (extrair com `expedicaoErrorCode`).

| HTTP | Código | Tratamento no app |
|---|---|---|
| 409 | `lote_fechado` | para a leitura; "Este lote já foi fechado" |
| 409 | `lote_aberto` | reintegrar de lote aberto: mensagem amigável |
| 409 | `epc_em_outro_lote` | body `epcs: [{ epc, loteId }]`; a chamada INTEIRA é recusada. App bloqueia esses EPCs (não reenvia), avisa "N peça(s) já estão em outro lote aberto" e reenvia o restante |
| 409 | `trava_desligada` | reintegrar: "reintegração desligada no Nexus" |
| 409 | `destino_nao_estoque` | reintegrar: lote sem destino Estoque |
| 409 | `reintegracao_em_andamento` | reintegrar: aguardar e conferir de novo |
| 409 | `lote_aberto_indisponivel` | abrir/retomar lote: "Não foi possível abrir ou retomar o lote agora" (corrida rara: outro lote aberto da operadora foi fechado entre o insert e a releitura; tentar de novo resolve) |
| 404 | `lote_nao_encontrado` | erro fatal da tela |
| 404 | `epc_nao_encontrado_no_lote` | remover: tira da lista local |
| 422 | `epcs_invalidos` | EPCs descartados sem aviso |
| 422 | `lote_vazio` | fechar: "leia ao menos uma peça" |
| 422 | `janela_invalida` | listagem de lotes |
| 426 | `app_desatualizado` | tratado globalmente (`updateGate`) |

## 5. Comportamento do app

- **Ao entrar**: `getMe()` + `canOperateExpedicao` (sem permissão → aviso; API fora → tenta abrir mesmo assim),
  depois `abrirLote()`. Se `retomado`, banner "Retomando lote aberto às HH:MM com N peças" e `getLote` popula a lista.
- **Leitura**: `useRfid().startPresenceSession` (mesma da Expedição), mas **acumulativa**: todo EPC visto uma vez entra
  no lote; peça tirada da mesa não some. `Set` de EPCs já enfileirados/enviados (nunca reenvia) e `Set` de bloqueados.
  Debounce de 250 ms e envio em lote (`adicionarEpcs` faz chunks de 200 e mescla `adicionados/repetidos/invalidos`,
  devolvendo o último `resumo`). EPCs são normalizados como no Nexus (`trim`, maiúsculas, só hex, exatamente 24 chars); inválidos são ignorados e contados num aviso.
  Retry de 4 s só em erro de rede, 5xx e 401; demais 4xx descartam a leva e avisam. `lote_fechado` (e erro de rede no `fechar`) confere
  `getLote`: se já está fechado, vai ao resultado e retoma a reintegração; nunca volta a ler num lote fechado.
  "Por produto" recarrega via `getLote` (debounce 800 ms) após adições.
- **Pausar/retomar**: para/retoma a sessão de presença (EPCs lidos durante a pausa não entram).
- **Remover**: `ConfirmDialog` + DELETE. O EPC removido continua em `vistos` (se a peça seguir na mesa, não volta sozinha).
- **Fechar lote**: `ConfirmDialog` com destino (Estoque/Descarte/Troca, default Estoque) e motivo opcional. Antes de
  chamar `fechar`, descarrega a fila de envio. Tela de resultado com o bloco de reintegração:
  `desligada` / `ok` / `parcial`|`erro` (tabela por variante + "Tentar reintegrar de novo") / `em_andamento` (há mais de 2 min: "Reintegração parou no meio. Tentar de novo") /
  destino ≠ estoque ("Peças não reintegradas"). Botões "Novo lote" e "Voltar ao menu".
- **Reintegração em passadas** (`reintegrarAteZerar`): com `pendente`, a tela chama `reintegrarLote` em loop sequencial até
  `resumo.pendente === 0`, mostrando "Reintegrando ao estoque… N de M variantes". 409 `reintegracao_em_andamento`: espera 3 s e
  tenta de novo (máx. 10×), depois "Outra estação está reintegrando este lote". Erro de rede/outro: mantém o último estado e
  oferece "Tentar reintegrar de novo" (mesmo loop). Variante `incerto` aparece como "Sem confirmação da Shopify, será reenviado".
- **Lotes anteriores** (`DevolucaoLotesModal`): `listarLotes({ de: hoje-30d, limit: 100 })`; detalhe com itens,
  por produto e, em lote `fechado` com reintegração `pendente`/`parcial`/`erro` (ou variante `incerto`), botão de reintegrar. Lote `aberto` não tem ações.
