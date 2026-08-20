# Modelo de datos y migraciones

## Identidades

- `question_key = bank_id + "|" + question_id`
- `category_key = bank_id + "|" + category_id`
- `level_key = scale_id + "|" + level_id_local`
- `(match_id, seq)` identifica la posición de un evento.

Los IDs son opacos y no se reutilizan. Los eventos congelan categoría, nivel, jugador y una copia de pregunta, respuesta y explicación para que una edición futura del banco no reescriba una partida.

## Tablas SQLite

- Catálogo: `banks`, `categories`, `levels`, `questions`, `players`.
- Juego: `matches`, `participants`, `events`.
- Histórico importado: `historical_attempts`.
- Operación: `question_retirements`, `sessions`, `api_requests`, `runtime_meta`.

`events` impone unicidad en `event_id`, `(match_id, seq)` e `idempotency_key`. `question_retirements` impone una sola retirada global por pregunta.

## Migración de semilla

El servidor calcula SHA-256 sobre nombre y bytes de todos los CSV cada cinco segundos. Si cambia:

1. decodifica y valida el conjunto completo fuera de la transacción;
2. abre `BEGIN IMMEDIATE`;
3. reemplaza catálogos e histórico propiedad de la semilla;
4. conserva partidas, participantes y eventos creados en la web;
5. elimina retiradas cuyo `question_key` ya no exista;
6. actualiza `seed_version`, digest y revisión;
7. confirma de forma atómica.

Una semilla inválida se rechaza y la base anterior sigue operativa. Diagnóstico y `/api/health` muestran el error.

## Schema técnico

`PRAGMA user_version=8` identifica la primera versión SQLite del servidor. Una base con versión desconocida se rechaza antes de servir para evitar una migración destructiva o implícita. Las futuras versiones deben añadir una migración explícita y mantener los backups JSON del esquema anterior como fixture de prueba.
