# Operación, seguridad y diagnóstico

## Variables

- `TRIVIAL_HOST`: interfaz; por defecto `127.0.0.1`.
- `TRIVIAL_PORT`: puerto; por defecto `8080`.
- `TRIVIAL_DATABASE`: ruta SQLite; por defecto `var/trivial.sqlite3`.
- `TRIVIAL_ADMIN_TOKEN`: activa backup, importación, reset y recarga manual.
- `TRIVIAL_SECURE_COOKIE`: debe ser `true` bajo HTTPS.

La clave administrativa debe ser larga, aleatoria y distinta de otras credenciales. No debe incluirse en el ZIP, Git ni JavaScript.

## Publicación HTTPS

El proceso debe ser único para cada fichero SQLite. Un proxy puede publicar el servicio así:

```nginx
server {
    listen 443 ssl http2;
    server_name trivial.example.org;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Los certificados y límites de acceso se gestionan en el proxy. El servicio no necesita permisos de escritura sobre el código ni los CSV; solo sobre `var/`.

## Actualización automática del banco

El servidor inspecciona `data/*.csv` cada cinco segundos. Un cambio válido se aplica entero en una transacción y aumenta la revisión que reciben las pestañas; uno inválido se rechaza, conserva la última semilla válida y activa las alertas de salud, interfaz y diagnóstico. En Docker, se publica una nueva versión reconstruyendo la imagen; con una instalación descomprimida pueden sustituirse los CSV de forma atómica y el proceso los detectará sin reiniciarse.

## Endpoints operativos

- `GET /api/health`: SQLite, semilla y revisión.
- `GET /api/diagnostics`: integridad detallada sin enunciados.
- `GET /api/revision`: sincronización ligera entre pestañas.
- `GET /api/admin/backup`: copia JSON autenticada.
- `POST /api/admin/restore`: validación y restauración atómica.
- `POST /api/admin/reset`: elimina estado web y recarga CSV.
- `POST /api/admin/reload-seed`: fuerza validación y sincronización.

## Copias

La copia lógica contiene partidas web, participantes, eventos y retiradas leídos en un único snapshot. Incluye digest y versión de la semilla; una importación contra otra semilla se rechaza. Validación e importación comparten una transacción. No contiene cookies, sesiones ni claves.

Además debe copiarse periódicamente el archivo SQLite mediante una herramienta compatible con SQLite o deteniendo brevemente el contenedor. No se debe copiar únicamente el fichero principal ignorando `-wal` mientras el servidor escribe.

## Diagnóstico

Comprueba `integrity_check`, FKs, conteos, eventos y secuencias duplicados, terminales huérfanos, preguntas pendientes, proyección de cierre, quesitos incoherentes o duplicados, versiones, carga de semilla y stock bajo o cero. Los mensajes muestran IDs y tipos, no enunciados jugables.

## Restauración

`Restaurar base original` elimina partidas web y retiradas globales y vuelve exactamente a los CSV presentes. Nunca consulta el historial de Git. Exige confirmación en la interfaz y clave administrativa.
