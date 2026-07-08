'use strict';

/**
 * EcoFirma Users Service  (puerto 3001)
 * ──────────────────────────────────────
 * Responsabilidades:
 *   - POST /api/users/register  → Registra un nuevo usuario (bcrypt hash)
 *   - POST /api/users/login     → Autentica y devuelve JWT
 *
 * Base de datos: MySQL (tabla `users`)
 * Columnas: id (VARCHAR(36)), nombre, email (UNIQUE), password_hash, created_at
 */

const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const { register, metricsMiddleware } = require('./metrics');

const app = express();
const PORT = process.env.PORT || process.env.USERS_SERVICE_PORT || 3001;

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

if (!JWT_SECRET) {
  console.error('[Users] FATAL: JWT_SECRET no está definido. El servicio no puede arrancar de forma segura.');
  process.exit(1);
}

// ─── Conexión a MySQL ─────────────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? mysql.createPool(process.env.DATABASE_URL)
  : mysql.createPool({
      host: process.env.MYSQL_HOST || 'mysql',
      port: Number(process.env.MYSQL_PORT) || 3306,
      database: process.env.MYSQL_DB || 'ecofirma_users_db',
      user: process.env.MYSQL_USER || 'ecofirma_user',
      password: process.env.MYSQL_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 5000,
    });

// ─── Inicialización de tabla ──────────────────────────────────────────────────

/**
 * Crea la tabla `users` si no existe.
 * Se usa un esquema de reintentos con backoff exponencial para aguardar
 * a que MySQL esté listo.
 */
async function initDB(retries = 10, delay = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id            VARCHAR(36) PRIMARY KEY,
          nombre        VARCHAR(255) NOT NULL,
          email         VARCHAR(255) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('[Users] Tabla `users` lista en MySQL.');
      return;
    } catch (err) {
      console.warn(`[Users] Intento ${attempt}/${retries} de conexión a MySQL falló: ${err.message}`);
      if (attempt === retries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Middlewares ──────────────────────────────────────────────────────────────

app.use(express.json());
app.use(morgan('combined'));
// Instrumentación automática de requests para Prometheus
app.use(metricsMiddleware('users-service'));

// ─── Health-check y métricas Prometheus ─────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ecofirma-users-service' });
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

// ─── POST /api/users/register ─────────────────────────────────────────────────

app.post('/api/users/register', async (req, res) => {
  const { nombre, email, password } = req.body;

  // Validación de campos requeridos
  if (!nombre || typeof nombre !== 'string' || nombre.trim() === '') {
    return res.status(400).json({ error: 'El campo `nombre` es obligatorio.' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'El campo `email` debe ser un correo electrónico válido.' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'El campo `password` debe tener al menos 6 caracteres.' });
  }

  try {
    // Bcrypt con factor de costo 12 (buen balance entre seguridad y rendimiento)
    const SALT_ROUNDS = 12;
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const userId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, nombre, email, password_hash)
       VALUES (?, ?, ?, ?)`,
      [userId, nombre.trim(), email.toLowerCase().trim(), password_hash]
    );

    const user = { userId, nombre: nombre.trim(), email: email.toLowerCase().trim() };
    console.log(`[Users] Usuario registrado: ${user.userId} (${user.email})`);

    return res.status(201).json(user);
  } catch (err) {
    // ER_DUP_ENTRY = violación de clave única en MySQL (email duplicado)
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.status(409).json({ error: 'El email ya está registrado. Utiliza otro correo electrónico.' });
    }
    console.error('[Users] Error en /register:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor. Intenta de nuevo más tarde.' });
  }
});

// ─── POST /api/users/login ────────────────────────────────────────────────────

app.post('/api/users/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Los campos `email` y `password` son obligatorios.' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id AS "userId", nombre, email, password_hash
       FROM users
       WHERE email = ?`,
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      // No revelar si el email existe o no (seguridad)
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const user = rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // Firma del JWT con los datos mínimos necesarios (no incluir password_hash)
    const payload = {
      userId: user.userId,
      nombre: user.nombre,
      email: user.email,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    console.log(`[Users] Login exitoso: ${user.email}`);
    return res.status(200).json({
      token,
      user: {
        userId: user.userId,
        nombre: user.nombre,
        email: user.email,
      },
    });
  } catch (err) {
    console.error('[Users] Error en /login:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor. Intenta de nuevo más tarde.' });
  }
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`[Users] EcoFirma Users Service escuchando en http://0.0.0.0:${PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[Users] No se pudo inicializar la base de datos:', err.message);
    process.exit(1);
  });
} else if (process.env.NODE_ENV === 'test') {
  initDB().catch((err) => console.error('[Users] Error inicializando tests:', err.message));
}

module.exports = app;
