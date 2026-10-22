<?php

/**
 * Wash Hub POS routes. Loaded from routes/web.php with:
 *     require __DIR__.'/washhub.php';
 * (install-to-laravel.bat adds that line for you.)
 *
 *   /washhub       -> the POS app (resources/views/washhub.blade.php)
 *   /washhub/api   -> JSON API used by the app (CSRF token is sent by the frontend)
 */

use App\Http\Controllers\WashHubController;
use Illuminate\Support\Facades\Route;

Route::view('/washhub', 'washhub')->name('washhub');
Route::match(['get', 'post'], '/washhub/api', [WashHubController::class, 'handle'])->name('washhub.api');
