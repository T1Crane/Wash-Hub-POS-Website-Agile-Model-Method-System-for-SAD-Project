<?php
/**
 * ==========================================================================
 *  Wash Hub POS & Inventory — Backend logic (ONE file shared by two setups)
 * ==========================================================================
 *  Used by:
 *    1) api.php                        -> plain PHP on XAMPP (Apache + MySQL)
 *    2) app/Http/Controllers/WashHubController.php -> Laravel
 *
 *  How it works:
 *    - The frontend sends an "action" (e.g. "orders", "order_create") plus a
 *      JSON payload. handle() routes the action to a method below.
 *    - Every method returns a plain PHP array; the caller turns it into JSON.
 *    - Prices and totals are ALWAYS recalculated here (never trust the browser).
 *    - Dates are stored as DATETIME in the shop's timezone (Asia/Manila) and
 *      sent to the browser as ISO-8601 strings with offset (+08:00).
 *
 *  Database tables (all prefixed "wh_" so they won't clash with Laravel's own):
 *    wh_settings, wh_services, wh_customers, wh_orders, wh_order_items,
 *    wh_payments, wh_order_logs, wh_inventory, wh_inventory_logs
 *
 *  NOTE: only positional "?" placeholders are used so the same SQL works with
 *  both XAMPP's PDO settings and Laravel's (native prepares).
 */

namespace App\Services;

use DateTimeImmutable;
use DateTimeZone;
use InvalidArgumentException;
use PDO;
use PDOException;
use Throwable;

class WashHubApi
{
    /** Shop timezone. Change this if the shop is outside the Philippines. */
    public const TIMEZONE = 'Asia/Manila';

    /** Order workflow, in order. "completed" means Picked Up / Delivered. */
    public const STATUSES = ['received', 'washing', 'drying', 'ready', 'completed'];

    /** Accepted payment methods. */
    public const PAYMENT_METHODS = ['cash', 'gcash', 'card'];

    /** The two sides of the system: admin = Owner / Admin (full access), staff = Staff. */
    public const ROLES = ['admin', 'staff'];

    /** Actions anyone may call without logging in. */
    public const PUBLIC_ACTIONS = ['ping', 'login', 'logout', 'me', 'track'];

    /** Who may do what: action => roles allowed. Not listed = nobody (default deny). */
    public const PERMISSIONS = [
        'bootstrap'        => ['admin', 'staff'],
        'account_save'     => ['admin', 'staff'],  // "My Account": edit your own profile
        // Both sides: front desk and Orders board
        'orders'           => ['admin', 'staff'],
        'order'            => ['admin', 'staff'],
        'order_status'     => ['admin', 'staff'],
        'order_create'     => ['admin', 'staff'],
        'order_payment'    => ['admin', 'staff'],
        'order_notify'     => ['admin', 'staff'],
        'order_delete'     => ['admin', 'staff'],
        'customers'        => ['admin', 'staff'],
        'customer_save'    => ['admin', 'staff'],
        // Owner / Admin side only (Staff can't see Reports or Users)
        'dashboard'        => ['admin'],
        'report'           => ['admin'],
        'inventory'        => ['admin'],
        'inventory_logs'   => ['admin'],
        'inventory_save'   => ['admin'],
        'inventory_adjust' => ['admin'],
        'service_save'     => ['admin'],
        'settings_save'    => ['admin'],
        'users'            => ['admin'],
        'user_save'        => ['admin'],
        'user_delete'      => ['admin'],
    ];

    /** True if this role may run this action. $role = null means nobody is logged in. */
    public static function allowed(?string $role, string $action): bool
    {
        if (in_array($action, self::PUBLIC_ACTIONS, true)) {
            return true;
        }
        return $role !== null && in_array($role, self::PERMISSIONS[$action] ?? [], true);
    }

    /** Shop settings that the Settings page is allowed to change (key => default). */
    public const DEFAULT_SETTINGS = [
        'shop_name'     => 'Gap Wash Hub',
        'shop_tagline'  => 'Laundry Services',
        'shop_address'  => 'Shop address, City',
        'shop_phone'    => '0900 000 0000',
        'pickup_terms'  => 'Present this claim ticket when picking up. Items unclaimed after 30 days will be donated. '
                         . 'Gap Wash Hub is not liable for color bleeding, shrinkage, or items left in pockets. '
                         . 'Please check your items before leaving the counter.',
        'sms_template'  => 'Hi {name}! Your laundry ({code}) at {shop} is ready for pickup. Balance due: {balance}. Thank you!',
        // Web address the QR code on tickets points to (blank = the address the app is opened with)
        'public_url'    => '',
    ];

    /**
     * Starter price list = the shop's paper order form (Gap Wash Hub Laundry Form).
     * Prices are per load / per item, so every unit is "pc" (quantity).
     * name, unit, price (PHP), turnaround hours, is express, tile color
     */
    public const DEFAULT_SERVICES = [
        ['Wash',                       'pc', 65,  24, 0, 'blue'],
        ['Wash & Dry',                 'pc', 130, 24, 0, 'blue'],
        ['Dry',                        'pc', 80,  24, 0, 'amber'],
        ['Dry & Fold',                 'pc', 100, 24, 0, 'amber'],
        ['Wash, Dry, & Fold',          'pc', 150, 24, 0, 'teal'],
        ['Spin & Dry',                 'pc', 100, 24, 0, 'teal'],
        ['Package A',                  'pc', 180, 24, 0, 'violet'],
        ['Package B',                  'pc', 200, 24, 0, 'violet'],
        ['Package C',                  'pc', 220, 24, 0, 'violet'],
        ['Addt Detergent',             'pc', 15,  24, 0, 'green'],
        ['Addt Fabcon',                'pc', 15,  24, 0, 'green'],
        ['Over 8 kilos (Wash & Dry)',  'pc', 40,  24, 0, 'pink'],
        ['Over 8 kilos (Wash or Dry)', 'pc', 20,  24, 0, 'pink'],
        ['Blue Plastic',               'pc', 12,  24, 0, 'slate'],
    ];

    private PDO $db;
    private DateTimeZone $tz;

