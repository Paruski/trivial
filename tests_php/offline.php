<?php
declare(strict_types=1);

$root = dirname(__DIR__);
$runtimeFiles = [
    'public/api.php',
    'lib/trivial.php',
    'public/src/server-app.js',
    'public/index.html',
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

$index = (string)file_get_contents($root . '/public/index.html');
if (strpos($index, "TRIVIAL_API_ENDPOINT = 'api.php'") === false) {
    fwrite(STDERR, "FAIL: index.html no declara api.php como endpoint\n");
    exit(1);
}

foreach (['data', 'lib', 'var'] as $privateDir) {
    if (is_dir($root . '/public/' . $privateDir)) {
        fwrite(STDERR, "FAIL: $privateDir no debe estar bajo public/\n");
        exit(1);
    }
}

echo "ok - runtime local, index->api.php y datos privados fuera de public/\n";
