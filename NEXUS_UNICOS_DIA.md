# Nexus — Filtro por dia na fila de Únicos (Expedição)

Prompt pro agente do repo `nexus` (`Berzerk-Tech/nexus`, NestJS + Drizzle, pt-BR). Também é o **contrato** que o Berzerk Client já implementa (`src/services/expedicao.ts` → `getUnicos(dia?)`, `getUnicosPedidos(..., dia?)`, `UnicosResponse.dias`; `src/lib/unicosExpedicao.ts` → `diaDe`, `filtrarPorDia`). Leia o `CLAUDE.md` do nexus antes.

Contexto de negócio (06/11/2026): o Victor quer filtrar a fila de pedidos únicos por dia de emissão ("seleciona dia 4, só aparece pedido do dia 4"). Ordem de deploy: **qualquer uma** — o client funciona nos dois casos (nexus antigo ignora `dia` e não manda `dias`; o client então mostra um `input type="date"` e filtra a lateral localmente por `emitidoEm`).

## Contrato

### `GET /expedicao/unicos?dia=YYYY-MM-DD` (opcional)

- Sem `dia`: igual a hoje.
- Com `dia`: `grupos` e `totalPedidos` só com os pedidos emitidos naquele dia.
- Resposta ganha `dias?: { dia: string; pedidos: number }[]`: **todos** os dias com pedido na fila, ordem ASC, **sempre calculado sem o filtro** (é o que monta o select; se respeitasse o filtro, o select colapsaria no dia escolhido).

### `GET /expedicao/unicos/pedidos?estampa&tamanho&cor&dia=YYYY-MM-DD` (opcional)

- Com `dia`: só os pedidos do grupo emitidos naquele dia. Sem: igual a hoje.

### Definição de "dia"

`YYYY-MM-DD` no fuso **America/Sao_Paulo**, calculado a partir de `orders.dataEmissao` (o `emitidoEm` que a API já devolve em `UnicoPedido`). O client usa a mesma regra (`diaDe`, `Intl.DateTimeFormat` com `timeZone: "America/Sao_Paulo"`); pedido sem `dataEmissao` não pertence a nenhum dia (some quando há filtro e não entra em `dias`).

## Dicas de implementação

- `apps/api/src/modules/expedicao/unicos.service.ts`, `grupos()`: já carrega todas as `linhas` (com `emitidoEm`) em memória antes de `agruparUnicos`. Calcule `dias` do conjunto **completo** e só então filtre `linhas` por dia antes de agrupar.
- O cache `cacheGruposUnicos.obter('grupos', …)` precisa de chave por dia: `grupos:${dia ?? ''}` (senão o dia escolhido por uma estação vaza pras outras por 30 s).
- Contratos zod em `packages/contracts/src/expedicao-unicos.ts`:
  - `unicosPedidosQuerySchema` ganha `dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()`;
  - novo `unicosQuerySchema` igual (só `dia`) pro `GET /expedicao/unicos`;
  - `unicosResponseSchema` ganha `dias: z.array(z.object({ dia: z.string(), pedidos: z.number().int() })).optional()`.
- `GET /expedicao/unicos/pedidos`: aplicar o mesmo filtro de dia na query/lista do grupo.
- **`POST /expedicao/unicos/separar` ganha `dia` (opcional, mesmo formato).** Correção de 06/11 (tarde, vídeo do
  Luis Fernando): a lateral mostrava só os pedidos do dia filtrado, mas o bip sem `orderId` puxava o próximo da
  variante no FIFO INTEIRO — vinha pedido de outro dia que não estava na tela, a fila nunca zerava e o order bump só
  saía clicando em cima. Com `dia`: sem `orderId`, o próximo da variante **só entre os pedidos emitidos naquele dia**
  (mesma regra de `GET /unicos/pedidos?dia`); se não houver nenhum, responder o mesmo erro de fila vazia da variante
  que já existe (o client volta pra escolha de tamanho). Com `orderId`, `dia` é ignorado. `unicosSepararBodySchema`
  (ou equivalente) ganha `dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()`. O client (0.9.74) já manda
  `dia` sempre que o filtro está ativo; nexus antigo ignora o campo (comportamento de hoje).

## Testes

- `dia` filtra `grupos`/`totalPedidos`; `dias` continua com todos os dias e contagens.
- Pedido emitido 23:30 de SP (02:30Z do dia seguinte) cai no dia de SP, não no UTC.
- Duas chamadas com dias diferentes não compartilham cache.
- Sem `dia`: resposta igual à anterior (mais `dias`).
