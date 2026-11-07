# Локальное автообновление расписания (резервный вариант, если GitHub Actions
# не может достучаться до kstu.ru).
#
# Запуск вручную:  powershell -ExecutionPolicy Bypass -File tools\auto-update.ps1
# По расписанию:   см. README, раздел «Автообновление».

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PYTHONIOENCODING = "utf-8"
$env:GIT_TERMINAL_PROMPT = "0"

Write-Host "Скачиваю расписание..."
python tools/scrape.py --refresh
if ($LASTEXITCODE -ne 0) {
    Write-Error "scrape.py завершился с ошибкой"
    exit 1
}

$changes = git status --porcelain
if (-not $changes) {
    Write-Host "Изменений нет"
    exit 0
}

git add -A
git -c user.name="Pary bot" -c user.email="samkrusa@users.noreply.github.com" `
    commit -m ("auto: update schedule " + (Get-Date -Format "yyyy-MM-dd"))
git push

Write-Host "Готово: изменения отправлены на GitHub"
