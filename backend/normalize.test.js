import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adzunaSalary,
  cleanText,
  dedupeJobs,
  interleave,
  normalizeAdzunaJob,
  normalizeJoobleJob,
  normalizeJobs,
} from './normalize.js';
import { buildPortalLinks } from './config.js';

test('cleanText quita HTML y decodifica entidades', () => {
  assert.equal(cleanText('<b>Contador</b> &amp; auxiliar&nbsp;&#225;rea'), 'Contador & auxiliar área');
  assert.equal(cleanText(null), '');
});

test('normalizeJob no inventa salario y exige enlace http(s)', () => {
  const job = normalizeJoobleJob({ title: 'Contador', link: 'https://jooble.org/desc/1', salary: '' });
  assert.equal(job.salary, null);
  assert.equal(job.company, 'Empresa confidencial');
  assert.equal(job.via, 'Jooble');
  assert.equal(normalizeJoobleJob({ title: 'X', link: 'javascript:alert(1)' }), null);
  assert.equal(normalizeJoobleJob({ title: '', link: 'https://a.com' }), null);
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

test('adzunaSalary muestra anual y mensual, y descarta estimados', () => {
  assert.equal(adzunaSalary({ salary_min: 216000, salary_max: 216000 }), '$216,000 al año (≈ $18,000/mes)');
  assert.equal(
    adzunaSalary({ salary_min: 300000, salary_max: 360000 }),
    '$300,000 – $360,000 al año (≈ $25,000 – $30,000/mes)',
  );
  assert.equal(adzunaSalary({ salary_min: 200000, salary_max: 200000, salary_is_predicted: '1' }), null);
  assert.equal(adzunaSalary({}), null);
});

test('normalizeAdzunaJob arma el formato común', () => {
  const job = normalizeAdzunaJob({
    id: '42',
    title: 'Contador <strong>General</strong>',
    company: { display_name: 'Arioac' },
    location: { display_name: 'Guadalajara, Jalisco' },
    redirect_url: 'https://www.adzuna.com.mx/land/ad/42',
    contract_time: 'full_time',
    created: '2026-10-04T10:00:00Z',
  });
  assert.equal(job.title, 'Contador General');
  assert.equal(job.via, 'Adzuna');
  assert.equal(job.type, 'Tiempo completo');
  assert.equal(job.salary, null);
  assert.equal(job.id, 'adzuna:42');
});

test('dedupeJobs quita la misma vacante aunque venga de dos fuentes', () => {
  const a = normalizeJoobleJob({ title: 'Contador', company: 'Arioac', link: 'https://a.com/1' });
  const b = normalizeAdzunaJob({ title: 'Contador', company: { display_name: 'Arioac' }, redirect_url: 'https://b.com/1' });
  assert.equal(dedupeJobs(interleave([a], [b])).length, 1);
  assert.deepEqual(interleave([1, 2, 3], ['a']), [1, 'a', 2, 3]);
});
