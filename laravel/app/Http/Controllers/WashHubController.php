<?php

namespace App\Http\Controllers;

use App\Services\WashHubApi;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use Throwable;

/**
 * Wash Hub POS — Laravel endpoint (same JSON format as api.php on XAMPP).
 * Route: /washhub/api?action=<name>   (see routes/washhub.php)
 * All the logic is in app/Services/WashHubApi.php (copied from backend/WashHubApi.php).
 */
class WashHubController extends Controller
{
    public function handle(Request $request): JsonResponse
    {
        $input = array_merge($request->query(), $request->isJson() ? $request->json()->all() : $request->all());

        try {
            // Uses the "mysql" connection from config/database.php (.env DB_* values)
            $api = new WashHubApi(DB::connection('mysql')->getPdo());
            return response()->json(['ok' => true, 'data' => $api->handle((string) $request->query('action', ''), $input)]);
        } catch (InvalidArgumentException $e) {
            // Validation message for the cashier (e.g. "Customer name is required.")
            return response()->json(['ok' => false, 'error' => $e->getMessage()], 422);
        } catch (Throwable $e) {
            report($e);
            return response()->json(['ok' => false, 'error' => $e->getMessage()], 500);
        }
    }
}
