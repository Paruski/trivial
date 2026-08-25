# Trivial · servidor PHP

Versión para servidor propio de la aplicación. El **motor de juego está en PHP**; JavaScript solo presenta la interfaz y envía acciones al servidor. Los CSV de `data/` son la semilla canónica y `var/state.json` contiene automáticamente las partidas nuevas y el diario de eventos.

## Ejecutar

Requisitos: PHP 8.2 o posterior. Git es opcional, pero necesario para la autoactualización.

```bash
git clone --branch server-auto https://github.com/Paruski/trivial.git
cd trivial
php -S 0.0.0.0:8080 router.php
```

Abrir `http://IP-DEL-SERVIDOR:8080` desde cualquier equipo de la red. No hay Composer, npm, Python, base de datos externa, claves administrativas ni configuración obligatoria.

## Persistencia

- `data/*.csv`: banco e histórico versionados en Git.
- `var/state.json`: partidas y eventos creados en el servidor.
- `var/state.json` se escribe de forma atómica y queda fuera de Git.
- Todas las pestañas y equipos conectados ven el mismo estado; el navegador consulta la revisión cada 2 segundos.
- Se puede exportar/restaurar `state.json` desde la propia web.

## Autoactualización

Por defecto PHP comprueba cada 5 minutos si la rama `server-auto` tiene una versión nueva y ejecuta:

```text
git pull --ff-only origin server-auto
```

El estado local no se toca porque `var/` está ignorado. Si hay modificaciones manuales en archivos versionados, `--ff-only` evita sobreescribirlas. Para desactivar la comprobación automática:

```bash
TRIVIAL_AUTO_UPDATE=0 php -S 0.0.0.0:8080 router.php
```

También hay un botón **Comprobar actualización** en la interfaz.

## Reglas implementadas

- 1, 2 o 3 jugadores entre J1/J2/J3.
- Selección explícita del jugador inicial; no se fuerza J1.
- Selección de cualquier subconjunto de categorías y niveles.
- Rotación automática de turno dentro de los participantes elegidos, comenzando por el jugador inicial.
- El nivel se elige mediante PRNG determinista antes de escoger la pregunta.
- Los pesos se congelan al crear la partida según la **composición original de cada categoría**, no según el stock restante.
- Si un nivel se agota, se excluye y los pesos restantes se renormalizan implícitamente sin alterar sus proporciones relativas.
- Dentro del nivel se usa la primera pregunta disponible por `random_order`.
- Una pregunta mostrada, administrada, retirada o expuesta no vuelve a servirse globalmente.
- Descartar intenta sustituir por otra pregunta del mismo nivel; si no hay, vuelve al selector ponderado.
- Quesitos, cierre por victoria, cierre manual, estadísticas históricas + nuevas, deshacer y rehacer por eventos append-only.

## Comprobaciones

```bash
php -l router.php
php -l lib/trivial.php
php tests_php/smoke.php
```

La rama `main` es independiente y contiene la versión estática para GitHub Pages.
