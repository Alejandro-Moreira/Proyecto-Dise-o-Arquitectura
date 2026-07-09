'use strict';

const request = require('supertest');
const app = require('../index');

describe('API Gateway health check', () => {
  test('GET /health devuelve 200 con status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('ecofirma-gateway');
  });
});

describe('API Gateway Swagger documentation', () => {
  test('GET /api/docs devuelve HTML de Swagger UI', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!DOCTYPE html>');
    expect(res.text).toContain('swagger-ui');
  });

  test('GET /api/docs/swagger.json devuelve la especificación en JSON', async () => {
    const res = await request(app).get('/api/docs/swagger.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.info.title).toBe('EcoFirma API Gateway');
  });
});
