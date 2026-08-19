# Modelo de datos, CSV y migraciones

## Claves

- `question_key = bank_id + "|" + question_id`
- `level_key = scale_id + "|" + level_id_local`
- `category_key = bank_id + "|" + category_id`

Los IDs se tratan como opacos. No deben reciclarse tras eliminar una fila.

## Semilla CSV

Todos los archivos de `data/` son UTF-8 sin BOM, coma, comillas dobles, CRLF y estructura RFC 4180. Las cabeceras son ASCII `snake_case`. JSON aparece únicamente dentro del campo citado `level_weights_json` de una partida histórica o como payload citado de eventos y copias; no existe una segunda semilla JSON.

Tablas: bancos, categorías por banco, niveles por escala, preguntas, jugadores, partidas históricas, participantes, intentos históricos, exposiciones y eventos históricos. Cada nivel declara un `probability_weight` positivo; la escala vigente usa 70/20/10. Las preguntas pueden dividirse físicamente en varios CSV sin cambiar la identidad lógica del banco.

`npm run validate:data` comprueba decodificación, estructura, columnas, obligatorios, claves construidas, IDs, FKs, duplicados exactos de enunciado, estados y `question_count`.

## Eventos

Cada evento tiene `event_id`, `match_id`, `seq`, `timestamp`, `type`, `schema_version`, `action_id`, `idempotency_key` opcional y `payload`. `(match_id, seq)` e `idempotency_key` son índices únicos. Tipos mínimos: `MATCH_CREATED`, `QUESTION_DRAWN`, `ANSWER_REVEALED`, `RESULT_RECORDED`, `QUESTION_DISCARDED`, `MATCH_CLOSED`, `EVENT_REVERTED` y `EVENT_RESTORED`. `STOCK_EXHAUSTED` audita sorteos que alcanzan un nivel sin stock sin renormalizar probabilidades.

## Migraciones

IndexedDB usa una versión técnica independiente de `schema_version`. Al abrir:

1. crea o actualiza stores e índices;
2. normaliza eventos locales del esquema anterior (`ts` a `timestamp` y versión del evento);
3. carga y valida todos los CSV;
4. si cambió `seed_version`, sustituye filas propiedad de la semilla, conserva partidas/eventos locales y vuelve a aplicar las retiradas locales de preguntas comprometidas;
5. elimina de la propiedad de seed filas que ya no aparecen, sin mantener listas permanentes de IDs eliminados.

`Restaurar base original` borra el estado local completo y carga exactamente los CSV presentes. Nunca consulta el historial Git.
