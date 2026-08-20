# Estadísticas

## Inclusión

Se combinan intentos históricos computables y `RESULT_RECORDED` activos. Se excluyen descartes, respuestas sin comunicar, intentos no computables y resultados revertidos. Las preguntas mostradas sí cuentan para la distribución de niveles.

## Salidas

- Jugador: partidas, intentos, aciertos, fallos, precisión, quesitos intentados y ganados.
- Quesitos ganados frente a intentos reales y frente al máximo teórico de categorías habilitadas.
- Jugador × categoría, jugador × nivel y partida × jugador.
- Precisión agregada por categoría y nivel.
- Distribución observada frente a pesos objetivo por partida y categoría.
- Descartes, retiradas globales y evolución diaria.

La categoría se identifica por `bank_id|category_id`, evitando colisiones entre bancos.

## Inferencia

- Proporciones: intervalo de Wilson bilateral al 95 %.
- Comparaciones de jugadores: prueba exacta bilateral de Fisher.
- Multiplicidad: ajuste de Holm sobre las comparaciones ejecutadas.
- Líder de categoría: solo se publica si el mejor supera significativamente a todos los demás tras el ajuste, con `α=0,05`.
- Niveles observados: chi-cuadrado de bondad de ajuste contra los pesos congelados, con valor p por partida y categoría solo cuando todos los recuentos esperados son al menos cinco; antes se marca muestra insuficiente.

Los resultados describen las partidas registradas, no una población aleatoria de jugadores. Un valor no significativo significa evidencia insuficiente, no igualdad demostrada.
