'use strict';

/**
 * Módulo de métricas Prometheus compartido (prom-client)
 * ────────────────────────────────────────────────────────
 * Exporta métricas estándar del proceso Node.js más métricas personalizadas
 * de EcoFirma. Cada servicio importa este módulo y monta /metrics en Express.
 *
 * Uso:
 *   const { register, httpRequestDuration, httpRequestsTotal } = require('./metrics');
 *   app.get('/metrics', async (_req, res) => {
 *     res.set('Content-Type', register.contentType);
 *     res.end(await register.metrics());
 *   });
 */

const client = require('prom-client');

// Crear un registro propio (no el global) para aislar las métricas del servicio
const register = new client.Registry();

// Añadir métricas por defecto de Node.js (CPU, memoria, event loop lag, etc.)
client.collectDefaultMetrics({
  register,
  prefix: 'ecofirma_',
});

// ─── Histograma de duración de requests HTTP ──────────────────────────────────
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duración de los requests HTTP en segundos (histograma)',
  labelNames: ['method', 'route', 'status', 'service'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// ─── Contador total de requests HTTP ──────────────────────────────────────────
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total de requests HTTP recibidos',
  labelNames: ['method', 'route', 'status', 'service'],
  registers: [register],
});

// ─── Gauge de documentos por estado (solo para documents-service) ─────────────
const documentsGauge = new client.Gauge({
  name: 'ecofirma_documents_total',
  help: 'Total de documentos por estado',
  labelNames: ['estado'],
  registers: [register],
});

// ─── Contador de operaciones de firma ─────────────────────────────────────────
const signaturesProcessed = new client.Counter({
  name: 'ecofirma_signatures_processed_total',
  help: 'Total de firmas procesadas',
  labelNames: ['result'],  // 'success' | 'error'
  registers: [register],
});

// ─── Middleware de Express para instrumentar requests automáticamente ──────────
/**
 * Middleware que mide duración e incrementa contadores para cada request.
 *
 * @param {string} serviceName  Nombre del servicio (para el label `service`)
 * @returns Express middleware
 */
function metricsMiddleware(serviceName) {
  return (req, res, next) => {
    const start = Date.now();

    // Al finalizar la respuesta, registrar métricas
    res.on('finish', () => {
      const durationSeconds = (Date.now() - start) / 1000;
      // Normalizar la ruta para evitar cardinalidad explosiva con UUIDs
      const route = normalizeRoute(req.path);

      const labels = {
        method: req.method,
        route,
        status: res.statusCode.toString(),
        service: serviceName,
      };

      httpRequestDuration.observe(labels, durationSeconds);
      httpRequestsTotal.inc(labels);
    });

    next();
  };
}

/**
 * Normaliza rutas con IDs para evitar cardinalidad explosiva en Prometheus.
 * Ejemplo: /api/documents/abc-123-def → /api/documents/:id
 */
function normalizeRoute(path) {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:n');
}

module.exports = {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  documentsGauge,
  signaturesProcessed,
  metricsMiddleware,
};
