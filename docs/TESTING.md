# Pruebas y CI

`npm test` ejecuta validación CSV, tests JavaScript del banco y tests Python del servidor. La suite cubre:

- UTF-8, CRLF, RFC 4180, columnas, FKs, IDs y duplicados;
- las siete combinaciones posibles de uno a tres jugadores;
- todos los subconjuntos no vacíos de categorías y niveles;
- turno manual, congelación, segunda pregunta pendiente y PRNG;
- pesos estables, nivel agotado y orden estable;
- quesitos, descartes, sustitución, undo/redo y replay;
- idempotencia, rollback, escrituras concurrentes y secuencias;
- migración de semilla conservando partidas;
- backup, importación, reset, diagnóstico y estadística.

`npm run test:e2e` inicia el servidor real y usa Chromium para crear una partida J1+J3, elegir manualmente J3, responder, intentar quesito con J1, descartar antes de revelar, comprobar sustitución, deshacer, rehacer, recargar, abrir otra pestaña, cerrar y revisar estadísticas.

GitHub Actions ejecuta tests, E2E en la imagen oficial de Playwright, construcción del contenedor y generación del ZIP. Ningún artefacto se publica si falla una fase requerida.
