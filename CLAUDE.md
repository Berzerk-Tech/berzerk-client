# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**Berzerk Client** — the factory-floor desktop app for RFID labeling and shipping. GitHub remote is `Berzerk-Tech/berzerk-client`; this local checkout is named `berzerk-rfid` (same project, different dir name — don't be thrown by the mismatch). Tauri 2 + React 19 + TypeScript + Vite + Bun, packaged as a signed Windows installer (NSIS) for factory-floor PCs, with a Linux AppImage build also produced.

Three modules cover the industrial flow: **Etiquetagem** (RFID identity onto confirmed production batches), **Separação** (batch order picking against an RFID table), **Expedição** (final RFID scan, J&T shipping label + DANFE, marks the order shipped). Login is Google Workspace (`@berzerk.com.br`) via Cognito Hosted UI, orchestrated by the **Nexus** backend.

Ignore `minhacontaberzerk/` (a stray sibling-repo checkout, not part of this project), `node_modules/`, and `dist/`.

## Key Commands

```sh
bun install                          # deps
bun run dev                          # vite only, http://localhost:1420 (no Tauri shell)
bun run tauri dev                    # full app w/ Rust shell — first run ~5-10min (compiles Rust), then <10s
bun run build                        # tsc && vite build — this IS the typecheck gate, no separate typecheck script
bun run test                         # vitest run — jsdom, no Tauri; test/**/*.spec.{ts,tsx}
bun run tauri build                  # full bundle for the host platform
bun run tauri build --bundles appimage   # Linux AppImage only, output in src-tauri/target/release/bundle/appimage/
```

No lint script / no ESLint config in this repo — `tsc` via `bun run build` is the only static gate.

