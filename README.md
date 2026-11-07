# Wash Hub POS & Inventory Management System

**Development and Implementation of a Web-Based Point-of-Sale and Inventory Management System for Wash Hub using Agile Model Approach**
System Analysis and Design (SAD) project.

A touch-friendly front-desk system for a laundry shop: take orders, print claim tickets, track each load through the workflow, collect payments, monitor supplies and view sales reports.

**Stack:** HTML + CSS + vanilla JavaScript (no build step) · PHP 8 · MySQL/MariaDB (XAMPP) · works as plain PHP **or** inside Laravel.

---

## Features

| Module | What it does |
|---|---|
| **New Order (POS counter)** | Tap service tiles (Wash-Dry-Fold per kg, Dry Cleaning per piece, Ironing, Comforter, Express add-on). Enter weight in kg or piece counts with +/− steppers. Price is computed live. Search a customer by name/phone or quick-add one (name, phone, address/notes). Pickup or delivery, discount, notes. Payment: Cash / GCash / Card, amount received, change, and an automatic **Paid / Partial / Unpaid** status. Each order gets an auto-generated ID (`WH-YYMMDD-0001`) and an estimated ready time. |
| **Orders board** | Kanban columns **Received → Washing → Drying → Folding/Ready → Picked Up/Delivered**. One tap moves an order to the next stage, with Undo. Overdue orders are highlighted. There's also a List view with filters. Before releasing an order with an unpaid balance, the app asks you to collect payment. Both sides can **delete** a wrong order from its detail window (with a warning if money was already paid on it). |
| **Claim ticket** | Printable 80 mm receipt: shop logo/name, order ID, **QR code + Code 39 barcode**, item breakdown, weight, totals, payments, balance, pickup terms, plus a cut-off **bag tag**. Scan or type the ticket ID in the top bar to open an order (works with USB barcode scanners). |
| **QR order tracking** | The customer scans the ticket's QR code with their phone and sees their order's stage, ready time and balance, with no login. The link uses a secret random code per order (order IDs are easy to guess) and shows only the first name. |
| **Login & roles** | Every user logs in. The system has two sides. **Owner / Admin**: everything. **Staff**: New Order, Orders board, Customers and payments; **no Reports and no Users page** (also no Dashboard, Inventory or Settings). The server checks every request; the menu shows only what the role may use. |
| **Users** (Owner / Admin) | Add accounts, choose Owner / Admin or Staff, reset passwords, disable people who may come back, or delete accounts permanently. You can't demote, disable or delete your own account. |
| **My Account** (everyone) | Click your name in the sidebar: edit your name and username, change your password (needs the current one). |
| **Dashboard** | Today's and last-7-days sales, a 7-day sales chart, active/in-progress counts per stage, overdue orders, orders ready for pickup (with "Notify" SMS text), uncollected balances and low-stock alerts. |
| **Customers** | Profiles with order history and totals. "New order" pre-fills the POS. |
| **Inventory** | Supplies (detergent, fabric conditioner, bags, hangers…), stock level meter, reorder level, restock/use adjustments with a movement log. Owner / Admin can **delete** items that aren't used anymore (the trash button on the row). |
| **Reports** | Any date range: amount collected vs billed, orders, kg processed, revenue per service, payment methods. Print or export to CSV. |
| **Settings** | Shop details printed on tickets, pickup terms, SMS template, price list (add, edit, switch off or **delete** services: price, unit, turnaround hours, express flag, tile color). |
| **History cleanup** (Owner / Admin) | **Settings → History cleanup:** delete finished orders between two dates (checks the count first). **Customers:** delete a customer with all their orders. **Inventory:** clear the stock movement log (stock levels stay). |

---

## How to run it

The app picks its data mode by itself:
- **MySQL mode** when it can reach the PHP API (XAMPP or Laravel). The sidebar shows "MySQL connected".
- **Demo mode** when PHP isn't available (for example VS Code *Live Server* or double-clicking `index.html`). Data is saved in the browser's localStorage and comes with sample orders. A yellow banner tells you this.

