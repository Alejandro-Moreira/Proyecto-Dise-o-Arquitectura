'use strict';

/**
 * Tests unitarios del Users Service
 * ────────────────────────────────────
 * Cubre los endpoints POST /api/users/register y POST /api/users/login
 * usando mocks de pg y bcrypt para aislar de la infraestructura.
 */

const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock de pg Pool
const mockQuery = jest.fn();
jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: mockQuery,
    })),
  };
});

// Mock de bcryptjs
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed_password_mock'),
  compare: jest.fn(),
}));

// Mock de jsonwebtoken
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Carga la app después de configurar los mocks para evitar que initDB()
 * intente conectarse a una DB real durante los tests.
 */
function loadApp() {
  // Forzar que initDB() tenga éxito sin DB real
  mockQuery.mockResolvedValueOnce({ rows: [] }); // CREATE TABLE IF NOT EXISTS
  jest.resetModules();
  process.env.JWT_SECRET = 'test_secret_min_32_chars_ok_here';
  process.env.POSTGRES_PASSWORD = 'test_password';
  return require('../index');
}

// ─── Tests: POST /api/users/register ─────────────────────────────────────────

describe('POST /api/users/register', () => {
  let app;

  beforeAll(async () => {
    app = await loadApp();
    // Dar tiempo a que initDB() termine
    await new Promise((r) => setTimeout(r, 100));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('registra usuario correctamente y devuelve 201 con userId, nombre y email', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        userId: 'uuid-test-1',
        nombre: 'Ana García',
        email: 'ana@test.com',
      }],
    });

    const res = await request(app)
      .post('/api/users/register')
      .send({ nombre: 'Ana García', email: 'ana@test.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('userId');
    expect(res.body).toHaveProperty('nombre', 'Ana García');
    expect(res.body).toHaveProperty('email', 'ana@test.com');
    expect(res.body).not.toHaveProperty('password_hash');
  });

  test('devuelve 400 si falta el campo nombre', async () => {
    const res = await request(app)
      .post('/api/users/register')
      .send({ email: 'ana@test.com', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('devuelve 400 si el email no es válido', async () => {
    const res = await request(app)
      .post('/api/users/register')
      .send({ nombre: 'Ana', email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  test('devuelve 400 si el password tiene menos de 6 caracteres', async () => {
    const res = await request(app)
      .post('/api/users/register')
      .send({ nombre: 'Ana', email: 'ana@test.com', password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  test('devuelve 409 si el email ya está registrado (PG error 23505)', async () => {
    const pgError = new Error('duplicate key value');
    pgError.code = '23505';
    mockQuery.mockRejectedValueOnce(pgError);

    const res = await request(app)
      .post('/api/users/register')
      .send({ nombre: 'Ana', email: 'duplicado@test.com', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });
});

// ─── Tests: POST /api/users/login ────────────────────────────────────────────

describe('POST /api/users/login', () => {
  let app;

  beforeAll(async () => {
    app = await loadApp();
    await new Promise((r) => setTimeout(r, 100));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('login exitoso devuelve 200 con token JWT', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        userId: 'uuid-1',
        nombre: 'Ana',
        email: 'ana@test.com',
        password_hash: 'hashed',
      }],
    });
    require('bcryptjs').compare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/api/users/login')
      .send({ email: 'ana@test.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('user');
    expect(typeof res.body.token).toBe('string');
  });

  test('devuelve 401 si el usuario no existe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/users/login')
      .send({ email: 'noexiste@test.com', password: 'password123' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/credenciales/i);
  });

  test('devuelve 401 si el password es incorrecto', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ userId: 'uuid-1', nombre: 'Ana', email: 'ana@test.com', password_hash: 'hashed' }],
    });
    require('bcryptjs').compare.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/users/login')
      .send({ email: 'ana@test.com', password: 'wrong' });

    expect(res.status).toBe(401);
  });

  test('devuelve 400 si faltan email o password', async () => {
    const res = await request(app)
      .post('/api/users/login')
      .send({ email: 'ana@test.com' });

    expect(res.status).toBe(400);
  });
});

// ─── Tests: GET /health ───────────────────────────────────────────────────────

describe('GET /health', () => {
  let app;

  beforeAll(async () => {
    app = await loadApp();
    await new Promise((r) => setTimeout(r, 100));
  });

  test('devuelve 200 con status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
