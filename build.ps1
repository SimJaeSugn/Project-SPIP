# ============================================================
#  Project-SPIP - 설치본 빌드 (PowerShell)
#  실행: 우클릭 > PowerShell로 실행, 또는  powershell -ExecutionPolicy Bypass -File build.ps1
#  결과물: dist\  (NSIS 설치본 + portable exe)
#  옵션:  -Portable  (portable exe만 빌드)
# ============================================================
param([switch]$Portable)

# 콘솔 한글 출력 인코딩(UTF-8). 이 파일은 UTF-8 BOM으로 저장되어야 PowerShell 5.1이 한글을 올바로 읽습니다.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "[Project-SPIP] 빌드를 시작합니다..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[오류] Node.js가 없습니다. https://nodejs.org 에서 18 이상을 설치하세요." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path "node_modules")) {
  Write-Host "[1/2] 의존성 설치 중... (npm install)"
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Host "[오류] npm install 실패." -ForegroundColor Red; exit 1 }
} else {
  Write-Host "[1/2] 의존성 확인됨 - 설치 건너뜀."
}

# 빌드 전 정리: 이 프로젝트의 실행 중인 앱 인스턴스 종료 + dist 제거 (출력 파일 잠금 방지)
Write-Host "[정리] 실행 중인 앱 종료 + 이전 빌드 출력 제거..."
Get-CimInstance Win32_Process -Filter "Name='Project-SPIP.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($PSScriptRoot) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Test-Path "dist") { Remove-Item "dist" -Recurse -Force -ErrorAction SilentlyContinue }

$script = if ($Portable) { "build:portable" } else { "build" }
Write-Host "[2/2] 설치본 빌드 중... (npm run $script)"
npm run $script
if ($LASTEXITCODE -ne 0) {
  Write-Host "[오류] 빌드 실패. 위 로그를 확인하세요." -ForegroundColor Red
  Write-Host "  * app-builder.exe 실행 실패(ERR_ELECTRON_BUILDER_CANNOT_EXECUTE)면 백신이" -ForegroundColor Yellow
  Write-Host "    node_modules\app-builder-bin\win\x64\app-builder.exe 를 격리했을 수 있습니다." -ForegroundColor Yellow
  Write-Host "    프로젝트 폴더를 백신 예외에 추가한 뒤 'npm install' 재실행하세요." -ForegroundColor Yellow
  exit 1
}

Write-Host "[완료] 빌드 성공. 결과물은 dist\ 폴더에 있습니다." -ForegroundColor Green
if (Test-Path "dist") { Start-Process explorer "dist" }