### Option A — XAMPP (recommended)

1. Open the **XAMPP Control Panel** and **Start** both **Apache** and **MySQL**.
2. Make the project reachable from `htdocs`. Either:
   - **Link it** (keeps the Git repo where it is). Run once in Command Prompt:
     ```bat
     mklink /J C:\xampp\htdocs\washhub "C:\Users\PC\Documents\GitHub\Wash-Hub-POS-Website-Agile-Model-Method-System-for-SAD-Project"
     ```
   - **or** copy the whole folder to `C:\xampp\htdocs\washhub`.
3. Open **http://localhost/washhub/**

That's it: on first load `api.php` creates the database `washhub_pos`, all tables, the price list and sample supplies. To use a different MySQL user, password or port, edit [`config.php`](config.php).

4. Log in with the first Owner / Admin account: **`owner` / `owner123`**. Change the password right away (click your name → My Account), then add your staff under **Users**.
5. For the QR codes to work on customers' phones: **Settings → QR code link on tickets** → enter this PC's network address, e.g. `http://192.168.1.189/washhub/` (run `ipconfig` to find it). Phones must be on the shop Wi-Fi.

*(Optional)* To create the tables by hand, import [`database/washhub_pos.sql`](database/washhub_pos.sql) in phpMyAdmin (http://localhost/phpmyadmin → Import).

### Option B — Laravel

The same frontend and the same backend class run inside any Laravel 10/11/12 app.

1. Copy the files into your Laravel project:
   ```bat
   laravel\install-to-laravel.bat C:\path\to\your-laravel-app
   ```
   It copies `WashHubApi.php` → `app/Services/`, the controller, migration, Blade view, `routes/washhub.php` (and adds `require __DIR__.'/washhub.php';` to `routes/web.php`), and the CSS/JS → `public/vendor/washhub/`.
2. In the Laravel `.env`, point it at XAMPP's MySQL:
   ```env
   DB_CONNECTION=mysql
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_DATABASE=washhub_pos
   DB_USERNAME=root
   DB_PASSWORD=
   ```
   (Create the `washhub_pos` database in phpMyAdmin first if it doesn't exist, or let `php artisan migrate` offer to create it.)
3. In the Laravel folder:
   ```bat
   php artisan migrate
   php artisan serve
   ```
4. Open **http://127.0.0.1:8000/washhub**

After changing the frontend or `backend/WashHubApi.php`, run `install-to-laravel.bat` again to copy the new versions.

### Option C — Quick preview (no database)

Open `index.html` with VS Code **Live Server** ("Go Live"). Everything works in demo mode. Use **Settings → Reset demo data** to start over.

---

## Daily workflow (staff guide)

1. **New Order** → tap services → type the kg (or pieces) → find/add the customer → choose payment → **Create order & print ticket**. Give the customer the ticket and attach the bag tag to the laundry.
2. **Orders** board → tap **Start Washing → Move to Drying → Mark Ready** as the load moves.
3. When it's ready: Dashboard → **Ready — notify customer** → copy the SMS text or open the SMS app → **Mark as notified**.
4. At pickup: scan or type the ticket ID in the top bar → **Collect payment** if there's a balance → **Mark Picked Up / Delivered**.
5. End of day: check **Dashboard** and **Reports**. Record supply usage in **Inventory**.

---

## Project structure

```
index.php              XAMPP entry point (outputs index.html)
index.html             Page shell + script list
index.css              All styles (design tokens at the top)
index.js               Start-up, router (#/page), sidebar, top bar
js/
  utils.js             Formatting, icons, modal/toast helpers, workflow stages
  store.js             Data layer: MySQL via api.php, or demo mode (localStorage)
  ticket.js            Claim ticket, QR + barcode, printing, SMS notice
  views/
    dashboard.js       Dashboard
    pos.js             New Order (POS counter)
    board.js           Orders board (Kanban + list)
    order.js           Order detail modal, one-tap status, payments
    customers.js       Customers
    inventory.js       Inventory
    reports.js         Reports
    settings.js        Settings & price list
    users.js           User accounts (Owner / Admin only)
    account.js         My Account (every user)
api.php                JSON API for XAMPP  (api.php?action=...): login session + permission check
.htaccess              Tells the browser to always check for the newest JS/CSS
config.php             MySQL connection settings for XAMPP
backend/
  WashHubApi.php       ALL backend logic + table definitions (shared by XAMPP and Laravel)
database/
  washhub_pos.sql      Schema for phpMyAdmin (optional)
laravel/               Files that make it run inside Laravel (+ install script)
```

### Database tables

| Table | Purpose |
|---|---|
| `wh_customers` | Customer profiles (name, phone, address, notes) |
| `wh_services` | Price list: unit (`kg` / `pc` / `flat`), price, turnaround hours, express flag |
| `wh_orders` | One row per job/claim ticket: code, secret tracking code (for the QR link), status, totals, payment status, ready time |
| `wh_order_items` | Line items. Name and price are copied so old tickets stay correct after price changes |
| `wh_payments` | Each payment (cash/gcash/card). Sales reports are based on this table |
| `wh_order_logs` | Status history (audit trail of the board) |
| `wh_inventory` / `wh_inventory_logs` | Supplies and their stock movements |
| `wh_settings` | Shop name, address, ticket terms, SMS template, QR code link |
| `wh_users` | Login accounts: username, full name, **hashed** password (never the real one), role (`admin` = Owner / Admin side, `staff` = Staff side), active, last login |

### API actions (for documentation / testing)

`POST api.php?action=<name>` with a JSON body. Response: `{"ok": true, "data": …}` or `{"ok": false, "error": "…"}`.

- **No login needed:** `ping`, `login`, `logout`, `me`, `track` (QR page, needs the order's secret code)
- **Everyone logged in:** `bootstrap` (also returns the user's permission list), `account_save`, `orders`, `order`, `order_status`
- **Both sides (Owner / Admin and Staff):** `order_delete`, `order_create`, `order_payment`, `order_notify`, `customers`, `customer_save`
- **Owner / Admin only:** `dashboard`, `report`, `inventory`, `inventory_save`, `inventory_adjust`, `inventory_logs`, `inventory_delete`, `service_save`, `service_delete`, `settings_save`, `users`, `user_save`, `user_delete`, `history_delete`, `customer_delete`, `inventory_logs_clear`

The full list lives in `WashHubApi::PERMISSIONS`. An action not on the list is refused for everyone ("default deny"). Not logged in → HTTP 401; logged in but not allowed → 403.

Example: http://localhost/washhub/api.php?action=orders&status=active

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Yellow "Demo mode" banner on XAMPP | MySQL isn't running, or the password in `config.php` is wrong. The banner shows the exact error. |
| `Server did not return JSON` | You opened the page with Live Server (which can't run PHP). Use `http://localhost/washhub/`. |
| Port 3306 already in use | Another MySQL is running. Stop it, or change the port in XAMPP and `config.php`. |
| QR code missing on the ticket | The QR library loads from the internet (cdnjs). Offline, the barcode still prints and scans. |
| Laravel shows 419 | The page must be opened through the `/washhub` route (it supplies the CSRF token). |
| Wrong times | The shop timezone is `Asia/Manila` (`WashHubApi::TIMEZONE`). |
| "Can't load the app — Please log in first" with no login screen | The browser is running an old cached `index.js`. Press **Ctrl+F5**. |
| Forgot the Owner / Admin password | If another Owner / Admin exists, they can reset it under **Users**. Otherwise, in phpMyAdmin run `DELETE FROM wh_users;` and reload the app: it recreates `owner` / `owner123`. Orders and customers are not affected, but staff accounts must be added again. |
| QR code opens nothing on the phone | Set **Settings → QR code link** to the PC's network address (not `localhost`), and connect the phone to the same Wi-Fi. |

> Team note (see CodesReferences.txt): every file starts with a comment explaining what it's for, and each section is labeled. Please keep adding comments when you change code.
