'use strict';

/**
 * EcoFirma Signature Worker
 * ─────────────────────────
 * Contenedor independiente (sin servidor HTTP de negocio propio).
 * Simula la función de una Lambda/Serverless que procesa firmas digitales.
 *
 * Comportamiento:
 *   1. Se conecta a RabbitMQ y consume la cola `signature_queue`.
 *   2. Usa prefetch(1) + ack manual → garantiza procesamiento one-at-a-time
 *      y evita pérdida de mensajes si el proceso cae a mitad de un job.
 *   3. Simula 3 segundos de "procesamiento criptográfico".
 *   4. Llama al endpoint interno del Documents Service para marcar el
 *      documento como FIRMADO (usando X-Internal-Token).
 *   5. Si la llamada falla → nack con requeue, el mensaje vuelve a la cola.
 *      Mensajes con x-death >= MAX_RETRIES → nack sin requeue (→ DLQ).
 *
 * También expone un puerto HTTP mínimo (3003) solo para healthcheck de Docker.
 */

const amqp = require('amqplib');
const axios = require('axios');
const express = require('express');

// ─── Variables de entorno ─────────────────────────────────────────────────────

const RABBITMQ_USER = process.env.RABBITMQ_USER || 'guest';
const RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD || 'guest';
const RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'rabbitmq';
const RABBITMQ_PORT = process.env.RABBITMQ_PORT || 5672;
const RABBITMQ_URL = `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${RABBITMQ_HOST}:${RABBITMQ_PORT}`;
const SIGNATURE_QUEUE = 'signature_queue';

const DOCUMENTS_SERVICE_URL = process.env.DOCUMENTS_SERVICE_URL || 'http://documents-service:3002';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

// Número máximo de veces que un mensaje puede ser reintentado antes de ir a DLQ
const MAX_RETRIES = 3;

// Simulación del tiempo de procesamiento criptográfico (ms)
const CRYPTO_PROCESSING_DELAY_MS = 3000;

// ─── Servidor HTTP mínimo (solo para healthcheck) ─────────────────────────────

const healthApp = express();
healthApp.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ecofirma-signature-worker' });
});
healthApp.listen(3003, () => {
  console.log('[Worker] Servidor de healthcheck escuchando en http://0.0.0.0:3003');
});

// ─── Procesamiento de un mensaje ──────────────────────────────────────────────

/**
 * Simula el procesamiento criptográfico de una firma digital.
 * En producción, aquí iría la lógica real (HSM, PKI, etc.).
 *
 * @param {string} documentId  UUID del documento a firmar
 */
async function simulateCryptoProcessing(documentId) {
  console.log(`[Worker] ⏳ Iniciando procesamiento criptográfico para documentId=${documentId}...`);
  await new Promise((resolve) => setTimeout(resolve, CRYPTO_PROCESSING_DELAY_MS));
  console.log(`[Worker] ✅ Procesamiento criptográfico completado para documentId=${documentId}`);
}

/**
 * Llama al endpoint interno del Documents Service para actualizar el estado.
 *
 * @param {string} documentId
 * @throws Error si la llamada HTTP falla (para que el caller haga nack)
 */
async function markDocumentAsSigned(documentId) {
  const url = `${DOCUMENTS_SERVICE_URL}/api/documents/${documentId}/status`;
  console.log(`[Worker] Actualizando estado del documento ${documentId} → FIRMADO via ${url}`);

  const response = await axios.patch(
    url,
    { estado: 'FIRMADO' },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': INTERNAL_TOKEN,
      },
      timeout: 10000, // 10 segundos máximo de espera
    }
  );

  console.log(`[Worker] Documents Service respondió ${response.status} para documentId=${documentId}`);
}

/**
 * Obtiene el conteo de muertes (x-death) de un mensaje para saber cuántas
 * veces ha sido rechazado y reencolado.
 *
 * @param {Object} msg  Mensaje de amqplib
 * @returns {number}
 */
function getDeathCount(msg) {
  const xDeath = msg.properties.headers && msg.properties.headers['x-death'];
  if (!Array.isArray(xDeath) || xDeath.length === 0) return 0;
  return xDeath.reduce((sum, entry) => sum + (entry.count || 0), 0);
}

