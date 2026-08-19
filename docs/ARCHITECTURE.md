# Arquitectura

## Límites

La aplicación se sirve como archivos estáticos desde GitHub Pages. El navegador descarga HTML, CSS, módulos JavaScript y CSV; todo el juego sucede localmente. No existe una ruta de red de juego ni una dependencia de servicios externos.

## Capas

1. `data/*.csv`: semilla canónica limpia. No contiene tombstones de preguntas eliminadas ni anotaciones de rectificaciones resueltas.
2. `src/csv.js` y `src/seed.js`: decodificación estricta, mapeo y validación de semilla.
3. `src/domain.js`: reglas puras, replay, PRNG, pesos, stock, quesitos y undo/redo.
4. `src/db.js`: IndexedDB, migraciones, transacciones atómicas, Web Locks y BroadcastChannel.
5. `src/stats.js`, `src/diagnostics.js` y `src/backup.js`: proyecciones derivadas, integridad y transporte del estado.
6. `src/app.js`: interfaz; no contiene decisiones aleatorias propias.
7. `sw.js`: caché offline versionada conjuntamente por build y seed.

## Principios de estado

- Los CSV de preguntas son inmutables durante el juego. Un descarte crea una retirada local persistente en la fila IndexedDB correspondiente; una migración conserva esa marca y el reset la elimina.
- El stock operativo es pregunta activa local menos toda pregunta que haya aparecido en un `QUESTION_DRAWN` de esa partida, incluso si luego se deshace un resultado.
- Las partidas web nuevas se reconstruyen desde eventos. No dependen de una proyección de intentos susceptible de quedar a medias.
- El histórico canónico anterior permanece en `attempts-*.csv`; los cambios de una pregunta futura no reescriben sus `category_id` ni `level_key` ya congelados.
- Todas las operaciones lógicamente atómicas usan una única transacción. Un descarte, su retirada local y su posible sustitución se confirman juntos.

## Multidimensionalidad

El motor no presupone IDs concretos, seis categorías ni tres niveles. `bank_id` selecciona el banco; las categorías se relacionan por `category_key`; `level_key` incorpora su escala; jugadores, categorías y niveles se recorren desde datos. La restricción de uno a tres jugadores es una regla de creación, no una codificación de J1/J2/J3.
