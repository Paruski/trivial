# Pruebas y CI/CD

`npm test` valida los CSV y ejecuta pruebas Node sin red. Cubren combinaciones de jugadores, subconjuntos de categorías/niveles, jugador manual, congelación, PRNG, pesos, agotamiento, orden, quesitos, descartes, replay, undo/redo, idempotencia conceptual, estadísticas, copias y diagnóstico.

`npm run test:e2e` usa Chromium real. El caso crea J1+J3, configura categorías/niveles, juega explícitamente con J3 y J1, registra acierto y fallo de quesito, descarta con sustitución, hace undo/redo, recarga, verifica persistencia, abre otra pestaña, cierra y revisa estadísticas.

GitHub Actions tiene tres compuertas:

1. `test`: `npm ci` y `npm test`;
2. `e2e`: instala Chromium y ejecuta Playwright;
3. `deploy`: publica el checkout estático en Pages solo si las dos anteriores pasan.

Un informe Playwright se conserva como artefacto durante siete días si falla el E2E.
