# Creación y validación de preguntas

## Protocolo

1. Elegir banco, categoría y nivel conforme a su definición.
2. Reservar un `question_id` nuevo; nunca reciclar uno retirado o eliminado.
3. Construir `question_key` con `bank_id|question_id`.
4. Redactar pregunta, respuesta principal y explicación.
5. Asignar `status=active`, `random_order` nuevo y `order_key` estable sin alterar filas anteriores.
6. Añadir la fila al final del CSV de su categoría.
7. Actualizar `question_count` y `seed_version`.
8. Ejecutar `npm test`.
9. Someter el contenido a revisión humana antes de desplegar.

La plantilla está en `templates/question-bank.csv`.

## Criterios editoriales

- Una respuesta principal clara, breve y verificable.
- Enunciado autocontenido, concreto y sin trampas artificiales.
- Sin pistas que revelen la respuesta.
- Explicación breve que añada contexto.
- Evitar dependencia temporal salvo que una fecha de corte sea parte explícita.
- Evitar ambigüedad geográfica, terminológica o de edición.
- Revisar factualidad y dificultad por una segunda persona.

## Niveles vigentes

- `CUR`: contenido enseñado desde al menos los años setenta en la educación obligatoria española.
- `AUT`: fuera del currículo obligatorio general, pero fácilmente localizable y aprendible por una persona curiosa.
- `NIC`: exige formación profunda, aproximadamente nivel de graduado en la materia con buen dominio.

El motor admite otras escalas y cualquier número de niveles.

## CSV

UTF-8 estricto, sin BOM, coma, comillas dobles, CRLF y cabeceras ASCII `snake_case`. El validador comprueba estructura, obligatorios, claves, FKs, IDs, estados, `question_count`, duplicados de enunciado y `order_key`, interrogación, longitudes y ausencia literal de la respuesta en el enunciado. Los límites son 220 caracteres para pregunta, 120 para respuesta y 300 para explicación.
