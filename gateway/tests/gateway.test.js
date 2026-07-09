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
