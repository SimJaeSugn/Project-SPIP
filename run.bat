@echo off
REM ============================================================
REM  Project-SPIP - 앱 실행 (더블클릭, 개발 실행)
REM  설치본 빌드 없이 바로 Electron 앱 창을 띄웁니다 (= npm start).
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 18 이상을 설치하세요.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 의존성 설치 중... ^(npm install^)
  call npm install
  if errorlevel 1 ( echo [오류] npm install 실패. & pause & exit /b 1 )
)

echo Project-SPIP 앱을 실행합니다...
call npm start
endlocal
