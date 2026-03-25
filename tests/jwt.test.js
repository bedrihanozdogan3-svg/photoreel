const { generateToken, verifyToken, generateApiKey } = require('../utils/jwt');

describe('JWT Utils', () => {
  test('token oluşturulabilir ve doğrulanabilir', () => {
    const token = generateToken({ userId: 'test123' });
    expect(token).toBeDefined();
    const decoded = verifyToken(token);
    expect(decoded.userId).toBe('test123');
  });

  test('geçersiz token null döner', () => {
    const result = verifyToken('invalid-token');
    expect(result).toBeNull();
  });

  test('API key oluşturulabilir', () => {
    const key = generateApiKey('user1');
    expect(key).toBeDefined();
    const decoded = verifyToken(key);
    expect(decoded.type).toBe('api_key');
  });
});