// ─── Consumidor principal ─────────────────────────────────────────────────────

/**
 * Conecta a RabbitMQ con reintentos y comienza a consumir mensajes.
 */
async function startWorker(retries = 15, delay = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Worker] Intentando conectar a RabbitMQ (${attempt}/${retries})...`);
      const connection = await amqp.connect(RABBITMQ_URL);
      const channel = await connection.createChannel();

      // Declara la cola principal como durable con DLX configurado
      await channel.assertQueue(SIGNATURE_QUEUE, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': 'ecofirma.dlx',
          'x-dead-letter-routing-key': 'signature.dead',
        },
      });

      // Declara DLX y su cola de mensajes muertos
      await channel.assertExchange('ecofirma.dlx', 'direct', { durable: true });
      await channel.assertQueue('signature_dead_letter', { durable: true });
      await channel.bindQueue('signature_dead_letter', 'ecofirma.dlx', 'signature.dead');

      // prefetch(1): procesa UN mensaje a la vez → evita sobrecarga y pérdida de mensajes
      await channel.prefetch(1);

      console.log(`[Worker] 🚀 Conectado a RabbitMQ. Consumiendo cola: ${SIGNATURE_QUEUE}`);

      channel.consume(SIGNATURE_QUEUE, async (msg) => {
        if (!msg) {
          // El canal fue cancelado por el broker
          console.warn('[Worker] Mensaje nulo recibido (canal cancelado).');
          return;
        }

        let documentId = null;

        try {
          const content = JSON.parse(msg.content.toString());
          documentId = content.documentId;

          if (!documentId) {
            throw new Error('Mensaje inválido: falta `documentId`.');
          }

          console.log(`[Worker] 📨 Mensaje recibido: documentId=${documentId}`);

          // Verificar si el mensaje ha sido reintentado demasiadas veces
          const deathCount = getDeathCount(msg);
          if (deathCount >= MAX_RETRIES) {
            console.error(
              `[Worker] ❌ documentId=${documentId} superó el límite de ${MAX_RETRIES} reintentos. Enviando a DLQ.`
            );
            // nack sin requeue → RabbitMQ lo enrutará al DLX automáticamente
            channel.nack(msg, false, false);
            return;
          }

          // Simulación del procesamiento criptográfico (3 segundos)
          await simulateCryptoProcessing(documentId);

          // Llamada al Documents Service para actualizar estado
          await markDocumentAsSigned(documentId);

          // ack manual: confirma que el mensaje fue procesado exitosamente
          channel.ack(msg);
          console.log(`[Worker] ✔ Mensaje procesado y confirmado (ack) para documentId=${documentId}`);
        } catch (err) {
          const context = documentId ? `documentId=${documentId}` : 'mensaje desconocido';
          console.error(`[Worker] ❌ Error procesando ${context}:`, err.message);

          if (err.response) {
            // Error HTTP del Documents Service
            console.error(
              `[Worker] Documents Service respondió ${err.response.status}: ${JSON.stringify(err.response.data)}`
            );
          }

          // nack con requeue=true → el mensaje vuelve a la cola para reintento
          // Si llega al límite MAX_RETRIES, la próxima iteración lo enviará a DLQ
          channel.nack(msg, false, true);
          console.warn(`[Worker] ↩ Mensaje reencola para reintento.`);
        }
      });

      // Manejar cierre de conexión
      connection.on('close', () => {
        console.warn('[Worker] Conexión RabbitMQ cerrada. Reconectando en 10s...');
        setTimeout(() => startWorker(), 10000);
      });

      connection.on('error', (err) => {
        console.error('[Worker] Error en conexión RabbitMQ:', err.message);
      });

      return; // Éxito; salir del bucle de reintentos
    } catch (err) {
      console.warn(`[Worker] Intento ${attempt}/${retries} fallido: ${err.message}`);
      if (attempt === retries) {
        console.error('[Worker] FATAL: No se pudo conectar a RabbitMQ tras todos los intentos.');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Manejo de señales del proceso ───────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[Worker] SIGTERM recibido. Cerrando worker gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Worker] SIGINT recibido. Cerrando worker gracefully...');
  process.exit(0);
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

startWorker();
