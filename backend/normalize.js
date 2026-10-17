// Convierte las vacantes de Jooble a un formato común y elimina duplicados.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// Quita etiquetas HTML (Jooble resalta coincidencias con <b>) y decodifica entidades.
export function cleanText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === '#') {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function comparable(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Clave para detectar la misma vacante repetida: título + empresa.
export function dedupeKey(job) {
  return `${comparable(job.title)}|${comparable(job.company)}`;
}

export function normalizeJoobleJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanText(raw.title);
  const url = safeUrl(raw.link);
  if (!title || !url) return null;

  const job = {
    id: `jooble:${raw.id ?? url}`,
    title,
    company: cleanText(raw.company) || 'Empresa confidencial',
    location: cleanText(raw.location) || 'Ubicación no especificada',
    // Nunca inventamos salario: si no viene, se marca como no especificado.
    salary: cleanText(raw.salary) || null,
    type: cleanText(raw.type) || null,
    snippet: cleanText(raw.snippet),
    date: safeDate(raw.updated),
    url,
    via: 'Jooble',
    origin: cleanText(raw.source) || null,
  };
  job.key = dedupeKey(job);
  return job;
}

const mxn = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

// Adzuna publica salarios anuales. Si el salario es estimado por Adzuna
// (salary_is_predicted = "1"), no lo mostramos: no inventamos salarios.
export function adzunaSalary(raw) {
  if (String(raw.salary_is_predicted) === '1') return null;
  const min = Number(raw.salary_min) || 0;
  const max = Number(raw.salary_max) || 0;
  if (!min && !max) return null;
  const low = min || max;
  const high = Math.max(min, max);
  const yearly = low === high ? `$${mxn.format(low)}` : `$${mxn.format(low)} – $${mxn.format(high)}`;
  const monthly =
    low === high
      ? `$${mxn.format(low / 12)}`
      : `$${mxn.format(low / 12)} – $${mxn.format(high / 12)}`;
  return `${yearly} al año (≈ ${monthly}/mes)`;
}

const ADZUNA_TIME = { full_time: 'Tiempo completo', part_time: 'Medio tiempo' };
const ADZUNA_CONTRACT = { permanent: 'Indefinido', contract: 'Por contrato' };

export function normalizeAdzunaJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanText(raw.title);
  const url = safeUrl(raw.redirect_url);
  if (!title || !url) return null;

  const type = [ADZUNA_TIME[raw.contract_time], ADZUNA_CONTRACT[raw.contract_type]]
    .filter(Boolean)
    .join(' · ');

  const job = {
    id: `adzuna:${raw.id ?? url}`,
    title,
    company: cleanText(raw.company?.display_name) || 'Empresa confidencial',
    location: cleanText(raw.location?.display_name) || 'Ubicación no especificada',
    salary: adzunaSalary(raw),
    type: type || null,
    snippet: cleanText(raw.description),
    date: safeDate(raw.created),
    url,
    via: 'Adzuna',
    origin: null,
  };
  job.key = dedupeKey(job);
  return job;
}

// Quita duplicados (también entre fuentes) y conserva el orden.
export function dedupeJobs(jobs) {
  const seen = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || seen.has(job.key)) continue;
    seen.add(job.key);
    out.push(job);
  }
  return out;
}

export function normalizeJobs(rawJobs, normalizer = normalizeJoobleJob) {
  if (!Array.isArray(rawJobs)) return [];
  return dedupeJobs(rawJobs.map(normalizer));
}

// Intercala las listas de cada fuente para que ninguna quede siempre al final.
export function interleave(...lists) {
  const out = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}
