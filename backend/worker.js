// Cloudflare Worker: recibe búsquedas del frontend, consulta Jooble y cachea resultados.
// La clave de Jooble vive solo aquí (secreto JOOBLE_API_KEY), nunca en el HTML.

import { normalizeJobs } from './normalize.js';
import {
  ALLOWED_DAYS,
  ALLOWED_RADIUS,
  JOOBLE_TIMEOUT_MS,
  MAX_PAGE,
  RESULTS_PER_PAGE,
  buildPortalLinks,
} from './config.js';

const MEMORY_CACHE_LIMIT = 200;
const memoryCache = new Map();

class PublicError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === '/api/health') {
      return json({ ok: true }, 200, cors);
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
    if (!env.JOOBLE_API_KEY) {
      return json(
        { error: 'El servidor no tiene configurada la clave de Jooble.', links },
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

    let data;
    try {
      data = await queryJooble(params, env);
    } catch (err) {
      const status = err instanceof PublicError ? err.status : 502;
      const message =
        err instanceof PublicError
          ? err.message
          : 'No pudimos consultar las vacantes. Intenta de nuevo en unos minutos.';
      console.error('Jooble error:', err);
      return json({ error: message, links }, status, cors);
    }

    ctx.waitUntil(writeCache(key, data, ttl));
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOOBLE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`https://${host}/api/${encodeURIComponent(env.JOOBLE_API_KEY)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'JobRadar/0.1 (+https://github.com/luis2d/jobradar)',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new PublicError('Jooble tardó demasiado en responder. Intenta de nuevo.', 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

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
    total,
    page: params.page,
    hasMore: params.page < MAX_PAGE && params.page * RESULTS_PER_PAGE < total,
    jobs: normalizeJobs(raw.jobs),
  };
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
