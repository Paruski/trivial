# Trivial

Aplicación estática autosuficiente para GitHub Pages. Permite jugar con J1, J2 y J3 en cualquier combinación de 1 a 3 participantes, escogiendo categorías y niveles por partida.

## Datos canónicos

La semilla está en `data/` y usa CSV UTF-8 **sin BOM**, separador coma, comillas dobles y finales de línea CRLF (dialecto RFC 4180). Las cabeceras son ASCII estables. No hay una segunda semilla JSON.

- `players.csv`: jugadores.
- `categories.csv`: categorías.
- `levels.csv`: niveles.
- `questions-*.csv`: banco de preguntas por categoría.
- `matches.csv`, `participants.csv`, `attempts-*.csv`, `exposures.csv`: histórico inicial.
- `events.csv`: ledger inicial de eventos web.
- `meta.csv`: versión y metadatos de semilla.

Al abrir la web, estos CSV se cargan automáticamente en IndexedDB. Las partidas nuevas se guardan automáticamente en el navegador; `Restaurar base original` vuelve exactamente a la semilla del repositorio.

## Selección de preguntas

La configuración de cada partida congela jugadores, categorías, niveles, semilla y pesos de nivel. El nivel de cada turno se selecciona con un PRNG determinista. Los pesos proceden de la composición original de la categoría y no disminuyen al consumirse preguntas; un nivel solo se elimina de la distribución cuando ya no tiene stock activo. Dentro del nivel elegido se sirve la siguiente pregunta por `random_order`.

## Desarrollo y despliegue

No hay backend ni dependencia de LLM. GitHub Actions ejecuta `node --test tests/*.mjs` y, si las pruebas pasan, publica la aplicación en GitHub Pages.