**Release:** bump the version in **three** places (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`), `bun install` to refresh `bun.lock`, then commit, `git tag vX.Y.Z`, `git push --follow-tags`. `.github/workflows/release.yml` builds+signs on tag push (Windows nsis+updater, Ubuntu 22.04 appimage+updater) and publishes the GitHub release with `latest.json`. `release.ps1` exists as a Windows helper but has a stale hardcoded commit message left over from an old version bump — don't trust its commit message, just the git plumbing.

**Supabase migrations** (`migrations/*.sql`): plain numbered SQL files, **not** an automated pipeline — apply manually via the Supabase SQL editor or CLI against the "Industrial" project. Note: as of 0.8.0 this app itself no longer talks to Supabase at runtime (see Architecture) — these are legacy/manually-applied schema for tables other services still touch.

## Architecture

```
src/                     React app
  components/            UI (HomeMenu, Login, Separacao, Expedicao, BatchBrowser, ...)
  lib/                    cognito.ts (login), auth.ts (loopback), api.ts, realtime.ts (WS),
                          deep-link.ts, updater.ts, printer.ts, imagens.ts (CDN thumbnailing), rfid.ts
  services/               data access — calls into the Nexus API (orders, batches, expedicao, print jobs)
src-tauri/src/
  lib.rs                 entry point — registers plugins + all invoke_handler commands
  itag_client.rs         talks to the local iTAG Monitor HTTP service (127.0.0.1:9093) — continuous RFID read
  itag_iprint.rs          talks to the iTAG REST API (itag2.itagalert.com.br) — burns RFID into printed labels
  printing.rs             silent printing via bundled SumatraPDF.exe (no Windows dialog)
  oauth_loopback.rs        local HTTP server for the Cognito PKCE callback
  usb_devices.rs / rfid_usb.rs   serial port enumeration / sniffing
migrations/               manual SQL, see Key Commands
NEXUS_EXPEDICAO.md        contract doc for the Nexus Expedição endpoints — read before touching src/services/expedicao.ts
```

**Data flow / Nexus:** since 0.8.0 the app has **no Supabase runtime dependency at all** — Etiquetagem and Rastreio migrated off it (`docs/plano-corte-supabase.md` in the nexus repo). Everything goes through the Nexus API (`VITE_SEPARACAO_API_URL`, must end in `/api`) with the Cognito **`id_token`** as Bearer (not the access token — it's the one carrying `email`), plus a `X-Berzerk-Client-Version` header on every call (`src/lib/api.ts`) that lets the server force-block outdated clients with `426 app_desatualizado`. A WebSocket (`VITE_SEPARACAO_WS_URL`) pushes `queue.changed` and `print-jobs.changed`; slow polling is the fallback.

**Tauri IPC boundary** (`src-tauri/src/lib.rs` `invoke_handler`): `oauth_loopback::start_oauth_listener`; `itag_client::{itag_ping, itag_send_command, itag_poll_tags, itag_reinventory}`; `itag_iprint::{itag_iprint_ping, itag_iprint_gerar_rfid, itag_iprint_query_inventory, itag_iprint_movimentar, itag_epc_details}`; `usb_devices::list_serial_ports`; `rfid_usb::serial_sniff`; `printing::{print_pdf_silent, print_image_silent, list_windows_printers, print_engine_status}`. The front end never talks to hardware directly — always through `invoke(...)`.

**RFID hardware, two separate paths:** (1) the bench RFID reader is driven through the local **iTAG Monitor** Windows service (plain HTTP on `127.0.0.1:9093`, no TLS needed since it's native-side) — start/stop/poll continuous reads; (2) burning a fresh RFID tag during Etiquetagem goes through the **iTAG iPrint REST API** (`itag2.itagalert.com.br`, Basic auth configured per-station in Settings). See "Fluxo padrão de integração V1.2.pdf" at repo root for the vendor spec both are built against.

**Printing:** all labels (J&T shipping label, DANFE, Picking Geral sheet) print silently via the bundled `SumatraPDF.exe` (`src-tauri/resources/`) — `window.print()` would pop a Windows dialog the bench can't answer. `-print-settings "1,fit"` matters operationally: the packing machine drops one bag per page printed.

**Updater/signing:** `tauri-plugin-updater`, endpoint is the GitHub releases `latest.json`, public key embedded in `tauri.conf.json` (`plugins.updater.pubkey`). Private signing key lives outside the repo (`~/.berzerk-rfid-keys/tauri-updater.key`, Leonardo's machine) + GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`. Since 0.9.2 updates are **forced**: the real gate is the Nexus-side minimum version (`426 app_desatualizado`, configured in Nexus → Configurações), the GitHub update check is only an early warning and never blocks on its own network failure.

**Auth:** Cognito Authorization Code + PKCE against the Nexus's Hosted UI (Google IdP, `@berzerk.com.br`), via a local loopback HTTP server on `127.0.0.1:54321` (Chrome blocks custom-scheme redirects without a user gesture, hence the loopback instead of a `berzerk://` redirect). Bearer for API+WS is the Cognito **id_token**.

**Deep link:** `berzerk://` scheme (`tauri-plugin-deep-link` + `tauri-plugin-single-instance`), used by the Nexus web UI to hand off an already-authenticated session to the desktop app.

## Conventions

- UI text and code comments are predominantly **pt-BR**; match existing style in new code.
- Version bump is **always** three files in lockstep (see Key Commands) — a mismatch silently breaks the updater/signing pipeline.
- Never hand-edit `src-tauri/gen/` or `src-tauri/target/` (generated/build output, gitignored).
- New migrations go in `migrations/` as `YYYYMMDD_description.sql`, applied manually — there is no migration runner in this repo.
- Don't reintroduce a Supabase runtime dependency without checking `docs/plano-corte-supabase.md` in the nexus repo first — it was deliberately removed in 0.8.0.

## Gotchas

- First run on a factory PC always trips Windows SmartScreen ("O Windows protegeu seu PC") — expected, there's no code-signing certificate yet, only the Tauri updater's own Ed25519 signature.
- `src-tauri/resources/SumatraPDF.exe` must be present and committed or the installer ships with **no printing at all**; `release.ps1` force-adds it for exactly this reason.
- Don't load full-resolution Shopify CDN images — this caused a WebView2 out-of-memory crash on the bench in production (0.9.7). Use `src/lib/imagens.ts`'s CDN-thumbnail helper for any new `<img>`.
- `.env` needs `VITE_COGNITO_DOMAIN`/`VITE_COGNITO_CLIENT_ID`/`VITE_COGNITO_REGION` and `VITE_SEPARACAO_API_URL` (`VITE_SEPARACAO_WS_URL` optional, falls back to polling). `VITE_SUPABASE_*` in an old `.env` is dead — nothing reads it — but the release workflow still passes those secrets through; don't read that as evidence Supabase is still live.
- Deep-link window focus is unreliable on wlroots/Hyprland (Wayland refuses foreground-steal) — works fine on Windows, the actual target platform.
- AppImage deep-link registration is path-based; moving/renaming the AppImage after first run breaks it until it's re-run from the new path.
- Raising "Versão mínima do Berzerk Client" in Nexus before the matching release is actually published locks out every station at once — always deploy API → release client → then raise the minimum.
- CI Windows and Linux runners both build (`release.yml` matrix); don't assume Linux is unbuilt without checking that workflow first.

## Related repos

- **nexus** (ex-`berzerk-industrial`, NestJS monolith, `Berzerk-Tech/nexus`) — the backend for all three modules. `NEXUS_EXPEDICAO.md` at this repo's root is the contract doc for the Expedição endpoints; read it before touching `src/services/expedicao.ts`.
- **minhacontaberzerk** (posvenda webapp, Supabase/Lovable) — the legacy app being migrated off; its business rules (e.g. Expedição conferência guards) are still the reference until fully ported. The copy nested in this working directory is stray and out of scope.
- **berzerk-infra** — Terraform for the Cognito user pool / Hosted UI this app authenticates against. No IaC lives in this repo.

## Cross-project Berzerk conventions

- No IaC in app repos — Terraform lives in `berzerk-infra`.
- No static AWS credentials.
- Auth is Google Workspace federation; this app's specific mechanism is Cognito Hosted UI + PKCE via Nexus (not a direct Supabase Auth call — Supabase itself was removed from this app in 0.8.0).
- Tickets are `BER-<n>`.
