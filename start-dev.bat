@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title PackingProof Web - Quick Launcher

echo ================================================================
echo   PackingProof Web - Khoi dong nhanh moi truong Development
echo ================================================================
echo.

:: 1. Kiem tra tep cau hinh .env
if not exist ".env" (
    echo [LOI] Khong tim thay tep .env tai thu muc goc: %CD%
    echo       Vui long sao chep .env.example thanh .env va cau hinh mat khau truoc.
    echo.
    if /i not "%~1"=="--no-browser" pause
    exit /b 1
)

:: 2. Kiem tra dich vu PostgreSQL (postgresql-x64-18)
sc query postgresql-x64-18 | find "RUNNING" >nul 2>&1
if errorlevel 1 goto :start_pg
echo [OK] Dich vu PostgreSQL ^(postgresql-x64-18^) dang hoat dong.
goto :check_backend

:start_pg
echo [INFO] Dich vu postgresql-x64-18 chua chay. Dang thu khoi dong...
net start postgresql-x64-18 >nul 2>&1
sc query postgresql-x64-18 | find "RUNNING" >nul 2>&1
if not errorlevel 1 (
    echo [OK] Da khoi dong dich vu postgresql-x64-18.
) else (
    echo [CANH BAO] Khong the tu dong bat postgresql-x64-18 ^(can quyen Administrator^).
    echo            Neu Backend bao loi ket noi DB, hay chuot phai chon Run as administrator.
)

:check_backend
:: 3. Khoi dong Backend API (.NET 10) tren cong 5080
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5080 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto :backend_already_running

echo [START] Dang mo cua so Backend API tren cong 5080...
start "PackingProof Backend API [5080]" /D "%~dp0" cmd /k "chcp 65001 >nul && dotnet run --project backend/src/PackingProof.Api"
goto :check_frontend

:backend_already_running
echo [OK] Backend API dang chay san tren cong 5080.

:check_frontend
:: 4. Khoi dong Frontend Vite HTTPS (React 19) tren cong 5173 (mo LAN 0.0.0.0)
if not exist "frontend\node_modules" (
    echo [INFO] Chua co frontend\node_modules. Dang cai dat thu vien npm...
    call npm --prefix frontend install
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto :frontend_already_running

echo [START] Dang mo cua so Frontend Vite HTTPS tren cong 5173...
start "PackingProof Frontend Web HTTPS [5173]" /D "%~dp0" cmd /k "chcp 65001 >nul && npm --prefix frontend run dev"
goto :wait_ready

:frontend_already_running
echo [OK] Frontend Vite HTTPS dang chay san tren cong 5173.

:wait_ready
echo.
echo [WAIT] Dang kiem tra trang thai san sang cua Backend ^(5080^) va Frontend HTTPS ^(5173^)...
powershell -NoProfile -Command "$deadline = (Get-Date).AddSeconds(35); $be = $false; $fe = $false; while ((Get-Date) -lt $deadline) { if (-not $be) { try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5080/health/ready' -TimeoutSec 2; if ($r.StatusCode -eq 200) { $be = $true } } catch {} }; if (-not $fe) { if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { $fe = $true } }; if ($be -and $fe) { break }; Start-Sleep -Milliseconds 700 }; if ($be) { Write-Host '[OK] Backend API & PostgreSQL da san sang (http://localhost:5080).' -ForegroundColor Green } else { Write-Host '[INFO] Backend dang tiep tuc bien dich/khoi dong trong cua so rieng...' -ForegroundColor Yellow }; if ($fe) { Write-Host '[OK] Frontend Vite HTTPS da san sang (https://localhost:5173).' -ForegroundColor Green } else { Write-Host '[INFO] Frontend dang tiep tuc khoi dong trong cua so rieng...' -ForegroundColor Yellow }"

:: 5. Hien thi dia chi truy cap HTTPS cho PC va Dien thoai iPhone/Android cung Wi-Fi
echo.
echo ================================================================
echo   DIA CHI TRUY CAP UNG DUNG ^(HTTPS BAO MAT CHO CAMERA^)
echo ================================================================
echo   - May tinh ^(PC^):                 https://localhost:5173
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'WSL|vEthernet|Loopback|Docker' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1 -ExpandProperty IPAddress); if ($ip) { Write-Output $ip }"`) do (
    echo   - Dien thoai ^(iPhone/Android^):   https://%%I:5173
)
echo   - Backend Health Check:          http://localhost:5080/health/ready
echo ----------------------------------------------------------------
echo   Luu y lan dau truy cap tren trinh duyet / dien thoai:
echo   - Android ^(Chrome^): Bam "Nang cao (Advanced)" -^> "Tiep tuc truy cap (Proceed)"
echo   - iPhone ^(Safari^):  Bam "Hien thi chi tiet (Show Details)" -^> "Truy cap trang web nay"
echo ================================================================
echo.

if /i "%~1"=="--no-browser" exit /b 0

start "" "https://localhost:5173"
echo Da mo trinh duyet. Cua so Backend va Frontend dang chay doc lap.
echo Ban co the dong cua so Launcher nay ma khong anh huong den server.
echo ^(De tat nhanh toan bo server, hay chay file stop-dev.bat^)
echo.
pause
exit /b 0
