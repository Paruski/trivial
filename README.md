# Trivial · servidor PHP v2

Versión para servidor propio de la aplicación. El **motor de juego está en PHP**; JavaScript presenta la interfaz y envía acciones al servidor. Los CSV de `data/` son la semilla canónica y `var/state.json` contiene automáticamente las partidas nuevas y el diario de eventos.

## Ejecutar

Requisitos: PHP 8.2 o posterior.

```bash
git clone --branch server-auto-v2 https://github.com/Paruski/trivial.git
cd trivial
php -S 0.0.0.0:8080 router.php
```

Abrir `http://IP-DEL-SERVIDOR:8080` desde cualquier equipo de la red. No hay Composer, npm, Python, base de datos externa, claves administrativas ni configuración obligatoria.

Una vez clonado, **el servidor no se conecta a GitHub ni a ningún servicio externo**. No ejecuta comprobaciones de versión ni llamadas HTTP salientes. Las futuras actualizaciones del código se hacen manualmente por el administrador del servidor.

## Persistencia

- `data/*.csv`: banco e histórico inicial incluidos con el código.
- `var/state.json`: partidas y eventos creados en el servidor.
- `var/state.json` se escribe de forma atómica y queda fuera de Git.
- Todas las pestañas y equipos conectados ven el mismo estado; el navegador consulta la revisión local del servidor cada 2 segundos.
- Se puede exportar/restaurar `state.json` desde la propia web.
- Las decisiones de juego nunca se envían a GitHub: se guardan únicamente en el servidor.

## Reglas v2

- 1, 2 o 3 jugadores entre J1/J2/J3.
- Selección explícita del jugador inicial; no se fuerza J1.
- Selección de cualquier subconjunto de categorías y niveles.
- **Un acierto conserva el turno del mismo jugador.**
- **Un fallo pasa el turno al siguiente participante.**
- El marcador de la partida en curso aparece en la parte superior e indica claramente el turno actual y, por jugador, el número y las categorías de sus quesitos.
- Obtener todos los quesitos configurados no cierra la partida. En una partida estándar con las seis categorías son seis quesitos.
- Cuando la ficha llega físicamente al centro se registra aparte con la acción **He llegado al centro**.
- En el centro, los demás jugadores eligen la categoría de la pregunta final.
- Acertar esa pregunta final cierra la partida con `reason=victoria_centro`.
- Fallar en el centro pasa el turno al siguiente jugador y obliga a volver a llegar al centro en un turno posterior.
- El nivel se elige mediante PRNG determinista antes de escoger la pregunta.
- Los pesos se congelan al crear la partida según la composición original de cada categoría, no según el stock restante.
- Si un nivel se agota, se excluye y los pesos restantes se renormalizan sin alterar sus proporciones relativas.
- Dentro del nivel se usa la primera pregunta disponible por `random_order`.
- Una pregunta mostrada, administrada, retirada o expuesta no vuelve a servirse globalmente.
- Descartar intenta sustituir por otra pregunta del mismo nivel; si no hay, vuelve al selector ponderado.
- Quesitos, llegada al centro, resultados, cierre, deshacer y rehacer se conservan como eventos append-only.

## Compatibilidad de estado

La rama v2 reutiliza el mismo formato `schemaVersion=1` y puede leer partidas y eventos existentes de `var/state.json`. Los eventos nuevos de centro se añaden sin modificar los CSV históricos.

## Comprobaciones

```bash
php -l router.php
php -l lib/trivial.php
php -l lib/v2.php
node --check src/server-app-v2.js
php tests_php/smoke.php
php tests_php/v2.php
php tests_php/offline.php
```

La rama `server-auto` conserva la versión anterior. La rama `main` contiene la versión estática para GitHub Pages.
