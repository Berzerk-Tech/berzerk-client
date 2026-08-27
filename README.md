# Berzerk Client

> Estação industrial onde produtos da Berzerk recebem identidade RFID
> e são despachados. Substitui o antigo "Print Station" — o escopo
> cresceu de impressão pra operação RFID completa (etiquetagem +
> expedição + dispositivos USB).

Aplicação desktop instalada nos PCs do chão de fábrica da Berzerk. Cobre os módulos do fluxo industrial:

- **Etiquetagem** — aplica identidade RFID em lotes confirmados de produção. Lookup de EAN13 (local + Shopify) e impressão com margem de segurança.
- **Separação** — a operadora entra numa fila (tamanho + puro/misto), recebe um **lote** de pedidos (o tamanho é configurado no Nexus) e confere peça a peça na mesa RFID.
- **Expedição** — bipa etiqueta RFID, identifica pedido pronto, imprime etiqueta J&T e DANFE.

Login no **Nexus** (Cognito, Google Workspace `@berzerk.com.br`) — a partir da v0.7.0.

---

## Instalação (operador de fábrica)

Tempo total: ~3 minutos por PC.

1. Baixar o instalador mais recente: [latest release](https://github.com/Berzerk-Tech/berzerk-client/releases/latest) → `Berzerk.Client_*_x64-setup.exe`.

2. Executar o `.exe`. Na primeira vez, o Windows SmartScreen vai bloquear com a mensagem **"O Windows protegeu seu PC"**:
   - Clicar em **"Mais informações"**
   - Clicar em **"Executar assim mesmo"**

   Isso aparece porque o app ainda não tem certificado de assinatura de código do Windows. Acontece **uma única vez por PC** — após instalado, abre normal.

3. Seguir o instalador (Next, Next, Install). O app é instalado em `%LOCALAPPDATA%\Programs\Berzerk Client\` e adicionado ao Menu Iniciar.

4. Abrir o app pelo atalho do Menu Iniciar. Clicar em **"Entrar com Google"** e logar com sua conta `@berzerk.com.br`.

5. Pronto. A janela do navegador fecha sozinha, o app já abre na tela principal.

### Atualizações (obrigatórias desde a 0.9.2)

O app verifica atualizações **ao abrir e ao entrar em cada módulo** (Etiquetagem, Separação, Expedição). Quando há versão nova, ele **para**: uma tela cheia com

> **Atualize o Berzerk Client** — instalada v0.X.Y → necessária v0.X.Z — [Atualizar agora]

Não há "mais tarde". Clicando em "Atualizar agora" ele baixa, valida a assinatura, substitui o executável e reinicia — ~30 segundos. Se a mesa estava com um lote de separação reservado, o lote **volta para a fila sozinho** antes do bloqueio, para não travar as outras estações.

A mesma tela aparece se o Nexus recusar uma chamada com **426** (`app_desatualizado`): o servidor tem uma **versão mínima** configurada (Configurações → Versão mínima do Berzerk Client, no Nexus) e abaixo dela não há fila, etiquetagem nem expedição. É essa a trava de verdade — o check do GitHub é só o aviso antecipado, e falha de rede nele **não** bloqueia ninguém.

Não é necessário reinstalar manualmente — uma vez instalado, esquece.

---

## Troubleshooting

### "O Windows protegeu seu PC" (SmartScreen)

Comportamento esperado na **primeira instalação**. Veja passo 2 acima.

### "Login não configurado nesta instalação"

O build saiu sem `VITE_COGNITO_DOMAIN`/`VITE_COGNITO_CLIENT_ID`. É falha de release, não da máquina — falar com o time de tecnologia.

### Etiquetagem dá 403 / "sem permissão"

A Etiquetagem passou a exigir a permissão **`etiquetagem:operate`** no Nexus (0.8.0). Antes ela não pedia nada: o portão era a RLS do Supabase, que liberava para qualquer sessão. Quem etiqueta precisa do papel **`etiquetador`** — atribuído na tela de Usuários & Papéis do Nexus.

### "Continue o login no navegador" trava indefinidamente

1. Verificar se o navegador padrão abriu uma aba em `accounts.google.com`
2. Se a aba ficou em branco / não terminou, fechar a aba e clicar **"Cancelar"** no app
3. Tentar de novo

### "Falha ao verificar atualização"

Geralmente é falta de internet no PC. O app continua funcionando com a versão atual — o check do GitHub **não** bloqueia quando falha.

### Travou na tela "Atualize o Berzerk Client" e não baixa

Ela mostra "Não foi possível baixar a atualização automaticamente" quando o GitHub não responde. Use **Abrir página de versões**, baixe o instalador e rode por cima da instalação atual. Se o número exigido ainda não existe na página de releases, a versão mínima no Nexus foi subida cedo demais — falar com o time de tecnologia (dá pra desligar a exigência na hora, em Configurações → Versão mínima do Berzerk Client).

### Quero forçar logout

No canto inferior da tela principal: **"Encerrar sessão"**.

---

## Para desenvolvedores

### Stack

Tauri 2 + React 19 + TypeScript + Vite + Bun. Login e API **100% no Nexus** (Cognito + `api-nexus.cloud.berzerk.com.br`). Desde a 0.8.0 **não há mais nenhuma dependência do Supabase** — a Etiquetagem e o Rastreio, os últimos consumidores, migraram na fase 3 do `docs/plano-corte-supabase.md`.

Estrutura:

```
src/                     # React app
  components/            # UI (HomeMenu, Login, BatchBrowser, etc)
  lib/                   # Helpers — cognito (login), auth (loopback), api, realtime (WS), deep-link, updater
  services/              # Camada de acesso a dados (chamadas à API do Nexus)
src-tauri/               # Rust app shell + plugins Tauri
  src/lib.rs             # Entry point — registra plugins
  src/oauth_loopback.rs  # HTTP server local para callback OAuth
.github/workflows/       # Build + release matrix
```

### Setup local

Requisitos:

- **Windows 10/11** com WebView2 (já vem no Edge)
- **Rust** ([rustup](https://rustup.rs))
- **Bun** ([curl -fsSL https://bun.sh/install | bash](https://bun.sh/))
- **Visual Studio Build Tools** com workload "Desktop development with C++"

```powershell
git clone git@github.com:Berzerk-Tech/berzerk-client.git
cd berzerk-client
cp .env.example .env
# O .env.example já vem com o Cognito de PROD (e o de DEV comentado).
# Falta só VITE_SUPABASE_PUBLISHABLE_KEY (chave anon pública) pra Etiquetagem.

bun install
bun run tauri dev
```

Testes (vitest + jsdom, sem Tauri): `bun run test` — cobre o helper de imagem
e o smoke de render da separação.

Primeiro `tauri dev` demora ~5-10min (compila ~430 crates Rust). Próximas execuções são incrementais (<10s).

Linux (Arch / Ubuntu / Fedora) também roda — ver [seção Linux](#desenvolver-em-linux) abaixo.

### Login (Cognito)

Desde a v0.7.0 quem autentica é o **Nexus**: Authorization Code + PKCE contra o Hosted UI do Cognito (pool staff), indo direto pro Google (`identity_provider=Google`, `prompt=select_account` — mesa compartilhada, o chooser sempre aparece).

O fluxo é não-trivial porque Chrome 120+ bloqueia custom schemes (`berzerk-print://`) em redirects sem gesto do usuário. Solução (a mesma de antes, com outro emissor):

1. App sobe servidor HTTP local em `127.0.0.1:54321` antes de abrir o navegador
2. `redirect_uri` aponta pra esse loopback (`/oauth-callback`)
3. `response_type=code` + PKCE S256 (o `#hash` do implicit não chegaria no server)
4. Servidor captura o `code`, emite o evento Tauri `oauth-callback-url`, encerra
5. `src/lib/cognito.ts` troca o code em `/oauth2/token` (sem secret), guarda a sessão em localStorage e renova sozinho pelo `refresh_token`

O **Bearer da API e do WS é o `id_token`** — o access token do Cognito não carrega `email`, e o Nexus usa o e-mail pra provisionar `usuarios`, casar papéis no 1º login e emitir o handoff do desktop.

**Logout** (explícito ou por inatividade) limpa a sessão local e também a do Hosted UI (`/logout` com `logout_uri` no mesmo loopback). Sem esse último passo, o próximo `authorize` na mesma máquina poderia devolver um code da operadora anterior sem passar pelo Google.

**Config** (não são segredos: domínio público e app client nativo sem secret):

| Env | PROD | DEV |
|---|---|---|
| `VITE_COGNITO_DOMAIN` | `https://auth.cloud.berzerk.com.br` | `https://auth.dev.cloud.berzerk.com.br` |
| `VITE_COGNITO_CLIENT_ID` | `3fblnt9gohl76eflpphff13okc` | `ugc706cc2h2ju752najt904g8` |
| `VITE_COGNITO_REGION` | `us-east-1` | `us-east-1` |

Os client ids saem de `terraform output cognito_desktop_client_id` na stack `nexus/<env>` do `berzerk-infra` (`stacks/nexus/*/auth.tf`, resource `aws_cognito_user_pool_client.desktop`). O callback `http://127.0.0.1:54321/oauth-callback` está cadastrado lá, em callback E logout URLs. No CI as três vêm de `vars` (não `secrets`).

### Etiquetagem e Rastreio no Nexus (0.8.0)

A 0.8.0 tirou o Supabase do app. A Etiquetagem e o Rastreio, que falavam direto com `silk_records`, `production_batches`, `rfid_print_jobs` e `rfid_epc_inventory`, passaram a usar a API do Nexus com o mesmo Bearer do resto do app:

| Antes (Supabase) | Agora (Nexus) |
|---|---|
| `silk_records` + `production_batches` | `GET /etiquetagem/lotes` |
| `production_batches.rfid_impresso_at` | `POST`/`DELETE /etiquetagem/lotes/:id/impresso` |
| `design_templates` + `unified_products` + edge `shopify-analytics` | `GET /etiquetagem/lotes/:id/eans` |
| `rfid_print_jobs` (+ Realtime) | `/etiquetagem/print-jobs/*` + WS `print-jobs.changed` |
| `rfid_epc_inventory` | `/etiquetagem/epcs/*` |
| `rfid_action_logs` | `POST /etiquetagem/log` (vira `auditoria`) |

Com isso saíram do app: `@supabase/supabase-js`, `src/lib/supabase.ts`, `src/lib/supabase-derivada.ts`, `src/services/ean13Lookup.ts`, as envs `VITE_SUPABASE_*`, o handoff `POST /desktop/handoff` e a tela "Etiquetagem indisponível".

Duas responsabilidades mudaram de lado, e é bom saber por quê:

- **Quem casa EPC ↔ tamanho é o servidor.** O app manda só a lista de EPCs na ordem em que a iTAG a devolveu; o Nexus expande os itens do job. O job é a cópia confiável do payload — refazer a expansão aqui duplicaria a regra, e um erro nela grava o EAN do tamanho errado na etiqueta.
- **"Descartar teste" virou uma chamada transacional.** Eram três passos daqui (buscar jobs → apagar EPCs → cancelar jobs) que podiam parar no meio e deixar EPC de teste vivo com o job já cancelado — etiqueta de teste lida na separação como peça de verdade.

**Permissão:** tudo sob `etiquetagem:operate` (papel `etiquetador` no Nexus). É a primeira vez que a mesa tem controle de acesso: antes o portão era a RLS do Supabase, que liberava para qualquer sessão autenticada.

### Separação em lote (0.9.0)

Pedido das separadoras no cutover: puxar **um pedido por vez** deixava a mesa parada entre um claim e outro, e a fila não tinha como ser atacada por dia de emissão. A 0.9.0 refaz o módulo em cima de três coisas:

**Lote de 10.** Ao entrar numa fila o app chama `POST /separacao/lote` e recebe até 10 pedidos que passam a ser **dela** — a sidebar deixa de ser a fila inteira e passa a ser o lote. Clicar num card só decide qual pedido vem agora (sem claim, sem disputa com outra estação). Depois de cada conclusão ou devolução o app chama o mesmo endpoint de novo, que é **idempotente**: devolve tudo o que ela já tem e completa até 10. O rodapé mostra quantos ainda estão na fila sem dono (`fila.restantes`). (Na 0.9.0 o número 10 vinha do app e a divisão entre as estações era emergente — cada reposição pegava só o que ainda não tinha dono; ver a 0.9.3 abaixo.)

Sair da fila (voltar ao menu, trocar de fila, logout por inatividade) **devolve o lote em aberto**, mandando os ids — senão os pedidos ficariam reservados e invisíveis pras outras mesas até o janitor expirar o claim. Se o app tiver sido fechado no meio do turno, `GET /separacao/meus-pedidos` faz a tela de filas oferecer **Retomar** (ou devolver).

**Seletor "Data".** A janela de data saiu do Filtro Inteligente e virou o botão **Data** na sidebar, com uma linha por data de emissão presente na fila e a contagem do dia (`GET /separacao/queue-dates`) — o mesmo controle do posvenda. Escolher uma data manda `dateFrom = dateTo` em tudo (lote, produtos, picking). Filtro de data salvo por versão anterior como *janela* (`dateFrom ≠ dateTo`) é descartado no load: o seletor é de dia único e não teria como mostrá-la — ela ficaria filtrando a fila sem aparecer em lugar nenhum.

**Picking Geral.** O botão na sidebar abre o agregado da fila (`GET /separacao/queue-products`, agora com `resumo`): uma seção por tamanho com SKU / Produto / Qtd, e os totais "N produtos • N itens • N pedidos". Serve nas duas filas — no misto os itens vêm de tamanhos variados e as seções aparecem todas. **Imprimir Tudo** e **Imprimir `<tamanho>`** geram o PDF (`src/lib/pickingPdf.ts`, jsPDF) e mandam pelo caminho **silencioso** do app (`src/lib/printer.ts` → SumatraPDF), o mesmo da etiqueta J&T e da DANFE; `window.print()` dentro do WebView abriria um diálogo do Windows, que é justamente o que a mesa não tem como responder. (A folha saía em A4 na impressora padrão até a 0.9.5 — ver abaixo.)

Endpoints novos que esta versão consome: `POST /separacao/lote`, `POST /separacao/lote/devolver`, `GET /separacao/meus-pedidos`, `GET /separacao/queue-dates`. Enquanto o Nexus não tiver o do lote, o app **degrada** pro claim de um pedido por vez (lote de um, sem "faltam X") em vez de mostrar erro — o app se atualiza sozinho em todas as estações, então as duas ordens de deploy precisam funcionar.

### Lote configurável e divisão da fila (0.9.3)

Duas mudanças de servidor que o app passa a acompanhar (ver
`docs/separacao-fila-lote.md` no Nexus):

**O tamanho do lote saiu do app.** Era `quantidade: 10` no corpo do
`POST /separacao/lote`; agora quem manda é a configuração
`separacao_lote_tamanho` (Configurações do Nexus → *Separação*), e o app não
manda mais o campo. Mudar de 10 para 6 deixou de exigir uma versão nova do
desktop.

**A fila esgotada é dividida.** Quando uma estação entra numa fila onde não
sobrou nada livre, o servidor tira das colegas que estão acima da divisão igual
os pedidos que elas **ainda não começaram a conferir** — fila com 10 e uma
operadora segurando os 10: a segunda a entrar sai com 5. Quem perdeu pedidos
recebe o `queue.changed` e o app re-busca o lote; como a resposta do
`POST /separacao/lote` é o retrato inteiro, a sidebar encolhe sozinha.

**`POST /separacao/:id/iniciar`** é o que protege a bancada: ao ABRIR um card
pra conferir, o app carimba o pedido no servidor e ele deixa de ser realocável.
A chamada é uma por pedido, best-effort (falha de rede não trava nada, e o app
tenta de novo quando a janela volta ao foco) e degrada em silêncio num Nexus
sem a rota. Se ainda assim o pedido da mesa sumir da resposta do lote, a tela
avisa *"Este pedido foi redistribuído para outra estação"* e volta pro lote —
ela nunca fica conferindo um pedido que o `complete` recusaria com 409.

### Sequência do lote, filtros na tela e trava do supervisor (0.9.5)

O que as separadoras reportaram no primeiro dia da 0.9.4.

**A mesa segue SEQUENCIAL.** Concluir (ou devolver) voltava pro PRIMEIRO card do
lote; agora abre o pedido SEGUINTE ao que saiu, e só volta ao começo quando não
sobrou nenhum depois dele — que é o caso "a lista acabou, o servidor repôs,
continua do primeiro novo". Clicar num card pra escolher a ordem continua
valendo.

**Pular (P).** A peça ainda não chegou da dobra: o pedido vai pro FIM da ordem
local e a mesa segue pro próximo. Ele **continua reservado** pra ela — pular não
fala com o servidor (só o `iniciar` do pedido que entra na mesa) —, aparece na
sidebar marcado como *pulado* e volta depois do último.

**O filtro vale sobre o lote.** Desde 27/08 o `POST /separacao/lote` do Nexus
devolve tudo o que já é dela no modo+tamanho, ignorando data/produto: os filtros
decidem só o que ENTRA de novo (foi o conserto de uma operadora com 81 pedidos).
Isso tirou o efeito que a operação usava — excluir "calça" e não ver calça. O
recorte de EXIBIÇÃO passa a ser do app: sidebar, Picking Geral e o "próximo"
percorrem só o que bate com o filtro, nada é devolvido ao servidor, e o rodapé
conta `N ocultos pelo filtro`. A regra de casamento é a mesma do servidor
(`ilike %termo%` sobre o nome do item) e a data usa o dia de **São Paulo**.
A data passou a contar no chip `Filtros (N)` do topo: ela sobrevive à troca de
fila (fica no `localStorage` da estação) e, invisível ali, deixava a operadora
entrar numa fila nova com o recorte de outro dia ativo — a fila e o Picking
Geral vinham vazios sem explicação. O Picking Geral também ganhou uma porta no
topo, ao lado de Filtros/Histórico, e a mensagem de "vazio" agora diz QUAL
recorte está ativo.

**Trava da liberação por supervisor.** O Nexus expõe em `GET /separacao/me` a
configuração `liberacaoSupervisorAtiva` (Configurações → Separação, padrão
ligada). Com ela DESLIGADA, **K** / "Concluir com faltantes" conclui direto
depois de um `Faltam N peças — concluir mesmo assim?`, sem o diálogo do PIN
(o Nexus grava a auditoria sem supervisor). Com ela ligada, nada muda. Se o
servidor recusar mesmo assim (a trava mudou no meio do turno), o 422
`liberacao_necessaria` cai no diálogo do PIN, como antes. Ausente na resposta =
ligada — nunca se afrouxa trava por causa da versão do servidor.

### Picking Geral em etiqueta (0.9.5)

Duas correções do que o campo reportou em 27/08.

**A folha virou etiqueta 100×150 mm.** O PDF do Picking Geral era A4 e ia pra
impressora **padrão** do Windows — que nas bancadas é a térmica de etiquetas.
Resultado: a página A4 inteira encolhida dentro de uma etiqueta de 10×15 cm,
fonte minúscula, ilegível de pé. Agora `src/lib/pickingPdf.ts` gera páginas de
**100×150 mm** (retrato, margem 4 mm) com corpo de fonte de bancada — tamanho
da seção em 22pt, produto em 11pt (quebra em até 2 linhas), quantidade em 14pt
negrito —, **uma seção de tamanho por etiqueta** (continua em `P (2/3)` quando
não cabe), cabeçalho repetido em toda etiqueta (operadora, escopo, data/hora,
fila, contagem da seção) e rodapé `Página N/M`. Cabem ~15 produtos por etiqueta.
O EAN saiu da folha: na prateleira ela pega pelo NOME, e os 10 cm valem mais em
corpo de fonte — o SKU continua na tela do Picking Geral.

E a impressão passa a usar **explicitamente a impressora de etiquetas
configurada** em Configurações (`getLabelPrinter()`, a mesma da etiqueta J&T e
da DANFE), em vez da padrão do Windows.

**Mistos não listam o tamanho da própria bancada.** Na fila de mistos GG as
peças GG já estão com a operadora na bancada; a folha existe pra ela buscar os
OUTROS tamanhos do pedido na prateleira. A seção da bancada agora fica fora —
no lote e na "fila inteira" —, com o recorte pelo mesmo **bucket** do claim
(`src/lib/filas.ts`, extraído de `Separacao.tsx`): a fila XG tira também
XXG/G1/G2/G3, a fila P tira PP. O cabeçalho (tela e etiqueta) mostra
*"sem GG (bancada)"* e os totais já vêm recalculados. Nas filas de **puros**
nada muda — ali a lista é a própria bancada.

### "Out of Memory" na bancada (0.9.7)

Incidente de 27/08: a bancada do CD entrava na fila de **puros** e o WebView2
trocava o app pela página do Chromium *"Esta página está com problemas —
Código de erro: Out of Memory"*. Uma chamada `POST /separacao/lote` no log do
API Gateway (72 KB) e nada depois — o app recebeu o lote e morreu desenhando.

**A causa é a imagem, não um laço de render.** As `imagemUrl` que o Nexus manda
nos itens do lote são o arquivo **original** do CDN da Shopify: medido em campo,
`RESSURECTED.jpg` tem **2083×2706 px**. O que ocupa memória não é o peso do
`.jpg`, é o bitmap — `w × h × 4` = **~23 MB por foto**. Um lote de 10 pedidos ×3
itens põe 33 `<img>` em tela de uma vez (30 miniaturas na sidebar + 3 cards do
pedido aberto): **~744 MB de bitmap**, antes de qualquer leitura RFID. O legado
(`minhacontaberzerk`) carregava a original de propósito — "nitidez" —, e foi
esse hábito que chegou até aqui.

`src/lib/imagens.ts` pede o tamanho de tela ao CDN, com a mesma convenção do
Nexus (`packages/contracts/src/shopify-thumb.ts`): `width=<px>` na query,
preservando o `?v=`. Só `cdn.shopify.com` e irmãos são tocados — Tiny/S3 já vem
em 770×1000 e passa **intacto** —, e URL que já pede tamanho (`width=` ou
sufixo `_NxN`) volta inalterada.

| Onde | Largura | Bitmap |
|---|---|---|
| Miniatura (sidebar do lote, histórico, Filtro Inteligente, etiquetagem) | 400 | ~0,8 MB |
| Picking / itens da Expedição | 800 | ~3,3 MB |
| Card do pedido ABERTO na mesa | 1000 | ~5,2 MB |

A foto do card **continua grande** — 1000 px de largura para um card de ~330 px
CSS cobre HiDPI com folga. As mesmas 33 imagens passam de ~744 MB para **~40 MB**.
Toda `<img>` da separação, expedição e etiquetagem leva `loading="lazy"` +
`decoding="async"`.

**Não era um laço de render.** A hipótese foi levantada e testada: o runner foi
montado num Chrome de verdade (layout real, 1366×768 e mais quatro resoluções,
1 a 20 itens por pedido, puro e misto, com e sem filtro salvo de outro dia,
rajadas de 60 `queue.changed`) e estabiliza em 3 a 7 commits em todos os casos.
`test/separacao-runner.render.spec.tsx` deixou a trava: entra na fila com um
lote de 10 e falha se o número de commits explodir — ou se alguma `<img>` voltar
a pedir a original.

**Rede embaixo.** `src/lib/memoriaWatchdog.ts` loga o heap do renderer de 60 em
60 segundos e, passando de 1,5 GB (ou 70% do teto do motor), **recarrega a
janela** com um toast explicando. A sessão está no localStorage e os pedidos
continuam reservados no servidor — ela perde 3 segundos em vez do turno, que é
estritamente melhor que a página de OOM. O vigia não corrige nada; ele existe
pra que o próximo vazamento apareça como uma curva no console em vez de uma
bancada parada.

Junto vieram os tetos que faltavam: o poll do iTAG faz **backoff** de 400 ms até
5 s enquanto a mesa não responde (eram 150 chamadas por minuto com a mesa
offline), o `Set` de pedidos já iniciados é podado a cada reposição do lote em
vez de acumular o turno inteiro, os osciladores do bipe se desconectam ao
terminar, e os timers dos banners morrem com a tela.

### Atualização forçada (0.9.2)

Pedido do dono: "não quero gente usando versão antiga". Antes, a atualização era um banner com **Mais tarde** — e na mesa do CD "mais tarde" é nunca; máquinas ficavam meses atrás e cada correção publicada só valia pra quem por acaso clicou.

**A trava é do servidor, não do app.** O app velho é justamente o que não tem a regra nova: qualquer verificação que dependa do binário instalado só passa a valer a partir da versão que a contém. Então quem barra é o Nexus, pela porta que o app velho já usa hoje.

Três peças:

| Peça | Onde | O quê |
|---|---|---|
| Header `X-Berzerk-Client-Version` | `src/lib/api.ts` | vai em **toda** chamada ao Nexus, com `getVersion()` do Tauri (resolvido uma vez e cacheado) |
| Bloqueio | `src/lib/updateGate.ts` + `src/components/UpdateRequired.tsx` | estado global com subscribe; tela cheia sem saída |
| Verificação antecipada | `App.tsx` | `verificarAtualizacao()` no boot (5 s) e ao entrar em Etiquetagem / Separação / Expedição |

Duas portas levam ao mesmo bloqueio, e a divisão é de propósito:

1. **426 do Nexus** (`{ error: "app_desatualizado", versaoMinima, versaoAtual }`) em qualquer chamada — a trava dura. Não tem como um app velho ignorá-la: quem responde é o outro lado.
2. **Updater do GitHub** — o aviso antecipado. Se o GitHub estiver fora, essa porta não abre (só um `console.warn`): falha de rede não pode parar a operação.

Antes de a tela entrar, os hooks de `onAntesDeBloquear` rodam — hoje só a Separação, devolvendo o lote (`SeparacaoRunner`, ao lado do `onBeforeForcedLogout`). Sem isso a mesa bloqueada levaria os pedidos reservados junto, invisíveis pras outras estações até o janitor expirar o claim. Teto de 2,5 s, e a falha é engolida (o janitor recupera).

Fora do Tauri (`bun dev` no navegador) `getVersion()` falha e o header não vai. É o certo: sem header o Nexus entende "não é o desktop" e deixa passar — desenvolver no browser não fica atrás de uma trava que existe pra máquina da mesa.

Quem define a mínima: **Nexus → Configurações → Versão mínima do Berzerk Client** (`PUT /settings/versao-desktop`, exige `identity:manage`). A ordem do rollout é sempre deploy da API → release do client → subir a mínima; ver `docs/aplicativo-desktop.md` no nexus.

### Deep link (abrir pelo Nexus)

O Nexus (web) tem um botão "Abrir Berzerk Client" que navega pra uma URL `berzerk://...`. O app abre (ou vem pra frente se já estiver aberto) e fica logado sem o operador digitar nada — pensado pra estação de fábrica onde o navegador roda num monitor e o app noutro.

**Esquema:** `berzerk`, registrado em `plugins.deep-link.desktop.schemes` no `tauri.conf.json`. URLs:

- `berzerk://auth?email=<e-mail>` — contrato ATUAL (Nexus ≥ 26/08). O link não carrega credencial nenhuma: só o e-mail de quem clicou, que vira `login_hint`.
- `berzerk://auth?token_hash=<hash>&type=magiclink` — contrato da 0.6.0, mantido. **O `token_hash` é ignorado desde a 0.8.0** (ele existia só para derivar a sessão Supabase); o host continua aceito porque links emitidos por versões antigas do Nexus ainda chegam.
- `berzerk://login` — mesmo tratamento do `auth` (0.7.0).
- `berzerk://open` — só foca a janela.

**Fluxo de auth (0.9.1):** focar a janela, RESOLVER a sessão do Nexus (renovando pelo refresh token se estiver vencida) e só então decidir. Com sessão viva não há nada a fazer além do toast. Sem sessão, o app dispara o PKCE no navegador **sem `prompt=select_account`** e com `login_hint=<e-mail>`: o navegador que mandou o link acabou de logar no Nexus, então o Hosted UI do Cognito devolve o código sozinho, a aba do loopback se fecha em ~1,5 s e o app entra logado — sem ninguém digitar nada.

Até a 0.9.0 esse login pedia `prompt=select_account`, então clicar em "Abrir Berzerk Client" abria o app e jogava a pessoa **de volta no navegador**, na tela de escolher a conta do Google. Era esse o bug de 26/08. O `prompt=select_account` continua no botão "Entrar com Google" da tela de login, onde ele existe por um motivo real: mesa compartilhada (a operadora que chega precisa escolher a conta dela) e o beco sem saída do `org_internal` quando o Google pega sozinho um gmail pessoal.

Sucesso → toast "Conectado como `<e-mail>`" e tela inicial. Falha → tela de login com o motivo (e o botão "Entrar com Google" ali do lado, que pede o seletor de contas).

**Segunda instância (Windows/Linux):** o SO abre uma nova instância do processo passando a URL como argumento de linha de comando. `tauri-plugin-single-instance` (feature `deep-link`) detecta isso, repassa a URL pra instância já rodando — que reemite como o evento `deep-link://new-url` do `tauri-plugin-deep-link`, o mesmo que `onOpenUrl` no front escuta — e a segunda instância se encerra. macOS recebe o evento diretamente do SO, sem precisar do single-instance.

**Registro do protocolo:**

- **Windows:** o instalador NSIS registra `berzerk://` no instalador. Além disso, `app.deep_link().register_all()` roda no `setup()` do app (`src-tauri/src/lib.rs`) toda vez que abre — redundante em produção, mas cobre o `tauri dev`.
- **Linux (AppImage):** não tem instalador que registre nada — o `register_all()` no `setup()` é quem grava a associação MIME (`xdg-mime`/`~/.local/share/applications`) na primeira vez que o AppImage roda. Se o AppImage não tiver sido integrado ao sistema (ex.: via AppImageLauncher), o registro ainda funciona porque aponta pro caminho onde o binário está sendo executado no momento — mas se o usuário mover o AppImage depois, o registro fica apontando pro lugar errado até o app rodar de novo do novo caminho.
- Testado localmente em Hyprland com `gio open 'berzerk://open'` / `gio open 'berzerk://login'` / `gio open 'berzerk://auth?token_hash=...&type=magiclink'` — registra e dispara corretamente.

**Exigência de versão:** o Nexus só mostra o botão pra quem já está em ≥ **0.9.1** (`DESKTOP_VERSAO_MINIMA_DEEP_LINK`; 0.6.0 foi a primeira com deep link, mas só a 0.9.1 abre logado de verdade). Quem estiver numa versão anterior não tem o esquema registrado — o link cai no browser sem handler.

**Limitações conhecidas:**

- **Foco de janela no Linux/Wayland:** `berzerk://open` chama `unminimize()` + `show()` + `setFocus()`, mas compositores wlroots (testado no Hyprland) podem recusar o "roubo" de foco de teclado de um app já em primeiro plano — a janela é levantada/desminimizada mas o teclado pode continuar na janela anterior até o operador clicar. No Windows isso não costuma acontecer.
- **AppImage movido/renomeado** depois do primeiro registro: ver nota acima — precisa rodar o app uma vez do novo caminho pra reregistrar.
- Este projeto não builda AppImage no CI ainda (workflow builda só Windows — ver seção abaixo), então hoje o deep link em produção só está coberto no Windows; a cobertura Linux é só pra quem builda/roda localmente.

### Lançar uma nova versão

```sh
# 1) Bumpar versão (mesmo número em ambos):
#    - package.json
#    - src-tauri/tauri.conf.json
#    - src-tauri/Cargo.toml
#    Depois bun install pra atualizar bun.lock

# 2) Commit + tag + push:
git add -A
git commit -m "v0.X.Y — <resumo do que mudou>"
git tag v0.X.Y
git push --follow-tags
```

GitHub Actions builda em ~7min, assina com a chave privada Ed25519, publica release com:

- `berzerk-client_0.X.Y_x64-setup.exe` — instalador NSIS pros operadores
- `berzerk-client_0.X.Y_x64-setup.nsis.zip` — bundle pro updater
- `berzerk-client_0.X.Y_x64-setup.nsis.zip.sig` — assinatura Ed25519
- `latest.json` — manifest que o updater consulta

PCs instalados pegam a atualização sozinhos na próxima abertura — e, desde a 0.9.2, **param** até atualizar.

**Passo 3 (opcional, quando a versão for obrigatória):** depois que as mesas já pegaram o release, subir a mínima no Nexus (**Configurações → Versão mínima do Berzerk Client**). Nunca antes: exigir um número que ainda não está publicado bloqueia todo mundo de uma vez, sem ter o que instalar.

### Onde mora o quê

| Coisa | Lugar |
|---|---|
| Chave privada de assinatura | `~/.berzerk-rfid-keys/tauri-updater.key` (Leonardo) + GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` |
| Chave pública (embutida no app) | `src-tauri/tauri.conf.json` em `plugins.updater.pubkey` |
| App client do login (desktop) | `berzerk-infra` → `stacks/nexus/<env>/auth.tf` → `aws_cognito_user_pool_client.desktop` (output `cognito_desktop_client_id`) |
| Pool + Hosted UI + IdP Google | `berzerk-infra` → `stacks/auth/<env>` (`auth.cloud.berzerk.com.br`) |
| Envs do login no CI | GitHub → repo → Settings → Variables: `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_CLIENT_ID`, `VITE_COGNITO_REGION` |
| Versão mínima exigida | Nexus → Configurações → **Versão mínima do Berzerk Client** (chave `desktop_versao_minima` em `system_settings`) |

### Desenvolver em Linux

Roda também — Tauri usa WebKit2GTK em vez de WebView2. Setup no Arch:

```sh
sudo pacman -S webkit2gtk-4.1 gtk3 librsvg libsoup3 base-devel \
               curl wget file openssl libappindicator-gtk3 patchelf
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -fsSL https://bun.sh/install | bash

bun install
bun run tauri dev
```

Pra produzir AppImage:

```sh
bun run tauri build --bundles appimage
# saída em src-tauri/target/release/bundle/appimage/
```

O workflow de release atualmente builda **só Windows**. Pra adicionar Linux, é mudar pra strategy matrix (ver [seção Linux release](./docs/linux-release.md) — pendente).

---

## Licença

Internal, all rights reserved. Berzerk Tech.
