# Arquitectura

## Componentes

1. `data/*.csv`: semilla canónica, versionada y legible.
2. `server/seed.py`: decodificación, validación y hash de la semilla.
3. `server/storage.py`: esquema SQLite, WAL, transacciones, sesiones y reconciliación.
4. `server/domain.py`: reglas autoritativas, PRNG, replay y acciones.
5. `server/statistics.py`: proyecciones e inferencia estadística.
6. `server/maintenance.py`: diagnóstico, backup, restauración y reset.
7. `server/api.py`: HTTP, API JSON, seguridad, estáticos y vigilancia de CSV.
8. `src/`: cliente sin persistencia canónica.
9. `sw.js`: caché del shell; nunca cachea `/api/`.

## Fuente de verdad

Los catálogos y preguntas nacen en CSV. El estado operativo vive en SQLite. Una retirada se guarda en `question_retirements`, por lo que no modifica silenciosamente la semilla. Al cambiar cualquier CSV, el servidor valida el conjunto completo y lo aplica en una transacción; conserva partidas y eventos web, y vuelve a superponer las retiradas globales.

El navegador mantiene únicamente estado efímero de interfaz y una cookie aleatoria HttpOnly. Si pierde la conexión puede abrir el shell cacheado, pero no inventa ni encola jugadas: una escritura solo se confirma cuando SQLite la acepta.

## Concurrencia y recuperación

SQLite usa WAL, claves únicas y `BEGIN IMMEDIATE`. El proceso HTTP atiende en hilos y serializa las secciones de escritura. Estadísticas, bootstrap y copias leen snapshots transaccionales coherentes. Cada llamada mutadora exige una clave de idempotencia permanente y acotada a sesión y recurso; `api_requests` devuelve la primera respuesta ante reintentos. Un fallo antes del commit revierte toda la operación.

Al iniciar, el servidor ejecuta las comprobaciones de integridad y FKs y reconstruye desde eventos el estado proyectado de las partidas web. Las inconsistencias de proyección reparables no requieren intervención manual.

Las partidas pertenecen a la sesión que las crea. Otras sesiones pueden verlas, pero no mutarlas. Las operaciones globales requieren `TRIVIAL_ADMIN_TOKEN`.

## Despliegue

El proceso se ejecuta una sola vez por base SQLite, detrás de un proxy HTTPS. El proxy debe preservar `Host` y enviar `X-Forwarded-Proto: https`. El volumen `var/` debe ser persistente y escribible por el UID del contenedor.
