# Berzerk Client

> Estação industrial onde produtos da Berzerk recebem identidade RFID
> e são despachados. Substitui o antigo "Print Station" — o escopo
> cresceu de impressão pra operação RFID completa (etiquetagem +
> expedição + dispositivos USB).

Aplicação desktop instalada nos PCs do chão de fábrica da Berzerk. Cobre dois módulos do fluxo industrial:

- **Etiquetagem** — aplica identidade RFID em lotes confirmados de produção. Lookup de EAN13 (local + Shopify) e impressão com margem de segurança.
- **Expedição** (em breve) — bipa etiqueta RFID, identifica pedido pronto, imprime DANFE.

Login restrito a contas Google Workspace `@berzerk.com.br`.

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

### Atualizações

O app verifica atualizações **automaticamente toda vez que abre**. Quando uma nova versão estiver disponível, aparece um banner no topo:

> **Atualização disponível: v0.X.Y** [Atualizar agora] [Mais tarde]

Clicando em "Atualizar agora", baixa, valida assinatura, substitui o executável e reinicia. Leva ~30 segundos. Também pode ser disparado manualmente em **Configurações → Atualizações → Verificar**.

Não é necessário reinstalar manualmente — uma vez instalado, esquece.

---

## Troubleshooting

### "O Windows protegeu seu PC" (SmartScreen)

Comportamento esperado na **primeira instalação**. Veja passo 2 acima.

### Não consigo logar — `missing OAuth secret`

Indica config quebrada no Supabase (provider Google sem Client Secret). Falar com o time de tecnologia — não é falha local.

### "Continue o login no navegador" trava indefinidamente

1. Verificar se o navegador padrão abriu uma aba em `accounts.google.com`
2. Se a aba ficou em branco / não terminou, fechar a aba e clicar **"Cancelar"** no app
3. Tentar de novo

### "Falha ao verificar atualização"

Geralmente é falta de internet no PC. O app continua funcionando offline com a versão atual.

### Quero forçar logout

No canto inferior da tela principal: **"Encerrar sessão"**.

---

## Para desenvolvedores

### Stack

Tauri 2 + React 19 + TypeScript + Vite + Bun. Backend Supabase (projeto `hvnysnfmsndjehjndipc`, gerenciado via Lovable Cloud).

Estrutura:

```
src/                     # React app
  components/            # UI (HomeMenu, Login, BatchBrowser, etc)
  lib/                   # Helpers — auth, deep-link, supabase client, updater, station id
  services/              # Camada de acesso a dados (Supabase queries)
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
# Editar .env com VITE_SUPABASE_PUBLISHABLE_KEY (chave anon pública)

bun install
bun run tauri dev
```

Primeiro `tauri dev` demora ~5-10min (compila ~430 crates Rust). Próximas execuções são incrementais (<10s).

Linux (Arch / Ubuntu / Fedora) também roda — ver [seção Linux](#desenvolver-em-linux) abaixo.

### OAuth em desktop apps

O fluxo de login é não-trivial porque Chrome 120+ bloqueia custom schemes (`berzerk-print://`) em redirects sem gesto do usuário. Solução adotada:

1. App sobe servidor HTTP local em `127.0.0.1:54321` antes de abrir o navegador
2. `redirectTo` aponta pra esse loopback
3. Supabase usa `flowType: 'pkce'` (retorna `?code=` em query — `#hash` não chega ao server)
4. Servidor captura o code, emite evento Tauri, fecha
5. Frontend chama `supabase.auth.exchangeCodeForSession(code)`

URLs registradas no Google Cloud OAuth Client + Lovable Cloud URI allow list:

```
https://hvnysnfmsndjehjndipc.supabase.co/auth/v1/callback    (Google → Supabase)
http://127.0.0.1:54321/oauth-callback                         (Supabase → app)
```

### Deep link (abrir pelo Nexus)

O Nexus (web) tem um botão "Abrir Berzerk Client" que navega pra uma URL `berzerk://...`. O app abre (ou vem pra frente se já estiver aberto) e fica logado sem o operador digitar nada — pensado pra estação de fábrica onde o navegador roda num monitor e o app noutro.

**Esquema:** `berzerk`, registrado em `plugins.deep-link.desktop.schemes` no `tauri.conf.json`. Duas URLs:

- `berzerk://auth?token_hash=<hash>&type=magiclink` — handoff de login.
- `berzerk://open` — só foca a janela.

**Fluxo de auth:** o Nexus gera o link com `supabase.auth.admin.generateLink({ type: 'magiclink', email })` no MESMO projeto Supabase deste app (`hvnysnfmsndjehjndipc`). O app consome com `supabase.auth.verifyOtp({ type: 'magiclink', token_hash })` (`src/lib/deep-link.ts`) — a sessão resultante é persistida do jeito de sempre (`persistSession: true` no client). Se já havia uma sessão de outro operador, ela é derrubada (`signOut`) antes de verificar o link — como o `token_hash` é opaco, não dá pra saber de antemão se é o mesmo e-mail, e derrubar sempre também garante que um link ruim não deixa uma sessão "logada errado" pra trás. Sucesso → toast "Conectado como `<e-mail>`" e tela inicial; link expirado/já usado → tela de login com "Link expirado ou inválido — entre com o Google.".

**Segunda instância (Windows/Linux):** o SO abre uma nova instância do processo passando a URL como argumento de linha de comando. `tauri-plugin-single-instance` (feature `deep-link`) detecta isso, repassa a URL pra instância já rodando — que reemite como o evento `deep-link://new-url` do `tauri-plugin-deep-link`, o mesmo que `onOpenUrl` no front escuta — e a segunda instância se encerra. macOS recebe o evento diretamente do SO, sem precisar do single-instance.

**Registro do protocolo:**

- **Windows:** o instalador NSIS registra `berzerk://` no instalador. Além disso, `app.deep_link().register_all()` roda no `setup()` do app (`src-tauri/src/lib.rs`) toda vez que abre — redundante em produção, mas cobre o `tauri dev`.
- **Linux (AppImage):** não tem instalador que registre nada — o `register_all()` no `setup()` é quem grava a associação MIME (`xdg-mime`/`~/.local/share/applications`) na primeira vez que o AppImage roda. Se o AppImage não tiver sido integrado ao sistema (ex.: via AppImageLauncher), o registro ainda funciona porque aponta pro caminho onde o binário está sendo executado no momento — mas se o usuário mover o AppImage depois, o registro fica apontando pro lugar errado até o app rodar de novo do novo caminho.
- Testado localmente em Hyprland com `gio open 'berzerk://open'` / `gio open 'berzerk://auth?token_hash=...&type=magiclink'` — registra e dispara corretamente.

**Exigência de versão:** o Nexus só mostra o botão pra quem já está em ≥ **0.6.0** (primeira versão com deep link). Quem estiver numa versão anterior não tem o esquema registrado — o link cai no browser sem handler.

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

PCs instalados pegam a atualização sozinhos na próxima abertura.

### Onde mora o quê

| Coisa | Lugar |
|---|---|
| Chave privada de assinatura | `~/.berzerk-rfid-keys/tauri-updater.key` (Leonardo) + GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` |
| Chave pública (embutida no app) | `src-tauri/tauri.conf.json` em `plugins.updater.pubkey` |
| OAuth Client | Google Cloud project `berzerk-shared` → APIs & Services → Credentials → "Berzerk Print Station" |
| Provider Google no Supabase | Lovable Cloud do projeto `separadordelistas` → Auth settings → Google → "Your own credentials" |
| Redirect URLs allow list | Lovable Cloud → Users → URI allow list |

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
