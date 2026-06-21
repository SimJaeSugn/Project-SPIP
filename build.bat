@echo off
REM ============================================================
REM  Project-SPIP - 설치본 빌드 (더블클릭 실행)
REM  결과물: dist\  (NSIS 설치본 + portable exe)
REM ============================================================
setlocal
cd /d "%~dp0"

echo [Project-SPIP] 빌드를 시작합니다...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 18 이상을 설치하세요.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] 의존성 설치 중... ^(npm install^)
  call npm install
  if errorlevel 1 (
    echo [오류] npm install 실패.
    pause
    exit /b 1
  )
) else (
  echo [1/2] 의존성 확인됨 ^(node_modules 존재^) - 설치 건너뜀.
)

echo.
echo [2/2] 설치본 빌드 중... ^(electron-builder^)
call npm run build
if errorlevel 1 (
  echo [오류] 빌드 실패. 위 로그를 확인하세요.
  pause
  exit /b 1
)

echo.
echo [완료] 빌드 성공. 결과물은 dist\ 폴더에 있습니다.
if exist "dist" start "" explorer "dist"
echo.
pause
endlocal
