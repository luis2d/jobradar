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

export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanText(raw.title);
  const url = safeUrl(raw.link);
  if (!title || !url) return null;

  const job = {
    id: String(raw.id ?? url),
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

export function normalizeJobs(rawJobs) {
  if (!Array.isArray(rawJobs)) return [];
  const seen = new Set();
  const jobs = [];
  for (const raw of rawJobs) {
    const job = normalizeJob(raw);
    if (!job || seen.has(job.key)) continue;
    seen.add(job.key);
    jobs.push(job);
  }
  return jobs;
}
