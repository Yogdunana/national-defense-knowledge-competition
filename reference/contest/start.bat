@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   国防知识竞赛计分系统
echo ============================================
pip install -r requirements.txt -q
python app.py
pause
