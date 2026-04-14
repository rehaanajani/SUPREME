@echo off
echo.
echo  ============================================
echo   SUPREME - AI Courtroom Simulator
echo  ============================================
echo.
echo  Starting backend on :8000...
start "SUPREME Backend" cmd /k "cd /d "C:\Users\rehaa\OneDrive\Documents\New project\supreme-backend" && python main.py"

timeout /t 3 /nobreak > nul

echo  Starting frontend on :3000...
start "SUPREME Frontend" cmd /k "cd /d "C:\Users\rehaa\OneDrive\Documents\New project\supreme-frontend" && npm run dev"

timeout /t 4 /nobreak > nul

echo.
echo  Both servers starting...
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:3000
echo   API Docs: http://localhost:8000/docs
echo.
start "" "http://localhost:3000"
