process.env.NODE_ENV = 'test';
const request = require('supertest');
const app = require('../src/app');

describe('health endpoints', () => {
  test('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
  test('GET /health/ready is 503 when DB not connected', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
  });
  test('unknown route is 404, not a crash', async () => {
    const res = await request(app).get('/definitely-not-a-route');
    expect(res.status).toBe(404);
  });
});
