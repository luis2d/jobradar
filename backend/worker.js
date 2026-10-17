// Cloudflare Worker: recibe búsquedas del frontend, consulta Jooble y Adzuna, y cachea resultados.
// Las claves viven solo aquí (secretos de Cloudflare), nunca en el HTML.

import { dedupeJobs, interleave, normalizeAdzunaJob, normalizeJobs } from './normalize.js';
import {
  ADZUNA_COUNTRY,
  ADZUNA_PAUSE_MS,
  ADZUNA_TIMEOUT_MS,
  ALLOWED_DAYS,
  ALLOWED_RADIUS,
  JOOBLE_TIMEOUT_MS,
  MAX_PAGE,
  RESULTS_PER_PAGE,
  buildPortalLinks,
} from './config.js';

const MEMORY_CACHE_LIMIT = 200;
// Si una fuente falla, cacheamos el resultado parcial poco tiempo para reintentar pronto.
const PARTIAL_CACHE_TTL = 60;
const memoryCache = new Map();
let adzunaPausedUntil = 0;

class PublicError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const SOURCES = [
  { name: 'Jooble', enabled: (env) => Boolean(env.JOOBLE_API_KEY), query: queryJooble },
  {
    name: 'Adzuna',
    enabled: (env) => Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY),
    query: queryAdzuna,
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === '/api/health') {
      return json({ ok: true, sources: SOURCES.filter((s) => s.enabled(env)).map((s) => s.name) }, 200, cors);
    }
    if (url.pathname !== '/api/search') {
      return json({ error: 'Ruta no encontrada.' }, 404, cors);
    }
    if (request.method !== 'GET') {
      return json({ error: 'Método no permitido.' }, 405, cors);
    }

    const params = parseParams(url.searchParams);
    const links = buildPortalLinks(params.keywords, params.location);

    if (!params.keywords) {
      return json({ error: 'Escribe una profesión o palabra clave.', links }, 400, cors);
    }
    const sources = SOURCES.filter((s) => s.enabled(env));
    if (!sources.length) {
      return json(
        { error: 'El servidor no tiene configurada ninguna fuente de vacantes.', links },
        500,
        cors,
      );
    }

    const ttl = clamp(parseInt(env.CACHE_TTL_SECONDS, 10) || 900, 60, 86400);
    const key = cacheKey(params);

    const cached = await readCache(key);
    if (cached) {
      return json({ ...cached, links, cached: true }, 200, cors);
    }

    const settled = await Promise.allSettled(sources.map((s) => s.query(params, env)));
    const results = [];
    const failed = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        console.error(`${sources[i].name} error:`, outcome.reason);
        failed.push({ source: sources[i].name, error: outcome.reason });
      }
    });

    if (!results.length) {
      const err = failed[0].error;
      const status = err instanceof PublicError ? err.status : 502;
      const message =
        err instanceof PublicError
          ? err.message
          : 'No pudimos consultar las vacantes. Intenta de nuevo en unos minutos.';
      return json({ error: message, links }, status, cors);
    }

    const data = {
      total: results.reduce((sum, r) => sum + r.total, 0),
      page: params.page,
      hasMore: results.some((r) => r.hasMore),
      jobs: dedupeJobs(interleave(...results.map((r) => r.jobs))),
      sources: results.map((r) => r.source),
      failedSources: failed.map((f) => f.source),
    };

    ctx.waitUntil(writeCache(key, data, failed.length ? PARTIAL_CACHE_TTL : ttl));
    return json({ ...data, links, cached: false }, 200, cors);
  },
};

