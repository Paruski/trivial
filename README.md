# Trivial

Aplicación estática autosuficiente para GitHub Pages. Permite jugar con J1, J2 y J3 en cualquier combinación de 1 a 3 participantes, escogiendo categorías y niveles por partida.

## Datos canónicos

La semilla está en `data/` y usa CSV UTF-8 **sin BOM**, separador coma, comillas dobles y finales de línea CRLF (dialecto RFC 4180). Las cabeceras son ASCII estables. No hay una segunda semilla JSON.

- `players.csv`: jugadores.
- `categories.csv`: categorías.
- `levels.csv`: niveles.
- `questions-*.csv`: banco de preguntas por categoría.
- `matches.csv`, `participants.csv`, `attempts-*.csv`: histórico inicial ya consolidado.
- `exposures.csv`: exposiciones operativas; la semilla inicial limpia no conserva descartes históricos.
- `events.csv`: ledger inicial de eventos web.
- `meta.csv`: versión y metadatos de semilla.

Los CSV canónicos representan únicamente el **estado final aceptado**. Las rectificaciones ya incorporadas no se conservan como anotaciones de corrección y las preguntas retiradas de la semilla no permanecen como filas `discarded`. Durante una partida sí pueden existir eventos operativos de descarte, deshacer y rehacer en IndexedDB para garantizar consistencia; una futura consolidación de la semilla puede compactarlos de nuevo al estado final.

Al abrir la web, estos CSV se cargan automáticamente en IndexedDB. Cuando cambia `seed_version`, la base local se reconcilia con la nueva semilla de forma determinista: actualiza el histórico canónico y elimina de las tablas históricas los registros que ya no pertenecen a la semilla, sin borrar partidas locales nuevas. `Restaurar base original` vuelve exactamente a la semilla del repositorio.

## Selección de preguntas

La configuración de cada partida congela jugadores, categorías, niveles, semilla y pesos de nivel. El nivel de cada turno se selecciona con un PRNG determinista. Los pesos proceden de la composición original de la categoría y no disminuyen al consumirse preguntas; un nivel solo se elimina de la distribución cuando ya no tiene stock activo. Dentro del nivel elegido se sirve la siguiente pregunta por `random_order`.

## Desarrollo y despliegue

No hay backend ni dependencia de LLM. GitHub Actions ejecuta `node --test tests/*.mjs` y, si las pruebas pasan, publica la aplicación en GitHub Pages.
