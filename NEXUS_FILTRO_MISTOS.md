# Nexus — Filtro Mistos + Exclusão global de produtos

Prompt pro agente do repo `nexus` (`Berzerk-Tech/nexus`, NestJS + Drizzle, pt-BR). Também é o **contrato** que o Berzerk Client já implementa (`src/lib/mistos.ts`, `src/services/orders.ts` → `QueueFilters.mistosProdutos`, `QueueProduct.produto`, `OrderItem.produto`). Leia o `CLAUDE.md` do nexus e `docs/separacao-fila-lote.md` antes.

Contexto de negócio (Black Friday, 04/11/2026): há ~6.000 pedidos mistos na fila. O Lucas desenhou o fluxo em `separacao-dev.html` + `filtro-mistos-prompts.md` (anexos da conversa). Ordem de deploy: **nexus primeiro, client depois** — o client degrada com nexus antigo (zod strip), mas aí reserva pedidos que a tela esconde.

Duas entregas, nesta ordem de prioridade, **num PR só** (`feat(separacao): filtro mistos + exclusão global de produtos`). Faça a Parte 1 completa (com testes) antes de começar a Parte 2. Deixe os checks do PR rodarem e passarem (sem bypass de admin); o merge é do Leonardo.

---

## Parte 1 (prioridade) — Filtro Mistos

### Regra

Um pedido misto (`separation_mode = 'total'`) pertence à fila do seu `predominant_size`. As peças desse tamanho saem da própria bancada; só as peças de **outro tamanho** precisam de picking. O Filtro Mistos recebe uma lista de **produtos** (produto inteiro, sem tamanho) e deixa na fila só o pedido em que:

1. existe ao menos uma peça de tamanho ≠ `predominant_size` (é misto de verdade), **e**
2. **todas** as peças de tamanho ≠ `predominant_size` são de produtos da lista, **e**
3. todas essas peças estão em `P, M, G, GG, XG` (peça em PP/G3/XXG etc. deixa o pedido de fora).

Peças do tamanho predominante não entram na conta (podem ser de qualquer produto).

### Produto = nome sem o tamanho

`order_items` não tem chave de produto. Definição canônica, que o client usa quando o campo não vem (`produtoDe` em `src/lib/mistos.ts`):

```
produto(nome, tamanho) =
  trim(nome)
  → remove no FIM: "(\s*-\s*|\s+)(<tamanho canônico>|<tamanho cru>)\s*$" (case-insensitive), quando conhecido
  → remove no FIM: "(\s*-\s*(PP|P|M|G|GG|XG|XXG|XGG|EG|G\d|\d+)|\s+(PP|P|M|G|GG|XG|XXG|XGG|EG|G\d))\s*$" (case-insensitive)
  → trim; se ficou vazio, devolve o nome original
```

O tamanho **exige separador antes** (hífen ou espaço): sem isso `"Regata Gym - M"` virava `"Regata Gy"`. **Número solto só sai depois de hífen** (`"… - 42"`): `"Short Dry Fit 2 em 1"` fica inteiro, com ou sem tamanho atrás. Tamanho canônico = `tamanhoDoItem` (`separacao.matching.ts:45`, campo ou último segmento " - " do nome; só espaço NÃO é tamanho — `"… Symbol GG"` fica sem tamanho e, por isso, nunca fecha no Filtro Mistos, dos dois lados).

Ex.: `"Oversized - Baki - G"` → `"Oversized - Baki"`; `"Regata Gym - M"` → `"Regata Gym"`; `"Short Dry Fit 2 em 1 - GG"` → `"Short Dry Fit 2 em 1"`. Comparação do filtro: **igualdade** de `lower(trim(produto))` — não é `ILIKE %termo%` como Adição/Exclusão. O client tem a mesma função em `src/lib/mistos.ts` (`produtoDe`), com os mesmos casos de teste — se mudar aqui, muda lá.

Implemente a derivação **uma vez** (SQL — função/expressão reutilizada — ou TS) e use a mesma nos três lugares abaixo. Se preferir uma função SQL (`separacao_produto_de(nome, tamanho)`), migration append-only em `packages/db/migrations/` + snapshot.

### API