function parseParams(search) {
  const text = (name) => (search.get(name) || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const int = (name) => parseInt(search.get(name) || '', 10);

  const radius = int('radius');
  const salary = int('salary');
  const days = int('days');

  return {
    keywords: text('keywords'),
    location: text('location'),
    page: clamp(int('page') || 1, 1, MAX_PAGE),
    radius: ALLOWED_RADIUS.includes(radius) ? radius : null,
    salary: Number.isFinite(salary) && salary > 0 ? Math.min(salary, 10_000_000) : null,
    days: ALLOWED_DAYS.includes(days) ? days : null,
  };
}

function cacheKey(params) {
  return JSON.stringify([
    params.keywords.toLowerCase(),
    params.location.toLowerCase(),
    params.page,
    params.radius,
    params.salary,
    params.days,
    // El filtro por días depende de la fecha de hoy.
    params.days ? new Date().toISOString().slice(0, 10) : null,
  ]);
}

async function queryJooble(params, env) {
  const host = env.JOOBLE_HOST || 'jooble.org';
  const body = {
    keywords: params.keywords,
    location: params.location,
    page: String(params.page),
    ResultOnPage: String(RESULTS_PER_PAGE),
  };
  if (params.radius !== null) body.radius = String(params.radius);
  if (params.salary !== null) body.salary = String(params.salary);
  if (params.days !== null) {
    const from = new Date(Date.now() - params.days * 86_400_000);
    body.datecreatedfrom = from.toISOString().slice(0, 10);
  }

  const response = await fetchWithTimeout(
    `https://${host}/api/${encodeURIComponent(env.JOOBLE_API_KEY)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'JobRadar/0.1 (+https://github.com/luis2d/jobradar)',
      },
      body: JSON.stringify(body),
    },
    JOOBLE_TIMEOUT_MS,
  );

  // Jooble está detrás de Cloudflare: un reto anti-bots no significa que la clave sea mala.
  if (response.headers.get('cf-mitigated') === 'challenge') {
    throw new PublicError('Jooble bloqueó temporalmente la consulta del servidor. Intenta más tarde.', 503);
  }
  if (response.status === 403 || response.status === 401) {
    throw new PublicError('La clave de Jooble no es válida o fue revocada.', 502);
  }
  if (response.status === 429) {
    throw new PublicError('Alcanzamos el límite de consultas. Intenta en unos minutos.', 429);
  }
  if (!response.ok) {
    throw new Error(`Jooble respondió ${response.status}`);
  }

  const raw = await response.json();
  const total = Number(raw.totalCount) || 0;
  return {
    source: 'Jooble',
    total,
    page: params.page,
    hasMore: params.page < MAX_PAGE && params.page * RESULTS_PER_PAGE < total,
    jobs: normalizeJobs(raw.jobs),
  };
}

async function queryAdzuna(params, env) {
  if (Date.now() < adzunaPausedUntil) {
    throw new PublicError('Adzuna está en pausa temporal.', 503);
  }
  const search = new URLSearchParams({
    app_id: env.ADZUNA_APP_ID,
    app_key: env.ADZUNA_APP_KEY,
    results_per_page: String(RESULTS_PER_PAGE),
    what: params.keywords,
    'content-type': 'application/json',
  });
  if (params.location) search.set('where', params.location);
  if (params.radius) search.set('distance', String(params.radius));
  if (params.days !== null) search.set('max_days_old', String(params.days));
  // El filtro del frontend es mensual; Adzuna trabaja con salario anual.
  if (params.salary !== null) search.set('salary_min', String(params.salary * 12));

  const url = `https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY}/search/${params.page}?${search}`;
  const response = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/json' } },
    ADZUNA_TIMEOUT_MS,
  );

  // Credenciales rechazadas o cuota agotada: no insistimos durante un rato.
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    adzunaPausedUntil = Date.now() + ADZUNA_PAUSE_MS;
    throw new PublicError(`Adzuna rechazó la consulta (${response.status}).`, 502);
  }
  if (!response.ok) {
    throw new Error(`Adzuna respondió ${response.status}`);
  }

  const raw = await response.json();
  const total = Number(raw.count) || 0;
  return {
    source: 'Adzuna',
    total,
    page: params.page,
    hasMore: params.page < MAX_PAGE && params.page * RESULTS_PER_PAGE < total,
    jobs: normalizeJobs(raw.results, normalizeAdzunaJob),
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new PublicError('La fuente de vacantes tardó demasiado en responder.', 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Caché en dos niveles: memoria del isolate (muy rápida, se pierde al reciclarse)
// y Cache API de Cloudflare (persiste entre isolates del mismo data center).
function cacheRequest(key) {
  return new Request(`https://cache.jobradar.internal/search?k=${encodeURIComponent(key)}`);
}

async function readCache(key) {
  const hit = memoryCache.get(key);
  if (hit) {
    if (hit.expires > Date.now()) return hit.data;
    memoryCache.delete(key);
  }
  try {
    const response = await caches.default.match(cacheRequest(key));
    if (!response) return null;
    const data = await response.json();
    remember(key, data, 60);
    return data;
  } catch {
    return null;
  }
}

async function writeCache(key, data, ttl) {
  remember(key, data, ttl);
  try {
    await caches.default.put(
      cacheRequest(key),
      new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${ttl}`,
        },
      }),
    );
  } catch (err) {
    console.warn('No se pudo escribir en Cache API:', err);
  }
}

function remember(key, data, ttl) {
  if (memoryCache.size >= MEMORY_CACHE_LIMIT) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
  memoryCache.set(key, { data, expires: Date.now() + ttl * 1000 });
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((o) => o.trim());
  const origin = request.headers.get('Origin');
  let allowOrigin = '*';
  if (!allowed.includes('*')) {
    allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
