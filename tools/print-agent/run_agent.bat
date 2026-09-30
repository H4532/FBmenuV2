@echo off
REM FB Menus print agent — double-click to run, or add to Task Scheduler "At startup".
cd /d "%~dp0"
:loop
python print_agent.py
echo Agent stopped. Restarting in 10 seconds...
timeout /t 10 /nobreak >nul
goto loop
