# PRNG y selección

## Unidad determinista

Para cada sorteo se calcula SHA-256 de:

```text
match_seed | draw_ordinal | player_id | category_id
```

Los primeros 64 bits, interpretados como entero sin signo, se dividen por `2^64`. El resultado pertenece a `[0,1)` y no depende del reloj, del proceso ni del navegador.

## Nivel

La partida congela los pesos declarados por los niveles habilitados. La escala vigente usa CUR=70, AUT=20 y NIC=10. En cada sorteo:

1. se obtiene el stock inédito y no retirado de la categoría;
2. se excluyen los niveles agotados;
3. se conservan los pesos originales de los restantes, que equivalen a normalizar sus proporciones relativas;
4. la unidad determinista selecciona el intervalo acumulado.

Consumir preguntas no modifica el peso mientras el nivel tenga stock. `QUESTION_DRAWN` registra unidad, pesos efectivos, ordinal, jugador, categoría, nivel y pregunta.

## Pregunta

Dentro del nivel se elige el menor par `(order_key, question_key)`. No se usa azar adicional. Toda pregunta que haya aparecido en cualquier `QUESTION_DRAWN` de la partida queda vista, incluso si después se deshace el resultado.

## Sustitución

Tras un descarte se mantiene el nivel si conserva stock. Solo cuando se agota se repite la selección ponderada entre los niveles restantes. La sustitución tiene un nuevo `draw_ordinal` y conserva jugador, categoría e intento de quesito.
