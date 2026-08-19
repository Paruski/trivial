import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSeed } from '../src/seed.js';
import { installFileFetch } from './helpers.mjs';

installFileFetch();

const legacyMaxId = { AL: 22, LI: 22, FI: 22, HI: 22, IN: 21, NE: 21 };
const expectedAddition = {
  AL: { CUR: 70, AUT: 20, NIC: 10 },
  LI: { CUR: 70, AUT: 20, NIC: 10 },
  FI: { CUR: 70, AUT: 20, NIC: 10 },
  HI: { CUR: 70, AUT: 20, NIC: 10 },
  IN: { CUR: 70, AUT: 20, NIC: 10 },
  NE: { CUR: 70, AUT: 20, NIC: 10 },
};

test('la ampliación añade exactamente 100 preguntas por categoría con proporción 70/20/10', async () => {
  const seed = await loadSeed();
  for (const [categoryId, expected] of Object.entries(expectedAddition)) {
    const added = seed.questions.filter((question) =>
      question.categoryId === categoryId
      && Number(question.questionId.split('-').at(-1)) > legacyMaxId[categoryId]);
    const counts = { CUR: 0, AUT: 0, NIC: 0 };
    for (const question of added) counts[question.levelKey.split('|').at(-1)] += 1;
    assert.equal(added.length, 100, categoryId);
    assert.deepEqual(counts, expected, categoryId);
    assert.equal(added.every((question) => question.status === 'active'), true, categoryId);
  }
});

test('las preguntas nuevas se anexan sin reutilizar IDs ni alterar el orden estable anterior', async () => {
  const seed = await loadSeed();
  for (const categoryId of Object.keys(expectedAddition)) {
    const rows = seed.questions.filter((question) => question.categoryId === categoryId);
    const legacy = rows.filter((question) => Number(question.questionId.split('-').at(-1)) <= legacyMaxId[categoryId]);
    const added = rows.filter((question) => Number(question.questionId.split('-').at(-1)) > legacyMaxId[categoryId]);
    assert.ok(Math.min(...added.map((question) => question.randomOrder)) > Math.max(...legacy.map((question) => question.randomOrder)), categoryId);
    assert.equal(new Set(added.map((question) => question.questionId)).size, 100, categoryId);
    assert.equal(new Set(added.map((question) => question.orderKey)).size, 100, categoryId);
  }
});
