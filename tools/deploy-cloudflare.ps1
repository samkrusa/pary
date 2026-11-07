# Деплой на Cloudflare Pages (бесплатный план).
#
# Нужны две вещи из панели Cloudflare:
#   Account ID  — правая колонка на странице Workers & Pages
#   API Token   — My Profile → API Tokens → Create Token →
#                 шаблон "Edit Cloudflare Workers" или право "Cloudflare Pages: Edit"
#
# Запуск:
#   $env:CLOUDFLARE_API_TOKEN = "..."
#   $env:CLOUDFLARE_ACCOUNT_ID = "..."
#   powershell -ExecutionPolicy Bypass -File tools\deploy-cloudflare.ps1
#
# Или параметрами:
#   ... -Token "..." -AccountId "..." -Project "pary"

param(
    [string]$Token = $env:CLOUDFLARE_API_TOKEN,
    [string]$AccountId = $env:CLOUDFLARE_ACCOUNT_ID,
    [string]$Project = "pary-knrtu"
)

$ErrorActionPreference = "Stop"

if (-not $Token -or -not $AccountId) {
    throw "Нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID (см. комментарий в начале файла)."
}

$env:CLOUDFLARE_API_TOKEN = $Token
$env:CLOUDFLARE_ACCOUNT_ID = $AccountId

$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $env:TEMP "pary-pages"

Write-Host "Готовлю чистую сборку..."
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null

# Берём только файлы из git, без .git, кэшей и тестов
git -C $root archive HEAD | tar -x -C $tmp
if ($LASTEXITCODE -ne 0) { throw "git archive завершился с ошибкой" }

Push-Location $tmp
try {
    Write-Host "Загружаю на Cloudflare Pages (проект: $Project)..."
    npx --yes wrangler@latest pages deploy . --project-name $Project --branch main --commit-dirty=true
    if ($LASTEXITCODE -ne 0) { throw "wrangler завершился с ошибкой" }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Готово. Адрес: https://$Project.pages.dev"
