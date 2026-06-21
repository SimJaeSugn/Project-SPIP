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
echo [정리] 실행 중인 앱 종료 + 이전 빌드 출력 제거 ^(출력 파일 잠금 방지^)
taskkill /IM "Project-SPIP.exe" /F >nul 2>nul
if exist "dist" rmdir /s /q "dist"

echo.
echo [2/2] 설치본 빌드 중... ^(electron-builder^)
call npm run build
if errorlevel 1 (
  echo [오류] 빌드 실패. 위 로그를 확인하세요.
  echo   * app-builder.exe 실행 실패^(ERR_ELECTRON_BUILDER_CANNOT_EXECUTE^)면 백신이
  echo     node_modules\app-builder-bin\win\x64\app-builder.exe 를 격리했을 수 있습니다.
  echo     프로젝트 폴더를 백신 예외에 추가한 뒤 'npm install' 재실행하세요.
  pause
  exit /b 1
)

echo.
echo [완료] 빌드 성공. 결과물은 dist\ 폴더에 있습니다.
if exist "dist" start "" explorer "dist"
echo.
pause
endlocal
