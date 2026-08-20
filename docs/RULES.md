# Reglas y protocolo

## `rules_version = trivial-rules-4.0.0`

Cada partida congela esta versión. Cambiar reglas exige otro identificador; el replay de partidas existentes conserva el suyo.

## Creación

Se elige banco, entre uno y tres jugadores, un subconjunto no vacío de categorías y un subconjunto no vacío de niveles. Cada categoría debe tener stock operativo en la configuración. Se congelan `match_id`, banco, jugadores, categorías, niveles, reglas, seed PRNG, pesos, instantánea de catálogo y fecha.

## Turno

No hay rotación automática. Antes de cada pregunta se elige explícitamente jugador y categoría y se indica si es intento de quesito. El usuario nunca elige el nivel. No se admite otra pregunta mientras exista una pendiente.

Al mostrar respuesta aparecen respuesta, explicación y selector de quién respondió. Un resultado cierra la pregunta y deja el turno siguiente sin seleccionar.

## Descarte

Puede hacerse antes o después de revelar. No cuenta como intento, no concede quesito ni cambia el jugador congelado. Exige motivo, retira globalmente la pregunta y crea una sustitución en la misma transacción. Mantiene nivel si queda stock; en caso contrario aplica el PRNG a los niveles restantes.

Undo no elimina la retirada global ni convierte preguntas vistas en inéditas.

## Quesitos y victoria

Se concede un quesito únicamente cuando `quesito_attempt`, `correct` y “no poseído” son verdaderos. El jugador que realmente respondió recibe el resultado. Un acierto ordinario no concede quesito y no puede duplicarse una categoría.

La victoria normal cierra cuando un jugador posee todas las categorías habilitadas. También hay cierre manual, por tiempo límite, interrupción u otro motivo. En cierres no ordinarios se conservan todos los jugadores empatados con la máxima cantidad; nunca se inventa un ganador único.

## Eventos y rectificación

Tipos: `MATCH_CREATED`, `TURN_SELECTED`, `QUESTION_DRAWN`, `ANSWER_REVEALED`, `RESULT_RECORDED`, `QUESTION_DISCARDED`, `MATCH_CLOSED`, `EVENT_REVERTED`, `EVENT_RESTORED`.

Cada evento tiene ID, partida, secuencia, timestamp, tipo, versión, acción, idempotencia y payload. Undo/redo añade eventos de control; nunca edita ni borra el ledger.
