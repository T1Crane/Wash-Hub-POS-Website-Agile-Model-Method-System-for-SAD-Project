<?php
/**
 * Entry point for XAMPP: http://localhost/<project-folder>/
 * Apache opens index.php first, which simply outputs the app shell (index.html).
 * The data comes from api.php (MySQL).
 */
header('Cache-Control: no-cache');
readfile(__DIR__ . '/index.html');
