import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv, rowsToObjects } from '../src/csv.js';
const root=new URL('../data/',import.meta.url);const qFiles=['AL','LI','FI','HI','IN','NE'].map(id=>`questions-${id}.csv`);const aFiles=['J1','J2','J3'].map(id=>`attempts-${id}.csv`);const files=['meta.csv','banks.csv','categories.csv','levels.csv',...qFiles,'players.csv','matches.csv','participants.csv',...aFiles,'exposures.csv','events.csv'];
test('todos los CSV son UTF-8 sin BOM y usan CRLF',()=>{for(const name of files){const p=fileURLToPath(new URL(name,root));const bytes=fs.readFileSync(p);assert.notDeepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf],`${name} no debe tener BOM`);assert.ok(bytes.includes(Buffer.from('\r\n')),`${name} debe usar CRLF`);new TextDecoder('utf-8',{fatal:true}).decode(bytes)}});
test('el banco integrado contiene 130 preguntas y claves únicas',()=>{const rows=qFiles.flatMap(name=>rowsToObjects(parseCsv(fs.readFileSync(fileURLToPath(new URL(name,root)),'utf8'))));assert.equal(rows.length,130);assert.equal(new Set(rows.map(r=>r.question_key)).size,130)});
test('el histórico mantiene la corrección de J2: Nebrija no fue quesito',()=>{const rows=aFiles.flatMap(name=>rowsToObjects(parseCsv(fs.readFileSync(fileURLToPath(new URL(name,root)),'utf8'))));const a=rows.find(r=>r.question_no==='23');assert.equal(a.player_id,'J2');assert.equal(a.question_id,'LI-014');assert.equal(a.quesito_attempt,'false');assert.equal(a.quesito_won,'false')});
