export const SCHEMA_VERSION = 8;
export const EVENT_SCHEMA_VERSION = 3;
export const RULES_VERSION = 'trivial-rules-4.0.0';

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
