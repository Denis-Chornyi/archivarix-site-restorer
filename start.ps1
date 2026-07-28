$ErrorActionPreference = "Stop"
$port = 4321

try {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
} catch {
    $listeners = @()
}

foreach ($listener in $listeners) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq "node") {
        Write-Host "Зупиняю попередню копію Archivarix Site Restorer (PID $($process.Id))..."
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit()
    } elseif ($process) {
        Write-Host "Порт $port зайнятий програмою $($process.ProcessName)."
        Write-Host "Закрийте її або змініть порт перед запуском."
        exit 1
    }
}

Set-Location -LiteralPath $PSScriptRoot
Write-Host "Запускаю актуальну версію Archivarix Site Restorer..."
& node "$PSScriptRoot\server.js"
exit $LASTEXITCODE