    /** The logged-in user making this request (null = nobody). Set by api.php / the Laravel controller. */
    private ?array $user = null;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->tz = new DateTimeZone(self::TIMEZONE);
    }

    public function setUser(?array $user): void
    {
        $this->user = $user;
    }

    // =====================================================================
    //  ROUTER — maps an action name to the method that handles it
    // =====================================================================

    /** @return mixed Plain array (or list) that will be JSON-encoded. */
    public function handle(string $action, array $in)
    {
        switch ($action) {
            // --- setup / app start ---
            case 'ping':             $this->install(); return ['mode' => 'mysql', 'time' => $this->iso($this->now())];
            case 'login':            return $this->login($in);
            case 'track':            return $this->track((string) ($in['t'] ?? ''));
            case 'bootstrap':        return ['settings' => $this->settings(), 'services' => $this->services(), 'permissions' => $this->myPermissions()];
            // --- user accounts ---
            case 'users':            return $this->users();
            case 'user_save':        return $this->saveUser($in);
            case 'user_delete':      return $this->deleteUser((int) ($in['id'] ?? 0));
            case 'account_save':     return $this->saveAccount($in);
            // --- settings & price list ---
            case 'settings_save':    return $this->saveSettings($in);
            case 'service_save':     return $this->saveService($in);
            // --- customers ---
            case 'customers':        return $this->customers($in);
            case 'customer_save':    return $this->saveCustomer($in);
            // --- orders / POS ---
            case 'orders':           return $this->orders($in);
            case 'order':            return $this->order((int) ($in['id'] ?? 0));
            case 'order_create':     return $this->createOrder($in);
            case 'order_status':     return $this->setStatus($in);
            case 'order_payment':    return $this->addPayment($in);
            case 'order_notify':     return $this->markNotified($in);
            case 'order_delete':     return $this->deleteOrder((int) ($in['id'] ?? 0));
            // --- dashboard & reports ---
            case 'dashboard':        return $this->dashboard();
            case 'report':           return $this->report($in);
            // --- inventory (supplies) ---
            case 'inventory':        return $this->inventory();
            case 'inventory_save':   return $this->saveInventoryItem($in);
            case 'inventory_adjust': return $this->adjustInventory($in);
            case 'inventory_logs':   return $this->inventoryLogs($in);
        }
        throw new InvalidArgumentException("Unknown action \"$action\".");
    }

    // =====================================================================
    //  DATABASE SETUP — creates tables + sample data on first run
    // =====================================================================

    /** CREATE TABLE statements. database/washhub_pos.sql is a copy of these for phpMyAdmin. */
    public static function schema(): array
    {
        $opts = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
        return [
            // Key/value shop settings (name, address, ticket terms...)
            "CREATE TABLE IF NOT EXISTS wh_settings (
                skey   VARCHAR(50) NOT NULL PRIMARY KEY,
                svalue TEXT NOT NULL
            ) $opts",

            // Price list. unit: kg = per kilo, pc = per piece, flat = one-time add-on
            "CREATE TABLE IF NOT EXISTS wh_services (
                id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name             VARCHAR(80)  NOT NULL,
                unit             ENUM('kg','pc','flat') NOT NULL DEFAULT 'kg',
                price            DECIMAL(10,2) NOT NULL DEFAULT 0,
                turnaround_hours INT UNSIGNED NOT NULL DEFAULT 24,
                is_express       TINYINT(1) NOT NULL DEFAULT 0,
                color            VARCHAR(20) NOT NULL DEFAULT 'blue',
                active           TINYINT(1) NOT NULL DEFAULT 1,
                sort_order       INT NOT NULL DEFAULT 0
            ) $opts",

            "CREATE TABLE IF NOT EXISTS wh_customers (
                id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name       VARCHAR(100) NOT NULL,
                phone      VARCHAR(30)  NOT NULL DEFAULT '',
                address    VARCHAR(255) NOT NULL DEFAULT '',
                notes      VARCHAR(255) NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                KEY idx_customer_phone (phone),
                KEY idx_customer_name (name)
            ) $opts",

            // One row per laundry job / claim ticket
            "CREATE TABLE IF NOT EXISTS wh_orders (
                id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                code              VARCHAR(20) NOT NULL UNIQUE,
                track_token       VARCHAR(32) NULL UNIQUE,
                customer_id       INT UNSIGNED NOT NULL,
                status            ENUM('received','washing','drying','ready','completed') NOT NULL DEFAULT 'received',
                fulfillment       ENUM('pickup','delivery') NOT NULL DEFAULT 'pickup',
                is_express        TINYINT(1) NOT NULL DEFAULT 0,
                total_weight      DECIMAL(8,2)  NOT NULL DEFAULT 0,
                subtotal          DECIMAL(10,2) NOT NULL DEFAULT 0,
                discount          DECIMAL(10,2) NOT NULL DEFAULT 0,
                total             DECIMAL(10,2) NOT NULL DEFAULT 0,
                amount_paid       DECIMAL(10,2) NOT NULL DEFAULT 0,
                payment_status    ENUM('unpaid','partial','paid') NOT NULL DEFAULT 'unpaid',
                notes             VARCHAR(255) NOT NULL DEFAULT '',
                created_at        DATETIME NOT NULL,
                ready_at          DATETIME NOT NULL,
                status_updated_at DATETIME NOT NULL,
                completed_at      DATETIME NULL,
                notified_at       DATETIME NULL,
                KEY idx_order_status (status),
                KEY idx_order_created (created_at),
                CONSTRAINT fk_order_customer FOREIGN KEY (customer_id) REFERENCES wh_customers(id)
            ) $opts",

            // Line items. Name/unit/price are copied so old tickets stay correct after price changes.
            "CREATE TABLE IF NOT EXISTS wh_order_items (
                id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                order_id   INT UNSIGNED NOT NULL,
                service_id INT UNSIGNED NULL,
                name       VARCHAR(80) NOT NULL,
                unit       ENUM('kg','pc','flat') NOT NULL,
                qty        DECIMAL(8,2)  NOT NULL,
                unit_price DECIMAL(10,2) NOT NULL,
                line_total DECIMAL(10,2) NOT NULL,
                CONSTRAINT fk_item_order FOREIGN KEY (order_id) REFERENCES wh_orders(id) ON DELETE CASCADE
            ) $opts",

            // Every payment received (an order can be paid in parts). Sales reports read this table.
            "CREATE TABLE IF NOT EXISTS wh_payments (
                id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                order_id INT UNSIGNED NOT NULL,
                amount   DECIMAL(10,2) NOT NULL,
                method   ENUM('cash','gcash','card') NOT NULL DEFAULT 'cash',
                paid_at  DATETIME NOT NULL,
                KEY idx_payment_date (paid_at),
                CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES wh_orders(id) ON DELETE CASCADE
            ) $opts",

            // Status history (audit trail of the workflow board)
            "CREATE TABLE IF NOT EXISTS wh_order_logs (
                id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                order_id   INT UNSIGNED NOT NULL,
                status     VARCHAR(20) NOT NULL,
                changed_at DATETIME NOT NULL,
                CONSTRAINT fk_log_order FOREIGN KEY (order_id) REFERENCES wh_orders(id) ON DELETE CASCADE
            ) $opts",

            // Inventory of shop supplies (detergent, bags, hangers...)
            "CREATE TABLE IF NOT EXISTS wh_inventory (
                id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name          VARCHAR(100) NOT NULL,
                unit          VARCHAR(20)  NOT NULL DEFAULT 'pcs',
                stock         DECIMAL(10,2) NOT NULL DEFAULT 0,
                reorder_level DECIMAL(10,2) NOT NULL DEFAULT 0,
                cost          DECIMAL(10,2) NOT NULL DEFAULT 0,
                updated_at    DATETIME NOT NULL
            ) $opts",

            // Stock movements: positive = restock, negative = used/damaged
            "CREATE TABLE IF NOT EXISTS wh_inventory_logs (
                id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                item_id    INT UNSIGNED NOT NULL,
                change_qty DECIMAL(10,2) NOT NULL,
                reason     VARCHAR(120) NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                CONSTRAINT fk_invlog_item FOREIGN KEY (item_id) REFERENCES wh_inventory(id) ON DELETE CASCADE
            ) $opts",
                // Staff accounts that can log in. "role" decides what each person may do.
            "CREATE TABLE IF NOT EXISTS wh_users (
                id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                username      VARCHAR(50)  NOT NULL UNIQUE,
                full_name     VARCHAR(100) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role          ENUM('admin','staff') NOT NULL DEFAULT 'staff',
                active        TINYINT(1) NOT NULL DEFAULT 1,
                created_at    DATETIME NOT NULL,
                last_login_at DATETIME NULL
            ) $opts",

        ];
    }

    /** Creates missing tables and inserts starter data. Safe to run many times. */
    public function install(): void
    {
        foreach (self::schema() as $sql) {
            $this->db->exec($sql);
        }

        // Upgrade for databases made before the QR tracking link existed:
        // add the column, then give every older order its own secret tracking code
        if (!$this->db->query("SHOW COLUMNS FROM wh_orders LIKE 'track_token'")->fetch()) {
            $this->db->exec('ALTER TABLE wh_orders ADD COLUMN track_token VARCHAR(32) NULL UNIQUE AFTER code');
        }
        $stmt = $this->db->prepare('UPDATE wh_orders SET track_token = ? WHERE id = ?');
        foreach ($this->db->query('SELECT id FROM wh_orders WHERE track_token IS NULL')->fetchAll(PDO::FETCH_COLUMN) as $id) {
            $stmt->execute([$this->newToken(), $id]);
        }

        // Add any missing setting keys (keeps values the shop already changed)
        $stmt = $this->db->prepare('INSERT IGNORE INTO wh_settings (skey, svalue) VALUES (?, ?)');
        foreach (self::DEFAULT_SETTINGS as $key => $value) {
            $stmt->execute([$key, $value]);
        }

        // Rebrand "Wash Hub" -> "Gap Wash Hub", but only where the old default text was never changed
        $this->db->prepare("UPDATE wh_settings SET svalue = ? WHERE skey = 'shop_name' AND svalue = 'Wash Hub'")
            ->execute([self::DEFAULT_SETTINGS['shop_name']]);
        $this->db->prepare("UPDATE wh_settings SET svalue = ? WHERE skey = 'pickup_terms' AND svalue = ?")
            ->execute([self::DEFAULT_SETTINGS['pickup_terms'], str_replace('Gap Wash Hub', 'Wash Hub', self::DEFAULT_SETTINGS['pickup_terms'])]);

        // Switch databases that still have the OLD starter price list (per-kg Wash-Dry-Fold etc.)
        // to the shop's real price list: old services are turned off (not deleted, so old tickets stay correct)
        $oldList = (int) $this->db->query("SELECT COUNT(*) FROM wh_services WHERE name = 'Wash-Dry-Fold' AND unit = 'kg'")->fetchColumn();
        $newList = (int) $this->db->query("SELECT COUNT(*) FROM wh_services WHERE name = 'Wash'")->fetchColumn();
        if ($oldList > 0 && $newList === 0) {
            $this->db->exec("UPDATE wh_services SET active = 0, sort_order = sort_order + 100 WHERE name IN ('Wash-Dry-Fold', 'Dry Cleaning', 'Ironing / Pressing', 'Comforter / Blanket', 'Express Add-on (Same Day)')");
            $this->insertDefaultServices();
        }

        if ((int) $this->db->query('SELECT COUNT(*) FROM wh_services')->fetchColumn() === 0) {
            $this->insertDefaultServices();
        }

        if ((int) $this->db->query('SELECT COUNT(*) FROM wh_inventory')->fetchColumn() === 0) {
            $now  = $this->dt($this->now());
            $stmt = $this->db->prepare('INSERT INTO wh_inventory (name, unit, stock, reorder_level, cost, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
            foreach ([
                ['Liquid Detergent',   'L',   20,  5,  95],
                ['Fabric Conditioner', 'L',   15,  5,  80],
                ['Color-safe Bleach',  'L',   4,   3,  70],
                ['Plastic Laundry Bags', 'pcs', 180, 50, 3],
                ['Hangers',            'pcs', 25,  30, 12],
                ['Dryer Sheets',       'box', 6,   2,  150],
            ] as $row) {
                $stmt->execute([...$row, $now]);
            }
        }

        // Upgrade from the old 4 roles to the 2 sides:
        // owner + admin -> admin (Owner / Admin side), cashier + staff -> staff (Staff side)
        $roleType = $this->db->query("SHOW COLUMNS FROM wh_users LIKE 'role'")->fetch(PDO::FETCH_ASSOC)['Type'] ?? '';
        if (str_contains($roleType, 'owner') || str_contains($roleType, 'cashier')) {
            $this->db->exec("ALTER TABLE wh_users MODIFY role ENUM('owner','admin','cashier','staff') NOT NULL DEFAULT 'staff'");
            $this->db->exec("UPDATE wh_users SET role = 'admin' WHERE role = 'owner'");
            $this->db->exec("UPDATE wh_users SET role = 'staff' WHERE role = 'cashier'");
            $this->db->exec("ALTER TABLE wh_users MODIFY role ENUM('admin','staff') NOT NULL DEFAULT 'staff'");
        }

        // First run: create the Owner / Admin account so someone can log in.
        // Default login: owner / owner123  (change it after the first login!)
        if ((int) $this->db->query('SELECT COUNT(*) FROM wh_users')->fetchColumn() === 0) {
            $this->db->prepare('INSERT INTO wh_users (username, full_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
                ->execute(['owner', 'Shop Owner', password_hash('owner123', PASSWORD_DEFAULT), 'admin', $this->dt($this->now())]);
        }
    }

    /** Adds the shop's price list (DEFAULT_SERVICES), in the same order as the paper form. */
    private function insertDefaultServices(): void
    {
        $stmt = $this->db->prepare('INSERT INTO wh_services (name, unit, price, turnaround_hours, is_express, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
        foreach (self::DEFAULT_SERVICES as $i => $row) {
            $stmt->execute([...$row, $i + 1]);
        }
    }

    // =====================================================================
    //  USERS & LOGIN
    // =====================================================================

    /** Checks username + password. Returns the user (never the hash) or throws an error. */
    public function login(array $in): array
    {
        $username = trim((string) ($in['username'] ?? ''));
        $password = (string) ($in['password'] ?? '');

        $stmt = $this->db->prepare('SELECT * FROM wh_users WHERE username = ?');
        $stmt->execute([$username]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        // Same message for "no such user" and "wrong password", so nobody can find out which usernames exist
        if (!$user || !password_verify($password, $user['password_hash'])) {
            throw new InvalidArgumentException('Wrong username or password.');
        }
        if (!$user['active']) {
            throw new InvalidArgumentException('This account is disabled. Please ask the Owner / Admin.');
        }

        $this->db->prepare('UPDATE wh_users SET last_login_at = ? WHERE id = ?')
            ->execute([$this->dt($this->now()), $user['id']]);

        return $this->publicUser($user);
    }

    /**
     * Reloads a logged-in user from the database (called on every request).
     * Returns null if the account was deleted or disabled, which logs them out.
     * This makes a role change by the Owner / Admin take effect right away.
     */
    public function freshUser(int $id): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM wh_users WHERE id = ? AND active = 1');
        $stmt->execute([$id]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        return $user ? $this->publicUser($user) : null;
    }

    /** The actions the current user may use. The screen uses this list to hide what they can't do. */
    private function myPermissions(): array
    {
        $role = $this->user['role'] ?? null;
        return array_values(array_filter(array_keys(self::PERMISSIONS), fn ($action) => self::allowed($role, $action)));
    }

    /** Owner / Admin only: list every account (never the password hashes). */
    private function users(): array
    {
        $rows = $this->db->query("SELECT * FROM wh_users ORDER BY FIELD(role, 'admin', 'staff'), full_name")
            ->fetchAll(PDO::FETCH_ASSOC);
        return array_map(fn ($u) => $this->publicUser($u) + [
            'active'        => (bool) $u['active'],
            'created_at'    => $this->iso($u['created_at']),
            'last_login_at' => $this->iso($u['last_login_at']),
        ], $rows);
    }

    /**
     * Owner / Admin only: create (no id) or edit (with id) an account.
     * Payload {id?, full_name, username, role, active, password}. Password is optional when editing (blank = keep).
     */
    private function saveUser(array $in): array
    {
        $id       = (int) ($in['id'] ?? 0);
        $fullName = $this->requireText($in['full_name'] ?? '', 'Full name');
        $username = $this->cleanUsername($in['username'] ?? '');
        $role     = (string) ($in['role'] ?? '');
        $active   = !isset($in['active']) || $in['active'] ? 1 : 0;
        $password = (string) ($in['password'] ?? '');

        if (!in_array($role, self::ROLES, true)) {
            throw new InvalidArgumentException('Choose a role.');
        }
        // Lock-out protection: you can't demote or disable their own account
        if ($id > 0 && $id === (int) ($this->user['id'] ?? 0) && ($role !== $this->user['role'] || !$active)) {
            throw new InvalidArgumentException("You can't change your own role or disable your own account.");
        }
        if ($id === 0 && $password === '') {
            throw new InvalidArgumentException('Set a password for the new account.');
        }
        if ($password !== '') {
            $this->checkNewPassword($password);
        }
        $this->assertUsernameFree($username, $id);

        if ($id > 0) {
            $stmt = $this->db->prepare('UPDATE wh_users SET full_name = ?, username = ?, role = ?, active = ? WHERE id = ?');
            $stmt->execute([$fullName, $username, $role, $active, $id]);
            if ($password !== '') {
                $this->db->prepare('UPDATE wh_users SET password_hash = ? WHERE id = ?')
                    ->execute([password_hash($password, PASSWORD_DEFAULT), $id]);
            }
        } else {
            $this->db->prepare('INSERT INTO wh_users (username, full_name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                ->execute([$username, $fullName, password_hash($password, PASSWORD_DEFAULT), $role, $active, $this->dt($this->now())]);
        }
        return $this->users();
    }

    /**
     * Owner / Admin only: permanently delete an account. Payload {id}.
     * Orders and payments are not linked to user accounts, so no shop records are lost.
     * You can't delete your own account (so the shop always keeps an Owner / Admin).
     */
    private function deleteUser(int $id): array
    {
        if ($id === (int) ($this->user['id'] ?? 0)) {
            throw new InvalidArgumentException("You can't delete your own account.");
        }
        $stmt = $this->db->prepare('DELETE FROM wh_users WHERE id = ?');
        $stmt->execute([$id]);
        if ($stmt->rowCount() === 0) {
            throw new InvalidArgumentException('User not found.');
        }
        return $this->users();
    }

    /**
     * "My Account" — any logged-in user edits their own name, username and password.
     * Payload {full_name, username, current_password, new_password}.
     * Changing the username or password needs the current password (in case someone else is using your screen).
     */
    private function saveAccount(array $in): array
    {
        $stmt = $this->db->prepare('SELECT * FROM wh_users WHERE id = ?');
        $stmt->execute([(int) ($this->user['id'] ?? 0)]);
        $me = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$me) {
            throw new InvalidArgumentException('Please log in first.');
        }

        $fullName    = $this->requireText($in['full_name'] ?? '', 'Full name');
        $username    = $this->cleanUsername($in['username'] ?? $me['username']);
        $newPassword = (string) ($in['new_password'] ?? '');

        if ($username !== $me['username'] || $newPassword !== '') {
            if (!password_verify((string) ($in['current_password'] ?? ''), $me['password_hash'])) {
                throw new InvalidArgumentException('Your current password is incorrect.');
            }
        }
        if ($newPassword !== '') {
            $this->checkNewPassword($newPassword);
        }
        $this->assertUsernameFree($username, (int) $me['id']);

        $this->db->prepare('UPDATE wh_users SET full_name = ?, username = ? WHERE id = ?')
            ->execute([$fullName, $username, $me['id']]);
        if ($newPassword !== '') {
            $this->db->prepare('UPDATE wh_users SET password_hash = ? WHERE id = ?')
                ->execute([password_hash($newPassword, PASSWORD_DEFAULT), $me['id']]);
        }
        return $this->freshUser((int) $me['id']);
    }

    /** The safe part of a user row: what the browser may see (no password hash). */
    private function publicUser(array $u): array
    {
        return ['id' => (int) $u['id'], 'username' => $u['username'], 'full_name' => $u['full_name'], 'role' => $u['role']];
    }

    /** Usernames: 3-50 characters, letters/numbers and . _ - @ (so an email address works too). */
    private function cleanUsername($value): string
    {
        $value = trim((string) $value);
        if (!preg_match('/^[A-Za-z0-9._@-]{3,50}$/', $value)) {
            throw new InvalidArgumentException('Username must be 3-50 characters: letters, numbers, dot, dash, underscore or @ (an email works too).');
        }
        return $value;
    }

    private function checkNewPassword(string $password): void
    {
        if (mb_strlen($password) < 6) {
            throw new InvalidArgumentException('Password must be at least 6 characters.');
        }
    }

    /** Usernames must be unique. $exceptId = the account being edited (it may keep its own name). */
    private function assertUsernameFree(string $username, int $exceptId): void
    {
        $stmt = $this->db->prepare('SELECT id FROM wh_users WHERE username = ? AND id <> ?');
        $stmt->execute([$username, $exceptId]);
        if ($stmt->fetchColumn()) {
            throw new InvalidArgumentException('That username is already taken.');
        }
    }

    // =====================================================================
    //  SETTINGS & SERVICES (price list)
    // =====================================================================

    private function settings(): array
    {
        $out = self::DEFAULT_SETTINGS;
        foreach ($this->db->query('SELECT skey, svalue FROM wh_settings')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $out[$row['skey']] = $row['svalue'];
        }
        return $out;
    }

    private function saveSettings(array $in): array
    {
        $stmt = $this->db->prepare('INSERT INTO wh_settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)');
        foreach (array_keys(self::DEFAULT_SETTINGS) as $key) {
            if (array_key_exists($key, $in)) {
                $stmt->execute([$key, trim((string) $in[$key])]);
            }
        }
        return $this->settings();
    }

    private function services(): array
    {
        $rows = $this->db->query('SELECT * FROM wh_services ORDER BY sort_order, id')->fetchAll(PDO::FETCH_ASSOC);
        return array_map(fn ($r) => [
            'id'               => (int) $r['id'],
            'name'             => $r['name'],
            'unit'             => $r['unit'],
            'price'            => (float) $r['price'],
            'turnaround_hours' => (int) $r['turnaround_hours'],
            'is_express'       => (bool) $r['is_express'],
            'color'            => $r['color'],
            'active'           => (bool) $r['active'],
            'sort_order'       => (int) $r['sort_order'],
        ], $rows);
    }

    /** Create (no id) or update (with id) a service. Returns the full price list. */
    private function saveService(array $in): array
    {
        $name = $this->requireText($in['name'] ?? '', 'Service name');
        $unit = in_array($in['unit'] ?? '', ['kg', 'pc', 'flat'], true) ? $in['unit'] : 'kg';
        $data = [
            $name,
            $unit,
            max(0, round((float) ($in['price'] ?? 0), 2)),
            max(1, (int) ($in['turnaround_hours'] ?? 24)),
            empty($in['is_express']) ? 0 : 1,
            preg_replace('/[^a-z]/', '', (string) ($in['color'] ?? 'blue')) ?: 'blue',
            !isset($in['active']) || $in['active'] ? 1 : 0,
            (int) ($in['sort_order'] ?? 0),
        ];
        $id = (int) ($in['id'] ?? 0);
        if ($id > 0) {
            $this->db->prepare('UPDATE wh_services SET name=?, unit=?, price=?, turnaround_hours=?, is_express=?, color=?, active=?, sort_order=? WHERE id=?')
                ->execute([...$data, $id]);
        } else {
            $this->db->prepare('INSERT INTO wh_services (name, unit, price, turnaround_hours, is_express, color, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute($data);
        }
        return $this->services();
    }

    // =====================================================================
    //  CUSTOMERS
    // =====================================================================

    /** Search customers by name or phone (empty q = most recent). */
    private function customers(array $in): array
    {
        $q      = trim((string) ($in['q'] ?? ''));
        $limit  = min(500, max(1, (int) ($in['limit'] ?? 100)));
        $where  = '';
        $params = [];
        if ($q !== '') {
            $where  = 'WHERE c.name LIKE ? OR c.phone LIKE ?';
            $params = ["%$q%", '%' . preg_replace('/\s+/', '', $q) . '%'];
        }
        // GROUP BY lists every column so it also works with ONLY_FULL_GROUP_BY (Laravel strict mode)
        $sql = "SELECT c.id, c.name, c.phone, c.address, c.notes, c.created_at,
                       COUNT(o.id) AS order_count, MAX(o.created_at) AS last_order_at, COALESCE(SUM(o.total), 0) AS total_spent
                FROM wh_customers c
                LEFT JOIN wh_orders o ON o.customer_id = c.id
                $where
                GROUP BY c.id, c.name, c.phone, c.address, c.notes, c.created_at
                ORDER BY last_order_at DESC, c.name
                LIMIT $limit";
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return array_map(fn ($r) => [
            'id'            => (int) $r['id'],
            'name'          => $r['name'],
            'phone'         => $r['phone'],
            'address'       => $r['address'],
            'notes'         => $r['notes'],
            'created_at'    => $this->iso($r['created_at']),
            'order_count'   => (int) $r['order_count'],
            'last_order_at' => $this->iso($r['last_order_at']),
            'total_spent'   => (float) $r['total_spent'],
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    private function saveCustomer(array $in): array
    {
        $fields = [
            $this->requireText($in['name'] ?? '', 'Customer name'),
            $this->cleanPhone($in['phone'] ?? ''),
            mb_substr(trim((string) ($in['address'] ?? '')), 0, 255),
            mb_substr(trim((string) ($in['notes'] ?? '')), 0, 255),
        ];
        $id = (int) ($in['id'] ?? 0);
        if ($id > 0) {
            $this->db->prepare('UPDATE wh_customers SET name=?, phone=?, address=?, notes=? WHERE id=?')->execute([...$fields, $id]);
        } else {
            $this->db->prepare('INSERT INTO wh_customers (name, phone, address, notes, created_at) VALUES (?, ?, ?, ?, ?)')
                ->execute([...$fields, $this->dt($this->now())]);
            $id = (int) $this->db->lastInsertId();
        }
        $stmt = $this->db->prepare('SELECT * FROM wh_customers WHERE id = ?');
        $stmt->execute([$id]);
        $c = $stmt->fetch(PDO::FETCH_ASSOC);
        return ['id' => (int) $c['id'], 'name' => $c['name'], 'phone' => $c['phone'], 'address' => $c['address'], 'notes' => $c['notes']];
    }

    /** Used by createOrder: picks an existing customer or creates a new one. */
    private function resolveCustomer(array $c): int
    {
        $id = (int) ($c['id'] ?? 0);
        if ($id > 0) {
            $stmt = $this->db->prepare('SELECT id FROM wh_customers WHERE id = ?');
            $stmt->execute([$id]);
            if ($stmt->fetchColumn()) {
                return $id;
            }
        }
        // Same phone number = same customer (avoids duplicate profiles)
        $phone = $this->cleanPhone($c['phone'] ?? '');
        if ($phone !== '') {
            $stmt = $this->db->prepare('SELECT id FROM wh_customers WHERE phone = ? LIMIT 1');
            $stmt->execute([$phone]);
            if ($found = $stmt->fetchColumn()) {
                return (int) $found;
            }
        }
        return $this->saveCustomer($c)['id'];
    }

    // =====================================================================
    //  ORDERS — POS counter, workflow board, claim tickets
    // =====================================================================

    /**
     * List orders.
     *   status: all (default) | active (not completed) | overdue | received | washing | drying | ready | completed
     *   q:      search order code, customer name or phone
     *   from/to: created date range (YYYY-MM-DD)
     *   completed_since_hours: for the board, only show recently completed orders
     */
    private function orders(array $in): array
    {
        $where  = [];
        $params = [];
        $status = (string) ($in['status'] ?? 'all');
        $now    = $this->dt($this->now());

        if ($status === 'active') {
            $where[] = "o.status <> 'completed'";
        } elseif ($status === 'overdue') {
            $where[]  = "o.status IN ('received','washing','drying') AND o.ready_at < ?";
            $params[] = $now;
        } elseif (in_array($status, self::STATUSES, true)) {
            $where[]  = 'o.status = ?';
            $params[] = $status;
        }
        if (!empty($in['completed_since_hours'])) {
            $where[]  = "(o.status <> 'completed' OR o.completed_at >= ?)";
            $params[] = $this->dt($this->now()->modify('-' . (int) $in['completed_since_hours'] . ' hours'));
        }
        if (($q = trim((string) ($in['q'] ?? ''))) !== '') {
            $where[] = '(o.code LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)';
            array_push($params, "%$q%", "%$q%", '%' . preg_replace('/\s+/', '', $q) . '%');
        }
        if (!empty($in['customer_id'])) {
            $where[]  = 'o.customer_id = ?';
            $params[] = (int) $in['customer_id'];
        }
        if (!empty($in['from'])) {
            $where[]  = 'o.created_at >= ?';
            $params[] = $this->dayStart($in['from']);
        }
        if (!empty($in['to'])) {
            $where[]  = 'o.created_at < ?';
            $params[] = $this->dayStart($in['to'], 1);
        }
        $limit = min(1000, max(1, (int) ($in['limit'] ?? 300)));
        $sql   = 'SELECT o.*, c.name AS c_name, c.phone AS c_phone, c.address AS c_address, c.notes AS c_notes
                  FROM wh_orders o JOIN wh_customers c ON c.id = o.customer_id '
               . ($where ? 'WHERE ' . implode(' AND ', $where) : '')
               . " ORDER BY o.created_at DESC LIMIT $limit";
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return $this->hydrateOrders($stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    private function order(int $id): array
    {
        $stmt = $this->db->prepare('SELECT o.*, c.name AS c_name, c.phone AS c_phone, c.address AS c_address, c.notes AS c_notes
                                    FROM wh_orders o JOIN wh_customers c ON c.id = o.customer_id WHERE o.id = ?');
        $stmt->execute([$id]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) {
            throw new InvalidArgumentException('Order not found.');
        }
        $order = $this->hydrateOrders($rows)[0];

        // Single-order view also includes the status history
        $stmt = $this->db->prepare('SELECT status, changed_at FROM wh_order_logs WHERE order_id = ? ORDER BY id');
        $stmt->execute([$id]);
        $order['history'] = array_map(fn ($r) => ['status' => $r['status'], 'at' => $this->iso($r['changed_at'])], $stmt->fetchAll(PDO::FETCH_ASSOC));
        return $order;
    }

    /**
     * POS checkout. Payload:
     *   customer:    {id} or {name, phone, address, notes}
     *   items:       [{service_id, qty}]   (qty = kg or pieces; ignored for flat add-ons)
     *   discount:    peso amount
     *   payment:     {amount, method}      (amount applied now; 0 = pay on pickup)
     *   fulfillment: pickup | delivery
     *   notes:       free text
     */
    private function createOrder(array $in): array
    {
        $items = $in['items'] ?? [];
        if (!is_array($items) || !$items) {
            throw new InvalidArgumentException('Add at least one service to the order.');
        }
        $services = [];
        foreach ($this->services() as $s) {
            $services[$s['id']] = $s;
        }

        // --- 1) price every line from the database price list ---
        $lines = [];
        $subtotal = 0.0;
        $weight = 0.0;
        $hours = 0;
        $express = null;
        foreach ($items as $it) {
            $svc = $services[(int) ($it['service_id'] ?? 0)] ?? null;
            if (!$svc || !$svc['active']) {
                throw new InvalidArgumentException('One of the selected services is no longer available.');
            }
            $qty = $svc['unit'] === 'flat' ? 1.0 : round((float) ($it['qty'] ?? 0), 2);
            if ($qty <= 0) {
                throw new InvalidArgumentException("Enter the " . ($svc['unit'] === 'kg' ? 'weight' : 'number of pieces') . " for {$svc['name']}.");
            }
            $line = round($qty * $svc['price'], 2);
            $lines[] = [$svc['id'], $svc['name'], $svc['unit'], $qty, $svc['price'], $line];
            $subtotal += $line;
            if ($svc['unit'] === 'kg') {
                $weight += $qty;
            }
            if ($svc['is_express']) {
                $express = $svc;
            } else {
                $hours = max($hours, $svc['turnaround_hours']);
            }
        }

        // --- 2) totals, payment, estimated pickup time ---
        // Express add-on overrides the turnaround (e.g. same-day = 6 hours)
        if ($express) {
            $hours = $express['turnaround_hours'];
        }
        $subtotal = round($subtotal, 2);
        $discount = min(max(round((float) ($in['discount'] ?? 0), 2), 0), $subtotal);
        $total    = round($subtotal - $discount, 2);
        $paid     = min(max(round((float) ($in['payment']['amount'] ?? 0), 2), 0), $total);
        $method   = $this->paymentMethod($in['payment']['method'] ?? 'cash');
        $fulfil   = ($in['fulfillment'] ?? '') === 'delivery' ? 'delivery' : 'pickup';
        $notes    = mb_substr(trim((string) ($in['notes'] ?? '')), 0, 255);
        $now      = $this->now();
        $readyAt  = $now->modify("+{$hours} hours");

        // --- 3) save everything in one transaction ---
        // Retries if two counters generate the same order code at the same moment.
        for ($attempt = 1; ; $attempt++) {
            $this->db->beginTransaction();
            try {
                $customerId = $this->resolveCustomer(is_array($in['customer'] ?? null) ? $in['customer'] : []);
                $code = $this->nextOrderCode($now);
                $this->db->prepare('INSERT INTO wh_orders
                        (code, track_token, customer_id, status, fulfillment, is_express, total_weight, subtotal, discount, total,
                         amount_paid, payment_status, notes, created_at, ready_at, status_updated_at)
                        VALUES (?, ?, ?, \'received\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    ->execute([$code, $this->newToken(), $customerId, $fulfil, $express ? 1 : 0, round($weight, 2), $subtotal, $discount, $total,
                               $paid, $this->paymentStatus($paid, $total), $notes, $this->dt($now), $this->dt($readyAt), $this->dt($now)]);
                $orderId = (int) $this->db->lastInsertId();

                $stmt = $this->db->prepare('INSERT INTO wh_order_items (order_id, service_id, name, unit, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)');
                foreach ($lines as $line) {
                    $stmt->execute([$orderId, ...$line]);
                }
                if ($paid > 0) {
                    $this->db->prepare('INSERT INTO wh_payments (order_id, amount, method, paid_at) VALUES (?, ?, ?, ?)')
                        ->execute([$orderId, $paid, $method, $this->dt($now)]);
                }
                $this->logStatus($orderId, 'received', $now);
                $this->db->commit();
                return $this->order($orderId);
            } catch (Throwable $e) {
                $this->db->rollBack();
                $duplicate = $e instanceof PDOException && $e->getCode() === '23000' && str_contains($e->getMessage(), 'code');
                if (!$duplicate || $attempt >= 3) {
                    throw $e;
                }
            }
        }
    }

    /**
     * Public "Where is my laundry?" page, opened by scanning the QR code on the claim ticket.
     * Needs the order's secret tracking code (not the order ID, which is easy to guess),
     * and shows only the customer's first name — no phone number or address.
     */
    private function track(string $token): array
    {
        $stmt = $this->db->prepare('SELECT id FROM wh_orders WHERE track_token = ?');
        $stmt->execute([$token]);
        $id = preg_match('/^[a-f0-9]{32}$/', $token) ? $stmt->fetchColumn() : false;
        if (!$id) {
            throw new InvalidArgumentException('This tracking link is not valid. Please check your claim ticket or contact the shop.');
        }
        $o = $this->order((int) $id);
        $s = $this->settings();
        return [
            'shop'  => ['name' => $s['shop_name'], 'phone' => $s['shop_phone'], 'address' => $s['shop_address']],
            'order' => [
                'code'           => $o['code'],
                'first_name'     => explode(' ', trim($o['customer']['name']))[0],
                'status'         => $o['status'],
                'fulfillment'    => $o['fulfillment'],
                'is_express'     => $o['is_express'],
                'created_at'     => $o['created_at'],
                'ready_at'       => $o['ready_at'],
                'completed_at'   => $o['completed_at'],
                'total'          => $o['total'],
                'balance'        => $o['balance'],
                'payment_status' => $o['payment_status'],
                'items'          => array_map(fn ($i) => ['name' => $i['name'], 'unit' => $i['unit'], 'qty' => $i['qty']], $o['items']),
            ],
        ];
    }

    /** A random 32-character secret, e.g. for the tracking link (impossible to guess). */
    private function newToken(): string
    {
        return bin2hex(random_bytes(16));
    }

    /** Order/Tag ID format: WH-YYMMDD-0001 (resets daily). */
    private function nextOrderCode(DateTimeImmutable $now): string
    {
        $prefix = 'WH-' . $now->format('ymd') . '-';
        $stmt   = $this->db->prepare('SELECT code FROM wh_orders WHERE code LIKE ? ORDER BY code DESC LIMIT 1');
        $stmt->execute([$prefix . '%']);
        $last = $stmt->fetchColumn();
        $next = $last ? ((int) substr($last, strlen($prefix))) + 1 : 1;
        return $prefix . str_pad((string) $next, 4, '0', STR_PAD_LEFT);
    }

    /** Workflow board: move an order to another stage. Payload {id, status}. */
    private function setStatus(array $in): array
    {
        $id     = (int) ($in['id'] ?? 0);
        $status = (string) ($in['status'] ?? '');
        if (!in_array($status, self::STATUSES, true)) {
            throw new InvalidArgumentException('Invalid status.');
        }
        $this->order($id); // throws if missing
        $now = $this->now();
        $this->db->prepare('UPDATE wh_orders SET status = ?, status_updated_at = ?, completed_at = ? WHERE id = ?')
            ->execute([$status, $this->dt($now), $status === 'completed' ? $this->dt($now) : null, $id]);
        $this->logStatus($id, $status, $now);
        return $this->order($id);
    }

    /** Record a (partial) payment on an existing order. Payload {id, amount, method}. */
    private function addPayment(array $in): array
    {
        $order   = $this->order((int) ($in['id'] ?? 0));
        $balance = round($order['total'] - $order['amount_paid'], 2);
        if ($balance <= 0) {
            throw new InvalidArgumentException('This order is already fully paid.');
        }
        $amount = min(round((float) ($in['amount'] ?? 0), 2), $balance);
        if ($amount <= 0) {
            throw new InvalidArgumentException('Enter the amount received.');
        }
        $paid = round($order['amount_paid'] + $amount, 2);
        $this->db->beginTransaction();
        try {
            $this->db->prepare('INSERT INTO wh_payments (order_id, amount, method, paid_at) VALUES (?, ?, ?, ?)')
                ->execute([$order['id'], $amount, $this->paymentMethod($in['method'] ?? 'cash'), $this->dt($this->now())]);
            $this->db->prepare('UPDATE wh_orders SET amount_paid = ?, payment_status = ? WHERE id = ?')
                ->execute([$paid, $this->paymentStatus($paid, $order['total']), $order['id']]);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        return $this->order($order['id']);
    }

    /** Marks that the customer was already texted/called that the laundry is ready. */
    /**
     * Both sides: permanently delete a wrong order (e.g. a typo in the weight or the wrong customer).
     * Its items, payments and status history are deleted with it (ON DELETE CASCADE),
     * so any payment on it also disappears from the sales reports. The customer profile stays.
     */
    private function deleteOrder(int $id): array
    {
        $order = $this->order($id); // throws "Order not found." if it doesn't exist
        $this->db->prepare('DELETE FROM wh_orders WHERE id = ?')->execute([$id]);
        return ['deleted' => $order['code']];
    }

    private function markNotified(array $in): array
    {
        $id = (int) ($in['id'] ?? 0);
        $this->db->prepare('UPDATE wh_orders SET notified_at = ? WHERE id = ?')->execute([$this->dt($this->now()), $id]);
        return $this->order($id);
    }

    private function logStatus(int $orderId, string $status, DateTimeImmutable $at): void
    {
        $this->db->prepare('INSERT INTO wh_order_logs (order_id, status, changed_at) VALUES (?, ?, ?)')
            ->execute([$orderId, $status, $this->dt($at)]);
    }

    /** Adds customer, items and payments to raw order rows (2 extra queries total, not per order). */
    private function hydrateOrders(array $rows): array
    {
        if (!$rows) {
            return [];
        }
        $ids   = array_map(fn ($r) => (int) $r['id'], $rows);
        $marks = implode(',', array_fill(0, count($ids), '?'));

        $items = [];
        $stmt  = $this->db->prepare("SELECT * FROM wh_order_items WHERE order_id IN ($marks) ORDER BY id");
        $stmt->execute($ids);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $i) {
            $items[(int) $i['order_id']][] = [
                'service_id' => $i['service_id'] === null ? null : (int) $i['service_id'],
                'name'       => $i['name'],
                'unit'       => $i['unit'],
                'qty'        => (float) $i['qty'],
                'unit_price' => (float) $i['unit_price'],
                'line_total' => (float) $i['line_total'],
            ];
        }

        $payments = [];
        $stmt     = $this->db->prepare("SELECT * FROM wh_payments WHERE order_id IN ($marks) ORDER BY id");
        $stmt->execute($ids);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $p) {
            $payments[(int) $p['order_id']][] = ['amount' => (float) $p['amount'], 'method' => $p['method'], 'paid_at' => $this->iso($p['paid_at'])];
        }

        return array_map(function ($r) use ($items, $payments) {
            $id = (int) $r['id'];
            return [
                'id'                => $id,
                'code'              => $r['code'],
                'track_token'       => $r['track_token'],
                'status'            => $r['status'],
                'fulfillment'       => $r['fulfillment'],
                'is_express'        => (bool) $r['is_express'],
                'total_weight'      => (float) $r['total_weight'],
                'subtotal'          => (float) $r['subtotal'],
                'discount'          => (float) $r['discount'],
                'total'             => (float) $r['total'],
                'amount_paid'       => (float) $r['amount_paid'],
                'balance'           => round((float) $r['total'] - (float) $r['amount_paid'], 2),
                'payment_status'    => $r['payment_status'],
                'notes'             => $r['notes'],
                'created_at'        => $this->iso($r['created_at']),
                'ready_at'          => $this->iso($r['ready_at']),
                'status_updated_at' => $this->iso($r['status_updated_at']),
                'completed_at'      => $this->iso($r['completed_at']),
                'notified_at'       => $this->iso($r['notified_at']),
                'customer'          => ['id' => (int) $r['customer_id'], 'name' => $r['c_name'], 'phone' => $r['c_phone'], 'address' => $r['c_address'], 'notes' => $r['c_notes']],
                'items'             => $items[$id] ?? [],
                'payments'          => $payments[$id] ?? [],
            ];
        }, $rows);
    }

    // =====================================================================
    //  DASHBOARD & REPORTS
    // =====================================================================

    private function dashboard(): array
    {
        $now        = $this->now();
        $todayStart = $now->setTime(0, 0);
        $weekStart  = $todayStart->modify('-6 days');

        // Sales = money actually received (payments), grouped per day for the last 7 days
        $stmt = $this->db->prepare('SELECT DATE(paid_at) AS d, SUM(amount) AS total FROM wh_payments WHERE paid_at >= ? GROUP BY DATE(paid_at)');
        $stmt->execute([$this->dt($weekStart)]);
        $byDay = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $byDay[$r['d']] = (float) $r['total'];
        }
        $week = [];
        for ($d = $weekStart; $d <= $todayStart; $d = $d->modify('+1 day')) {
            $key    = $d->format('Y-m-d');
            $week[] = ['date' => $key, 'label' => $d->format('D'), 'total' => $byDay[$key] ?? 0.0];
        }

        $stmt = $this->db->prepare('SELECT method, SUM(amount) AS total FROM wh_payments WHERE paid_at >= ? GROUP BY method');
        $stmt->execute([$this->dt($todayStart)]);
        $methods = ['cash' => 0.0, 'gcash' => 0.0, 'card' => 0.0];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $methods[$r['method']] = (float) $r['total'];
        }

        $stmt = $this->db->prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total_weight), 0) AS kg FROM wh_orders WHERE created_at >= ?');
        $stmt->execute([$this->dt($todayStart)]);
        $today = $stmt->fetch(PDO::FETCH_ASSOC);

        $statusCounts = array_fill_keys(['received', 'washing', 'drying', 'ready'], 0);
        foreach ($this->db->query("SELECT status, COUNT(*) AS n FROM wh_orders WHERE status <> 'completed' GROUP BY status")->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $statusCounts[$r['status']] = (int) $r['n'];
        }

        $receivable = (float) $this->db->query("SELECT COALESCE(SUM(total - amount_paid), 0) FROM wh_orders WHERE payment_status <> 'paid'")->fetchColumn();

        return [
            'today_sales'    => end($week)['total'],
            'week_sales'     => round(array_sum(array_column($week, 'total')), 2),
            'week'           => $week,
            'today_methods'  => $methods,
            'today_orders'   => (int) $today['n'],
            'today_kg'       => (float) $today['kg'],
            'status_counts'  => $statusCounts,
            'active_count'   => array_sum($statusCounts),
            'receivable'     => $receivable,
            'overdue'        => $this->orders(['status' => 'overdue', 'limit' => 50]),
            'ready'          => $this->orders(['status' => 'ready', 'limit' => 50]),
            'low_stock'      => array_values(array_filter($this->inventory(), fn ($i) => $i['low'])),
        ];
    }

    /** Sales report for a date range. Payload {from, to} as YYYY-MM-DD (defaults: this month). */
    private function report(array $in): array
    {
        $now  = $this->now();
        $from = $this->validDate($in['from'] ?? '') ?: $now->format('Y-m-01');
        $to   = $this->validDate($in['to'] ?? '') ?: $now->format('Y-m-d');
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        $start = $this->dayStart($from);
        $end   = $this->dayStart($to, 1);

        // Collected per day (payments) + orders per day (intake)
        $days = [];
        for ($d = new DateTimeImmutable($from, $this->tz); $d->format('Y-m-d') <= $to; $d = $d->modify('+1 day')) {
            $days[$d->format('Y-m-d')] = ['date' => $d->format('Y-m-d'), 'collected' => 0.0, 'orders' => 0, 'billed' => 0.0, 'kg' => 0.0];
        }
        $stmt = $this->db->prepare('SELECT DATE(paid_at) AS d, SUM(amount) AS total FROM wh_payments WHERE paid_at >= ? AND paid_at < ? GROUP BY DATE(paid_at)');
        $stmt->execute([$start, $end]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $days[$r['d']]['collected'] = (float) $r['total'];
        }
        $stmt = $this->db->prepare('SELECT DATE(created_at) AS d, COUNT(*) AS n, SUM(total) AS billed, SUM(total_weight) AS kg FROM wh_orders WHERE created_at >= ? AND created_at < ? GROUP BY DATE(created_at)');
        $stmt->execute([$start, $end]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $days[$r['d']]['orders'] = (int) $r['n'];
            $days[$r['d']]['billed'] = (float) $r['billed'];
            $days[$r['d']]['kg']     = (float) $r['kg'];
        }

        // Revenue per service (based on orders received in the range)
        $stmt = $this->db->prepare('SELECT i.name, i.unit, SUM(i.qty) AS qty, SUM(i.line_total) AS revenue, COUNT(DISTINCT i.order_id) AS orders
                                    FROM wh_order_items i JOIN wh_orders o ON o.id = i.order_id
                                    WHERE o.created_at >= ? AND o.created_at < ?
                                    GROUP BY i.name, i.unit ORDER BY revenue DESC');
        $stmt->execute([$start, $end]);
        $services = array_map(fn ($r) => ['name' => $r['name'], 'unit' => $r['unit'], 'qty' => (float) $r['qty'], 'revenue' => (float) $r['revenue'], 'orders' => (int) $r['orders']], $stmt->fetchAll(PDO::FETCH_ASSOC));

        $stmt = $this->db->prepare('SELECT method, SUM(amount) AS total, COUNT(*) AS n FROM wh_payments WHERE paid_at >= ? AND paid_at < ? GROUP BY method');
        $stmt->execute([$start, $end]);
        $methods = array_map(fn ($r) => ['method' => $r['method'], 'total' => (float) $r['total'], 'count' => (int) $r['n']], $stmt->fetchAll(PDO::FETCH_ASSOC));

        $days      = array_values($days);
        $orders    = array_sum(array_column($days, 'orders'));
        $billed    = round(array_sum(array_column($days, 'billed')), 2);
        return [
            'from'      => $from,
            'to'        => $to,
            'days'      => $days,
            'services'  => $services,
            'methods'   => $methods,
            'totals'    => [
                'collected' => round(array_sum(array_column($days, 'collected')), 2),
                'billed'    => $billed,
                'orders'    => $orders,
                'kg'        => round(array_sum(array_column($days, 'kg')), 2),
                'average'   => $orders ? round($billed / $orders, 2) : 0,
            ],
        ];
    }

    // =====================================================================
    //  INVENTORY (shop supplies)
    // =====================================================================

    private function inventory(): array
    {
        $rows = $this->db->query('SELECT * FROM wh_inventory ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);
        return array_map(fn ($r) => [
            'id'            => (int) $r['id'],
            'name'          => $r['name'],
            'unit'          => $r['unit'],
            'stock'         => (float) $r['stock'],
            'reorder_level' => (float) $r['reorder_level'],
            'cost'          => (float) $r['cost'],
            'updated_at'    => $this->iso($r['updated_at']),
            'low'           => (float) $r['stock'] <= (float) $r['reorder_level'],
        ], $rows);
    }

    /** Create or edit a supply item. Stock is only set on create; use inventory_adjust after that. */
    private function saveInventoryItem(array $in): array
    {
        $name   = $this->requireText($in['name'] ?? '', 'Item name');
        $unit   = mb_substr(trim((string) ($in['unit'] ?? 'pcs')), 0, 20) ?: 'pcs';
        $level  = max(0, round((float) ($in['reorder_level'] ?? 0), 2));
        $cost   = max(0, round((float) ($in['cost'] ?? 0), 2));
        $now    = $this->dt($this->now());
        $id     = (int) ($in['id'] ?? 0);
        if ($id > 0) {
            $this->db->prepare('UPDATE wh_inventory SET name=?, unit=?, reorder_level=?, cost=?, updated_at=? WHERE id=?')
                ->execute([$name, $unit, $level, $cost, $now, $id]);
        } else {
            $stock = max(0, round((float) ($in['stock'] ?? 0), 2));
            $this->db->prepare('INSERT INTO wh_inventory (name, unit, stock, reorder_level, cost, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
                ->execute([$name, $unit, $stock, $level, $cost, $now]);
            $id = (int) $this->db->lastInsertId();
            if ($stock > 0) {
                $this->db->prepare('INSERT INTO wh_inventory_logs (item_id, change_qty, reason, created_at) VALUES (?, ?, ?, ?)')
                    ->execute([$id, $stock, 'Initial stock', $now]);
            }
        }
        return $this->inventory();
    }

    /** Stock in/out. Payload {id, change (+restock / -used), reason}. */
    private function adjustInventory(array $in): array
    {
        $id     = (int) ($in['id'] ?? 0);
        $change = round((float) ($in['change'] ?? 0), 2);
        if ($change == 0) {
            throw new InvalidArgumentException('Enter a quantity to add or remove.');
        }
        $stmt = $this->db->prepare('SELECT stock FROM wh_inventory WHERE id = ?');
        $stmt->execute([$id]);
        $stock = $stmt->fetchColumn();
        if ($stock === false) {
            throw new InvalidArgumentException('Item not found.');
        }
        if ((float) $stock + $change < 0) {
            throw new InvalidArgumentException('Not enough stock (only ' . (float) $stock . ' left).');
        }
        $now = $this->dt($this->now());
        $this->db->prepare('UPDATE wh_inventory SET stock = stock + ?, updated_at = ? WHERE id = ?')->execute([$change, $now, $id]);
        $this->db->prepare('INSERT INTO wh_inventory_logs (item_id, change_qty, reason, created_at) VALUES (?, ?, ?, ?)')
            ->execute([$id, $change, mb_substr(trim((string) ($in['reason'] ?? '')), 0, 120), $now]);
        return $this->inventory();
    }

    /** Latest stock movements (optionally for one item). */
    private function inventoryLogs(array $in): array
    {
        $id     = (int) ($in['id'] ?? 0);
        $stmt   = $this->db->prepare('SELECT l.*, i.name, i.unit FROM wh_inventory_logs l JOIN wh_inventory i ON i.id = l.item_id '
                . ($id ? 'WHERE l.item_id = ? ' : '') . 'ORDER BY l.id DESC LIMIT 100');
        $stmt->execute($id ? [$id] : []);
        return array_map(fn ($r) => [
            'item_id'    => (int) $r['item_id'],
            'name'       => $r['name'],
            'unit'       => $r['unit'],
            'change'     => (float) $r['change_qty'],
            'reason'     => $r['reason'],
            'created_at' => $this->iso($r['created_at']),
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    // =====================================================================
    //  SMALL HELPERS
    // =====================================================================

    private function now(): DateTimeImmutable
    {
        return new DateTimeImmutable('now', $this->tz);
    }

    /** DateTime -> 'Y-m-d H:i:s' for MySQL. */
    private function dt(DateTimeImmutable $d): string
    {
        return $d->format('Y-m-d H:i:s');
    }

    /** MySQL DATETIME string -> ISO 8601 with offset for JavaScript (null stays null). */
    private function iso($value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!$value instanceof DateTimeImmutable) {
            $value = new DateTimeImmutable((string) $value, $this->tz);
        }
        return $value->format(DATE_ATOM);
    }

    /** 'YYYY-MM-DD' (+ optional days) -> start of that day as a MySQL DATETIME string. */
    private function dayStart(string $date, int $addDays = 0): string
    {
        $date = $this->validDate($date);
        if (!$date) {
            throw new InvalidArgumentException('Invalid date.');
        }
        return $this->dt((new DateTimeImmutable($date, $this->tz))->modify("+$addDays days"));
    }

    private function validDate($value): ?string
    {
        return is_string($value) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) ? $value : null;
    }

    private function paymentStatus(float $paid, float $total): string
    {
        if ($paid <= 0 && $total > 0) {
            return 'unpaid';
        }
        return $paid + 0.001 >= $total ? 'paid' : 'partial';
    }

    private function paymentMethod($method): string
    {
        return in_array($method, self::PAYMENT_METHODS, true) ? $method : 'cash';
    }

    private function cleanPhone($phone): string
    {
        return mb_substr(preg_replace('/[^\d+]/', '', (string) $phone), 0, 30);
    }

    private function requireText($value, string $label): string
    {
        $value = trim((string) $value);
        if ($value === '') {
            throw new InvalidArgumentException("$label is required.");
        }
        return mb_substr($value, 0, 100);
    }
}
