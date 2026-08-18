export const APP_NAME = 'Trivial';
export const SCHEMA_VERSION = 6;
export const EVENT_SCHEMA_VERSION = 1;
export const RULES_VERSION = 'trivial-rules-2.0.0';
export const BUILD_VERSION = '2026-08-19.3';

export const EVENT_TYPES = Object.freeze({
  MATCH_CREATED: 'MATCH_CREATED',
  QUESTION_DRAWN: 'QUESTION_DRAWN',
  ANSWER_REVEALED: 'ANSWER_REVEALED',
  RESULT_RECORDED: 'RESULT_RECORDED',
  QUESTION_DISCARDED: 'QUESTION_DISCARDED',
  MATCH_CLOSED: 'MATCH_CLOSED',
  EVENT_REVERTED: 'EVENT_REVERTED',
  EVENT_RESTORED: 'EVENT_RESTORED',
});

export const SEED_FILES = Object.freeze({
  meta: ['./data/meta.csv'],
  banks: ['./data/banks.csv'],
  categories: ['./data/categories.csv'],
  levels: ['./data/levels.csv'],
  questions: ['./data/questions-AL.csv', './data/questions-LI.csv', './data/questions-FI.csv', './data/questions-HI.csv', './data/questions-IN.csv', './data/questions-NE.csv'],
  players: ['./data/players.csv'],
  matches: ['./data/matches.csv'],
  participants: ['./data/participants.csv'],
  attempts: ['./data/attempts-J1.csv', './data/attempts-J2.csv', './data/attempts-J3.csv'],
  exposures: ['./data/exposures.csv'],
  events: ['./data/events.csv'],
});

export const DATA_STORES = Object.freeze([
  'banks', 'categories', 'levels', 'questions', 'players', 'matches',
  'participants', 'attempts', 'exposures', 'events',
]);
