import { test, expect } from '@playwright/test';

test('flujo real multijugador, descarte, undo/redo, persistencia y segunda pestaña', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Partida', exact: true })).toBeVisible();
  const newMatch = page.getByRole('button', { name: 'Nueva partida' });
  await expect(newMatch).toBeEnabled();
  await newMatch.click();
  await page.locator('input[name="player"][value="J1"]').check();
  await page.locator('input[name="player"][value="J3"]').check();
  for (const input of await page.locator('input[name="category"]').all()) if (!['AL', 'IN'].includes(await input.getAttribute('value'))) await input.uncheck();
  for (const input of await page.locator('input[name="level"]').all()) if (!['S_DIFICULTAD_TRIVIAL_V1|CUR', 'S_DIFICULTAD_TRIVIAL_V1|AUT'].includes(await input.getAttribute('value'))) await input.uncheck();
  await page.getByRole('button', { name: 'Crear partida' }).click();
  await expect(page.getByText('Elige jugador y categoría')).toBeVisible();

  await page.locator('[data-player-id="J3"]').click();
  await page.locator('[data-category-id="AL"]').click();
  await page.locator('#draw-question').click();
  await expect(page.getByText('Juega J3')).toBeVisible();
  await page.locator('#reveal-answer').click();
  await expect(page.locator('[data-testid="answer"]')).toBeVisible();
  await page.locator('#record-correct').click();

  await page.locator('[data-player-id="J1"]').click();
  await page.locator('[data-category-id="AL"]').click();
  await page.locator('#quesito-toggle').check();
  await page.locator('#draw-question').click();
  await page.locator('#reveal-answer').click();
  await page.locator('#record-wrong').click();

  await page.locator('[data-player-id="J1"]').click();
  await page.locator('[data-category-id="AL"]').click();
  await page.locator('#draw-question').click();
  const discardedPrompt = await page.locator('.question-text').textContent();
  await page.locator('#reveal-answer').click();
  await page.locator('#discard-question').click();
  await expect(page.locator('.question-text')).not.toHaveText(discardedPrompt);
  await page.locator('#undo-action').click();
  await expect(page.locator('.question-text')).toHaveText(discardedPrompt);
  await page.locator('#redo-action').click();
  await expect(page.locator('.question-text')).not.toHaveText(discardedPrompt);

  await page.reload();
  await expect(page.getByText('PREGUNTA PENDIENTE')).toBeVisible();
  const secondPage = await context.newPage();
  await secondPage.goto('/');
  await expect(secondPage.getByText('PREGUNTA PENDIENTE')).toBeVisible();

  await page.locator('#reveal-answer').click();
  await page.locator('#record-wrong').click();
  await expect(secondPage.getByText('Elige jugador y categoría')).toBeVisible();
  await secondPage.locator('#close-reason').selectOption('time_limit');
  await secondPage.locator('#close-match').click();
  await expect(secondPage.getByText('Partida finalizada')).toBeVisible();
  await secondPage.getByRole('button', { name: 'Estadísticas' }).click();
  await expect(secondPage.getByText('Jugador × categoría')).toBeVisible();
  await expect(secondPage.locator('#stats-root').getByText('J1', { exact: true }).first()).toBeVisible();
  await expect(secondPage.locator('#stats-root').getByText('J3', { exact: true }).first()).toBeVisible();
});
