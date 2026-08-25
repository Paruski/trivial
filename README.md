# Trivial · servidor PHP

Versión definitiva para servidor propio. El navegador sirve `public/index.html`; ese índice declara `api.php` como endpoint y el JavaScript llama exclusivamente a ese PHP por misma-origen. El motor de juego está en `lib/trivial.php`, el banco e histórico inicial en `data/` y el estado vivo en `var/state.json`.

## Clonar y servir

Requisito: PHP 8.2 o posterior.

```bash
git clone --branch server --single-branch https://github.com/Paruski/trivial.git
cd trivial
php -S 0.0.0.0:8080 -t public
```

Abre `http://IP-DEL-SERVIDOR:8080/` desde los equipos de la red.

Si quieres borrar incluso la referencia local al repositorio después de clonar:

```bash
git remote remove origin
```

No hay Composer, npm, Python, base de datos externa, claves administrativas ni configuración obligatoria para ejecutar la aplicación.

## Despliegue con Apache o Nginx

Configura **`public/` como DocumentRoot / web root** y habilita PHP 8.2+. El proceso PHP debe tener permiso de lectura sobre `data/` y `lib/`, y permiso de escritura sobre `var/`.

No publiques la raíz completa del repositorio: `data/`, `lib/` y `var/` están deliberadamente fuera de `public/`, de modo que ni el banco con respuestas ni `state.json` puedan descargarse como archivos estáticos.

## Arquitectura

```text
navegador
   │
   ├── public/index.html
   ├── public/styles.css
   └── public/src/server-app.js
              │
              └── public/api.php?path=/api/...
                         │
                         └── lib/trivial.php
                              ├── data/*.csv      (semilla e histórico)
                              └── var/state.json  (partidas nuevas)
```

`index.html` fija explícitamente `window.TRIVIAL_API_ENDPOINT = 'api.php'`. Todas las operaciones de juego, estadísticas, backup y restauración pasan por ese PHP. No hay `git fetch`, `git pull`, comprobaciones remotas ni llamadas HTTP salientes en el runtime.

## Persistencia

- `data/*.csv`: banco e histórico inicial incluidos con el código.
- `var/state.json`: partidas y eventos creados en el servidor.
- La escritura de `state.json` es atómica y está protegida con bloqueo de archivo.
- `var/` está fuera de Git salvo `var/.gitkeep`.
- Todas las pestañas y equipos conectados comparten el mismo estado; el navegador consulta la revisión del PHP cada 2 segundos.
- La web permite exportar y restaurar una copia JSON del estado.

## Reglas implementadas

- 1, 2 o 3 jugadores entre J1/J2/J3.
- Selección explícita del jugador inicial.
- Cualquier subconjunto de categorías y niveles.
- Rotación automática de turno.
- Nivel elegido mediante PRNG determinista con pesos congelados al crear la partida.
- Dentro del nivel se usa la primera pregunta disponible por `random_order`.
- Una pregunta mostrada, administrada, retirada o expuesta no vuelve a servirse globalmente.
- Descartar intenta sustituir por otra pregunta del mismo nivel y, si no hay, vuelve al selector ponderado.
- Quesitos, cierre por victoria, cierre manual, estadísticas históricas + nuevas y deshacer/rehacer por eventos append-only.

## Comprobaciones

```bash
php -l public/api.php
php -l lib/trivial.php
node --check public/src/server-app.js
php tests_php/smoke.php
php tests_php/offline.php
```

La CI además levanta `php -S ... -t public`, comprueba que `index.html` puede hablar con `api.php`, valida `/api/health` y `/api/bootstrap`, y verifica que `data/` y `var/` no sean accesibles por HTTP.

La rama `main` sigue siendo independiente y contiene la versión estática histórica para GitHub Pages. La rama definitiva de servidor es `server`.
