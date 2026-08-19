# Estadísticas

Las proyecciones se calculan al abrir desde intentos históricos canónicos y `RESULT_RECORDED` activos de partidas nuevas.

La sección comienza con un resumen ejecutivo móvil y visual. Publica:

- por jugador: partidas, intentos, aciertos, fallos, precisión, quesitos intentados y ganados, y quesitos ganados respecto a todos los que pudo obtener (suma de categorías habilitadas en sus partidas);
- precisión agregada por categoría y por nivel;
- jugador × categoría;
- jugador × nivel;
- partida × jugador;
- niveles observados frente a las proporciones objetivo congeladas;
- número de descartes;
- evolución temporal por día y jugador.

No cuentan como acierto ni fallo: descartes, respuestas aún no comunicadas, resultados revertidos o intentos marcados como no computables. La distribución observada sí cuenta preguntas mostradas, porque mide niveles realmente expuestos, incluso si después se rectifica el resultado.

Cada proporción relevante muestra un intervalo de confianza de Wilson al 95%. El jugador más preciso de una categoría solo se destaca si supera al segundo mediante una prueba z bilateral de dos proporciones con `α=0,05`; se muestra el valor p. Estas inferencias describen la muestra local y no corrigen por comparaciones múltiples, por lo que deben interpretarse como exploratorias.
