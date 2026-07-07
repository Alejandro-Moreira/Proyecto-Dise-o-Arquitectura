'use strict';

/**
 * Tests unitarios del Documents Service
 * ─────────────────────────────────────
 * Cubre CRUD de documentos con mocks de pg, ioredis y amqplib.
 */

const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));

const mockRedisGet = jest.fn();
const mockRedisSetex = jest.fn();
const mockRedisDel = jest.fn();
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    setex: mockRedisSetex,
    del: mockRedisDel,
    on: jest.fn(),
  }));
});

const mockSendToQueue = jest.fn();
const mockAssertQueue = jest.fn().mockResolvedValue({});
const mockAssertExchange = jest.fn().mockResolvedValue({});
const mockBindQueue = jest.fn().mockResolvedValue({});
jest.mock('amqplib', () => ({
  connect: jest.fn().mockResolvedValue({
    createChannel: jest.fn().mockResolvedValue({
      assertQueue: mockAssertQueue,
      assertExchange: mockAssertExchange,
      bindQueue: mockBindQueue,
      sendToQueue: mockSendToQueue,
      consume: jest.fn(),
    }),
    on: jest.fn(),
  }),
}));

// ─── Muestra de documento ─────────────────────────────────────────────────────

const SAMPLE_DOC_ROW = {
  id: 'doc-uuid-123',
  titulo: 'Contrato Test',
  contenido_base64: 'Q29udGVuaWRv',
  autor_id: 'user-uuid-456',
  estado: 'PENDIENTE',
};

const SAMPLE_DOC_RESPONSE = {
  id: 'doc-uuid-123',
  titulo: 'Contrato Test',
  contenidoBase64: 'Q29udGVuaWRv',
  autorId: 'user-uuid-456',
  estado: 'PENDIENTE',
  status: 'PENDIENTE',
};

// ─── Setup ───────────────────────────────────────────────────────────────────

let app;

beforeAll(async () => {
  mockQuery.mockResolvedValue({ rows: [] }); // initDB CREATE TABLE
  jest.resetModules();
  process.env.POSTGRES_PASSWORD = 'test_password';
  process.env.INTERNAL_TOKEN = 'test_internal_token';
  app = require('../index');
  await new Promise((r) => setTimeout(r, 200));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);  // default: cache MISS
  mockRedisSetex.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
});

// ─── Tests: POST /api/documents ──────────────────────────────────────────────

