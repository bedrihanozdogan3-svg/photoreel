const { analyzeProduct } = require('../services/product-analyzer');

describe('Product Analyzer', () => {
  test('API key yoksa hata fırlatır', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = '';
    // Config cache'ini temizle
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../services/product-analyzer')];
    const { analyzeProduct: ap } = require('../services/product-analyzer');
    await expect(ap('test', 'image/jpeg')).rejects.toThrow();
    process.env.GEMINI_API_KEY = origKey;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../services/product-analyzer')];
  });

  test('modül export doğru', () => {
    expect(typeof analyzeProduct).toBe('function');
  });
});
