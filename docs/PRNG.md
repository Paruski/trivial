# PRNG y selección

La selección de nivel ocurre antes que la de pregunta.

## Pesos

Al crear una partida se cuenta, para cada categoría y nivel habilitado, la composición completa y original del banco actual. Estos enteros se congelan en `level_weights`. Consumir preguntas no reduce el peso mientras el nivel tenga stock. Cuando se agota, se elimina del conjunto efectivo y se mantienen sin renormalizar los pesos originales restantes; normalizarlos para probabilidad conserva sus proporciones.

## Unidad determinista

`deterministicUnit` aplica FNV-1a de 32 bits y una mezcla entera reproducible a:

`match_seed | draw_ordinal | player_id | category_id`

El valor en `[0,1)` recorre acumulativamente los pesos efectivos. Se registra junto a estos pesos en `QUESTION_DRAWN`. Dentro del nivel se selecciona la pregunta disponible con menor `order_key`.

Los descartes fuerzan primero el nivel anterior. Si está agotado, usan un nuevo `draw_ordinal` y la misma regla de nivel. Los draws revertidos siguen contando como vistos y dentro del ordinal bruto, por lo que un replay con la misma semilla y el mismo ledger produce el mismo resultado.
