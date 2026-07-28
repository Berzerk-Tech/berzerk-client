# Brand — Berzerk Creators

Identidade **monocromática** (preto & branco), alto contraste, geometria reta (§10 do PRD).
Sem cor de acento na marca — acento na UI é inversão de contraste, não cor. **Sem roxo.**

## Assets

| Arquivo | Uso |
|---|---|
| `logo-horizontal-light.png` | Lockup horizontal **preto** — fundo claro (tema light) |
| `logo-horizontal-dark.png` | Lockup horizontal **branco** — fundo escuro (tema dark) |
| `icon-light.png` | Ícone **preto** — fundo claro |
| `icon-dark.png` | Ícone **branco** — fundo escuro / favicon |

> Convenção dos arquivos originais: `HOR` = lockup horizontal, `ICON` = ícone;
> `B` = preto (fundo claro), `W` = branco (fundo escuro). Renomeados aqui para
> `*-light` / `*-dark` (pelo fundo onde são usados).

Cópias servidas pela SPA ficam em `apps/web/public/` (+ `icon.png` como favicon).
O componente `<Logo>` (`apps/web/src/components/Logo.tsx`) escolhe a variante pelo tema.

## Tokens de tema

Definidos em `apps/web/src/theme/tokens.css` (CSS vars HSL) e consumidos pelo
`tailwind.config.ts`. Tipografia: **Space Grotesk** (display, espelha o wordmark) +
**Inter** (corpo). `--radius` baixo (cantos quase retos).

## Pendente
- `banner.png` (banner da marca) — a fornecer.
