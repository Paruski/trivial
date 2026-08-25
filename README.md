# Trivial · servidor PHP

Versión para servidor propio de la aplicación. El **motor de juego está en PHP**; JavaScript solo presenta la interfaz y envía acciones al servidor. Los CSV de `data/` son la semilla canónica y `var/state.json` contiene automáticamente las partidas nuevas y el diario de eventos.

## Ejecutar

Requisitos: PHP 8.2 o posterior.

```bash
git clone --branch server-auto https://github.com/Paruski/trivial.git
cd trivial
php -S 0.0.0.0:8080 router.php
```

Abrir `http://IP-DEL-SERVIDOR:8080` desde cualquier equipo de la red. No hay Composer, npm, Python, base de datos externa, claves administrativas ni configuración obligatoria.

Una vez clonado, **el servidor no se conecta a GitHub ni a ningún servicio externo**. No ejecuta `git fetch`, `git pull`, comprobaciones de versión ni llamadas HTTP salientes. Las futuras actualizaciones del código se hacen manualmente por el administrador del servidor.

## Persistencia

- `data/*.csv`: banco e histórico inicial incluidos con el código.
- `var/state.json`: partidas y eventos creados en el servidor.
- `var/state.json` se escribe de forma atómica y queda fuera de Git.
- Todas las pestañas y equipos conectados ven el mismo estado; el navegador consulta la revisión local del servidor cada 2 segundos.
- Se puede exportar/restaurar `state.json` desde la propia web.
- Las decisiones de juego nunca se envían a GitHub: se guardan únicamente en el servidor.

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
