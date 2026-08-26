<?php
declare(strict_types=1);

$root = dirname(__DIR__);
$runtimeFiles = [
    'router.php',
    'lib/trivial.php',
    'lib/v2.php',
    'src/server-app-v2.js',
    'index.html',
];
$forbidden = [
    'github.com',
    'api.github.com',
    'raw.githubusercontent.com',
    'git pull',
    'git fetch',
    '/api/update',
    'maybe_auto_update',
    'auto_update_status',
    'TRIVIAL_AUTO_UPDATE',
    'TRIVIAL_BRANCH',
];

foreach ($runtimeFiles as $file) {
    $text = file_get_contents($root . '/' . $file);
    if ($text === false) {
        fwrite(STDERR, "FAIL: no se pudo leer $file\n");
        exit(1);
    }
    foreach ($forbidden as $needle) {
        if (stripos($text, $needle) !== false) {
            fwrite(STDERR, "FAIL: conexión externa prohibida en $file: $needle\n");
            exit(1);
        }
    }
}

echo "ok - runtime v2 sin conexiones GitHub\n";
