# Vacante: buscador de empleos tipo radar

Buscador de vacantes reales en línea. El usuario escribe una profesión (o elige una sugerencia), aplica filtros a la izquierda y ve a la derecha las vacantes encontradas, con enlace directo para postularse.

## Objetivo del MVP

- Buscar vacantes reales usando una API oficial de agregador (Jooble).
- Respuesta rápida gracias a caché.
- Costo cero o casi cero en la fase inicial.
- Enlaces de búsqueda a Indeed, Computrabajo y LinkedIn como complemento, sin prometer que sus vacantes aparecerán en los resultados.

## Stack

- **Frontend:** HTML, CSS y JavaScript vanilla en un solo `index.html`.
- **Backend:** función serverless (Cloudflare Workers, Vercel o Netlify Functions) que guarda la clave de API y llama a Jooble.
- **Caché:** en memoria o con KV del proveedor, por algunos minutos u horas.
- **Fuentes de datos:** Jooble API (clave gratuita) y Adzuna API (país `mx`; 25 llamadas de prueba, luego £8/mes). Si una fuente falla o se queda sin cuota, la página sigue con la otra.

## Estructura propuesta

```
jobradar/
├── README.md
├── frontend/
│   └── index.html          # Interfaz: buscador, filtros y resultados
├── backend/
│   ├── worker.js           # Worker que consulta Jooble y cachea
│   ├── normalize.js        # Convierte resultados a un formato común
│   ├── normalize.test.js   # Pruebas (npm test)
│   └── config.js           # Portales de respaldo y patrones de URL
├── wrangler.toml           # Config de Cloudflare: el Worker sirve frontend y /api/*
├── package.json
└── .env.example            # Variables de entorno (sin valores reales)
```

## Requisitos

- Cuenta gratuita en Cloudflare (o Vercel/Netlify).
- Node.js 18 o superior, para correr pruebas locales con Wrangler (si usas Cloudflare).
- Clave gratuita de Jooble.

## Uso rápido

```bash
npm install
copy .env.example .env      # y pon tu JOOBLE_API_KEY
npm run dev                 # abre http://127.0.0.1:8787
npm test
```

Para publicar: `npx wrangler login`, `npx wrangler secret put JOOBLE_API_KEY` (y `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`) y `npm run deploy`.

Versión publicada: https://jobradar.luis2d.workers.dev

Si tu clave de Jooble es de un país específico, cambia `JOOBLE_HOST` en `wrangler.toml` (por ejemplo, `mx.jooble.org`).

### API del backend

`GET /api/search?keywords=contador&location=Guadalajara&page=1&radius=16&days=7&salary=15000`

Devuelve `{ total, page, hasMore, jobs: [...], sources, failedSources, links: [...], cached }`. Cada vacante trae `title`, `company`, `location`, `salary` (o `null`), `type`, `snippet`, `date`, `url`, `via` y `origin`. Los errores responden `{ error, links }`.

## Pasos para iniciar (guía original)

1. **Obtén la clave de Jooble.** Entra a jooble.org/api/about, completa el formulario con tu nombre, correo y sitio web, y guarda la clave que te entregan. Confirma en su documentación los límites de uso y los países disponibles, incluido México.

2. **Guarda la clave en el backend, nunca en el HTML.** Crea el archivo `.env` a partir de `.env.example`:

   ```
   JOOBLE_API_KEY=tu_clave_aqui
   CACHE_TTL_SECONDS=900
   ```

   En Cloudflare, configúrala como secreto con `wrangler secret put JOOBLE_API_KEY`.

3. **Crea la función de búsqueda.** El backend debe recibir `keywords`, `location` y `page`, llamar a `https://jooble.org/api/TU_CLAVE` con método POST y devolver al frontend una lista normalizada con título, empresa, ubicación, salario (si existe), fecha, enlace y fuente.

4. **Activa la caché.** Guarda cada combinación de búsqueda durante `CACHE_TTL_SECONDS`. Así reduces llamadas y mejoras la velocidad.

5. **Conecta el frontend.** El buscador de la izquierda llama a tu backend, no a Jooble directamente. Los resultados se muestran a la derecha.

6. **Prueba en local.** Con Wrangler ejecuta `npm run dev` y abre http://127.0.0.1:8787 (el mismo Worker sirve la página). Prueba búsquedas vacías, búsquedas sin resultados y errores de red.

7. **Publica.** `npm run deploy` publica backend y frontend juntos en Cloudflare Workers.

## Reglas del proyecto

- No hacer scraping de Indeed, LinkedIn, Computrabajo ni otros portales.
- No inventar salarios. Si la vacante no lo publica, mostrar "No especificado".
- Mostrar siempre la fuente de cada vacante (por ejemplo, "Vía Jooble").
- Los enlaces de Indeed, Computrabajo y LinkedIn son búsquedas de apoyo, no resultados garantizados.
- No guardar datos personales de los usuarios sin una política de privacidad.

## Limitaciones conocidas

- Jooble puede no tener vacantes de todas las profesiones o ciudades.
- Muchas vacantes no incluyen salario. Adzuna publica salarios anuales; los estimados por Adzuna se muestran como "No especificado".
- Una misma vacante puede aparecer repetida; la normalización debe eliminar duplicados por título y empresa.
- Los límites del plan gratuito pueden cambiar. Revisa la documentación antes de escalar.

## Próximos pasos

- [ ] Obtener la clave de Jooble y confirmar cobertura para México.
- [x] Escribir `worker.js` y `normalize.js`.
- [x] Conectar el buscador con el backend.
- [x] Agregar caché y manejo de errores.
- [x] Revisar si Adzuna conviene como segunda fuente (sí trae vacantes locales de México).
- [x] Publicar la versión de prueba.
- [ ] Conseguir clave de Jooble con cobertura de México (la actual es del índice de EE. UU.).
- [ ] Decidir si se paga el plan de Adzuna cuando se acaben las llamadas de prueba.

## Licencia

Por definir.
