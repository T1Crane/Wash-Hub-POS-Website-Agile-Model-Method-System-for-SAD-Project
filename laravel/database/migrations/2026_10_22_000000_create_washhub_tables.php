<?php

use App\Services\WashHubApi;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Creates the Wash Hub tables (wh_*) and starter data.
 * The table definitions live in WashHubApi::schema() so XAMPP and Laravel
 * always use the exact same database structure.
 */
return new class extends Migration
{
    protected $connection = 'mysql';

    public function up(): void
    {
        (new WashHubApi(DB::connection('mysql')->getPdo()))->install();
    }

    public function down(): void
    {
        Schema::connection('mysql')->disableForeignKeyConstraints();
        foreach (['wh_inventory_logs', 'wh_inventory', 'wh_order_logs', 'wh_payments', 'wh_order_items', 'wh_orders', 'wh_customers', 'wh_services', 'wh_settings'] as $table) {
            Schema::connection('mysql')->dropIfExists($table);
        }
        Schema::connection('mysql')->enableForeignKeyConstraints();
    }
};
