# release.ps1 — lança a versão que está no package.json.
# Uso:  .\release.ps1   (se bloquear: powershell -ExecutionPolicy Bypass -File .\release.ps1)
# Faz: garante identidade do git → bun install → add → commit → (re)tag → push.
# Checa cada passo (PowerShell não para sozinho em erro de comando nativo).

Set-Location $PSScriptRoot

function Fail($msg) { Write-Host "ERRO: $msg" -ForegroundColor Red; exit 1 }

# 0) Identidade do git (sem isto o commit falha silenciosamente).
if (-not (git config user.email)) { git config user.email "leonardo.flores@berzerk.com.br" }
if (-not (git config user.name))  { git config user.name  "Leonardo Flores" }

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
Write-Host "== Lancando $tag ==" -ForegroundColor Cyan

# 1) Dependencias (atualiza bun.lock com a versao + jspdf/jsbarcode).
bun install
if ($LASTEXITCODE -ne 0) { Fail "bun install falhou." }

# 2) SumatraPDF no bundle (senao o instalador sai sem impressao silenciosa).
if (Test-Path "src-tauri\resources\SumatraPDF.exe") {
  git add -f "src-tauri\resources\SumatraPDF.exe"
  Write-Host "SumatraPDF.exe incluido no commit." -ForegroundColor Green
} else {
  Write-Host "AVISO: src-tauri\resources\SumatraPDF.exe nao encontrado — instalador sairia SEM impressao." -ForegroundColor Yellow
}

# 3) Commit de tudo.
git add -A
git commit -m "$tag — Expedicao: identificacao via nexus, impressao silenciosa e UX nova"
if ($LASTEXITCODE -ne 0) { Write-Host "Nada novo pra commitar (ou commit falhou) — seguindo." -ForegroundColor Yellow }

# 4) (Re)cria a tag apontando pro commit ATUAL (apaga a antiga se existir).
git tag -d $tag 2>$null | Out-Null
git tag $tag
if ($LASTEXITCODE -ne 0) { Fail "git tag falhou." }

# 5) Push do branch + tag.
git push origin HEAD --follow-tags
if ($LASTEXITCODE -ne 0) {
  Write-Host "git push FALHOU." -ForegroundColor Red
  $remote = (git remote get-url origin)
  Write-Host "Remote: $remote"
  if ($remote -like "git@*") {
    Write-Host "Remote via SSH. Se esta maquina nao tiver chave SSH com permissao de escrita, troque pra HTTPS:" -ForegroundColor Yellow
    Write-Host "  git remote set-url origin https://github.com/Berzerk-Tech/berzerk-client.git"
    Write-Host "  e rode de novo (pede usuario + Personal Access Token do GitHub como senha)."
  }
  exit 1
}

Write-Host "== Push OK. Acompanhe o build: ==" -ForegroundColor Green
Write-Host "  gh run list --repo Berzerk-Tech/berzerk-client --limit 3"
