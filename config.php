<?php
/**
 * Database settings for the plain PHP / XAMPP setup (used by api.php).
 * XAMPP defaults: user "root", empty password, port 3306.
 * The database is created automatically on first load if it doesn't exist.
 *
 * (Laravel does NOT use this file — it uses the DB_* values in Laravel's .env.)
 */
return [
    'host'     => getenv('WASHHUB_DB_HOST') ?: '127.0.0.1',
    'port'     => getenv('WASHHUB_DB_PORT') ?: '3306',
    'database' => getenv('WASHHUB_DB_NAME') ?: 'washhub_pos',
    'username' => getenv('WASHHUB_DB_USER') ?: 'root',
    'password' => getenv('WASHHUB_DB_PASS') ?: '',
];
