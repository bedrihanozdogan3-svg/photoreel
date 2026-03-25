const config = require('../config');

describe('Config', () => {
  test('varsayılan port 3000', () => {
    expect(config.port).toBe(3000);
  });

  test('env development olmalı (test ortamı)', () => {
    expect(['development', 'test']).toContain(config.env);
  });

  test('bodyLimit tanımlı olmalı', () => {
    expect(config.bodyLimit).toBeDefined();
  });

  test('kota limitleri pozitif sayı olmalı', () => {
    expect(config.quota.gemini).toBeGreaterThan(0);
    expect(config.quota.claude).toBeGreaterThan(0);
  });

  test('allowedOrigins dizi olmalı', () => {
    expect(Array.isArray(config.allowedOrigins)).toBe(true);
    expect(config.allowedOrigins.length).toBeGreaterThan(0);
  });
});
