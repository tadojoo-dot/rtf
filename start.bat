@echo off
chcp 65001 > nul
cd /d "%~dp0"

set PORT=8787
set URL=http://127.0.0.1:%PORT%/index.html

echo.
echo  RTF Dashboard - 로컬 서버 모드
echo  주소: %URL%
echo.
echo  파일을 고를 필요가 없습니다. RAW 파일과 결산자료를 자동으로 읽습니다.
echo  이 창은 닫지 마세요. 닫으면 서버가 꺼집니다.
echo.

:: 결산자료가 사전계산 JSON보다 새로우면 다시 계산한다 (없으면 그냥 넘어감).
:: 브라우저에서 결산 xlsx를 직접 파싱하면 12초간 멈추므로 미리 만들어 둔다.
if exist "tools\build-closing.js" (
  echo  [결산자료] 사전 계산 확인 중...
  node "tools\build-closing.js" --if-stale
  echo.
)

:: 정적 서버 (프로젝트 폴더를 그대로 서빙). 이 노드 프로세스가 서버다.
start "RTF local server" /min node "tools\serve.js" %PORT%

:: 서버가 뜰 때까지 잠깐 기다린 뒤 브라우저를 연다.
ping -n 3 127.0.0.1 > nul
start "" "%URL%"

echo  브라우저를 열었습니다. 이 창을 닫으면 서버가 꺼집니다.
echo.
pause
