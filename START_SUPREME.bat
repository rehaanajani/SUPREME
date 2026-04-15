@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND=%ROOT%supreme-backend"
set "FRONTEND=%ROOT%supreme-frontend"

if not exist "%BACKEND%\main.py" (
  echo  ERROR: Backend not found at "%BACKEND%"
  goto :end
)

if not exist "%FRONTEND%\package.json" (
  echo  ERROR: Frontend not found at "%FRONTEND%"
  goto :end
)

echo.
echo  ============================================
echo   SUPREME - AI Courtroom Simulator
echo  ============================================
echo.
echo  Starting backend on :8000...
start "SUPREME Backend" cmd /k "cd /d ""%BACKEND%"" && python main.py"

timeout /t 3 /nobreak > nul

echo  Starting frontend on :3000...
start "SUPREME Frontend" cmd /k "cd /d ""%FRONTEND%"" && npm run dev"

timeout /t 4 /nobreak > nul

echo.
echo  Both servers starting...
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:3000
echo   API Docs: http://localhost:8000/docs
echo.
start "" "http://localhost:3000"

:end
endlocal
