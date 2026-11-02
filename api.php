<?php
/**
 * ==========================================================================
 *  Wash Hub POS — JSON API for XAMPP (plain PHP + MySQL)
 * ==========================================================================
 *  The frontend calls:  api.php?action=<name>   (body = JSON payload)
 *  Response format:     {"ok": true, "data": ...}  or  {"ok": false, "error": "..."}
 *
 *  All the real logic lives in backend/WashHubApi.php (also used by Laravel).
 */

require __DIR__ . '/backend/WashHubApi.php';

use App\Services\WashHubApi;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
session_start(); // remembers who is logged in (a cookie in the browser + a small file on the server)

/** Connects to MySQL and creates the database the first time. */
function washhub_connect(): PDO
{
    $cfg = require __DIR__ . '/config.php';
    if (!preg_match('/^[A-Za-z0-9_]+$/', $cfg['database'])) {
        throw new RuntimeException('Invalid database name in config.php');
    }
    $pdo = new PDO(
        "mysql:host={$cfg['host']};port={$cfg['port']};charset=utf8mb4",
        $cfg['username'],
        $cfg['password'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `{$cfg['database']}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo->exec("USE `{$cfg['database']}`");
    return $pdo;
}

// Payload = query string (?action=...&id=...) + JSON body
$input  = json_decode(file_get_contents('php://input') ?: '[]', true);
$input  = array_merge($_GET, is_array($input) ? $input : []);
$action = (string) ($input['action'] ?? '');

try {
    $api = new WashHubApi(washhub_connect());

    // Reload the logged-in user from the database on every request, so a role change or a
    // disabled account takes effect right away (null = deleted or disabled -> logged out)
    if (!empty($_SESSION['washhub_user']) && $action !== 'ping') {
        $_SESSION['washhub_user'] = $api->freshUser((int) $_SESSION['washhub_user']['id']);
    }
    $api->setUser($_SESSION['washhub_user'] ?? null);

    // Is the logged-in user allowed to do this action? (see WashHubApi::PERMISSIONS)
    $role = $_SESSION['washhub_user']['role'] ?? null;
    if (!WashHubApi::allowed($role, $action)) {
        http_response_code($role ? 403 : 401);   // 401 = not logged in, 403 = logged in but not allowed
        echo json_encode(['ok' => false, 'error' => $role ? 'Your role is not allowed to do this.' : 'Please log in first.']);
        exit;
    }

    if ($action === 'login') {
        $user = $api->handle('login', $input);     // throws "Wrong username or password." if wrong
        session_regenerate_id(true);               // new session ID after login (blocks "session fixation" attacks)
        $_SESSION['washhub_user'] = $user;
        $data = $user;
    } elseif ($action === 'logout') {
        $_SESSION = [];
        session_destroy();
        $data = true;
    } elseif ($action === 'me') {
        $data = $_SESSION['washhub_user'] ?? null;  // who is logged in right now (null = nobody)
    } else {
        $data = $api->handle($action, $input);
        if ($action === 'account_save') {
            $_SESSION['washhub_user'] = $data;      // keep the session in sync with the new name / username
        }
    }
    echo json_encode(['ok' => true, 'data' => $data]);
} catch (InvalidArgumentException $e) {
    // Validation problem the cashier can fix (e.g. "Customer name is required.")
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
} catch (PDOException $e) {
    http_response_code(500);
    $hint = in_array($e->getCode(), [2002, '2002', 1045, '1045'], false)
        ? ' Is MySQL running in the XAMPP Control Panel? Check config.php.'
        : '';
    echo json_encode(['ok' => false, 'error' => 'Database error: ' . $e->getMessage() . $hint]);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
