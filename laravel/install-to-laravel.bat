@echo off
REM ==========================================================================
REM  Copies Wash Hub POS into an existing Laravel project.
REM  Usage:   laravel\install-to-laravel.bat C:\path\to\your-laravel-app
REM  Run it again after changing the frontend or backend/WashHubApi.php.
REM ==========================================================================
setlocal
set "SRC=%~dp0.."
set "LV=%~dp0"
set "DEST=%~1"

if "%DEST%"=="" (
  echo Usage: install-to-laravel.bat C:\path\to\your-laravel-app
  exit /b 1
)
if not exist "%DEST%\artisan" (
  echo "%DEST%" does not look like a Laravel project ^(no artisan file^).
  exit /b 1
)

echo Copying backend...
if not exist "%DEST%\app\Services" mkdir "%DEST%\app\Services"
copy /Y "%SRC%\backend\WashHubApi.php" "%DEST%\app\Services\WashHubApi.php" >nul
copy /Y "%LV%app\Http\Controllers\WashHubController.php" "%DEST%\app\Http\Controllers\WashHubController.php" >nul
copy /Y "%LV%database\migrations\2026_10_22_000000_create_washhub_tables.php" "%DEST%\database\migrations\" >nul
copy /Y "%LV%resources\views\washhub.blade.php" "%DEST%\resources\views\washhub.blade.php" >nul
copy /Y "%LV%routes\washhub.php" "%DEST%\routes\washhub.php" >nul

REM Assets go to public\vendor\washhub (NOT public\washhub, which would block the /washhub route)
echo Copying frontend to public\vendor\washhub ...
if not exist "%DEST%\public\vendor\washhub" mkdir "%DEST%\public\vendor\washhub"
copy /Y "%SRC%\index.css" "%DEST%\public\vendor\washhub\index.css" >nul
copy /Y "%SRC%\index.js" "%DEST%\public\vendor\washhub\index.js" >nul
xcopy /E /I /Y /Q "%SRC%\js" "%DEST%\public\vendor\washhub\js" >nul

findstr /C:"washhub.php" "%DEST%\routes\web.php" >nul 2>&1
if errorlevel 1 (
  echo Adding route include to routes\web.php ...
  >>"%DEST%\routes\web.php" echo.
  >>"%DEST%\routes\web.php" echo require __DIR__.'/washhub.php';
)

echo.
echo Done. Next steps:
echo   1. In %DEST%\.env set DB_CONNECTION=mysql, DB_DATABASE=washhub_pos, DB_USERNAME=root, DB_PASSWORD=
echo   2. php artisan migrate
echo   3. php artisan serve   then open http://127.0.0.1:8000/washhub
endlocal
