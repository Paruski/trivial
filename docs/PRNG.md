# PRNG y selección

La selección de nivel ocurre antes que la de pregunta.

## Pesos

Cada nivel declara `probability_weight` en `levels.csv`. La escala actual fija CUR=70, AUT=20 y NIC=10. Al crear una partida se congelan esos pesos para cada categoría y nivel habilitado; si se habilita un subconjunto, se normalizan únicamente sus pesos declarados. Consumir preguntas nunca modifica el peso.

El sorteo conserva todos los pesos habilitados aunque un nivel se agote. Si el PRNG selecciona una combinación categoría+nivel sin stock, no sustituye su peso por el de otro nivel: registra `STOCK_EXHAUSTED`, muestra una alerta de reposición e incrementa el ordinal. Así la distribución no queda condicionada silenciosamente por la disponibilidad.

## Unidad determinista

`deterministicUnit` aplica FNV-1a de 32 bits y una mezcla entera reproducible a:

`match_seed | draw_ordinal | player_id | category_id`

El valor en `[0,1)` recorre acumulativamente los pesos congelados. Se registra junto a estos pesos en `QUESTION_DRAWN` o `STOCK_EXHAUSTED`. Dentro del nivel se selecciona la pregunta disponible con menor `order_key`.

Los descartes usan un nuevo `draw_ordinal` y repiten la misma regla 70/20/10 para generar la sustitución. Los draws revertidos siguen contando como vistos y dentro del ordinal bruto, por lo que un replay con la misma semilla y el mismo ledger produce el mismo resultado.
