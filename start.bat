@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo RTF Dashboard를 로컬 파일 모드로 엽니다.
echo 서버는 실행하지 않습니다.
echo.

start "" "%~dp0index.html"