1. **`mistosProdutos?: string[]`** no `queueFiltersSchema` (`packages/contracts/src/separacao.ts:305`), cada item 2–120 chars, trim. Vale em `POST /separacao/lote`, `/claim`, `/claim-mixed`, e nos GETs `queue-products`, `queue-dates`, `queues` (CSV, como `termosCsv`). Em `mode: "normal"` o campo é ignorado.
2. **`queueFiltersConditions`** (`separacao.service.ts:346`): condição nova quando `mistosProdutos` não é vazio, no formato das outras (assim claim, lote, `foraDoRecorte`, contadores, datas e `queueProducts` ficam coerentes de uma vez). Esboço:
   ```sql
   EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND tam(oi) IS DISTINCT FROM o.predominant_size)
   AND NOT EXISTS (
     SELECT 1 FROM order_items oi
     WHERE oi.order_id = o.id
       AND tam(oi) IS DISTINCT FROM o.predominant_size
       AND NOT (lower(produto(oi)) = ANY(:produtosLower) AND tam(oi) IN ('P','M','G','GG','XG'))
   )
   ```
   `tam(oi)` = a mesma normalização de `TAMANHO_NORM` (`fila-ordem.ts:50`). Os três filtros (Exclusão, Adição, Mistos) se **somam** (AND).
3. **`produto`** (string) nas respostas:
   - cada linha de `GET /separacao/queue-products` (`separacao.service.ts:3073`), em `mode=total`;
   - cada item de pedido devolvido por `lote`, `claim*`, `meus-pedidos`, `GET /separacao/:id` (onde `imagemUrl` é montado).
   É isso que garante que client e servidor filtram pela mesma chave — e é o **detector de suporte**: o client só mostra a aba Filtro Mistos e só aplica o filtro salvo quando os itens do lote / as linhas do `queue-products` vêm com `produto`. Sem o campo, o client assume nexus antigo e desliga o filtro (senão o claim reservaria 50 mistos quaisquer que a tela esconderia).
4. `GET /separacao/queue-products?mode=total&size=M` continua devolvendo **todas** as peças dos mistos do M (as do M e as de outro tamanho) com `orderIds` — o client reconstrói pedido→peças a partir disso. Não mude a agregação (`nome|tamanho|ean`).

### Não fazer (por enquanto)

- Rota nova "itens de cada pedido misto" que o Lucas sugeriu: o client reconstrói pelos `orderIds` de `queue-products`; a contagem de pedidos e o ranking ficam exatos, só a soma de peças pode variar ±1 quando o cliente levou 2 iguais (raro, e o lote tem itens exatos). Fica como melhoria se a mesa reclamar.
- Mexer em `predominant_size`/`separation_mode` (ingestão) — a regra usa o que já está gravado.

### Testes

Unitários da condição (pedido com 1 peça fora do produto marcado passa; com 2 produtos fora e só 1 marcado não passa; peça fora em G3 não passa; puro-M disfarçado — sem peça fora — não passa; case-insensitive; `mode=normal` ignora). Integração do `lote` com `mistosProdutos` + `excludeProducts` somando. Snapshot do `queue-products` com `produto`.

### Configuração (sem código)

`separacao_lote_tamanho_mistos` (padrão 50) limita o lote. Com Filtro Mistos uma marcação fecha 100–200 pedidos; vale subir pra ~100 na Black (mais pedidos por viagem de picking; o custo é lista maior por estação e mais pedidos presos numa mesa). Decisão do Leonardo, pela tela de Configurações.

---

## Parte 2 — Exclusão global de produtos ("falta no galpão")

### Problema

O Filtro Exclusão é por estação (localStorage do client, chave por fila). Quando falta uma peça, falta pro galpão inteiro, e a Stefhany precisa ir máquina por máquina marcando. Precisa de **uma lista no servidor**, válida pra todas as estações e filas, editável de qualquer estação ou do Nexus web, com efeito imediato.

### Desenho

1. **Tabela** `separacao_exclusoes_globais` (migration append-only + snapshot): `id uuid`, `termo text` (2–80, trim, único entre ativos, case-insensitive), `criado_por`/`criado_por_nome`/`criado_em`, `removido_por`/`removido_por_nome`/`removido_em` (soft delete = histórico de quem tirou o quê). Sem tabela nova de auditoria: as colunas já contam a história. **Sem canal**: a lista é do galpão — peça que falta pro e-commerce falta pro Mercado Livre também, e o `PUT` que substitui a lista inteira só é seguro se não há recorte que a estação não enxerga.
2. **Endpoints** (controller de separação):
   - `GET /separacao/exclusoes-globais` → `{ termos: [{ id, termo, criadoPor, criadoEm }], atualizadoEm }` — `separacao:read`. `criadoPor` = nome de exibição de quem adicionou. Campo opcional `podeEditar: boolean` (12/11; também no POST/DELETE): `false` = só a supervisão altera — o client esconde switch/"Limpar do galpão", mostra "Só a supervisão altera os produtos em falta." e trata 403 na escrita com a mesma mensagem; ausente/`true` = qualquer estação edita.
   - `POST /separacao/exclusoes-globais` `{ termo }` → cria (ou revive um removido; termo já ativo → 200 idempotente) → devolve a lista inteira no mesmo shape do GET — `separacao:operate`.
   - `DELETE /separacao/exclusoes-globais/:id` → soft delete (id já removido → 200 idempotente; **404 só se a rota não existe**) → devolve a lista inteira — `separacao:operate`.
   - **Sem `PUT` de lista inteira**: substituir a lista a partir do que uma estação viu ao abrir o modal apagava o que outra estação tinha acabado de pôr. O client manda o diff, termo a termo.
