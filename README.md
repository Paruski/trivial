# Trivial

Aplicación estática, autosuficiente y offline para GitHub Pages. No usa backend, APIs, hojas externas ni modelos durante el juego. Los CSV del repositorio son la única semilla canónica; IndexedDB conserva en cada navegador las partidas nuevas como un ledger append-only.

## Jugar

La versión publicada vive en `https://paruski.github.io/trivial/`. Una partida admite entre uno y tres jugadores disponibles y cualquier subconjunto no vacío de categorías y niveles que tenga stock. En cada turno se eligen explícitamente jugador, categoría y si se intenta quesito; el motor elige el nivel y la pregunta.

## Desarrollo

Requisitos: Node.js 22 o posterior.

```sh
npm ci
npm test
npx playwright install chromium
npm run test:e2e
```

Para servirla localmente:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

## Especificación

- [Arquitectura](docs/ARCHITECTURE.md)
- [Reglas y protocolo de juego](docs/RULES.md)
- [Modelo de datos, CSV y migraciones](docs/DATA_MODEL.md)
- [Creación y validación de preguntas](docs/QUESTIONS.md)
- [PRNG y selección](docs/PRNG.md)
- [Estadísticas](docs/STATISTICS.md)
- [Undo/redo, recuperación, copias y diagnóstico](docs/OPERATIONS.md)
- [Pruebas y CI/CD](docs/TESTING.md)

## Versiones canónicas

- `schema_version`: `6`
- `rules_version`: `trivial-rules-2.0.0`
- `seed_version`: `2026-08-19.4`

Estas versiones también están en `src/config.js` y `data/meta.csv`. GitHub Actions solo despliega Pages después de validar la semilla, superar las pruebas unitarias y completar el E2E en Chromium.
