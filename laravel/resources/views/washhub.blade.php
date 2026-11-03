<!doctype html>
{{--
  Wash Hub POS — Laravel version of index.html.
  Same page shell; assets are served from public/vendor/washhub/ and the API goes to /washhub/api.
  If you change index.html, make the same change here.
--}}
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0b1a3a">
  <meta name="csrf-token" content="{{ csrf_token() }}">
  <title>Gap Wash Hub POS</title>
  <link rel="icon" type="image/png" href="{{ asset('vendor/washhub/assets/logo.png') }}">
  <link rel="stylesheet" href="{{ asset('vendor/washhub/index.css') }}">
  <script>
    window.WASHHUB_API = @json(route('washhub.api'));
    window.WASHHUB_ASSETS = @json(asset('vendor/washhub') . '/');  // where assets/logo.png lives
  </script>
</head>
<body>
  <div class="app">
    <aside class="sidebar" id="sidebar"></aside>
    <main class="main">
      <div id="banner"></div>
      <header class="topbar">
        <h1 id="page-title">Gap Wash Hub</h1>
        <span class="spacer"></span>
        <div class="scan-box">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8M18 8v8"/></svg>
          <input type="search" id="scan" placeholder="Scan / type ticket ID, press Enter" aria-label="Find order by ticket ID" autocomplete="off">
        </div>
        <span class="clock" id="clock"></span>
      </header>
      <div class="view" id="view"><div class="loading">Starting Gap Wash Hub POS…</div></div>
    </main>
  </div>
  <div id="modal-root"></div>
  <div id="toast-root" aria-live="polite"></div>
  <div id="print-root"></div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <script src="{{ asset('vendor/washhub/js/utils.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/store.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/ticket.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/order.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/dashboard.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/pos.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/board.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/customers.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/inventory.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/reports.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/settings.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/users.js') }}"></script>
  <script src="{{ asset('vendor/washhub/js/views/account.js') }}"></script>
  <script src="{{ asset('vendor/washhub/index.js') }}"></script>
</body>
</html>
