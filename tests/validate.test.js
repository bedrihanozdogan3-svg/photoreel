const { schemas } = require('../middlewares/validate');

describe('Validation Schemas', () => {
  describe('sendMessage', () => {
    test('geçerli mesaj kabul edilir', () => {
      const { error } = schemas.sendMessage.validate({ text: 'Merhaba' });
      expect(error).toBeUndefined();
    });

    test('boş mesaj reddedilir', () => {
      const { error } = schemas.sendMessage.validate({ text: '' });
      expect(error).toBeDefined();
    });

    test('text olmadan reddedilir', () => {
      const { error } = schemas.sendMessage.validate({});
      expect(error).toBeDefined();
    });

    test('çok uzun mesaj reddedilir', () => {
      const { error } = schemas.sendMessage.validate({ text: 'a'.repeat(5001) });
      expect(error).toBeDefined();
    });
  });

  describe('agentCommand', () => {
    test('geçerli komut kabul edilir', () => {
      const { error } = schemas.agentCommand.validate({ type: 'screenshot', data: '' });
      expect(error).toBeUndefined();
    });

    test('geçersiz type reddedilir', () => {
      const { error } = schemas.agentCommand.validate({ type: 'hack', data: '' });
      expect(error).toBeDefined();
    });
  });

  describe('approvalResponse', () => {
    test('approved kabul edilir', () => {
      const { error } = schemas.approvalResponse.validate({ decision: 'approved' });
      expect(error).toBeUndefined();
    });

    test('geçersiz karar reddedilir', () => {
      const { error } = schemas.approvalResponse.validate({ decision: 'maybe' });
      expect(error).toBeDefined();
    });
  });
});
