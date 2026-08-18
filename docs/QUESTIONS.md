# Creación y validación de preguntas

## Protocolo

1. Copiar `templates/question-bank.csv` o editar el archivo de preguntas del banco actual.
2. Reservar un `question_id` nuevo que nunca haya sido usado. No recuperar IDs desde Git ni reutilizar eliminados.
3. Construir `question_key` como `bank_id|question_id`.
4. Usar una categoría existente del mismo banco y un `level_key` existente.
5. Escribir enunciado, respuesta principal breve, explicación breve, `status=active`, `random_order` y un `order_key` estable.
6. Ejecutar `node scripts/normalize-data.mjs` para normalizar comillas y CRLF.
7. Actualizar `question_count` y `seed_version`.
8. Ejecutar `npm test` y el E2E.

## Criterios editoriales

- una respuesta principal clara y verificable;
- enunciado autocontenido y preciso;
- sin trampas artificiales ni respuesta revelada en el propio enunciado;
- explicación breve que justifique la respuesta;
- evitar dependencia temporal innecesaria;
- revisar duplicados semánticos además del detector exacto.

La escala actual contiene `CUR` (curricular), `AUT` (autodidacta) y `NIC` (nicho), pero ninguna regla del motor depende de esos valores ni de que sean tres.

## Orden estable

Las preguntas se sirven por menor `order_key` dentro del nivel. El patrón actual es `bank_id|random_order` con relleno a seis cifras `|question_id`. Añadir una fila puede ocupar una posición nueva, pero jamás debe cambiar el `order_key` de preguntas antiguas ni su orden relativo.

Cambiar categoría o nivel de una pregunta solo afecta partidas futuras: eventos e intentos históricos conservan sus snapshots.
