import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, normalizeJob, normalizeJobs } from './normalize.js';
import { buildPortalLinks } from './config.js';

test('cleanText quita HTML y decodifica entidades', () => {
  assert.equal(cleanText('<b>Contador</b> &amp; auxiliar&nbsp;&#225;rea'), 'Contador & auxiliar área');
  assert.equal(cleanText(null), '');
});

test('normalizeJob no inventa salario y exige enlace http(s)', () => {
  const job = normalizeJob({ title: 'Contador', link: 'https://jooble.org/desc/1', salary: '' });
  assert.equal(job.salary, null);
  assert.equal(job.company, 'Empresa confidencial');
  assert.equal(job.via, 'Jooble');
  assert.equal(normalizeJob({ title: 'X', link: 'javascript:alert(1)' }), null);
  assert.equal(normalizeJob({ title: '', link: 'https://a.com' }), null);
});

test('normalizeJobs elimina duplicados por título y empresa', () => {
  const jobs = normalizeJobs([
    { title: 'Contador Sr.', company: 'ACME', link: 'https://a.com/1' },
    { title: 'contador  sr', company: 'Acmé', link: 'https://a.com/2' },
    { title: 'Contador Sr.', company: 'Otra', link: 'https://a.com/3' },
  ]);
  assert.equal(jobs.length, 2);
});

test('buildPortalLinks arma búsquedas de apoyo', () => {
  const links = buildPortalLinks('Diseñador gráfico', 'Ciudad de México');
  assert.deepEqual(links.map((l) => l.id), ['indeed', 'computrabajo', 'linkedin']);
  assert.equal(links[1].url, 'https://mx.computrabajo.com/trabajo-de-disenador-grafico-en-ciudad-de-mexico');
  assert.deepEqual(buildPortalLinks('', 'x'), []);
});
