# Reglas y protocolo de juego

## rules_version `trivial-rules-2.0.0`

Esta es la especificación normativa de la versión. Cada partida nueva congela este valor; una versión futura de las reglas debe usar otro identificador y conservar la reproducción de partidas existentes.

## Creación

Se elige un banco, entre uno y tres jugadores disponibles, al menos una categoría y al menos un nivel. Toda categoría habilitada debe disponer de alguna pregunta activa en los niveles elegidos. La partida congela `match_id`, `bank_id`, jugadores, categorías, niveles, `rules_version`, seed PRNG, pesos originales por categoría y nivel, y fecha.

## Turno

No hay rotación automática. Sin una pregunta pendiente, la interfaz exige:

1. jugador;
2. categoría;
3. indicación de intento de quesito;
4. `Sacar pregunta`.

El nivel no se muestra para elegirlo. `QUESTION_DRAWN` congela `draw_ordinal`, `random_unit`, `effective_weights`, jugador, categoría, `level_key`, `question_key` e intento de quesito. No se admite un segundo draw pendiente.

La respuesta y explicación solo aparecen después de `Mostrar respuesta`. Acierto, fallo y descarte quedan habilitados entonces.

## Descartes

Un descarte no es intento, no cambia de jugador y no afecta al quesito. La pregunta vista queda fuera del pool de esa partida. En la misma transacción se busca sustitución para idénticos jugador, categoría e intento de quesito: primero en el mismo nivel; si se agotó, por la selección determinista normal entre niveles restantes.

## Quesitos y victoria

Un quesito se gana solo cuando `quesito_attempt`, `correct` y “no poseído antes” son verdaderos. Un acierto ordinario no lo concede y una categoría no puede duplicarse por jugador. La victoria normal cierra la partida cuando un jugador posee todas las categorías habilitadas.

También se permite cierre manual, por tiempo límite, interrupción u otro motivo. El cierre conserva todas las personas con la máxima cantidad de quesitos; por tanto puede haber empate y nunca se fuerza un ganador único.
