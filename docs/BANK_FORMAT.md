# Formato de banco

La aplicación acepta CSV UTF-8. Está pensada para poder importar directamente una exportación de la pestaña `Banco` del proyecto Trivial.

Columnas reconocidas (se toleran variantes de nombre):

- `ID` / `question_id`
- `Categoría` / `category_id`
- `Dificultad` / `nivel` / `level_id`
- `Pregunta`
- `Respuesta`
- `Explicación breve`
- `Estado`
- `Orden aleatorio`

## Estados

- `no administrada` → `active`: puede salir en una partida.
- `administrada` → `retired`: se conserva para histórico, pero no vuelve a salir por defecto.
- `descartada` → `discarded`: queda fuera del juego.

La importación no publica el CSV. El contenido se guarda en IndexedDB en el navegador donde se haya cargado.
