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
    text: Joi.string().min(1).max(5000).required(),
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
};

module.exports = { validate, schemas };
