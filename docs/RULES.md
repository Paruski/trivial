# Reglas y protocolo de juego

## rules_version `trivial-rules-3.0.0`

Esta es la especificación normativa de la versión. Cada partida nueva congela este valor; una versión futura de las reglas debe usar otro identificador y conservar la reproducción de partidas existentes.

## Creación

Se elige un banco, entre uno y tres jugadores disponibles, al menos una categoría y al menos un nivel. Toda categoría habilitada debe disponer de alguna pregunta activa en los niveles elegidos. La partida congela `match_id`, `bank_id`, jugadores, categorías, niveles, `rules_version`, seed PRNG, pesos fijos por categoría y nivel, y fecha.

## Turno

El marcador siempre muestra el turno actual y no existe rotación automática. El primer turno corresponde al primer jugador configurado. El jugador que realmente respondió se indica al comunicar el resultado y pasa a ser el turno visible siguiente tanto si acertó como si falló; la aplicación nunca elige por sí sola a otra persona. Sin una pregunta pendiente, la interfaz exige:

1. categoría;
2. indicación de intento de quesito;
3. `Sacar pregunta`.

El nivel no se muestra para elegirlo. `QUESTION_DRAWN` congela `draw_ordinal`, `random_unit`, `effective_weights`, jugador, categoría, `level_key`, `question_key` e intento de quesito. No se admite un segundo draw pendiente.

La respuesta y explicación solo aparecen después de `Mostrar respuesta`. Entonces se elige el jugador que respondió y se registra acierto o fallo; el descarte también queda habilitado.

## Descartes

Un descarte no es intento, no cambia de jugador y no afecta al quesito. La pregunta comprometida se marca como retirada en IndexedDB y queda fuera de todas las partidas locales nuevas. En la misma transacción se registran el descarte, la retirada y, si existe, una sustitución de la misma categoría e intento de quesito mediante un nuevo sorteo 70/20/10. Undo no vuelve a convertir una pregunta vista o retirada en inédita. `Restaurar base original` elimina las retiradas locales y recupera exactamente los CSV actuales.

## Quesitos y victoria

Un quesito se gana solo cuando `quesito_attempt`, `correct` y “no poseído antes” son verdaderos. Un acierto ordinario no lo concede y una categoría no puede duplicarse por jugador. La victoria normal cierra la partida cuando un jugador posee todas las categorías habilitadas.

También se permite cierre manual, por tiempo límite, interrupción u otro motivo. El cierre conserva todas las personas con la máxima cantidad de quesitos; por tanto puede haber empate y nunca se fuerza un ganador único.
