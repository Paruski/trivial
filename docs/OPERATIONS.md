# Undo/redo, recuperación, copias y diagnóstico

## Undo/redo

El ledger es append-only. Deshacer añade `EVENT_REVERTED`; rehacer añade `EVENT_RESTORED`. Un `action_id` agrupa operaciones como resultado+cierre por victoria o descarte+sustitución. La proyección ignora eventos de dominio revertidos, pero el pool considera todos los `QUESTION_DRAWN` brutos: una pregunta vista nunca vuelve silenciosamente a inédita.

Después de deshacer, una acción de dominio nueva invalida el redo anterior. Ni undo ni redo borran filas ni reutilizan `seq`.

## Atomicidad y pestañas

Creación de partida, eventos de una acción, descarte+retirada+sustitución y restauración completa usan una única transacción. La serialización usa Web Locks cuando está disponible. IndexedDB, su índice único `(match_id, seq)` y las claves de idempotencia son el fallback seguro. BroadcastChannel refresca otras pestañas; sin él, una recarga reconstruye el mismo estado.

Cerrar el navegador antes del commit aborta toda la transacción. Después del commit, el replay es suficiente: no hay proyecciones web parciales que reparar.

## Copias

Exportar crea JSON con todas las stores y versiones. Importar valida formato, arrays, IDs, FKs básicas, secuencias, idempotencia y controles antes de abrir la transacción que sustituye el estado. Un error deja intacta la base existente.

## Diagnóstico

La pestaña comprueba IDs de pregunta/evento, FKs, `question_count`, duplicados de `seq`, intentos huérfanos, terminales huérfanos o duplicados, pendientes incoherentes, quesitos imposibles o duplicados, `seed_version` y `schema_version`. También alerta sobre stock cero por categoría+nivel y retiradas locales. Muestra tipo e ID, no el texto de preguntas jugables.

Ante una incidencia, primero exportar una copia, anotar los IDs informados y recargar. `Restaurar base original` es deliberadamente destructivo para las partidas locales y requiere confirmación.