describe('POST /api/documents', () => {
  test('crea documento y devuelve 201 con estructura correcta', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [SAMPLE_DOC_ROW] });

    const res = await request(app)
      .post('/api/documents')
      .send({
        titulo: 'Contrato Test',
        contenidoBase64: 'Q29udGVuaWRv',
        autorId: 'user-uuid-456',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(SAMPLE_DOC_RESPONSE);
    // Verifica que se publicó en RabbitMQ
    expect(mockSendToQueue).toHaveBeenCalledWith(
      'signature_queue',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true })
    );
  });

  test('devuelve 400 si falta titulo', async () => {
    const res = await request(app)
      .post('/api/documents')
      .send({ contenidoBase64: 'abc', autorId: 'u1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/titulo/i);
  });

  test('devuelve 400 si falta contenidoBase64', async () => {
    const res = await request(app)
      .post('/api/documents')
      .send({ titulo: 'Test', autorId: 'u1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contenidoBase64/i);
  });

  test('devuelve 400 si falta autorId', async () => {
    const res = await request(app)
      .post('/api/documents')
      .send({ titulo: 'Test', contenidoBase64: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/autorId/i);
  });
});

// ─── Tests: GET /api/documents ────────────────────────────────────────────────

describe('GET /api/documents', () => {
  test('devuelve lista desde PostgreSQL cuando cache MISS', async () => {
    mockRedisGet.mockResolvedValueOnce(null); // MISS
    mockQuery.mockResolvedValueOnce({ rows: [SAMPLE_DOC_ROW] });

    const res = await request(app).get('/api/documents');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject(SAMPLE_DOC_RESPONSE);
    // Verifica que se guardó en caché
    expect(mockRedisSetex).toHaveBeenCalled();
  });

  test('devuelve lista desde Redis cuando cache HIT (no consulta PG)', async () => {
    const cached = JSON.stringify([SAMPLE_DOC_RESPONSE]);
    mockRedisGet.mockResolvedValueOnce(cached); // HIT

    const res = await request(app).get('/api/documents');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject(SAMPLE_DOC_RESPONSE);
    // PG NO debe ser consultado en cache HIT
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─── Tests: GET /api/documents/:id ───────────────────────────────────────────

describe('GET /api/documents/:id', () => {
  test('devuelve documento por ID desde PostgreSQL (cache MISS)', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({ rows: [SAMPLE_DOC_ROW] });

    const res = await request(app).get('/api/documents/doc-uuid-123');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(SAMPLE_DOC_RESPONSE);
    expect(mockRedisSetex).toHaveBeenCalled();
  });

  test('devuelve documento desde Redis (cache HIT)', async () => {
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(SAMPLE_DOC_RESPONSE));

    const res = await request(app).get('/api/documents/doc-uuid-123');

    expect(res.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('devuelve 404 si el documento no existe', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/documents/no-existe');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no encontrado/i);
  });
});

describe('PUT /api/documents/:id', () => {
  test('actualiza un documento existente', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_DOC_ROW] })
      .mockResolvedValueOnce({
        rows: [{ ...SAMPLE_DOC_ROW, titulo: 'Contrato Actualizado' }],
      });

    const res = await request(app)
      .put('/api/documents/doc-uuid-123')
      .send({ titulo: 'Contrato Actualizado' });

    expect(res.status).toBe(200);
    expect(res.body.titulo).toBe('Contrato Actualizado');
    expect(mockRedisSetex).toHaveBeenCalled();
    expect(mockRedisDel).toHaveBeenCalled();
  });

  test('devuelve 404 al actualizar documento inexistente', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/api/documents/no-existe')
      .send({ titulo: 'Nuevo título' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/documents/:id', () => {
  test('elimina un documento existente', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'doc-uuid-123' }] });

    const res = await request(app).delete('/api/documents/doc-uuid-123');

    expect(res.status).toBe(204);
    expect(mockRedisDel).toHaveBeenCalled();
  });

  test('devuelve 404 al eliminar documento inexistente', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/api/documents/no-existe');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/documents/:id/status', () => {
  test('devuelve el estado público del documento', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'doc-uuid-123', estado: 'FIRMADO' }] });

    const res = await request(app).get('/api/documents/doc-uuid-123/status');

    expect(res.status).toBe(200);
    expect(res.body.documentId).toBe('doc-uuid-123');
    expect(res.body.status).toBe('FIRMADO');
  });
});

// ─── Tests: PATCH /api/documents/:id/status [INTERNO] ────────────────────────

describe('PATCH /api/documents/:id/status (interno)', () => {
  test('actualiza estado a FIRMADO con token interno correcto', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...SAMPLE_DOC_ROW, estado: 'FIRMADO' }],
    });

    const res = await request(app)
      .patch('/api/documents/doc-uuid-123/status')
      .set('X-Internal-Token', 'test_internal_token')
      .send({ estado: 'FIRMADO' });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('FIRMADO');
    expect(res.body.status).toBe('FIRMADO');
    // Verifica que se invalida la caché
    expect(mockRedisDel).toHaveBeenCalled();
  });

  test('devuelve 403 sin token interno o token incorrecto', async () => {
    const res = await request(app)
      .patch('/api/documents/doc-uuid-123/status')
      .set('X-Internal-Token', 'wrong_token')
      .send({ estado: 'FIRMADO' });

    expect(res.status).toBe(403);
  });

  test('devuelve 400 con estado inválido', async () => {
    const res = await request(app)
      .patch('/api/documents/doc-uuid-123/status')
      .set('X-Internal-Token', 'test_internal_token')
      .send({ estado: 'ESTADO_INVALIDO' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/estado/i);
  });
});

// ─── Tests: GET /health y /metrics ───────────────────────────────────────────

describe('Endpoints de observabilidad', () => {
  test('GET /health devuelve 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /metrics devuelve métricas en formato Prometheus', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('# HELP');
  });
});
