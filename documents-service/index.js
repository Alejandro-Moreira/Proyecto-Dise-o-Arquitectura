'use strict';

/**
 * EcoFirma Documents Service  (puerto 3002)
 * ──────────────────────────────────────────
 * Responsabilidades:
 *   - POST   /api/documents           → Crear documento
 *   - GET    /api/documents           → Listar todos (cache-aside Redis)
 *   - GET    /api/documents/:id       → Obtener por ID (cache-aside Redis)
 *   - POST   /api/signatures/process  → Iniciar firma asíncrona (publica en RabbitMQ)
 *   - PATCH  /api/documents/:id/status → [INTERNO] Actualizar estado (usado por Signature Worker)
 *
 * Base de datos: PostgreSQL (tabla `documents`)
 * Caché: Redis (patrón cache-aside, TTL configurable)
 * Cola: RabbitMQ (cola `signature_queue`)
 *
 * Decisión de diseño de BD:
 *   Se usa una única base de datos PostgreSQL (`ecofirma_db`) compartida entre
 *   users-service y documents-service, con tablas separadas por servicio.
 *   Esto simplifica la operación local (un único contenedor PG) y es perfectamente
 *   válido para esta escala. En producción se optaría por DBs independientes.
 */

const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');
const { register, metricsMiddleware, documentsGauge, signaturesProcessed } = require('./metrics');

const app = express();
const PORT = process.env.DOCUMENTS_SERVICE_PORT || 3002;

// ─── Variables de entorno ─────────────────────────────────────────────────────

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
const REDIS_TTL = parseInt(process.env.REDIS_TTL || '300', 10); // segundos
const RABBITMQ_USER = process.env.RABBITMQ_USER || 'guest';
const RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD || 'guest';
const RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'rabbitmq';
const RABBITMQ_PORT = process.env.RABBITMQ_PORT || 5672;
const RABBITMQ_URL = `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${RABBITMQ_HOST}:${RABBITMQ_PORT}`;
const SIGNATURE_QUEUE = 'signature_queue';

// ─── Conexión a PostgreSQL ────────────────────────────────────────────────────

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT) || 5432,
  database: process.env.POSTGRES_DB || 'ecofirma_db',
  user: process.env.POSTGRES_USER || 'ecofirma_user',
  password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 5000,
});

// ─── Conexión a Redis ─────────────────────────────────────────────────────────

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: Number(process.env.REDIS_PORT) || 6379,
  // Reintentar conexión automáticamente (ioredis lo hace por defecto)
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('connect', () => console.log('[Documents] Conectado a Redis.'));
redis.on('error', (err) => console.error('[Documents] Error de Redis:', err.message));

// ─── Conexión a RabbitMQ ──────────────────────────────────────────────────────

/**
 * Mantiene una referencia al canal de RabbitMQ para reutilizarlo.
 * Se reconecta automáticamente si la conexión se cae.
 */
let rabbitChannel = null;

