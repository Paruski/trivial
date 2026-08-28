<?php
declare(strict_types=1);

$layout = file_get_contents(__DIR__ . '/../styles-layout.css');
$app = file_get_contents(__DIR__ . '/../src/app.js');
$index = file_get_contents(__DIR__ . '/../index.html');

if ($layout === false || $app === false || $index === false) {
    fwrite(STDERR, "FAIL: no se pudieron leer los recursos de interfaz\n");
    exit(1);
}

if (strpos($layout, '#game-root .marker{position:static') === false) {
    fwrite(STDERR, "FAIL: el marcador puede volver a flotar sobre los controles\n");
    exit(1);
}
if (strpos($layout, '#game-root .category-button{position:relative;z-index:2;pointer-events:auto') === false) {
    fwrite(STDERR, "FAIL: los botones de tema no tienen una capa clicable explícita\n");
    exit(1);
}
if (strpos($app, 'selectedCategoryId=categoryId') === false || strpos($app, "disabled:!selectedCategoryId") === false) {
    fwrite(STDERR, "FAIL: la selección de tema no habilita Sacar pregunta\n");
    exit(1);
}
if (strpos($index, 'styles-layout.css?v=') === false) {
    fwrite(STDERR, "FAIL: index.html no carga la corrección de layout versionada\n");
    exit(1);
}

echo "ok - marker stays in flow; category controls remain clickable and enable draw\n";
