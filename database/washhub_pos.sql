-- ==========================================================================
-- Wash Hub POS & Inventory - MySQL / MariaDB schema (for phpMyAdmin import)
-- --------------------------------------------------------------------------
-- OPTIONAL: api.php creates the database and these tables automatically on
-- first load. Use this file if you prefer importing manually in phpMyAdmin,
-- or for your SAD documentation (data dictionary / ERD).
-- Generated from WashHubApi::schema() in backend/WashHubApi.php - if you change
-- the tables, change them there too.
-- ==========================================================================

CREATE DATABASE IF NOT EXISTS `washhub_pos` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `washhub_pos`;

CREATE TABLE IF NOT EXISTS wh_settings (
    skey   VARCHAR(50) NOT NULL PRIMARY KEY,
    svalue TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_services (
    id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name             VARCHAR(80)  NOT NULL,
    unit             ENUM('kg','pc','flat') NOT NULL DEFAULT 'kg',
    price            DECIMAL(10,2) NOT NULL DEFAULT 0,
    turnaround_hours INT UNSIGNED NOT NULL DEFAULT 24,
    is_express       TINYINT(1) NOT NULL DEFAULT 0,
    color            VARCHAR(20) NOT NULL DEFAULT 'blue',
    active           TINYINT(1) NOT NULL DEFAULT 1,
    sort_order       INT NOT NULL DEFAULT 0,
    loyalty          TINYINT(1) NOT NULL DEFAULT 1,   -- 1 = each load earns a loyalty tick
    deleted_at       DATETIME NULL DEFAULT NULL   -- soft delete: NULL = active, a date = in the Trash
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_customers (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    phone      VARCHAR(30)  NOT NULL DEFAULT '',
    address    VARCHAR(255) NOT NULL DEFAULT '',
    notes      VARCHAR(255) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    loyalty_ticks INT UNSIGNED NOT NULL DEFAULT 0,   -- loyalty card: total ticks (over all cards)
    loyalty_free_used INT UNSIGNED NOT NULL DEFAULT 0,  -- FREE rewards already used (earned - used = available)
    deleted_at DATETIME NULL DEFAULT NULL,   -- soft delete
    KEY idx_customer_phone (phone),
    KEY idx_customer_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_orders (
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
    loyalty_counted   TINYINT(1)    NOT NULL DEFAULT 0,  -- 1 = those ticks are in the customer total
    loyalty_rewards   INT UNSIGNED  NOT NULL DEFAULT 0,  -- FREE boxes this order reached
    loyalty_discount  DECIMAL(10,2) NOT NULL DEFAULT 0,  -- peso value of the loyalty reward
    loyalty_after     INT UNSIGNED  NULL,                -- customer total ticks after this order
    deleted_at        DATETIME NULL DEFAULT NULL,   -- soft delete
    KEY idx_order_status (status),
    KEY idx_order_created (created_at),
    CONSTRAINT fk_order_customer FOREIGN KEY (customer_id) REFERENCES wh_customers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_order_items (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id   INT UNSIGNED NOT NULL,
    service_id INT UNSIGNED NULL,
    name       VARCHAR(80) NOT NULL,
    unit       ENUM('kg','pc','flat') NOT NULL,
    qty        DECIMAL(8,2)  NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    line_total DECIMAL(10,2) NOT NULL,
    CONSTRAINT fk_item_order FOREIGN KEY (order_id) REFERENCES wh_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_payments (
    id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id INT UNSIGNED NOT NULL,
    amount   DECIMAL(10,2) NOT NULL,
    method   ENUM('cash','gcash','card') NOT NULL DEFAULT 'cash',
    paid_at  DATETIME NOT NULL,
    KEY idx_payment_date (paid_at),
    CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES wh_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_order_logs (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id   INT UNSIGNED NOT NULL,
    status     VARCHAR(20) NOT NULL,
    changed_at DATETIME NOT NULL,
    CONSTRAINT fk_log_order FOREIGN KEY (order_id) REFERENCES wh_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_inventory (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    unit          VARCHAR(20)  NOT NULL DEFAULT 'pcs',
    stock         DECIMAL(10,2) NOT NULL DEFAULT 0,
    reorder_level DECIMAL(10,2) NOT NULL DEFAULT 0,
    cost          DECIMAL(10,2) NOT NULL DEFAULT 0,
    updated_at    DATETIME NOT NULL,
    deleted_at    DATETIME NULL DEFAULT NULL   -- soft delete
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_inventory_logs (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id    INT UNSIGNED NOT NULL,
    change_qty DECIMAL(10,2) NOT NULL,
    reason     VARCHAR(120) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    deleted_at DATETIME NULL DEFAULT NULL,   -- soft delete
    CONSTRAINT fk_invlog_item FOREIGN KEY (item_id) REFERENCES wh_inventory(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wh_users (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    full_name     VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          ENUM('admin','staff') NOT NULL DEFAULT 'staff',
    is_owner      TINYINT(1) NOT NULL DEFAULT 0,   -- 1 = the ★ Shop Owner (exactly one account)
    active        TINYINT(1) NOT NULL DEFAULT 1,
    created_at    DATETIME NOT NULL,
    last_login_at DATETIME NULL,
    deleted_at    DATETIME NULL DEFAULT NULL   -- soft delete
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Activity log: who did what and when (no foreign key, so records stay after a user is deleted)
CREATE TABLE IF NOT EXISTS wh_activity_logs (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    INT UNSIGNED NULL,
    user_name  VARCHAR(160) NOT NULL DEFAULT '',
    action     VARCHAR(40)  NOT NULL,
    details    VARCHAR(255) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    INDEX idx_activity_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Starter price list (the shop's paper order form; prices per load / per item)
INSERT INTO wh_services (name, unit, price, turnaround_hours, is_express, color, sort_order, loyalty) VALUES
('Wash', 'pc', 65, 24, 0, 'blue', 1, 1),
('Wash & Dry', 'pc', 130, 24, 0, 'blue', 2, 1),
('Dry', 'pc', 80, 24, 0, 'amber', 3, 1),
('Dry & Fold', 'pc', 100, 24, 0, 'amber', 4, 1),
('Wash, Dry, & Fold', 'pc', 150, 24, 0, 'teal', 5, 1),
('Spin & Dry', 'pc', 100, 24, 0, 'teal', 6, 1),
('Package A', 'pc', 180, 24, 0, 'violet', 7, 1),
('Package B', 'pc', 200, 24, 0, 'violet', 8, 1),
('Package C', 'pc', 220, 24, 0, 'violet', 9, 1),
('Addt Detergent', 'pc', 15, 24, 0, 'green', 10, 0),
('Addt Fabcon', 'pc', 15, 24, 0, 'green', 11, 0),
('Over 8 kilos (Wash & Dry)', 'pc', 40, 24, 0, 'pink', 12, 0),
('Over 8 kilos (Wash or Dry)', 'pc', 20, 24, 0, 'pink', 13, 0),
('Blue Plastic', 'pc', 12, 24, 0, 'slate', 14, 0);

-- Starter supplies
INSERT INTO wh_inventory (name, unit, stock, reorder_level, cost, updated_at) VALUES
('Liquid Detergent', 'L', 20, 5, 95, NOW()),
('Fabric Conditioner', 'L', 15, 5, 80, NOW()),
('Color-safe Bleach', 'L', 4, 3, 70, NOW()),
('Plastic Laundry Bags', 'pcs', 180, 50, 3, NOW()),
('Hangers', 'pcs', 25, 30, 12, NOW()),
('Dryer Sheets', 'box', 6, 2, 150, NOW());

-- Shop settings and the first Owner / Admin account (owner / owner123) are created
-- automatically the first time the app is opened.
