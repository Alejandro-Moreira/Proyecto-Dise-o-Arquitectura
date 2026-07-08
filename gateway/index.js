'use strict';

/**
 * EcoFirma API Gateway
 * ────────────────────
 * Actúa como punto de entrada único (puerto 8080).
 * Enruta las peticiones a los microservicios internos mediante
 * http-proxy-middleware, sin reimplementar lógica de negocio.
 *
 * Rutas:
 *   /api/users/*      → Users Service  (http://users-service:3001)
 *   /api/documents/*  → Documents Service (http://documents-service:3002)
 *   /api/signatures/* → Documents Service (http://documents-service:3002)
 *   /metrics          → Métricas Prometheus (prom-client)
 */

const express = require('express');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { register, metricsMiddleware } = require('./metrics');

const app = express();
const PORT = process.env.PORT || process.env.GATEWAY_PORT || 8080;

const USERS_SERVICE_URL = process.env.USERS_SERVICE_URL || 'http://users-service:3001';
const DOCUMENTS_SERVICE_URL = process.env.DOCUMENTS_SERVICE_URL || 'http://documents-service:3002';

// ─── Middlewares globales ────────────────────────────────────────────────────

app.use(morgan('combined'));
// Instrumentación automática de todos los requests para Prometheus
app.use(metricsMiddleware('gateway'));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Token');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

// ─── Health-check y métricas ──────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ecofirma-gateway', timestamp: new Date().toISOString() });
});

// Endpoint de métricas Prometheus
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ─── Opciones comunes de proxy ────────────────────────────────────────────────

/**
 * Construye opciones de proxy con manejo de errores centralizado.
 * Si el servicio downstream no responde, devuelve 502 con JSON limpio
 * (no un stack trace crudo).
 *
 * @param {string} target  URL base del servicio destino
 * @param {string} name    Nombre del servicio (para logs y mensajes de error)
 */
function buildProxyOptions(target, name) {
  return {
    target,
    changeOrigin: true,
    pathRewrite: (_path, req) => req.originalUrl,
    on: {
      error: (err, req, res) => {
        console.error(`[Gateway] Error al conectar con ${name}: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).json({
            error: `El servicio ${name} no está disponible en este momento. Intenta de nuevo más tarde.`,
          });
        }
      },
      proxyReq: (proxyReq, req) => {
        // Reenviar el header Authorization (JWT) sin modificarlo
        const auth = req.headers['authorization'];
        if (auth) {
          proxyReq.setHeader('Authorization', auth);
        }
      },
    },
  };
}

// ─── Proxy routes ─────────────────────────────────────────────────────────────

app.use('/api/users', createProxyMiddleware(buildProxyOptions(USERS_SERVICE_URL, 'users-service')));
app.use('/api/signatures', createProxyMiddleware(buildProxyOptions(DOCUMENTS_SERVICE_URL, 'documents-service')));
app.use('/api/documents', createProxyMiddleware(buildProxyOptions(DOCUMENTS_SERVICE_URL, 'documents-service')));

// ─── Ruta no encontrada ───────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada en el API Gateway.' });
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Gateway] EcoFirma API Gateway escuchando en http://0.0.0.0:${PORT}`);
  console.log(`[Gateway] → /api/users/*      → ${USERS_SERVICE_URL}`);
  console.log(`[Gateway] → /api/documents/*  → ${DOCUMENTS_SERVICE_URL}`);
  console.log(`[Gateway] → /api/signatures/* → ${DOCUMENTS_SERVICE_URL}`);
  console.log(`[Gateway] → /metrics          → Prometheus metrics`);
});

module.exports = app;
