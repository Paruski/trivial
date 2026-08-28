# Trivial · servidor PHP v2

Aplicación autocontenida para servidor propio. La **interfaz y las reglas** viven en el código; los **temas, niveles y preguntas** viven en CSV y pueden estar fuera del directorio de la web. El estado de las partidas se guarda aparte en JSON local del servidor.

## Ejecutar

Requisito: PHP 8.2 o posterior.

```bash
git clone --branch server-auto-v2 https://github.com/Paruski/trivial.git
cd trivial
php -S 0.0.0.0:8080 router.php
```

Abrir `http://IP-DEL-SERVIDOR:8080`.

No requiere Composer, npm, Python ni una base SQL. Durante su ejecución no consulta GitHub ni servicios externos.

## Arquitectura

```text
index.html + styles.css + src/app.js   interfaz
                 │
                 ▼
             router.php                API + allowlist de estáticos
                 │
        ┌────────┴─────────┐
        ▼                  ▼
 lib/game.php        lib/storage.php    reglas / estado de partidas
        │
        ▼
 lib/content.php                          cargador e índice de contenido
        │
        ▼
 TRIVIAL_DATA_DIR                         CSV externos
```

El navegador nunca lee directamente los CSV. PHP los valida, indexa y sirve solo los datos necesarios a través de la API. `router.php` no publica `data/`, `var/`, `lib/` ni los tests como ficheros web.

## Contenido fuera de la web

Para separar completamente código y contenido:

```bash
TRIVIAL_DATA_DIR=/srv/trivial-data \
TRIVIAL_VAR_DIR=/srv/trivial-state \
php -S 0.0.0.0:8080 router.php
```

`TRIVIAL_DATA_DIR` puede ser un volumen, una carpeta gestionada por otra herramienta o un montaje de red. No necesita estar dentro del repositorio. `TRIVIAL_VAR_DIR` contiene `state.json` y los bloqueos de escritura.

Si no se definen, se usan `data/` y `var/` del proyecto para conservar compatibilidad con instalaciones existentes.

## Cómo escalar temas y preguntas

Los temas **no están escritos a mano en PHP o JavaScript**. Para añadir uno:

1. añadir una fila a `categories.csv`;
2. añadir preguntas con ese `bank_id` y `category_id` en cualquier CSV descubierto;
3. no modificar el motor ni la interfaz.

El cargador descubre automáticamente:

- `questions-*.csv` en la raíz de datos;
- cualquier `.csv` dentro de `questions/`, también en subdirectorios;
- `attempts-*.csv` y CSV dentro de `attempts/` para histórico opcional.

Esto permite fragmentar bancos grandes, por ejemplo:

```text
/srv/trivial-data/
  meta.csv
  banks.csv
  categories.csv
  levels.csv
  players.csv
  exposures.csv
  questions/
    arte/0001.csv
    arte/0002.csv
    historia/0001.csv
    ciencia/0001.csv
```

Los ficheros pueden agrupar una o varias categorías; el vínculo real está en las columnas `bank_id`, `category_id` y `level_key`.

### CSV obligatorios

- `meta.csv`
- `banks.csv`
- `categories.csv`
- `levels.csv`
- `players.csv`
- al menos un CSV de preguntas

### Esquema de preguntas

Campos obligatorios:

```text
question_key,bank_id,question_id,category_id,level_key,prompt,answer
```

Campos admitidos por el motor actual:

```text
explanation,status,random_order,order_key
```

`status=active` hace jugable una pregunta. El orden dentro del nivel se basa en `random_order` y después `question_key`.

### Esquema de temas

`categories.csv` admite:

```text
bank_id,category_id,category_key,label,color,color_css,emoji,active,quesito_default
```

`color_css` debe contener un color CSS (por ejemplo `#3b82f6`); evita que la presentación dependa de nombres de color escritos en un idioma concreto.

## Recarga de contenido

El servidor calcula una firma con nombres, tamaño y marcas de modificación de los CSV. Si se añade, sustituye o modifica un CSV, la siguiente petición vuelve a validar e indexar el contenido automáticamente. No hace falta modificar el código ni reiniciar PHP.

Una ampliación inválida no se mezcla silenciosamente: el API devuelve un error hasta que el conjunto CSV vuelva a ser coherente.

## Validaciones de escalabilidad y consistencia

Al cargar los datos se comprueba, entre otras cosas:

- claves de banco, nivel, jugador, categoría y pregunta duplicadas;
- categorías que apuntan a bancos inexistentes;
- preguntas que apuntan a banco, tema o nivel inexistente;
- enunciados activos exactamente duplicados tras normalizar espacios y mayúsculas/minúsculas;
- estructura irregular de CSV;
- recarga al añadir nuevos fragmentos de preguntas.

Los bancos ya no dependen de mantener manualmente `question_count`: el motor calcula el total real de preguntas. Si el valor declarado difiere, se registra como aviso de diagnóstico.

`GET /api/diagnostics` expone conteos, ficheros de contenido y avisos sin publicar el contenido jugable completo.

## Escalabilidad

La parte diseñada para crecer es **contenido**:

- número de temas/categorías: dinámico;
- número de bancos: dinámico;
- número de niveles: dinámico;
- número de CSV de preguntas: dinámico;
- número de preguntas: ampliable mediante fragmentos;
- selección de preguntas: usa índices por banco → tema → nivel, evitando recorrer todo el banco en cada sorteo.

Los jugadores siguen siendo un catálogo pequeño (`players.csv`) y cada partida admite de 1 a 3 participantes. No se ha diseñado una capa de cuentas, registro o escalado masivo de usuarios porque no es un requisito del juego.

El estado operativo sigue en `state.json`. Es adecuado para un único servidor y un grupo pequeño de jugadores. Si en el futuro se quisiera escalar a muchas partidas concurrentes, `storage.php` es el único módulo que habría que sustituir por SQLite/PostgreSQL; el contenido CSV y las reglas no dependen de ese formato.

## Reglas v2

- un acierto conserva el turno;
- un fallo pasa el turno al siguiente participante;
- el marcador muestra turno y quesitos por jugador;
- conseguir todos los quesitos no da la victoria;
- la llegada física al centro se registra por separado;
- los demás jugadores eligen la categoría de la pregunta final;
- acertar en el centro gana;
- fallar en el centro cambia el turno, pero la ficha permanece en el centro hasta el siguiente intento;
- una pregunta mostrada, retirada o expuesta no vuelve a servirse globalmente.

## Persistencia

Las partidas nuevas y sus eventos se guardan en `state.json` mediante bloqueo de fichero y reemplazo atómico. El navegador consulta `/api/revision` cada dos segundos para detectar cambios de partidas o de contenido.

Se puede exportar y restaurar el JSON desde la pestaña **Servidor**.

## Comprobaciones

```bash
php -l router.php
php -l lib/content.php
php -l lib/storage.php
php -l lib/game.php
node --check src/app.js
php tests_php/content.php
php tests_php/smoke.php
php tests_php/rules.php
php tests_php/security.php
php tests_php/offline.php
```

La rama `server-auto` conserva la versión anterior. `main` contiene la versión estática de GitHub Pages.
