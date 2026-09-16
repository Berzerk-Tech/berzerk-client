# NEXUS — lista devolvida não "escapa" + filtro de produto em lista impressa

> **Para o agente do repo `nexus`.** Contrato app ↔ nexus fechado do lado do
> Berzerk Client em 16/09/2026 (client **0.9.43**, PR #76). O app já consome
> `devolvidaEm`; falta o nexus produzir. Contexto completo do incidente no fim.

## O que o app já faz (0.9.43)

- `GET /separacao/listas` → `ListaResumo.devolvidaEm?: string | null`. Lista com
  `devolvidaEm` preenchido **sai do banner 🚨 "N pedidos da sua lista impressa
  estão fora da sua mesa — Recuperar agora"** do runner. No modal "Listas
  impressas" ela aparece com o chip "devolvida em HH:MM" e a recuperação
  explícita continua possível.
- Nada mais muda no client. Campo ausente (nexus antigo) = comportamento de hoje.

## Parte A — obrigatória: marcar a lista devolvida

1. **Migration** `packages/db/migrations/0099_*.sql` (append-only):
   `separacao_listas` ganha `devolvida_em timestamptz null` e
   `devolvida_por text null`. Schema Drizzle em `packages/db/src/schema/orders.ts`
   (ao lado de `recuperada_em`/`recuperada_por`).
2. **`SeparacaoService.devolverLote`** (`separacao.service.ts` ~L1082), dentro
   da mesma transação, quando `incluirLista = true` e houve pedido com
   `lista_em` solto: carimbar `devolvida_em = now()`, `devolvida_por = ator`
   em **toda lista do ator criada hoje (America/Sao_Paulo) cujo `order_ids`
   intersecta os ids soltos**. Hoje só a auditoria
   (`separacao.lista_devolvida_com_pin`) sabe que a lista foi devolvida.
3. **`ListasService.listar`** (`listas.service.ts` ~L144): devolver
   `devolvidaEm` no `ListaResumo` (contrato em
   `packages/contracts/src/separacao-listas.ts`, `z.string().nullable()`).
   Manter `pedidosRecuperaveis`/`pedidosRetomaveis` reais — o modal usa.
4. **`ListasService.recuperar`**: ao recuperar (`idsParaRecuperar.length > 0`)
   uma lista devolvida, limpar `devolvida_em`/`devolvida_por` (ela pegou de
   volta de propósito).
5. Testes `.db.spec` de `listas.service` e `separacao.service` cobrindo:
   devolver com `incluirLista` carimba a lista de hoje; `listar` expõe o campo;
   recuperar limpa.

## Parte B — decisão do Leonardo (ver seção "Decisão" abaixo)

Situação: `lote()` (`separacao.service.ts` ~L640-670) só devolve à fila o que
está fora do recorte **e** sem `iniciado_em` **e** sem `lista_em` (regra de
04/09: lista impressa é de quem imprimiu). Então, se a operadora imprime a
lista e **depois** exclui um produto no filtro, os pedidos com aquele produto
ficam com ela (escondidos na sidebar, contando no alvo do lote — a mesa não
repõe). O único jeito de tirá-los hoje é devolver a lista inteira com PIN.

**Opção 1 (recomendada — automático):** em `foraDoRecorte`, quando o request
tem `excludeProducts`, soltar TAMBÉM pedidos com `lista_em` (ainda sem
`iniciado_em`) que contêm produto excluído:

```
foraDoRecorte = temFiltro AND meusNaFila AND iniciado_em IS NULL AND (
    (lista_em IS NULL AND NOT filtros_completos)      -- regra atual
 OR (excludeProducts?.length AND produtosNoPedido(excludeProducts)) -- novo
)
```

Só o filtro de **produto** fura a proteção da lista; **data** continua não
furando (foi a data trocando a cada poucos segundos que "sumiu" os mistos em
04/09). Registrar na auditoria (`separacao.lista_pedido_solto_por_exclusao`,
com os termos) pra ter rastro. Teste `.db.spec`: pedido com `lista_em` +
produto excluído sai; com `iniciado_em` fica; só data não solta lista.

**Opção 2 (conservadora — manual com PIN):** nexus não muda em B. O app
ganha, ao aplicar exclusão com pedidos ocultos de lista impressa, o botão
"Devolver N pedidos com esses produtos", que chama
`POST /separacao/lote/devolver` com `orderIds` + `incluirLista: true` +
`liberacao` (PIN), que já existe. Precisa de outra release do client.

### Decisão

**Opção 1** (Leonardo, 16/09/2026): "já que o pedido não tem peça, não vai
sair mesmo; idealmente ninguém pegaria até ter as peças novamente". Ou seja:
exclusão de produto solta o pedido da lista impressa, e o pedido volta pra
fila normal — não é preciso escondê-lo das outras mesas (elas tendem a excluir
o mesmo produto em ruptura). Se um dia quiser segurar esses pedidos até a peça
voltar, o gancho é `separacao_rupturas`, fora deste escopo.

## Incidente que motivou (16/09/2026, mistos G, Sabrina Araújo, 173 pedidos)

08:46 imprimiu lista de 100 **sem** o filtro → aplicou o filtro, pedidos com
produto excluído não saíram (Parte B) → 09:42 devolveu a lista com PIN
(motivo "Lista impressa sem o filtro") → 09:42–09:45 lote novo + lista nova de
100 → 09:46 o banner 🚨 ofereceu a lista **devolvida** como escapada
(`listar` conta como recuperável todo `order_id` da lista que está `ready`
sem dono; não existe marca de devolução) → "Recuperar agora" → 86 voltaram +
14 já dela recarimbados = 173 = duas listas de 100 menos 27 concluídas.

Verificado no RDS de prod: em nenhuma operadora existe pedido fora do recorte
que a regra atual mandaria soltar e ficou preso (`deveria_soltar = 0`); tudo
que fica fora do filtro é `lista_em` (Janaina 85/135 por data, Thayna 38/38,
Jardiane 3 por produto). O janitor só solta lista impressa em `virou_o_dia`.
