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
    /** Status names as shown on screen (used in the Trash list). */
    private const STATUS_NAMES = ['received' => 'Received', 'washing' => 'Washing', 'drying' => 'Drying', 'ready' => 'Folding / Ready', 'completed' => 'Picked Up / Delivered'];

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
        'inventory_delete' => ['admin'],  // remove a supply item that's no longer used
        'service_save'    => ['admin'],
        'service_delete'   => ['admin'],
        'settings_save'    => ['admin'],
        'users'            => ['admin'],
        'user_save'        => ['admin'],
        'user_delete'      => ['admin'],
        // Owner / Admin only: deleting history
        'history_delete'       => ['admin'],  // finished orders in a date range
        'customer_delete'      => ['admin'],  // a customer + all their orders
        'customer_loyalty' => ['admin'],      // change a customer's loyalty card by hand
        'loyalty_card_save' => ['admin'],     // Loyalty Card page form (e.g. copy a paper card)
        'inventory_logs_clear' => ['admin'],  // the stock movement log
        // Shop Owner only (an Owner / Admin account that also has the ★ Shop Owner mark, see OWNER_ONLY)
        'activity_log'     => ['admin'],  // who did what and when
        'owner_transfer'   => ['admin'],  // hand the Shop Owner mark to another Owner / Admin
        // Trash (soft-deleted records)
        'trash'            => ['admin'],  // see what was deleted
        'trash_restore'    => ['admin'],  // bring it back
        'trash_purge'      => ['admin'],  // delete forever (Shop Owner only, see OWNER_ONLY)
    ];

    /**
     * Actions that need the ★ Shop Owner mark on top of the Owner / Admin role.
     * There is exactly one Shop Owner (wh_users.is_owner = 1). Other admins can't use these.
     */
    public const OWNER_ONLY = ['activity_log', 'owner_transfer', 'trash_purge'];

    /**
     * SOFT DELETE: these tables have a deleted_at column.
     *   deleted_at = NULL  -> the row is active and shows on the screens
     *   deleted_at = date  -> the row was "deleted": it is hidden but still in the database (Trash)
     * Deleting = UPDATE ... SET deleted_at = NOW()     Restoring = UPDATE ... SET deleted_at = NULL
     * Every screen reads only rows WHERE deleted_at IS NULL.
     * A real DELETE happens only with "Delete forever" in the Trash (Shop Owner only).
     */
    public const SOFT_DELETE_TABLES = ['wh_services', 'wh_customers', 'wh_orders', 'wh_inventory', 'wh_inventory_logs', 'wh_users'];

    /** Payments that count in sales: only those whose order is NOT in the Trash. Used in FROM ... as alias "p". */
    private const LIVE_PAYMENTS = 'wh_payments p JOIN wh_orders po ON po.id = p.order_id AND po.deleted_at IS NULL';

    /** Trash tabs: type name used by the API => its table. */
    private const TRASH_TYPES = [
        'orders'     => 'wh_orders',
        'customers'  => 'wh_customers',
        'services'   => 'wh_services',
        'inventory'  => 'wh_inventory',
        'stock_logs' => 'wh_inventory_logs',
        'users'      => 'wh_users',
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
        'shop_address'  => 'Lot 3, Blk 14 E, Phase 3C, Tamban St., Kaunlaran Vill., Caloocan City',
        'shop_phone'    => 'Smart: 0920 890 3787 · Globe: 0915 779 6070',
        'pickup_terms'  => 'Present this claim ticket when picking up. Items unclaimed after 30 days will be donated. '
                         . 'Gap Wash Hub is not liable for color bleeding, shrinkage, or items left in pockets. '
                         . 'Please check your items before leaving the counter.',
        'sms_template'  => 'Hi {name}! Your laundry ({code}) at {shop} is ready for pickup. Balance due: {balance}. Thank you!',
        // Web address the QR code on tickets points to (blank = the address the app is opened with)
        'public_url'    => '',
        // Loyalty card: every N ticks (1 tick = 1 load) gives a reward. Default: 14-box card, FREE at box 7 and 14.
        'loyalty_enabled'      => '1',          // '1' = on, '0' = off
        'loyalty_card_size'    => '14',         // boxes on one card
        'loyalty_free_every'   => '7',          // every 7th box is FREE
        'loyalty_reward'       => 'free_load',  // free_load = cheapest load in the order is free | amount = ₱ off | percent = % off
        'loyalty_reward_value' => '0',          // the ₱ or % for "amount" / "percent"
        'loyalty_mode'         => 'save',       // save = FREE is saved as "FREE available", the cashier uses it later
                                                // auto = FREE is used right away on the order that reaches the box
    ];

    /**
     * Starter price list = the shop's paper order form (Gap Wash Hub Laundry Form).
     * Prices are per load / per item, so every unit is "pc" (quantity).
     * name, unit, price (PHP), turnaround hours, is express, tile color, earns a loyalty tick (1/0: add-ons don't)
     */
    public const DEFAULT_SERVICES = [
        ['Wash',                       'pc', 65,  24, 0, 'blue', 1],
        ['Wash & Dry',                 'pc', 130, 24, 0, 'blue', 1],
        ['Dry',                        'pc', 80,  24, 0, 'amber', 1],
        ['Dry & Fold',                 'pc', 100, 24, 0, 'amber', 1],
        ['Wash, Dry, & Fold',          'pc', 150, 24, 0, 'teal', 1],
        ['Spin & Dry',                 'pc', 100, 24, 0, 'teal', 1],
        ['Package A',                  'pc', 180, 24, 0, 'violet', 1],
        ['Package B',                  'pc', 200, 24, 0, 'violet', 1],
        ['Package C',                  'pc', 220, 24, 0, 'violet', 1],
        ['Addt Detergent',             'pc', 15,  24, 0, 'green', 0],
        ['Addt Fabcon',                'pc', 15,  24, 0, 'green', 0],
        ['Over 8 kilos (Wash & Dry)',  'pc', 40,  24, 0, 'pink', 0],
        ['Over 8 kilos (Wash or Dry)', 'pc', 20,  24, 0, 'pink', 0],
        ['Blue Plastic',               'pc', 12,  24, 0, 'slate', 0],
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
        // Owner protection: some actions need the ★ Shop Owner mark, not just the Owner / Admin role
        if (in_array($action, self::OWNER_ONLY, true) && empty($this->user['is_owner'])) {
            throw new InvalidArgumentException('Only the Shop Owner can do this.');
        }
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
            case 'owner_transfer':   return $this->transferOwner($in);
            case 'activity_log':     return $this->activityLog($in);
            // --- settings & price list ---
            case 'settings_save':    return $this->saveSettings($in);
            case 'service_save':     return $this->saveService($in);
            case 'service_delete':   return $this->deleteService((int) ($in['id'] ?? 0));
            // --- customers ---
            case 'customers':        return $this->customers($in);
            case 'customer_save':    return $this->saveCustomer($in);
            case 'customer_delete':  return $this->deleteCustomer((int) ($in['id'] ?? 0));
            case 'customer_loyalty': return $this->setCustomerLoyalty($in);
            case 'loyalty_card_save': return $this->saveLoyaltyCard($in);
            // --- deleting history ---
            case 'history_delete':       return $this->deleteHistory($in);
            case 'inventory_logs_clear': return $this->clearInventoryLogs();
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
            case 'inventory_delete': return $this->deleteInventoryItem((int) ($in['id'] ?? 0));
            // --- trash (soft delete) ---
            case 'trash':            return $this->trash();
            case 'trash_restore':    return $this->restoreFromTrash($in);
            case 'trash_purge':      return $this->purgeFromTrash($in);
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
                sort_order       INT NOT NULL DEFAULT 0,
                loyalty          TINYINT(1) NOT NULL DEFAULT 1,   -- 1 = each load earns a loyalty tick (add-ons: 0)
                deleted_at       DATETIME NULL DEFAULT NULL   -- soft delete: NULL = active, date = in Trash
            ) $opts",

            "CREATE TABLE IF NOT EXISTS wh_customers (
                id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name       VARCHAR(100) NOT NULL,
                phone      VARCHAR(30)  NOT NULL DEFAULT '',
                address    VARCHAR(255) NOT NULL DEFAULT '',
                notes      VARCHAR(255) NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                loyalty_ticks INT UNSIGNED NOT NULL DEFAULT 0,   -- loyalty card: total ticks so far (over all cards)
                loyalty_free_used INT UNSIGNED NOT NULL DEFAULT 0,  -- FREE rewards already used (earned - used = available)
                deleted_at DATETIME NULL DEFAULT NULL,   -- soft delete
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
                loyalty_ticks     INT UNSIGNED  NOT NULL DEFAULT 0,  -- ticks this order earned
                loyalty_counted   TINYINT(1)    NOT NULL DEFAULT 0,  -- 1 = those ticks are in the customer's total
                loyalty_rewards   INT UNSIGNED  NOT NULL DEFAULT 0,  -- FREE boxes this order reached
                loyalty_discount  DECIMAL(10,2) NOT NULL DEFAULT 0,  -- peso value of the loyalty reward
                loyalty_after     INT UNSIGNED  NULL,                -- customer's total ticks after this order (for the ticket)
                deleted_at        DATETIME NULL DEFAULT NULL,   -- soft delete
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
                updated_at    DATETIME NOT NULL,
                deleted_at    DATETIME NULL DEFAULT NULL   -- soft delete
            ) $opts",

            // Stock movements: positive = restock, negative = used/damaged
            "CREATE TABLE IF NOT EXISTS wh_inventory_logs (
                id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                item_id    INT UNSIGNED NOT NULL,
                change_qty DECIMAL(10,2) NOT NULL,
                reason     VARCHAR(120) NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                deleted_at DATETIME NULL DEFAULT NULL,   -- soft delete (Clear history button)
                CONSTRAINT fk_invlog_item FOREIGN KEY (item_id) REFERENCES wh_inventory(id) ON DELETE CASCADE
            ) $opts",
                // Staff accounts that can log in. "role" decides what each person may do.
            "CREATE TABLE IF NOT EXISTS wh_users (
                id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                username      VARCHAR(50)  NOT NULL UNIQUE,
                full_name     VARCHAR(100) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role          ENUM('admin','staff') NOT NULL DEFAULT 'staff',
                is_owner      TINYINT(1) NOT NULL DEFAULT 0,   -- 1 = the ★ Shop Owner (exactly one account)
                active        TINYINT(1) NOT NULL DEFAULT 1,
                created_at    DATETIME NOT NULL,
                last_login_at DATETIME NULL,
                deleted_at    DATETIME NULL DEFAULT NULL   -- soft delete (a deleted account can't log in)
            ) $opts",

            // Activity log: who did what and when (logins, account changes, deletions).
            // No foreign key on purpose: the record stays even after that user account is deleted.
            // The app has no action to edit or delete these rows.
            "CREATE TABLE IF NOT EXISTS wh_activity_logs (
                id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                user_id    INT UNSIGNED NULL,
                user_name  VARCHAR(160) NOT NULL DEFAULT '',
                action     VARCHAR(40)  NOT NULL,
                details    VARCHAR(255) NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                INDEX idx_activity_time (created_at)
            ) $opts",

        ];
    }

    /** Creates missing tables and inserts starter data. Safe to run many times. */
    public function install(): void
    {
        foreach (self::schema() as $sql) {
            $this->db->exec($sql);
        }

        // Upgrade for databases made before soft delete existed: add the deleted_at column
        foreach (self::SOFT_DELETE_TABLES as $table) {
            if (!$this->db->query("SHOW COLUMNS FROM $table LIKE 'deleted_at'")->fetch()) {
                $this->db->exec("ALTER TABLE $table ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL");
            }
        }

        // Upgrade for databases made before the loyalty card existed
        if (!$this->db->query("SHOW COLUMNS FROM wh_services LIKE 'loyalty'")->fetch()) {
            $this->db->exec('ALTER TABLE wh_services ADD COLUMN loyalty TINYINT(1) NOT NULL DEFAULT 1');
            // the starter add-ons (detergent, fabcon, over 8 kilos, plastic) don't earn ticks
            $addOns = array_column(array_filter(self::DEFAULT_SERVICES, fn ($s) => !$s[6]), 0);
            $this->db->prepare('UPDATE wh_services SET loyalty = 0 WHERE name IN (' . implode(',', array_fill(0, count($addOns), '?')) . ')')->execute($addOns);
        }
        foreach ([
            ['wh_customers', 'loyalty_ticks',    'INT UNSIGNED NOT NULL DEFAULT 0'],
            ['wh_orders',    'loyalty_ticks',    'INT UNSIGNED NOT NULL DEFAULT 0'],
            ['wh_orders',    'loyalty_counted',  'TINYINT(1) NOT NULL DEFAULT 0'],
            ['wh_orders',    'loyalty_rewards',  'INT UNSIGNED NOT NULL DEFAULT 0'],
            ['wh_orders',    'loyalty_discount', 'DECIMAL(10,2) NOT NULL DEFAULT 0'],
            ['wh_orders',    'loyalty_after',    'INT UNSIGNED NULL'],
        ] as [$table, $column, $type]) {
            if (!$this->db->query("SHOW COLUMNS FROM $table LIKE '$column'")->fetch()) {
                $this->db->exec("ALTER TABLE $table ADD COLUMN $column $type");
            }
        }
        if (!$this->db->query("SHOW COLUMNS FROM wh_customers LIKE 'loyalty_free_used'")->fetch()) {
            $this->db->exec('ALTER TABLE wh_customers ADD COLUMN loyalty_free_used INT UNSIGNED NOT NULL DEFAULT 0');
            // FREE rewards already given on earlier orders count as used
            $this->db->exec('UPDATE wh_customers c SET loyalty_free_used = (SELECT COALESCE(SUM(o.loyalty_rewards), 0) FROM wh_orders o
                             WHERE o.customer_id = c.id AND o.loyalty_counted = 1)');
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

        // Replace the old placeholder address and phone with the shop's real ones (only if never edited)
        $this->db->prepare("UPDATE wh_settings SET svalue = ? WHERE skey = 'shop_address' AND svalue = 'Shop address, City'")
            ->execute([self::DEFAULT_SETTINGS['shop_address']]);
        $this->db->prepare("UPDATE wh_settings SET svalue = ? WHERE skey = 'shop_phone' AND svalue = '0900 000 0000'")
            ->execute([self::DEFAULT_SETTINGS['shop_phone']]);

        // Rebrand "Wash Hub" -> "Gap Wash Hub", but only where the old default text was never changed
        $this->db->prepare("UPDATE wh_settings SET svalue = ? WHERE skey = 'shop_name' AND svalue = 'Wash Hub'")
            ->execute([self::DEFAULT_SETTINGS['shop_name']]);
        $this->db->prepare("UPDATE wh_settings SET svalue = ? WHERE skey = 'pickup_terms' AND svalue = ?")
            ->execute([self::DEFAULT_SETTINGS['pickup_terms'], str_replace('Gap Wash Hub', 'Wash Hub', self::DEFAULT_SETTINGS['pickup_terms'])]);

        // Replace the OLD starter price list (per-kg Wash-Dry-Fold etc.) with the shop's real price list.
        // The old services are deleted. Past orders are not affected: each order line keeps its own
        // copy of the service name and price (see wh_order_items).
        $oldStarter = "(name = 'Wash-Dry-Fold' AND unit = 'kg' AND price = 35)
                    OR (name = 'Dry Cleaning' AND unit = 'pc' AND price = 180)
                    OR (name = 'Ironing / Pressing' AND unit = 'pc' AND price = 20)
                    OR (name = 'Comforter / Blanket' AND unit = 'pc' AND price = 150)
                    OR (name = 'Express Add-on (Same Day)' AND unit = 'flat' AND price = 60)";
        // Runs only once per database (remembered in wh_settings), so services added later are never touched
        $done = (int) $this->db->query("SELECT COUNT(*) FROM wh_settings WHERE skey = 'upgrade_price_list'")->fetchColumn();
        if (!$done) {
            if ((int) $this->db->query("SELECT COUNT(*) FROM wh_services WHERE $oldStarter")->fetchColumn() > 0) {
                $this->db->exec("DELETE FROM wh_services WHERE $oldStarter");
                if ((int) $this->db->query("SELECT COUNT(*) FROM wh_services WHERE name = 'Wash'")->fetchColumn() === 0) {
                    $this->insertDefaultServices();
                }
            }
            $this->db->exec("INSERT IGNORE INTO wh_settings (skey, svalue) VALUES ('upgrade_price_list', 'done')");
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
        if (!$this->db->query("SHOW COLUMNS FROM wh_users LIKE 'is_owner'")->fetch()) {
            $this->db->exec('ALTER TABLE wh_users ADD COLUMN is_owner TINYINT(1) NOT NULL DEFAULT 0 AFTER role');
        }
        if ((int) $this->db->query('SELECT COUNT(*) FROM wh_users')->fetchColumn() === 0) {
            $this->db->prepare('INSERT INTO wh_users (username, full_name, password_hash, role, is_owner, created_at) VALUES (?, ?, ?, ?, 1, ?)')
                ->execute(['owner', 'Shop Owner', password_hash('owner123', PASSWORD_DEFAULT), 'admin', $this->dt($this->now())]);
        }
        // There must always be one ★ Shop Owner. If there is none (older database, or the owner row
        // was removed in phpMyAdmin), the oldest active Owner / Admin account becomes the Shop Owner.
        if ((int) $this->db->query('SELECT COUNT(*) FROM wh_users WHERE is_owner = 1')->fetchColumn() === 0) {
            $this->db->exec("UPDATE wh_users SET is_owner = 1 WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1");
        }
    }

    /** Adds the shop's price list (DEFAULT_SERVICES), in the same order as the paper form. */
    private function insertDefaultServices(): void
    {
        $stmt = $this->db->prepare('INSERT INTO wh_services (name, unit, price, turnaround_hours, is_express, color, loyalty, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
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

        $stmt = $this->db->prepare('SELECT * FROM wh_users WHERE username = ? AND deleted_at IS NULL'); // deleted accounts can't log in
        $stmt->execute([$username]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        // Same message for "no such user" and "wrong password", so nobody can find out which usernames exist
        // Failed attempts are written to the activity log with the username typed (NEVER the password).
        // No person is named as "who": anyone at the counter could have typed it.
        if (!$user || !password_verify($password, $user['password_hash'])) {
            $this->record('login_failed', ($user ? 'Wrong password' : 'Unknown username') . ' · username typed: ' . mb_substr($username, 0, 60), []);
            throw new InvalidArgumentException('Wrong username or password.');
        }
        if (!$user['active']) {
            $this->record('login_failed', "Disabled account · username typed: {$user['username']}", []);
            throw new InvalidArgumentException('This account is disabled. Please ask the Owner / Admin.');
        }

        $this->db->prepare('UPDATE wh_users SET last_login_at = ? WHERE id = ?')
            ->execute([$this->dt($this->now()), $user['id']]);
        $this->record('login', 'Logged in', $user);

        return $this->publicUser($user);
    }

    /**
     * Reloads a logged-in user from the database (called on every request).
     * Returns null if the account was deleted or disabled, which logs them out.
     * This makes a role change by the Owner / Admin take effect right away.
     */
    public function freshUser(int $id): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM wh_users WHERE id = ? AND active = 1 AND deleted_at IS NULL');
        $stmt->execute([$id]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        return $user ? $this->publicUser($user) : null;
    }

    /** The actions the current user may use. The screen uses this list to hide what they can't do. */
    private function myPermissions(): array
    {
        $role    = $this->user['role'] ?? null;
        $isOwner = !empty($this->user['is_owner']);
        return array_values(array_filter(array_keys(self::PERMISSIONS), fn ($action) =>
            self::allowed($role, $action) && ($isOwner || !in_array($action, self::OWNER_ONLY, true))));
    }

    /** Owner / Admin only: list every account (never the password hashes). The Shop Owner is listed first. */
    private function users(): array
    {
        $rows = $this->db->query("SELECT * FROM wh_users WHERE deleted_at IS NULL ORDER BY is_owner DESC, FIELD(role, 'admin', 'staff'), full_name")
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
        // Load the account as it is now (to check the owner rules and to log what changed)
        $old = null;
        if ($id > 0) {
            $stmt = $this->db->prepare('SELECT * FROM wh_users WHERE id = ? AND deleted_at IS NULL');
            $stmt->execute([$id]);
            $old = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
            if (!$old) {
                throw new InvalidArgumentException('User not found.');
            }
        }
        // Owner protection: an admin who is NOT the Shop Owner may only manage Staff accounts.
        // (Editing your own account is fine; the rule above already stops you changing your own role.)
        $isSelf = $id > 0 && $id === (int) ($this->user['id'] ?? 0);
        if (!$isSelf && empty($this->user['is_owner'])) {
            if ($old && $old['role'] === 'admin') {
                throw new InvalidArgumentException('Only the Shop Owner can change another Owner / Admin account.');
            }
            if ($role === 'admin') {
                throw new InvalidArgumentException('Only the Shop Owner can add an Owner / Admin or promote someone to Owner / Admin.');
            }
        }
        if ($id === 0 && $password === '') {
            throw new InvalidArgumentException('Set a password for the new account.');
        }
        if ($password !== '') {
            $this->checkNewPassword($password);
        }
        $this->assertUsernameFree($username, $id);

        // Activity log: write down exactly what changed (never the password itself)
        if ($old) {
            $changes = [];
            if ($old['full_name'] !== $fullName) { $changes[] = "name \"{$old['full_name']}\" → \"$fullName\""; }
            if ($old['username'] !== $username)  { $changes[] = "username {$old['username']} → $username"; }
            if ($old['role'] !== $role)          { $changes[] = 'role ' . self::roleName($old['role']) . ' → ' . self::roleName($role); }
            if ((int) $old['active'] !== $active) { $changes[] = $active ? 'enabled the account again' : 'disabled the account'; }
            if ($password !== '')                { $changes[] = 'reset the password'; }
            $log = $changes ? ['user_edit', "$fullName ($username): " . implode(', ', $changes)] : null;
        } else {
            $log = ['user_add', "$fullName ($username) as " . self::roleName($role) . ($active ? '' : ', disabled')];
        }

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
        if ($log) {
            $this->record(...$log);   // written only after the save worked
        }
        return $this->users();
    }

    /**
     * Owner / Admin only: delete an account (SOFT delete: it goes to the Trash and can no longer log in). Payload {id}.
     * You can't delete your own account (so the shop always keeps an Owner / Admin).
     * Owner protection: nobody can delete the ★ Shop Owner, and only the Shop Owner can delete another Owner / Admin.
     */
    private function deleteUser(int $id): array
    {
        if ($id === (int) ($this->user['id'] ?? 0)) {
            throw new InvalidArgumentException("You can't delete your own account.");
        }
        $stmt = $this->db->prepare('SELECT * FROM wh_users WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$id]);
        $target = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$target) {
            throw new InvalidArgumentException('User not found.');
        }
        if ($target['is_owner']) {
            throw new InvalidArgumentException("The Shop Owner's account can't be deleted.");
        }
        if ($target['role'] === 'admin' && empty($this->user['is_owner'])) {
            throw new InvalidArgumentException('Only the Shop Owner can delete another Owner / Admin account.');
        }
        $this->softDelete('wh_users', $id);
        $this->record('user_delete', "{$target['full_name']} ({$target['username']}), " . self::roleName($target['role']));
        return $this->users();
    }

    /**
     * Shop Owner only: hand the ★ Shop Owner mark to another active Owner / Admin. Payload {id, password}.
     * Asks for the owner's own password again, so nobody can do this on an unlocked screen.
     * Afterwards the old owner is a normal Owner / Admin (and the new owner could remove them).
     */
    private function transferOwner(array $in): array
    {
        $stmt = $this->db->prepare('SELECT * FROM wh_users WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([(int) ($this->user['id'] ?? 0)]);
        $me = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$me || !password_verify((string) ($in['password'] ?? ''), $me['password_hash'])) {
            throw new InvalidArgumentException('Your password is incorrect.');
        }
        $id = (int) ($in['id'] ?? 0);
        if ($id === (int) $me['id']) {
            throw new InvalidArgumentException('You are already the Shop Owner.');
        }
        $stmt->execute([$id]);
        $target = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$target) {
            throw new InvalidArgumentException('User not found.');
        }
        if ($target['role'] !== 'admin' || !$target['active']) {
            throw new InvalidArgumentException('Only an active Owner / Admin account can become the Shop Owner.');
        }
        // One statement, so there is never a moment with zero or two owners
        $this->db->prepare('UPDATE wh_users SET is_owner = CASE WHEN id = ? THEN 1 ELSE 0 END')->execute([$id]);
        $this->record('owner_transfer', "Shop Owner handed over from {$me['full_name']} ({$me['username']}) to {$target['full_name']} ({$target['username']})");
        return $this->users();
    }

    /** Shop Owner only: the latest activity log entries, newest first. Payload {limit?} (default 300, max 1000). */
    private function activityLog(array $in): array
    {
        $limit = max(1, min(1000, (int) ($in['limit'] ?? 300)));
        $rows  = $this->db->query("SELECT * FROM wh_activity_logs ORDER BY id DESC LIMIT $limit")->fetchAll(PDO::FETCH_ASSOC);
        return array_map(fn ($r) => [
            'id'         => (int) $r['id'],
            'user_id'    => $r['user_id'] === null ? null : (int) $r['user_id'],
            'user_name'  => $r['user_name'],
            'action'     => $r['action'],
            'details'    => $r['details'],
            'created_at' => $this->iso($r['created_at']),
        ], $rows);
    }

    /**
     * Writes one line to the activity log. $who = the person doing it (default: the logged-in user; [] = nobody).
     * Their name is copied into the row, so the record still makes sense after the account is deleted.
     */
    private function record(string $action, string $details = '', ?array $who = null): void
    {
        $who = $who ?? $this->user;
        $this->db->prepare('INSERT INTO wh_activity_logs (user_id, user_name, action, details, created_at) VALUES (?, ?, ?, ?, ?)')
            ->execute([
                $who['id'] ?? null,
                $who ? mb_substr("{$who['full_name']} ({$who['username']})", 0, 160) : '',
                $action,
                mb_substr($details, 0, 255),
                $this->dt($this->now()),
            ]);
    }

    /** 'admin' -> 'Owner / Admin', 'staff' -> 'Staff' (for log messages). */
    private static function roleName(string $role): string
    {
        return $role === 'admin' ? 'Owner / Admin' : 'Staff';
    }

    /** 1234.5 -> '₱1,234.50' (for log messages). */
    private static function peso($amount): string
    {
        return '₱' . number_format((float) $amount, 2);
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

        // Activity log (My Account changes)
        $changes = [];
        if ($me['full_name'] !== $fullName) { $changes[] = "name \"{$me['full_name']}\" → \"$fullName\""; }
        if ($me['username'] !== $username)  { $changes[] = "username {$me['username']} → $username"; }
        if ($newPassword !== '')            { $changes[] = 'changed own password'; }
        if ($changes) {
            $this->record('account_edit', implode(', ', $changes), ['id' => $me['id'], 'full_name' => $fullName, 'username' => $username]);
        }
        return $this->freshUser((int) $me['id']);
    }

    /** The safe part of a user row: what the browser may see (no password hash). */
    private function publicUser(array $u): array
    {
        return [
            'id'        => (int) $u['id'],
            'username'  => $u['username'],
            'full_name' => $u['full_name'],
            'role'      => $u['role'],
            'is_owner'  => !empty($u['is_owner']),   // the ★ Shop Owner
        ];
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

    /**
     * Usernames must be unique. $exceptId = the account being edited (it may keep its own name).
     * A deleted account in the Trash still keeps its username (so it can be restored).
     */
    private function assertUsernameFree(string $username, int $exceptId): void
    {
        $stmt = $this->db->prepare('SELECT deleted_at FROM wh_users WHERE username = ? AND id <> ?');
        $stmt->execute([$username, $exceptId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row && $row['deleted_at'] !== null) {
            throw new InvalidArgumentException('That username belongs to a deleted account in the Trash. Restore that account, or choose another username.');
        }
        if ($row) {
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
        // Loyalty card settings must be sensible numbers
        if (isset($in['loyalty_card_size']) || isset($in['loyalty_free_every'])) {
            $size  = (int) ($in['loyalty_card_size'] ?? $this->settings()['loyalty_card_size']);
            $every = (int) ($in['loyalty_free_every'] ?? $this->settings()['loyalty_free_every']);
            if ($size < 2 || $size > 50) {
                throw new InvalidArgumentException('A loyalty card must have 2 to 50 boxes.');
            }
            if ($every < 1 || $every > $size) {
                throw new InvalidArgumentException("The FREE box must be between 1 and $size.");
            }
        }
        if (isset($in['loyalty_mode']) && !in_array($in['loyalty_mode'], ['save', 'auto'], true)) {
            throw new InvalidArgumentException('Choose when a FREE reward is used.');
        }
        if (isset($in['loyalty_reward']) && !in_array($in['loyalty_reward'], ['free_load', 'amount', 'percent'], true)) {
            throw new InvalidArgumentException('Choose a loyalty reward.');
        }
        if (isset($in['loyalty_reward_value'])) {
            $in['loyalty_reward_value'] = (string) max(0, round((float) $in['loyalty_reward_value'], 2));
        }
        if (isset($in['loyalty_enabled'])) {
            $in['loyalty_enabled'] = empty($in['loyalty_enabled']) || $in['loyalty_enabled'] === '0' ? '0' : '1';
        }

        $this->loyaltyCfg = null;   // the loyalty settings may change
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
        $rows = $this->db->query('SELECT * FROM wh_services WHERE deleted_at IS NULL ORDER BY sort_order, id')->fetchAll(PDO::FETCH_ASSOC);
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
            'loyalty'          => (bool) $r['loyalty'],   // earns loyalty ticks
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
            !isset($in['loyalty']) || $in['loyalty'] ? 1 : 0,   // earns loyalty ticks (default yes)
        ];
        $id = (int) ($in['id'] ?? 0);
        if ($id > 0) {
            $this->db->prepare('UPDATE wh_services SET name=?, unit=?, price=?, turnaround_hours=?, is_express=?, color=?, active=?, sort_order=?, loyalty=? WHERE id=? AND deleted_at IS NULL')
                ->execute([...$data, $id]);
        } else {
            $this->db->prepare('INSERT INTO wh_services (name, unit, price, turnaround_hours, is_express, color, active, sort_order, loyalty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute($data);
        }
        return $this->services();
    }

    /**
     * Owner / Admin: remove a service from the price list (soft delete -> Trash). Payload {id}.
     * Past orders are not affected: each order line keeps its own copy of the name and price.
     */
    private function deleteService(int $id): array
    {
        $stmt = $this->db->prepare('SELECT name, price FROM wh_services WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$id]);
        $svc = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$svc) {
            throw new InvalidArgumentException('Service not found.');
        }
        $this->softDelete('wh_services', $id);
        $this->record('service_delete', "{$svc['name']} (" . self::peso($svc['price']) . ')');
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
        $where  = 'WHERE c.deleted_at IS NULL';   // soft delete: hide customers in the Trash
        $params = [];
        if ($q !== '') {
            $where .= ' AND (c.name LIKE ? OR c.phone LIKE ?)';
            $params = ["%$q%", '%' . preg_replace('/\s+/', '', $q) . '%'];
        }
        // GROUP BY lists every column so it also works with ONLY_FULL_GROUP_BY (Laravel strict mode)
        // Order totals only count orders that are not in the Trash
        if (!empty($in['loyalty_only'])) {   // Loyalty Card page: only customers who have a card going
            $where .= ' AND (c.loyalty_ticks > 0 OR c.loyalty_free_used > 0)';
        }
        $sql = "SELECT c.id, c.name, c.phone, c.address, c.notes, c.created_at, c.loyalty_ticks, c.loyalty_free_used,
                       COUNT(o.id) AS order_count, MAX(o.created_at) AS last_order_at, COALESCE(SUM(o.total), 0) AS total_spent
                FROM wh_customers c
                LEFT JOIN wh_orders o ON o.customer_id = c.id AND o.deleted_at IS NULL
                $where
                GROUP BY c.id, c.name, c.phone, c.address, c.notes, c.created_at, c.loyalty_ticks, c.loyalty_free_used
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
        ] + $this->loyaltySummary($r), $stmt->fetchAll(PDO::FETCH_ASSOC));
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
            $this->db->prepare('UPDATE wh_customers SET name=?, phone=?, address=?, notes=? WHERE id=? AND deleted_at IS NULL')->execute([...$fields, $id]);
        } else {
            $this->db->prepare('INSERT INTO wh_customers (name, phone, address, notes, created_at) VALUES (?, ?, ?, ?, ?)')
                ->execute([...$fields, $this->dt($this->now())]);
            $id = (int) $this->db->lastInsertId();
        }
        $stmt = $this->db->prepare('SELECT * FROM wh_customers WHERE id = ?');
        $stmt->execute([$id]);
        $c = $stmt->fetch(PDO::FETCH_ASSOC);
        return ['id' => (int) $c['id'], 'name' => $c['name'], 'phone' => $c['phone'], 'address' => $c['address'], 'notes' => $c['notes']]
             + $this->loyaltySummary($c);
    }

    /** Used by createOrder: picks an existing customer or creates a new one. */
    private function resolveCustomer(array $c): int
    {
        $id = (int) ($c['id'] ?? 0);
        if ($id > 0) {
            $stmt = $this->db->prepare('SELECT id FROM wh_customers WHERE id = ? AND deleted_at IS NULL');
            $stmt->execute([$id]);
            if ($stmt->fetchColumn()) {
                return $id;
            }
        }
        // Same phone number = same customer (avoids duplicate profiles). Customers in the Trash are skipped.
        $phone = $this->cleanPhone($c['phone'] ?? '');
        if ($phone !== '') {
            $stmt = $this->db->prepare('SELECT id FROM wh_customers WHERE phone = ? AND deleted_at IS NULL LIMIT 1');
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
        $where  = ['o.deleted_at IS NULL'];   // soft delete: orders in the Trash never show
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
        $sql   = 'SELECT o.*, c.name AS c_name, c.phone AS c_phone, c.address AS c_address, c.notes AS c_notes, c.loyalty_ticks AS c_ticks, c.loyalty_free_used AS c_free_used
                  FROM wh_orders o JOIN wh_customers c ON c.id = o.customer_id '
               . ($where ? 'WHERE ' . implode(' AND ', $where) : '')
               . " ORDER BY o.created_at DESC LIMIT $limit";
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return $this->hydrateOrders($stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    private function order(int $id): array
    {
        $stmt = $this->db->prepare('SELECT o.*, c.name AS c_name, c.phone AS c_phone, c.address AS c_address, c.notes AS c_notes, c.loyalty_ticks AS c_ticks, c.loyalty_free_used AS c_free_used
                                    FROM wh_orders o JOIN wh_customers c ON c.id = o.customer_id WHERE o.id = ? AND o.deleted_at IS NULL');
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
        $loyaltyLines = [];   // the same lines, for the loyalty card math
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
            $loyaltyLines[] = ['unit' => $svc['unit'], 'qty' => $qty, 'price' => $svc['price'], 'loyalty' => $svc['loyalty']];
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

                // --- loyalty card: ticks this order earns, and the reward if it reaches a FREE box ---
                // (FOR UPDATE locks the customer row, so two counters can't both use the same FREE box)
                $stmt = $this->db->prepare('SELECT loyalty_ticks, loyalty_free_used FROM wh_customers WHERE id = ? FOR UPDATE');
                $stmt->execute([$customerId]);
                $card = $stmt->fetch(PDO::FETCH_ASSOC);
                $loyalty = $this->loyaltyPlan((int) $card['loyalty_ticks'], (int) $card['loyalty_free_used'],
                    $in['loyalty_ticks'] ?? null, $in['loyalty_use_free'] ?? 0, $loyaltyLines, $subtotal, $discount);

                $total = round($subtotal - $discount - $loyalty['discount'], 2);
                $paid  = min(max(round((float) ($in['payment']['amount'] ?? 0), 2), 0), $total);
                $code  = $this->nextOrderCode($now);
                $this->db->prepare('INSERT INTO wh_orders
                        (code, track_token, customer_id, status, fulfillment, is_express, total_weight, subtotal, discount, total,
                         amount_paid, payment_status, notes, created_at, ready_at, status_updated_at,
                         loyalty_ticks, loyalty_counted, loyalty_rewards, loyalty_discount, loyalty_after)
                        VALUES (?, ?, ?, \'received\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
                    ->execute([$code, $this->newToken(), $customerId, $fulfil, $express ? 1 : 0, round($weight, 2), $subtotal, $discount, $total,
                               $paid, $this->paymentStatus($paid, $total), $notes, $this->dt($now), $this->dt($readyAt), $this->dt($now),
                               $loyalty['ticks'], $loyalty['used'], $loyalty['discount'], $loyalty['after']]);
                $orderId = (int) $this->db->lastInsertId();
                $this->db->prepare('UPDATE wh_customers SET loyalty_ticks = ?, loyalty_free_used = loyalty_free_used + ? WHERE id = ?')
                    ->execute([$loyalty['after'], $loyalty['used'], $customerId]);
                if ($loyalty['ticks'] !== $loyalty['auto']) {
                    // the cashier changed the number of ticks by hand -> write it down
                    $this->record('loyalty_override', "$code: loyalty ticks set to {$loyalty['ticks']} (automatic count was {$loyalty['auto']})"
                        . ($loyalty['used'] ? ' · FREE used ' . self::peso($loyalty['discount']) : ''));
                }

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
        $stmt = $this->db->prepare('SELECT id FROM wh_orders WHERE track_token = ? AND deleted_at IS NULL');
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

    /**
     * Order/Tag ID format: WH-YYMMDD-0001 (resets daily).
     * Counts orders in the Trash too, so a deleted order's code is never given to a new order.
     */
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

    /**
     * Both sides: delete a wrong order (e.g. a typo in the weight or the wrong customer).
     * SOFT delete: the order goes to the Trash. Its items, payments and status history stay in the
     * database, but its payments no longer count in the sales reports. The customer profile stays.
     */
    private function deleteOrder(int $id): array
    {
        $order = $this->order($id); // throws "Order not found." if it doesn't exist (or is already in the Trash)
        $this->softDelete('wh_orders', $id);
        // A wrong order shouldn't count on the loyalty card: take its ticks back (restoring it gives them back)
        $this->takeBackLoyaltyTicks($order);
        $this->record('order_delete', "{$order['code']} · {$order['customer']['name']} · total " . self::peso($order['total'])
            . ' · paid ' . self::peso($order['amount_paid']));
        return ['deleted' => $order['code']];
    }

    /** Marks that the customer was already texted/called that the laundry is ready. */
    private function markNotified(array $in): array
    {
        $id = (int) ($in['id'] ?? 0);
        $this->db->prepare('UPDATE wh_orders SET notified_at = ? WHERE id = ? AND deleted_at IS NULL')->execute([$this->dt($this->now()), $id]);
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
                'customer'          => ['id' => (int) $r['customer_id'], 'name' => $r['c_name'], 'phone' => $r['c_phone'], 'address' => $r['c_address'], 'notes' => $r['c_notes'],
                                        'loyalty_ticks' => (int) $r['c_ticks'], 'loyalty_free_used' => (int) $r['c_free_used']],
                'items'             => $items[$id] ?? [],
                'payments'          => $payments[$id] ?? [],
                // loyalty card for this order
                'loyalty_ticks'     => (int) $r['loyalty_ticks'],
                'loyalty_counted'   => (bool) $r['loyalty_counted'],
                'loyalty_rewards'   => (int) $r['loyalty_rewards'],
                'loyalty_discount'  => (float) $r['loyalty_discount'],
                'loyalty_after'     => $r['loyalty_after'] === null ? null : (int) $r['loyalty_after'],
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

        // Sales = money actually received (payments), grouped per day for the last 7 days.
        // Payments on orders in the Trash are left out (LIVE_PAYMENTS joins only active orders).
        $live = self::LIVE_PAYMENTS;
        $stmt = $this->db->prepare("SELECT DATE(p.paid_at) AS d, SUM(p.amount) AS total FROM $live WHERE p.paid_at >= ? GROUP BY DATE(p.paid_at)");
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

        $stmt = $this->db->prepare("SELECT p.method, SUM(p.amount) AS total FROM $live WHERE p.paid_at >= ? GROUP BY p.method");
        $stmt->execute([$this->dt($todayStart)]);
        $methods = ['cash' => 0.0, 'gcash' => 0.0, 'card' => 0.0];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $methods[$r['method']] = (float) $r['total'];
        }

        $stmt = $this->db->prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total_weight), 0) AS kg FROM wh_orders WHERE created_at >= ? AND deleted_at IS NULL');
        $stmt->execute([$this->dt($todayStart)]);
        $today = $stmt->fetch(PDO::FETCH_ASSOC);

        $statusCounts = array_fill_keys(['received', 'washing', 'drying', 'ready'], 0);
        foreach ($this->db->query("SELECT status, COUNT(*) AS n FROM wh_orders WHERE status <> 'completed' AND deleted_at IS NULL GROUP BY status")->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $statusCounts[$r['status']] = (int) $r['n'];
        }

        $receivable = (float) $this->db->query("SELECT COALESCE(SUM(total - amount_paid), 0) FROM wh_orders WHERE payment_status <> 'paid' AND deleted_at IS NULL")->fetchColumn();

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
        // (orders in the Trash and their payments are left out of every number below)
        $live = self::LIVE_PAYMENTS;
        $stmt = $this->db->prepare("SELECT DATE(p.paid_at) AS d, SUM(p.amount) AS total FROM $live WHERE p.paid_at >= ? AND p.paid_at < ? GROUP BY DATE(p.paid_at)");
        $stmt->execute([$start, $end]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $days[$r['d']]['collected'] = (float) $r['total'];
        }
        $stmt = $this->db->prepare('SELECT DATE(created_at) AS d, COUNT(*) AS n, SUM(total) AS billed, SUM(total_weight) AS kg FROM wh_orders WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL GROUP BY DATE(created_at)');
        $stmt->execute([$start, $end]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $days[$r['d']]['orders'] = (int) $r['n'];
            $days[$r['d']]['billed'] = (float) $r['billed'];
            $days[$r['d']]['kg']     = (float) $r['kg'];
        }

        // Revenue per service (based on orders received in the range)
        $stmt = $this->db->prepare('SELECT i.name, i.unit, SUM(i.qty) AS qty, SUM(i.line_total) AS revenue, COUNT(DISTINCT i.order_id) AS orders
                                    FROM wh_order_items i JOIN wh_orders o ON o.id = i.order_id
                                    WHERE o.created_at >= ? AND o.created_at < ? AND o.deleted_at IS NULL
                                    GROUP BY i.name, i.unit ORDER BY revenue DESC');
        $stmt->execute([$start, $end]);
        $services = array_map(fn ($r) => ['name' => $r['name'], 'unit' => $r['unit'], 'qty' => (float) $r['qty'], 'revenue' => (float) $r['revenue'], 'orders' => (int) $r['orders']], $stmt->fetchAll(PDO::FETCH_ASSOC));

        $stmt = $this->db->prepare("SELECT p.method, SUM(p.amount) AS total, COUNT(*) AS n FROM $live WHERE p.paid_at >= ? AND p.paid_at < ? GROUP BY p.method");
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
        $rows = $this->db->query('SELECT * FROM wh_inventory WHERE deleted_at IS NULL ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);
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
            $this->db->prepare('UPDATE wh_inventory SET name=?, unit=?, reorder_level=?, cost=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
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
        $stmt = $this->db->prepare('SELECT stock FROM wh_inventory WHERE id = ? AND deleted_at IS NULL');
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

    /**
     * Delete a supply item the shop no longer uses (soft delete -> Trash).
     * Its stock movement records stay in the database; they are hidden while the item is in the Trash.
     */
    private function deleteInventoryItem(int $id): array
    {
        $stmt = $this->db->prepare('SELECT name, unit, stock FROM wh_inventory WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$id]);
        $item = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$item) {
            throw new InvalidArgumentException('Item not found.');
        }
        $this->softDelete('wh_inventory', $id);
        $this->record('inventory_delete', "{$item['name']} (had " . (float) $item['stock'] . " {$item['unit']} in stock)");
        return $this->inventory();
    }

    /** Latest stock movements (optionally for one item). */
    private function inventoryLogs(array $in): array
    {
        $id     = (int) ($in['id'] ?? 0);
        // Only records that are not in the Trash, for items that are not in the Trash
        $stmt   = $this->db->prepare('SELECT l.*, i.name, i.unit FROM wh_inventory_logs l JOIN wh_inventory i ON i.id = l.item_id '
                . 'WHERE l.deleted_at IS NULL AND i.deleted_at IS NULL ' . ($id ? 'AND l.item_id = ? ' : '') . 'ORDER BY l.id DESC LIMIT 100');
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
    //  DELETING HISTORY (Owner / Admin only)
    //  All of these are SOFT deletes: the rows get a deleted_at date and move
    //  to the Trash. Orders in the Trash (and their payments) leave the reports,
    //  but they can be restored. Only "Delete forever" in the Trash removes them.
    // =====================================================================

    /**
     * Delete FINISHED orders (Picked Up / Delivered) received between two dates.
     * Payload {from, to} as YYYY-MM-DD, plus confirm: true to really delete.
     * Without confirm it only counts them, so the screen can show "12 orders, P1,560" first.
     * Orders that are not finished yet are never deleted here.
     */
    private function deleteHistory(array $in): array
    {
        $from = $this->validDate($in['from'] ?? '');
        $to   = $this->validDate($in['to'] ?? '');
        if (!$from || !$to) {
            throw new InvalidArgumentException('Choose a start date and an end date.');
        }
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        $where  = "status = 'completed' AND created_at >= ? AND created_at < ? AND deleted_at IS NULL";
        $params = [$this->dayStart($from), $this->dayStart($to, 1)];

        $stmt = $this->db->prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS billed, COALESCE(SUM(amount_paid), 0) AS paid FROM wh_orders WHERE $where");
        $stmt->execute($params);
        $sum = $stmt->fetch(PDO::FETCH_ASSOC);
        $result = ['from' => $from, 'to' => $to, 'count' => (int) $sum['n'], 'billed' => (float) $sum['billed'], 'paid' => (float) $sum['paid'], 'deleted' => false];

        if (!empty($in['confirm']) && $result['count'] > 0) {
            $this->db->prepare("UPDATE wh_orders SET deleted_at = ? WHERE $where")->execute([$this->dt($this->now()), ...$params]);
            $result['deleted'] = true;
            $this->record('history_delete', "{$result['count']} finished orders from $from to $to · billed "
                . self::peso($result['billed']) . ' · paid ' . self::peso($result['paid']));
        }
        return $result;
    }

    /**
     * Delete a customer profile together with ALL of that customer's orders (soft delete -> Trash). Payload {id}.
     * The customer and the orders get the SAME deleted_at time, so restoring the customer
     * brings back exactly the orders that were deleted with them.
     */
    private function deleteCustomer(int $id): array
    {
        $stmt = $this->db->prepare('SELECT name FROM wh_customers WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$id]);
        $name = $stmt->fetchColumn();
        if ($name === false) {
            throw new InvalidArgumentException('Customer not found.');
        }
        $now = $this->dt($this->now());
        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare('UPDATE wh_orders SET deleted_at = ? WHERE customer_id = ? AND deleted_at IS NULL');
            $stmt->execute([$now, $id]);
            $orders = $stmt->rowCount();
            $this->db->prepare('UPDATE wh_customers SET deleted_at = ? WHERE id = ?')->execute([$now, $id]);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->record('customer_delete', "$name, with $orders order" . ($orders === 1 ? '' : 's'));
        return ['deleted' => $name, 'orders' => $orders];
    }

    /** Clear the inventory "Recent stock movements" log (soft delete -> Trash). Current stock levels are NOT changed. */
    private function clearInventoryLogs(): array
    {
        $stmt = $this->db->prepare('UPDATE wh_inventory_logs SET deleted_at = ? WHERE deleted_at IS NULL');
        $stmt->execute([$this->dt($this->now())]);
        $n = $stmt->rowCount();
        $this->record('inventory_logs_clear', "$n stock movement record" . ($n === 1 ? '' : 's') . ' cleared');
        return ['deleted' => $n];
    }

    // =====================================================================
    //  LOYALTY CARD
    //  1 tick per load. A card has N boxes (default 14); every Mth box (7, 14) is FREE.
    //  The customer's running total is wh_customers.loyalty_ticks (counts over all cards:
    //  tick 15 = box 1 of card #2). js/utils.js (WH.loyaltyPlan) has the same rules for the preview.
    // =====================================================================

    /** Loyalty settings read once per request (cleared when the settings are saved). */
    private ?array $loyaltyCfg = null;

    /** The loyalty settings as numbers. */
    private function loyaltyConfig(): array
    {
        if ($this->loyaltyCfg !== null) {
            return $this->loyaltyCfg;
        }
        $s    = $this->settings();
        $size = max(2, min(50, (int) $s['loyalty_card_size']));
        $cfg  = [
            'enabled' => $s['loyalty_enabled'] === '1',
            'size'    => $size,
            'every'   => max(1, min($size, (int) $s['loyalty_free_every'])),
            'reward'  => in_array($s['loyalty_reward'], ['free_load', 'amount', 'percent'], true) ? $s['loyalty_reward'] : 'free_load',
            'value'   => max(0.0, (float) $s['loyalty_reward_value']),
            'mode'    => $s['loyalty_mode'] === 'auto' ? 'auto' : 'save',
        ];
        return $this->loyaltyCfg = $cfg;
    }

    /** Is tick number $t (counted over all cards) on a FREE box? e.g. size 14, every 7: ticks 7, 14, 21, 28… */
    private static function isFreeTick(int $t, array $cfg): bool
    {
        return ((($t - 1) % $cfg['size']) + 1) % $cfg['every'] === 0;
    }

    /** How many FREE boxes $ticks ticks have reached in total. e.g. 17 ticks on a 14/7 card = 2 (box 7 and box 14). */
    private static function freeEarned(int $ticks, array $cfg): int
    {
        return intdiv($ticks, $cfg['size']) * intdiv($cfg['size'], $cfg['every']) + intdiv($ticks % $cfg['size'], $cfg['every']);
    }

    /** The loads in an order that earn ticks, cheapest first, as peso values (1 piece/load = its price, 1 kg line = the whole line). */
    private static function loadValues(array $lines): array
    {
        $loads = [];
        foreach ($lines as $l) {
            if ($l['loyalty']) {
                if ($l['unit'] === 'pc') {
                    for ($i = 0; $i < (int) floor($l['qty']); $i++) {
                        $loads[] = (float) $l['price'];
                    }
                } else {
                    $loads[] = $l['unit'] === 'kg' ? $l['qty'] * $l['price'] : (float) $l['price'];
                }
            }
        }
        sort($loads);
        return $loads;
    }

    /**
     * What an order earns and uses on the loyalty card.
     *   $before / $usedBefore = customer's ticks and FREE already used, before this order
     *   $requested            = ticks typed by the cashier, or null = automatic (1 per load of a "Loyalty" service)
     *   $useFree              = FREE rewards the cashier wants to use now ("save" mode only)
     *   $lines                = [['unit', 'qty', 'price', 'loyalty'], ...]
     * "save" mode: reaching a FREE box only adds to "FREE available"; the cashier decides when to use it.
     * "auto" mode: FREE boxes reached by this order are used on this order right away.
     * Returns ['ticks', 'auto', 'reached', 'used', 'discount', 'after', 'available' (left after this order)].
     */
    private function loyaltyPlan(int $before, int $usedBefore, $requested, $useFree, array $lines, float $subtotal, float $manualDiscount): array
    {
        $cfg   = $this->loyaltyConfig();
        $loads = self::loadValues($lines);
        $auto  = count($loads);   // 1 tick per load
        if (!$cfg['enabled']) {
            return ['ticks' => 0, 'auto' => 0, 'reached' => 0, 'used' => 0, 'discount' => 0.0, 'after' => $before, 'available' => 0];
        }
        $ticks = ($requested === null || $requested === '') ? $auto : max(0, min(50, (int) $requested));
        $after = $before + $ticks;

        $reached = 0;   // FREE boxes this order lands on
        for ($t = $before + 1; $t <= $after; $t++) {
            if (self::isFreeTick($t, $cfg)) {
                $reached++;
            }
        }
        $available = max(0, self::freeEarned($after, $cfg) - $usedBefore);   // includes what this order just earned
        // how many FREE can one order use? one per load (free load), once for "% off", any number for "P off"
        $maxPerOrder = $cfg['reward'] === 'percent' ? 1 : ($cfg['reward'] === 'free_load' ? count($loads) : 99);

        if ($cfg['mode'] === 'auto') {
            $use = min($reached, $available, $maxPerOrder);
        } else {
            $use = max(0, (int) ($useFree ?? 0));
            if ($use > $available) {
                throw new InvalidArgumentException("This customer has only $available FREE available.");
            }
            if ($use > $maxPerOrder) {
                throw new InvalidArgumentException($cfg['reward'] === 'percent'
                    ? 'Only 1 FREE can be used per order.'
                    : "This order has only $maxPerOrder load(s), so at most $maxPerOrder FREE can be used.");
            }
        }

        $discount = 0.0;
        if ($use > 0) {
            if ($cfg['reward'] === 'amount') {
                $discount = $use * $cfg['value'];                              // P X off per FREE
            } elseif ($cfg['reward'] === 'percent') {
                $discount = $subtotal * min(100, $cfg['value']) / 100;         // X% off the order
            } else {
                $discount = array_sum(array_slice($loads, 0, $use));           // the cheapest load(s) are free
            }
        }
        $discount = round(min($discount, max(0, $subtotal - $manualDiscount)), 2);   // never below P0
        return ['ticks' => $ticks, 'auto' => $auto, 'reached' => $reached, 'used' => $use, 'discount' => $discount,
                'after' => $after, 'available' => $available - $use];
    }

    /** When a wrong order is deleted, its ticks come off the customer's card and any FREE it used is given back. */
    private function takeBackLoyaltyTicks(array $order): void
    {
        if ($order['loyalty_counted'] && ($order['loyalty_ticks'] > 0 || $order['loyalty_rewards'] > 0)) {
            $t = $order['loyalty_ticks'];
            $f = $order['loyalty_rewards'];
            $this->db->prepare('UPDATE wh_customers SET loyalty_ticks = GREATEST(loyalty_ticks, ?) - ?, loyalty_free_used = GREATEST(loyalty_free_used, ?) - ? WHERE id = ?')
                ->execute([$t, $t, $f, $f, $order['customer']['id']]);
            $this->db->prepare('UPDATE wh_orders SET loyalty_counted = 0 WHERE id = ?')->execute([$order['id']]);
        }
    }

    /** One customer's loyalty numbers for the screens. */
    private function loyaltySummary(array $c): array
    {
        $cfg    = $this->loyaltyConfig();
        $ticks  = (int) $c['loyalty_ticks'];
        $earned = self::freeEarned($ticks, $cfg);
        $used   = (int) $c['loyalty_free_used'];
        return ['loyalty_ticks' => $ticks, 'loyalty_free_earned' => $earned, 'loyalty_free_used' => $used, 'loyalty_free_available' => max(0, $earned - $used)];
    }

    /**
     * Owner / Admin: change a customer's loyalty card by hand. Payload {id, ticks? (new total) | add? (+5 / -1), free_used?, note?}.
     * For example to copy a paper loyalty card into the system, or to fix a mistake. Written to the Activity Log.
     */
    private function setCustomerLoyalty(array $in): array
    {
        $stmt = $this->db->prepare('SELECT * FROM wh_customers WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([(int) ($in['id'] ?? 0)]);
        $c = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$c) {
            throw new InvalidArgumentException('Customer not found.');
        }
        return $this->applyLoyaltyChange($c, $in);
    }

    /**
     * Owner / Admin, Loyalty Card page form: find the customer (by phone, else by exact name) or add them,
     * then add ticks and/or set "FREE already used". Payload {name, phone, add, free_used, note}.
     */
    private function saveLoyaltyCard(array $in): array
    {
        $name  = $this->requireText($in['name'] ?? '', 'Customer name');
        $phone = $this->cleanPhone($in['phone'] ?? '');
        $c = false;
        if ($phone !== '') {
            $stmt = $this->db->prepare('SELECT * FROM wh_customers WHERE phone = ? AND deleted_at IS NULL LIMIT 1');
            $stmt->execute([$phone]);
            $c = $stmt->fetch(PDO::FETCH_ASSOC);
        }
        if (!$c) {
            $stmt = $this->db->prepare('SELECT * FROM wh_customers WHERE name = ? AND deleted_at IS NULL ORDER BY id LIMIT 1');
            $stmt->execute([$name]);
            $c = $stmt->fetch(PDO::FETCH_ASSOC);
        }
        if (!$c) {   // new customer
            $id   = $this->saveCustomer(['name' => $name, 'phone' => $phone])['id'];
            $stmt = $this->db->prepare('SELECT * FROM wh_customers WHERE id = ?');
            $stmt->execute([$id]);
            $c = $stmt->fetch(PDO::FETCH_ASSOC);
        }
        return $this->applyLoyaltyChange($c, $in);
    }

    /** Shared by the two actions above: validates, saves and logs the change. */
    private function applyLoyaltyChange(array $c, array $in): array
    {
        $ticks = (int) $c['loyalty_ticks'];
        if (isset($in['ticks']) && $in['ticks'] !== '') {
            $ticks = (int) $in['ticks'];
        } elseif (isset($in['add']) && $in['add'] !== '') {
            $ticks += (int) $in['add'];
        }
        if ($ticks < 0 || $ticks > 10000) {
            throw new InvalidArgumentException('The total ticks must be 0 or more.');
        }
        $used = isset($in['free_used']) && $in['free_used'] !== '' ? (int) $in['free_used'] : (int) $c['loyalty_free_used'];
        $earned = self::freeEarned($ticks, $this->loyaltyConfig());
        if ($used < 0 || $used > $earned) {
            throw new InvalidArgumentException("FREE already used must be between 0 and $earned (the FREE earned with $ticks ticks).");
        }
        $this->db->prepare('UPDATE wh_customers SET loyalty_ticks = ?, loyalty_free_used = ? WHERE id = ?')->execute([$ticks, $used, $c['id']]);
        $note = mb_substr(trim((string) ($in['note'] ?? '')), 0, 100);
        $this->record('loyalty_adjust', "{$c['name']}: ticks {$c['loyalty_ticks']} → $ticks, FREE used {$c['loyalty_free_used']} → $used" . ($note !== '' ? " · $note" : ''));
        $c['loyalty_ticks'] = $ticks;
        $c['loyalty_free_used'] = $used;
        return ['id' => (int) $c['id'], 'name' => $c['name']] + $this->loyaltySummary($c);
    }

    // =====================================================================
    //  TRASH — soft-deleted records: see them, restore them, or delete forever
    // =====================================================================

    /** SOFT DELETE one row: mark it with the current time instead of removing it. */
    private function softDelete(string $table, int $id): void
    {
        $this->db->prepare("UPDATE $table SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
            ->execute([$this->dt($this->now()), $id]);
    }

    /** Owner / Admin: everything in the Trash, newest first (up to 300 per type). */
    private function trash(): array
    {
        $q = fn (string $sql) => $this->db->query($sql)->fetchAll(PDO::FETCH_ASSOC);
        $at = fn ($r) => $this->iso($r['deleted_at']);
        return [
            'orders' => array_map(fn ($r) => [
                'id' => (int) $r['id'], 'deleted_at' => $at($r),
                'title'   => $r['code'],
                'details' => "{$r['c_name']} · " . self::STATUS_NAMES[$r['status']] . ' · total ' . self::peso($r['total']) . ' · paid ' . self::peso($r['amount_paid'])
                           . ($r['c_deleted'] ? ' · customer is in the Trash too' : ''),
            ], $q('SELECT o.*, c.name AS c_name, c.deleted_at AS c_deleted FROM wh_orders o JOIN wh_customers c ON c.id = o.customer_id
                   WHERE o.deleted_at IS NOT NULL ORDER BY o.deleted_at DESC, o.id DESC LIMIT 300')),
            'customers' => array_map(fn ($r) => [
                'id' => (int) $r['id'], 'deleted_at' => $at($r),
                'title'   => $r['name'],
                'details' => trim(($r['phone'] ?: 'no phone') . " · {$r['n']} order" . ($r['n'] == 1 ? '' : 's') . ' deleted with them'),
            ], $q('SELECT c.*, (SELECT COUNT(*) FROM wh_orders o WHERE o.customer_id = c.id AND o.deleted_at = c.deleted_at) AS n
                   FROM wh_customers c WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC LIMIT 300')),
            'services' => array_map(fn ($r) => [
                'id' => (int) $r['id'], 'deleted_at' => $at($r),
                'title' => $r['name'], 'details' => self::peso($r['price']) . ' per ' . $r['unit'],
            ], $q('SELECT * FROM wh_services WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 300')),
            'inventory' => array_map(fn ($r) => [
                'id' => (int) $r['id'], 'deleted_at' => $at($r),
                'title' => $r['name'], 'details' => (float) $r['stock'] . " {$r['unit']} in stock when deleted",
            ], $q('SELECT * FROM wh_inventory WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 300')),
            'stock_logs' => array_map(fn ($r) => [
                'id' => (int) $r['id'], 'deleted_at' => $at($r),
                'title'   => $r['name'],
                'details' => ($r['change_qty'] > 0 ? '+' : '') . (float) $r['change_qty'] . " {$r['unit']} · {$r['reason']} · " . substr($r['created_at'], 0, 16),
            ], $q('SELECT l.*, i.name, i.unit FROM wh_inventory_logs l JOIN wh_inventory i ON i.id = l.item_id
                   WHERE l.deleted_at IS NOT NULL ORDER BY l.deleted_at DESC, l.id DESC LIMIT 300')),
            'users' => array_map(fn ($r) => [
                'id' => (int) $r['id'], 'deleted_at' => $at($r),
                'title' => $r['full_name'], 'details' => "{$r['username']} · " . self::roleName($r['role']),
            ], $q('SELECT * FROM wh_users WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 300')),
        ];
    }

    /** Finds one row that is in the Trash, or throws. Returns [table, row]. */
    private function trashedRow(string $type, int $id): array
    {
        $table = self::TRASH_TYPES[$type] ?? null;
        if (!$table) {
            throw new InvalidArgumentException('Unknown Trash type.');
        }
        $stmt = $this->db->prepare("SELECT * FROM $table WHERE id = ? AND deleted_at IS NOT NULL");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new InvalidArgumentException('That record is not in the Trash anymore.');
        }
        return [$table, $row];
    }

    /** A short name for a trashed row (for the activity log). */
    private static function trashLabel(string $type, array $row): string
    {
        return match ($type) {
            'orders'     => 'order ' . $row['code'],
            'customers'  => 'customer ' . $row['name'],
            'services'   => 'service ' . $row['name'],
            'inventory'  => 'supply item ' . $row['name'],
            'stock_logs' => 'stock record #' . $row['id'],
            'users'      => "account {$row['full_name']} ({$row['username']})",
        };
    }

    /**
     * Owner / Admin: restore a record from the Trash = set deleted_at back to NULL. Payload {type, id}.
     *  - a customer comes back with the orders that were deleted together with them
     *  - an order whose customer is also in the Trash brings that customer back too
     *  - only the Shop Owner may restore an Owner / Admin account (owner protection)
     */
    private function restoreFromTrash(array $in): array
    {
        $type = (string) ($in['type'] ?? '');
        [$table, $row] = $this->trashedRow($type, (int) ($in['id'] ?? 0));
        $extra = '';
        if ($type === 'users' && $row['role'] === 'admin' && empty($this->user['is_owner'])) {
            throw new InvalidArgumentException('Only the Shop Owner can restore an Owner / Admin account.');
        }
        $this->db->beginTransaction();
        try {
            if ($type === 'customers') {
                $stmt = $this->db->prepare('UPDATE wh_orders SET deleted_at = NULL WHERE customer_id = ? AND deleted_at = ?');
                $stmt->execute([$row['id'], $row['deleted_at']]);
                $extra = ' with ' . $stmt->rowCount() . ' order(s)';
            }
            if ($type === 'orders') {
                $stmt = $this->db->prepare('UPDATE wh_customers SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL');
                $stmt->execute([$row['customer_id']]);
                $extra = $stmt->rowCount() ? ' (its customer was restored too)' : '';
                // give back the loyalty ticks that were taken when it was deleted
                if (!$row['loyalty_counted'] && ($row['loyalty_ticks'] > 0 || $row['loyalty_rewards'] > 0)) {
                    $this->db->prepare('UPDATE wh_customers SET loyalty_ticks = loyalty_ticks + ?, loyalty_free_used = loyalty_free_used + ? WHERE id = ?')
                        ->execute([$row['loyalty_ticks'], $row['loyalty_rewards'], $row['customer_id']]);
                    $this->db->prepare('UPDATE wh_orders SET loyalty_counted = 1 WHERE id = ?')->execute([$row['id']]);
                }
            }
            $this->db->prepare("UPDATE $table SET deleted_at = NULL WHERE id = ?")->execute([$row['id']]);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->record('trash_restore', 'Restored ' . self::trashLabel($type, $row) . $extra);
        return $this->trash();
    }

    /**
     * Shop Owner only: DELETE FOREVER (the only real DELETE in the system). Payload {type, id} or {type, all: true}.
     * Only rows already in the Trash can be removed. Removing an order also removes its items,
     * payments and status history (ON DELETE CASCADE). Removing a customer removes all their orders.
     */
    private function purgeFromTrash(array $in): array
    {
        $type  = (string) ($in['type'] ?? '');
        $table = self::TRASH_TYPES[$type] ?? null;
        if (!$table) {
            throw new InvalidArgumentException('Unknown Trash type.');
        }
        if (!empty($in['all'])) {
            $ids   = $this->db->query("SELECT id FROM $table WHERE deleted_at IS NOT NULL")->fetchAll(PDO::FETCH_COLUMN);
            $label = count($ids) . " $type (emptied that Trash tab)";
        } else {
            [, $row] = $this->trashedRow($type, (int) ($in['id'] ?? 0));
            $ids   = [$row['id']];
            $label = self::trashLabel($type, $row);
        }
        if ($ids) {
            $marks = implode(',', array_fill(0, count($ids), '?'));
            $this->db->beginTransaction();
            try {
                if ($type === 'customers') {   // orders point to the customer, so they go first
                    $this->db->prepare("DELETE FROM wh_orders WHERE customer_id IN ($marks)")->execute($ids);
                }
                $this->db->prepare("DELETE FROM $table WHERE id IN ($marks) AND deleted_at IS NOT NULL")->execute($ids);
                $this->db->commit();
            } catch (Throwable $e) {
                $this->db->rollBack();
                throw $e;
            }
            $this->record('trash_purge', 'Deleted forever: ' . $label);
        }
        return $this->trash();
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
