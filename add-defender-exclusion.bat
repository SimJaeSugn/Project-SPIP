@echo off
REM ============================================================
REM  Project-SPIP - Windows Defender 예외 등록 (1회, 관리자 필요)
REM
REM  빌드 시 Defender 실시간 검사가 새로 만든 app.asar(70MB+)에
REM  핸들을 걸어 이전 빌드 출력(dist\win-unpacked) 정리를 막으면
REM  electron-builder가 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE 로 실패한다.
REM  이 폴더를 Defender 예외에 등록하면 그 잠금이 사라진다.
REM ============================================================
setlocal

REM 관리자 권한 확인, 없으면 UAC로 재실행
net session >nul 2>nul
if errorlevel 1 (
  echo 관리자 권한이 필요합니다. UAC 창에서 "예"를 눌러주세요...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set "PROJ=%~dp0"
if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"

echo Defender 예외에 등록: %PROJ%
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath '%PROJ%'"
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath ([IO.Path]::Combine($env:LOCALAPPDATA,'electron-builder','Cache'))"

echo.
echo [완료] 예외 등록됨. 이제 build.bat 으로 반복 빌드해도 잠금이 없습니다.
echo  - 등록된 예외 확인: PowerShell(관리자) 에서  Get-MpPreference ^| Select -Expand ExclusionPath
echo.
pause
endlocal
