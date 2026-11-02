@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title PackingProof Web - Stop Dev Servers

echo ================================================================
echo   PackingProof Web - Dung Backend ^(5080^) va Frontend ^(5173^)
echo ================================================================
echo.

powershell -NoProfile -Command "$ports = @(5080, 5173); $pids = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if (-not $pids) { Write-Host '[INFO] Khong co tien trinh nao dang chay tren cong 5080 hoac 5173.' -ForegroundColor Yellow } else { foreach ($procId in $pids) { if ($procId -gt 4) { Write-Host ('[STOP] Dang dung tien trinh PID ' + $procId + '...') -ForegroundColor Cyan; cmd /c ('taskkill /PID ' + $procId + ' /T /F >nul 2>&1') } }; Write-Host '[OK] Da dung toan bo server tren cong 5080 va 5173.' -ForegroundColor Green }"

echo.
if /i not "%~1"=="--no-pause" pause
exit /b 0