3. **Aplicação no servidor, sempre**: em `queueFiltersConditions`, `excludeProducts` efetivo = `(body.excludeProducts ∪ globais ativos)`, em todos os canais. Vale pra claim, lote, `foraDoRecorte` (pedido com produto em falta sai da mesa de quem ainda não iniciou/listou — igual ao filtro local hoje), contadores (`queues` — assim os tiles da "Escolha a fila" já descontam), datas e `queue-products`. Client antigo continua mandando a lista local e ganha a global de graça.
4. **Resposta do `lote`/`claim`**: opcional, incluir `exclusoesGlobais: { termos: string[], atualizadoEm }` (client antigo ignora; o client novo hoje faz o GET no mount e no evento WS — pode ficar pra depois).
5. **WS**: evento novo `exclusoes-globais.changed` `{ atualizadoEm }` em `realtime.broadcast.ts` (união + helper), emitido após commit de POST/DELETE/PUT. Client refaz `GET` e reaplica o lote. Front web antigo ignora tipo desconhecido.
6. **Nexus web**: seção "Produtos em falta (exclusão global)" na página de Separação ou em `admin-configuracoes.tsx`, grupo Separação: lista com quem/quando, campo pra adicionar termo, botão remover. Simples, sem foto.
7. **Permissão — decisão tomada**: `separacao:operate` adiciona e remove (qualquer separadora, da própria estação). Justificativa: na Black o gargalo é velocidade; quem percebe a falta é quem está na prateleira; a tabela guarda quem fez. Se der abuso, vira trava (`separacao_exclusao_global_so_supervisor`, catálogo em `settings-travas.ts`) exigindo `separacao:liberar` — **não implementar agora**, só deixar o ponto único de checagem fácil de trocar.

### Testes

Unitários: união local ∪ global; termo revivido não duplica; case-insensitive. Integração: POST → `lote` de outra operadora passa a devolver o pedido com o produto pra fila (`foraDoRecorte`) exceto se iniciado/listado; `queues` desconta.

---

## O que o client faz do lado dele (pra referência, não é tarefa do nexus)

- Manda `mistosProdutos` no body dos mesmos endpoints em que manda `includeProducts` (**só o filtro local** — a exclusão global NÃO vai no body, o nexus une sozinho; o limite de 100 termos do body é respeitado); reaplica a regra em memória (`passaNosFiltros`); usa `produto` quando vem, senão deriva.
- Aba "Filtro Mistos" no Filtro Inteligente (ranking "fecha sozinho", grade do picking, "Imprimir mistos"), Picking Geral por produto × grade, etiqueta Zebra 100×150 só com as peças fora do tamanho da fila.
- Aba Exclusão: chips "galpão"/"só aqui", switch "Em todas as estações" (default ligado); ao aplicar manda o diff (`POST` por termo novo, `DELETE` por termo tirado); a lista só desta estação continua existindo pra caso raro (ex.: prateleira local vazia). Evento WS `exclusoes-globais.changed` → GET + reaplica o lote.

---

## Adendo 12/11/2026 — PP e G3 + sem limite (client 0.9.82+; nexus sobe ANTES)

- **`mistosTamanhos?: string[]`** no body (`POST /separacao/lote`, `/claim`, `/claim-mixed`), SEMPRE junto de `mistosProdutos`: o client manda `["PP","P","M","G","GG","XG","G3"]`. É o conjunto em que a peça fora do predominante pode estar; G1, G2 e XXG continuam deixando o pedido de fora. Sem o campo, o servidor segue em P–XG. Os GETs (`queues`/`queue`/`queue-dates`/`queue-products`) hoje NÃO levam `mistosProdutos` no client, então também não levam `mistosTamanhos`.
- **Sem limite**: com `mode: "total"` e `mistosProdutos` não vazio o client NÃO manda `quantidade` e mostra "Sem limite" no lugar do seletor; o servidor ignora `quantidade` e o teto de `separacao_lote_tamanho_mistos`, puxa todos que casam (guarda técnica de 500 por puxada).
- Lista impressa/picking: PP e G3 ganham caixa só na linha (produto) que tem peça nesses tamanhos; ordem dos pedidos na lista PP, P, M, G, GG, XG, G3. "Fora do predominante" segue como antes (inclusive PP numa fila M).
