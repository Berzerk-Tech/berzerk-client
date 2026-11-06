# Nexus — `GET /expedicao/orders/:id/documentos` de pedido ML não pode depender do Tiny

Incidente 06/11/2026 (vídeo do Victor, 10:34): a mesa de embalagem não "puxava" a etiqueta do
Mercado Livre. Nenhum pedido ML foi expedido hoje; o #997143 ficou parado em "Imprimir".

## Diagnóstico (prod)

- A etiqueta do Mercado Envios do #997143 **já estava** em `ml_shipping_labels` (S3,
  `etiquetas/ml/e2f75e8e-….pdf`, criada 00:52 UTC pela etapa `etiquetas-ml`). Idem para todos
  os ML separados hoje. Não é falta de etiqueta.
- API Gateway (`/aws/apigateway/berzerk-nexus-prod-api`): entre 13:32 e 13:34 UTC houve **12 respostas
  429** em `GET /api/expedicao/orders/{id}/documentos`, todas de pedidos ML, com
  `integrationLatency` ≈ 3.0–3.2 s. O #997143 (`e2f75e8e-71ab-4b43-b325-42d9a1e3af07`) levou 429
  às 13:34:46 UTC — o momento do vídeo.
- Causa no código (`apps/api/src/modules/expedicao/expedicao.service.ts`, `documentos()`): no ramo
  `order.expedicaoManual` o service chama `danfeDaMesa()` → `DanfeService.getDanfe()` → **duas
  chamadas ao Tiny v2** (`pedido.obter` + `nota.fiscal.obter`). Com o `TinyRateLimiter`
  bloqueado, `getDanfe` espera `TINY_LIMITER_ESPERA_MAX_MS = 3_000` e lança
  `rateLimitError()` (429 `tiny_rate_limited`). `danfeDaMesa` só absorve 404/501, então o 429
  propaga e a resposta inteira cai — **mesmo com a etiqueta ML pronta no cache**.
- O client trata o 429 de `documentos` como erro terminal ("Falha ao buscar os documentos do
  pedido") e o pedido não avança.
- É a repetição do bug da J&T de 04/09 (comentário em `documentos()`, linhas ~1150-1157: a DANFE
  saiu do `documentos` exatamente por isso). O ramo ML (20/10) trouxe a chamada ao Tiny de volta.

## Quem esgota a cota do Tiny

`/aws/lambda/berzerk-nexus-prod-separacao-worker`, etapa `etiquetas-ml` (`etiquetas-ml.etapa.ts`):
o único candidato do dia é o pedido **980518** (tiny 773500668), cuja expedição no Tiny está
`"situacao":"Cancelado"`. A etapa tenta ele a cada tick (~10 min), alterna entre
`expedicao_nao_encontrada` e `cota do Tiny esgotada`, e segura o limiter compartilhado que a
mesa precisa.

## O que mudar

1. **`documentos()` de pedido ML: DANFE best-effort, nunca 429.**
   - Se há etiqueta ML em cache (`ml_shipping_labels` com `label_s3_key`/`label_base64`), **não
     chamar o Tiny** para a DANFE: responder `danfe: null` + `etiquetaMl` preenchida. A mesa
     imprime a etiqueta ML; a DANFE só é fallback quando a etiqueta não existe.
   - Sem etiqueta em cache: tentar a DANFE, mas capturar o 429 (`HttpException` com status 429)
     e responder `danfe: null` + `etiquetaMlErro: { codigo: 'tiny_rate_limit', mensagem: … }`
     (código já existe em `EtiquetaMlErroCodigo`). O client já sabe mostrar esse erro e tentar de
     novo; o que ele não pode receber é a request inteira falhando.
   - Mesmo tratamento para outro `HttpException` do `DanfeService` que não seja 404/501: logar
     e seguir com `danfe: null`. A rota roda a cada bip; nenhuma dependência externa pode
     derrubá-la.
2. **Etapa `etiquetas-ml`: parar de bater no Tiny em pedido com expedição cancelada.**
   - Quando `buscarNoTiny` devolve `expedicao_nao_encontrada` com `detalhe.situacao ===
     'Cancelado'`, registrar isso (coluna/flag ou tabela de "desistidos", ou simplesmente
     excluir de `listarCandidatosEtiquetaMl` pedidos cujo último resultado foi cancelado) e não
     tentar de novo a cada tick. Um aviso por dia no log basta.
   - Opcional: respeitar o `tiny_rate_limit` por mais tempo (hoje `parouPor=cota` só encerra o
     run; o próximo tick volta a tentar e esgota de novo).
3. **Teste**: `expedicao.service.db.spec.ts` (ou unit) cobrindo: pedido ML com etiqueta em cache
   e `DanfeService` lançando 429 → 200 com `etiquetaMl` e `danfe: null`; pedido ML sem etiqueta e
   429 → 200 com `etiquetaMlErro.codigo = 'tiny_rate_limit'`.

## Client (Berzerk Client)

0.9.72: 429 em `documentos` deixa de ser erro terminal — a mesa tenta de novo sozinha a cada 5 s
(até 6 vezes) com o aviso "O Tiny está limitando as chamadas — tentando de novo…". É só
paliativo: com o nexus corrigido, o 429 não acontece.
