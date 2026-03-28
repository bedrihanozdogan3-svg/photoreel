/**
 * Fenix AI — API Veri Validasyonu
 * Joi şemaları ile tüm API girişlerini doğrular.
 */

const Joi = require('joi');

/**
 * Middleware factory — route'lara Joi validasyonu ekler.
 * Kullanım: router.post('/send', validate(schemas.sendMessage), handler)
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const data = source === 'body' ? req.body : source === 'query' ? req.query : req.params;
    const { error, value } = schema.validate(data, { abortEarly: false, stripUnknown: true });
    if (error) {
      const details = error.details.map(d => d.message).join(', ');
      return res.status(400).json({ ok: false, error: 'Geçersiz veri: ' + details });
    }
    // Temizlenmiş veriyi geri koy
    if (source === 'body') req.body = value;
    else if (source === 'query') req.query = value;
    else req.params = value;
    next();
  };
}

// === ŞEMALAR ===

const schemas = {
  // Chat API
  startConversation: Joi.object({
    topic: Joi.string().min(1).max(500).required(),
    maxTurns: Joi.number().integer().min(1).max(100).default(20)
  }),

  sendMessage: Joi.object({
    text: Joi.string().min(1).max(5000).required()
  }),

  // Claude Local
  sendToTablet: Joi.object({
    text: Joi.string().min(1).max(500000).required(), // 500KB — HTML dosyası gönderilebilsin
    from: Joi.string().max(50).default('tablet')
  }),

  replyMessage: Joi.object({
    text: Joi.string().min(1).max(5000).required(),
    replyTo: Joi.string().max(50).allow(null).default(null)
  }),

  ackMessages: Joi.object({
    ids: Joi.array().items(Joi.string().max(50)).min(1).max(100).required()
  }),

  // Agent
  agentCommand: Joi.object({
    type: Joi.string().valid('screenshot', 'run', 'close_app', 'open_app', 'shutdown', 'restart', 'lock', 'message').required(),
    data: Joi.string().max(1000).allow('').default('')
  }),

  // Approval
  approvalRequest: Joi.object({
    title: Joi.string().max(200).default('Onay Gerekli'),
    description: Joi.string().max(500).allow('').default(''),
    type: Joi.string().max(50).default('general')
  }),

  approvalResponse: Joi.object({
    decision: Joi.string().valid('approved', 'rejected').required()
  }),

  // Terminal
  terminalOutput: Joi.object({
    text: Joi.string().min(1).max(10000).required()
  }),

  // Product Analyze
  productAnalyze: Joi.object({
    image: Joi.string().min(1).max(5000000).required(), // base64 veya URL
    mimeType: Joi.string().valid('image/jpeg', 'image/png', 'image/webp').default('image/jpeg')
  }),

  productAnalyzeMultiple: Joi.object({
    images: Joi.array().items(Joi.object({
      image: Joi.string().min(1).max(500000).required(), // ~375KB base64 per image
      mimeType: Joi.string().valid('image/jpeg', 'image/png', 'image/webp').default('image/jpeg')
    })).min(1).max(10).required() // Max 10 ürün, toplam ~3.75MB
  }),

  // Background
  backgroundGenerate: Joi.object({
    analysis: Joi.object().required(),
    preferences: Joi.object().default({})
  }),

  // Music
  musicSearch: Joi.object({
    analysis: Joi.object().required(),
    duration: Joi.number().integer().min(5).max(120).default(30)
  }),

  beatSync: Joi.object({
    bpm: Joi.number().integer().min(40).max(220).required(),
    sceneDuration: Joi.number().min(0.5).max(30).default(2),
    sceneCount: Joi.number().integer().min(1).max(50).required()
  }),

  // Video
  videoStoryboard: Joi.object({
    images: Joi.array().items(Joi.string().min(1)).min(1).max(50).required(),
    options: Joi.object().default({})
  }),

  // Feedback
  feedback: Joi.object({
    videoId: Joi.string().max(100).allow(null),
    rating: Joi.string().valid('like', 'dislike').required(),
    category: Joi.string().max(100).default('unknown'),
    templateUsed: Joi.string().max(200).allow(null).default(null),
    transitionsUsed: Joi.array().items(Joi.string().max(50)).default([]),
    musicUsed: Joi.string().max(200).allow(null).default(null),
    comment: Joi.string().max(1000).allow(null).default(null),
    userId: Joi.string().max(100).default('anonymous')
  }),

  // Queue
  queueEnqueue: Joi.object({
    type: Joi.string().min(1).max(50).required(),
    payload: Joi.object().default({}),
    userId: Joi.string().max(100).allow(null).default(null)
  }),

  // Tool Call
  toolCall: Joi.object({
    name: Joi.string().min(1).max(100).required(),
    input: Joi.object().default({}),
    caller: Joi.string().max(50).default('api')
  }),
};

module.exports = { validate, schemas };
