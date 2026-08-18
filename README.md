# Trivial · GitHub Pages

Aplicación estática para dirigir partidas de Trivial desde un navegador, sin servidor y sin publicar el banco de preguntas.

## Funciones del MVP

- Crear cualquier número de partidas.
- Reutilizar jugadores entre partidas para estadísticas históricas.
- Activar cualquier subconjunto de categorías y niveles de un banco.
- Sacar la siguiente pregunta elegible respetando el orden del banco.
- Mostrar la respuesta cuando decida el anfitrión.
- Registrar acierto, fallo, intento de quesito y quesito obtenido.
- Descartar/contaminar una pregunta y excluirla globalmente.
- Deshacer y rehacer operaciones mediante un registro de eventos (no se destruye el histórico).
- Cerrar partidas con motivo de cierre y deshacer el cierre si fue accidental.
- Estadísticas por jugador, categoría y nivel.
- Copia completa JSON para migrar o recuperar el navegador.
- Importación CSV compatible con la pestaña `Banco` usada en Trivial.
- PWA básica: tras una primera carga puede seguir abriéndose con los recursos cacheados.

## Por qué el banco NO está en el repositorio

GitHub Pages publica los archivos del sitio. Si se incluyeran las preguntas y respuestas en JavaScript/JSON dentro del repositorio, cualquier visitante podría verlas desde el código fuente o las herramientas del navegador.

Por eso el repositorio contiene solo la aplicación. El anfitrión exporta su banco como CSV y lo carga localmente en la pestaña **Bancos**. IndexedDB conserva los datos en ese navegador.

Una copia completa (`trivial-backup-YYYY-MM-DD.json`) también contiene preguntas y respuestas: **no debe subirse a un repositorio público**.

## Desarrollo local

No hay dependencias de producción ni proceso de compilación.

```bash
python3 -m http.server 8080
```

Abrir `http://localhost:8080`.

Pruebas del dominio:

```bash
node --test tests/domain.test.mjs
```

## Publicación con GitHub Pages

El repositorio incluye `.github/workflows/pages.yml`. En GitHub:

1. Ve a **Settings → Pages**.
2. En **Build and deployment → Source**, selecciona **GitHub Actions**.
3. Haz push a `main`.

El workflow publica la raíz del repositorio como artefacto estático.

## Modelo de datos local

IndexedDB mantiene cinco grupos de datos principales:

- `banks`: metadatos de bancos, categorías y escalas/niveles.
- `questions`: preguntas de cada banco y estado (`active`, `retired`, `discarded`).
- `players`: jugadores globales reutilizables entre partidas.
- `matches`: configuración de cada partida.
- `events`: hechos de juego inmutables.

Los cambios de juego se representan con eventos como `QUESTION_DRAWN`, `RESULT_RECORDED`, `QUESTION_EXPOSED`, `MATCH_CLOSED`, `EVENT_REVERTED` y `EVENT_RESTORED`.

Las estadísticas se calculan a partir de los eventos activos, no se almacenan como totales editables.

## Siguiente evolución recomendada

- Importador directo de una exportación privada de la base relacional histórica actual.
- Selector de reglas por partida (número objetivo de quesitos, política de reutilización, etc.).
- Estadísticas por partida y comparativas temporales más avanzadas.
- Cifrado opcional de copias completas con Web Crypto.
- Sincronización multi-dispositivo solo si se añade deliberadamente un backend o un mecanismo de autenticación; no se debe incrustar un token de GitHub/Google en una web pública.