async function connectRabbitMQ(retries = 12, delay = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const connection = await amqp.connect(RABBITMQ_URL);
      const channel = await connection.createChannel();

      // Declara la cola como durable para sobrevivir reinicios de RabbitMQ
      await channel.assertQueue(SIGNATURE_QUEUE, {
        durable: true,
        // Dead-letter exchange para mensajes que superan el límite de reintentos
        arguments: {
          'x-dead-letter-exchange': 'ecofirma.dlx',
          'x-dead-letter-routing-key': 'signature.dead',
        },
      });

      // Declara también el Dead-Letter Exchange y su cola de respaldo
      await channel.assertExchange('ecofirma.dlx', 'direct', { durable: true });
      await channel.assertQueue('signature_dead_letter', { durable: true });
      await channel.bindQueue('signature_dead_letter', 'ecofirma.dlx', 'signature.dead');

      connection.on('error', (err) => {
        console.error('[Documents] Conexión RabbitMQ perdida:', err.message);
        rabbitChannel = null;
        // Reintentar reconexión tras un delay
        setTimeout(() => connectRabbitMQ(), 10000);
      });

      connection.on('close', () => {
        console.warn('[Documents] Conexión RabbitMQ cerrada. Reconectando...');
        rabbitChannel = null;
        setTimeout(() => connectRabbitMQ(), 10000);
      });

      rabbitChannel = channel;
      console.log('[Documents] Conectado a RabbitMQ. Cola lista:', SIGNATURE_QUEUE);
      return;
    } catch (err) {
      console.warn(`[Documents] Intento ${attempt}/${retries} de conexión a RabbitMQ falló: ${err.message}`);
      if (attempt === retries) {
        console.error('[Documents] No se pudo conectar a RabbitMQ. El servicio arrancará sin capacidad de encolar.');
        return;
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Inicialización de tabla ──────────────────────────────────────────────────

async function initDB(retries = 10, delay = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
          titulo           VARCHAR(500) NOT NULL,
          contenido_base64 TEXT         NOT NULL,
          autor_id         VARCHAR(255) NOT NULL,
          estado           VARCHAR(20)  NOT NULL DEFAULT 'PENDIENTE'
                             CHECK (estado IN ('PENDIENTE', 'FIRMADO')),
          created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        );
      `);
      console.log('[Documents] Tabla `documents` lista.');
      return;
    } catch (err) {
      console.warn(`[Documents] Intento ${attempt}/${retries} de conexión a PostgreSQL falló: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Middlewares ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' })); // contenidoBase64 puede ser grande
app.use(morgan('combined'));
// Instrumentación automática de requests HTTP para Prometheus
app.use(metricsMiddleware('documents-service'));

// ─── Health-check y métricas Prometheus ─────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ecofirma-documents-service' });
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

// ─── Helpers de caché Redis ───────────────────────────────────────────────────

const CACHE_KEY_ALL = 'documents:all';
const cacheKeyById = (id) => `documents:${id}`;

/**
 * Invalida la caché de la lista completa de documentos.
 * Se llama cada vez que se crea/modifica un documento para mantener consistencia.
 */
async function invalidateListCache() {
  try {
    await redis.del(CACHE_KEY_ALL);
    console.log('[Documents] Caché de lista invalidada.');
  } catch (err) {
    console.error('[Documents] Error invalidando caché de lista:', err.message);
  }
}

/**
 * Mapea una fila de la BD al formato de respuesta del contrato de API.
 */
function rowToDocumentResponse(row) {
  return {
    id: row.id,
    titulo: row.titulo,
    contenidoBase64: row.contenido_base64,
    autorId: row.autor_id,
    estado: row.estado,
  };
}

// ─── POST /api/documents ──────────────────────────────────────────────────────

app.post('/api/documents', async (req, res) => {
  const { titulo, contenidoBase64, autorId } = req.body;

  if (!titulo || typeof titulo !== 'string' || titulo.trim() === '') {
    return res.status(400).json({ error: 'El campo `titulo` es obligatorio.' });
  }
  if (!contenidoBase64 || typeof contenidoBase64 !== 'string') {
    return res.status(400).json({ error: 'El campo `contenidoBase64` es obligatorio.' });
  }
  if (!autorId || typeof autorId !== 'string' || autorId.trim() === '') {
    return res.status(400).json({ error: 'El campo `autorId` es obligatorio.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO documents (titulo, contenido_base64, autor_id)
       VALUES ($1, $2, $3)
       RETURNING id, titulo, contenido_base64, autor_id, estado`,
      [titulo.trim(), contenidoBase64, autorId.trim()]
    );

    const doc = rowToDocumentResponse(result.rows[0]);
    console.log(`[Documents] Documento creado: ${doc.id} ("${doc.titulo}")`);

    // Actualizar caché individual y borrar lista (patrón cache-aside)
    try {
      await redis.setex(cacheKeyById(doc.id), REDIS_TTL, JSON.stringify(doc));
      await invalidateListCache();
    } catch (cacheErr) {
      // La caché es opcional; un fallo no debe bloquear la respuesta
      console.error('[Documents] Error actualizando caché:', cacheErr.message);
    }

    // Publicar en RabbitMQ para que el Signature Worker lo procese
    if (rabbitChannel) {
      try {
        const message = JSON.stringify({ documentId: doc.id });
        // persistent: true → el mensaje sobrevive un reinicio de RabbitMQ
        rabbitChannel.sendToQueue(SIGNATURE_QUEUE, Buffer.from(message), { persistent: true });
        console.log(`[Documents] Mensaje publicado en ${SIGNATURE_QUEUE}: documentId=${doc.id}`);
      } catch (mqErr) {
        console.error('[Documents] Error publicando en RabbitMQ:', mqErr.message);
      }
    } else {
      console.warn('[Documents] RabbitMQ no disponible; el documento no será firmado automáticamente.');
    }

    return res.status(201).json(doc);
  } catch (err) {
    console.error('[Documents] Error en POST /api/documents:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── GET /api/documents ───────────────────────────────────────────────────────

app.get('/api/documents', async (_req, res) => {
  try {
    // 1. Intentar leer de Redis (cache-aside)
    const cached = await redis.get(CACHE_KEY_ALL).catch(() => null);

    if (cached) {
      // CACHE HIT: devuelve datos sin consultar PostgreSQL
      console.log('[Documents] Cache HIT en GET /api/documents (Redis). PostgreSQL no consultado.');
      return res.status(200).json(JSON.parse(cached));
    }

    // CACHE MISS: consultar PostgreSQL y repoblar caché
    console.log('[Documents] Cache MISS en GET /api/documents. Consultando PostgreSQL...');
    const result = await pool.query(
      `SELECT id, titulo, contenido_base64, autor_id, estado
       FROM documents
       ORDER BY created_at DESC`
    );

    const docs = result.rows.map(rowToDocumentResponse);

    // Repoblar caché de lista
    try {
      await redis.setex(CACHE_KEY_ALL, REDIS_TTL, JSON.stringify(docs));
    } catch (cacheErr) {
      console.error('[Documents] Error almacenando en caché:', cacheErr.message);
    }

    return res.status(200).json(docs);
  } catch (err) {
    console.error('[Documents] Error en GET /api/documents:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── GET /api/documents/:id ───────────────────────────────────────────────────

app.get('/api/documents/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Intentar leer de Redis (cache-aside)
    const cached = await redis.get(cacheKeyById(id)).catch(() => null);

    if (cached) {
      // CACHE HIT: devuelve datos sin consultar PostgreSQL
      console.log(`[Documents] Cache HIT en GET /api/documents/${id} (Redis). PostgreSQL no consultado.`);
      return res.status(200).json(JSON.parse(cached));
    }

    // CACHE MISS: consultar PostgreSQL
    console.log(`[Documents] Cache MISS en GET /api/documents/${id}. Consultando PostgreSQL...`);
    const result = await pool.query(
      `SELECT id, titulo, contenido_base64, autor_id, estado
       FROM documents
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Documento con id "${id}" no encontrado.` });
    }

    const doc = rowToDocumentResponse(result.rows[0]);

    // Repoblar caché del documento individual
    try {
      await redis.setex(cacheKeyById(id), REDIS_TTL, JSON.stringify(doc));
    } catch (cacheErr) {
      console.error('[Documents] Error almacenando en caché:', cacheErr.message);
    }

    return res.status(200).json(doc);
  } catch (err) {
    console.error(`[Documents] Error en GET /api/documents/${id}:`, err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── POST /api/signatures/process ────────────────────────────────────────────
//
// El Gateway enruta /api/signatures/* hacia este servicio.
// Este endpoint simplemente publica el documentId en la cola de RabbitMQ
// y devuelve 202 Accepted (procesamiento asíncrono).

app.post('/api/signatures/process', async (req, res) => {
  const { documentId } = req.body;

  if (!documentId || typeof documentId !== 'string' || documentId.trim() === '') {
    return res.status(400).json({ error: 'El campo `documentId` es obligatorio.' });
  }

  // Verificar que el documento existe
  try {
    const check = await pool.query('SELECT id FROM documents WHERE id = $1', [documentId.trim()]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: `Documento con id "${documentId}" no encontrado.` });
    }
  } catch (err) {
    console.error('[Documents] Error verificando documento:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!rabbitChannel) {
    return res.status(503).json({ error: 'Servicio de cola no disponible. Intenta de nuevo más tarde.' });
  }

  try {
    const message = JSON.stringify({ documentId: documentId.trim() });
    rabbitChannel.sendToQueue(SIGNATURE_QUEUE, Buffer.from(message), { persistent: true });
    console.log(`[Documents] Firma solicitada manualmente para documentId=${documentId}`);
    return res.status(202).json({ message: 'Signature processing initiated' });
  } catch (err) {
    console.error('[Documents] Error publicando en cola:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── PATCH /api/documents/:id/status [ENDPOINT INTERNO] ──────────────────────
//
// USO EXCLUSIVO del Signature Worker para actualizar el estado del documento.
// Protegido por el header `X-Internal-Token` que debe coincidir con la
// variable de entorno INTERNAL_TOKEN.
//
// NO está expuesto en el contrato público de la API Gateway.

app.patch('/api/documents/:id/status', async (req, res) => {
  // Validar token interno
  const internalToken = req.headers['x-internal-token'];
  if (!INTERNAL_TOKEN || internalToken !== INTERNAL_TOKEN) {
    console.warn(`[Documents] Intento de acceso interno no autorizado a PATCH /api/documents/${req.params.id}/status`);
    return res.status(403).json({ error: 'Acceso no autorizado.' });
  }

  const { id } = req.params;
  const { estado } = req.body;

  const validStates = ['PENDIENTE', 'FIRMADO'];
  if (!estado || !validStates.includes(estado)) {
    return res.status(400).json({ error: `El campo \`estado\` debe ser uno de: ${validStates.join(', ')}.` });
  }

  try {
    const result = await pool.query(
      `UPDATE documents
       SET estado = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, titulo, contenido_base64, autor_id, estado`,
      [estado, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Documento con id "${id}" no encontrado.` });
    }

    const doc = rowToDocumentResponse(result.rows[0]);
    console.log(`[Documents] Estado del documento ${id} actualizado a: ${estado}`);

    // Invalidar caché para forzar lectura fresca en próxima consulta
    try {
      await redis.del(cacheKeyById(id));
      await invalidateListCache();
      console.log(`[Documents] Caché invalidada para documento ${id} tras cambio de estado.`);
    } catch (cacheErr) {
      console.error('[Documents] Error invalidando caché tras actualización:', cacheErr.message);
    }

    return res.status(200).json(doc);
  } catch (err) {
    console.error(`[Documents] Error en PATCH /api/documents/${id}/status:`, err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

async function start() {
  await initDB();
  await connectRabbitMQ();
  app.listen(PORT, () => {
    console.log(`[Documents] EcoFirma Documents Service escuchando en http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[Documents] Error fatal en el arranque:', err.message);
  process.exit(1);
});
