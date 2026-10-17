// Configuración compartida del backend: parámetros de Jooble y portales de respaldo.

export const RESULTS_PER_PAGE = 20;
export const MAX_PAGE = 20;
export const JOOBLE_TIMEOUT_MS = 8000;

export const ADZUNA_COUNTRY = 'mx';
export const ADZUNA_TIMEOUT_MS = 8000;
// Si Adzuna rechaza las credenciales o se acaba la cuota, dejamos de llamarla un rato.
export const ADZUNA_PAUSE_MS = 10 * 60 * 1000;

// Valores de radio (km) que acepta Jooble.
export const ALLOWED_RADIUS = [0, 8, 16, 24, 40, 80];

// Días hacia atrás permitidos para el filtro "publicada en".
export const ALLOWED_DAYS = [1, 3, 7, 14, 30];

const enc = encodeURIComponent;

function slug(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Búsquedas de apoyo en otros portales. Son enlaces, no resultados:
// no se consulta ni se hace scraping de estos sitios.
export const FALLBACK_PORTALS = [
  {
    id: 'indeed',
    name: 'Indeed',
    build: (q, l) => `https://mx.indeed.com/jobs?q=${enc(q)}${l ? `&l=${enc(l)}` : ''}`,
  },
  {
    id: 'computrabajo',
    name: 'Computrabajo',
    build: (q, l) => `https://mx.computrabajo.com/trabajo-de-${slug(q)}${l ? `-en-${slug(l)}` : ''}`,
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    build: (q, l) =>
      `https://www.linkedin.com/jobs/search/?keywords=${enc(q)}&location=${enc(l || 'México')}`,
  },
];

export function buildPortalLinks(keywords, location) {
  if (!keywords) return [];
  return FALLBACK_PORTALS.map((p) => ({
    id: p.id,
    name: p.name,
    url: p.build(keywords, location),
  }));
}
