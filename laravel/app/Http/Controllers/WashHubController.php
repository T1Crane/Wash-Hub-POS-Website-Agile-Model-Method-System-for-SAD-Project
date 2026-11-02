<?php

namespace App\Http\Controllers;

use App\Services\WashHubApi;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use Throwable;

/**
 * Wash Hub POS — Laravel endpoint (same JSON format and same login rules as api.php on XAMPP).
 * Route: /washhub/api?action=<name>   (see routes/washhub.php)
 * All the logic is in app/Services/WashHubApi.php (copied from backend/WashHubApi.php).
 * The logged-in user is kept in Laravel's session under "washhub_user".
 */
class WashHubController extends Controller
{
    public function handle(Request $request): JsonResponse
    {
        $input   = array_merge($request->query(), $request->isJson() ? $request->json()->all() : $request->all());
        $action  = (string) $request->query('action', '');
        $session = $request->session();

        try {
            // Uses the "mysql" connection from config/database.php (.env DB_* values)
            $api = new WashHubApi(DB::connection('mysql')->getPdo());

            // Reload the logged-in user every request (role changes apply at once; disabled = logged out)
            $user = $session->get('washhub_user');
            if ($user && $action !== 'ping') {
                $user = $api->freshUser((int) $user['id']);
                $session->put('washhub_user', $user);
            }
            $api->setUser($user);

            // Permission check (see WashHubApi::PERMISSIONS)
            $role = $user['role'] ?? null;
            if (!WashHubApi::allowed($role, $action)) {
                return response()->json(['ok' => false, 'error' => $role ? 'Your role is not allowed to do this.' : 'Please log in first.'], $role ? 403 : 401);
            }

            if ($action === 'login') {
                $data = $api->handle('login', $input);
                $session->regenerate();                  // new session ID after login
                $session->put('washhub_user', $data);
            } elseif ($action === 'logout') {
                $session->forget('washhub_user');
                $session->invalidate();
                $session->regenerateToken();             // new CSRF token too
                $data = true;
            } elseif ($action === 'me') {
                $data = $user;
            } else {
                $data = $api->handle($action, $input);
                if ($action === 'account_save') {
                    $session->put('washhub_user', $data);
                }
            }
            return response()->json(['ok' => true, 'data' => $data]);
        } catch (InvalidArgumentException $e) {
            // Validation message for the cashier (e.g. "Customer name is required.")
            return response()->json(['ok' => false, 'error' => $e->getMessage()], 422);
        } catch (Throwable $e) {
            report($e);
            return response()->json(['ok' => false, 'error' => $e->getMessage()], 500);
        }
    }
}
