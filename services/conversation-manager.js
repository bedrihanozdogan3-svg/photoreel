const fs = require('fs');
const path = require('path');
const geminiService = require('./gemini-service');
const claudeService = require('./claude-service');

class ConversationManager {
  constructor(io) {
    this.io = io;
    this.state = 'idle'; // idle, running, paused
    this.messages = [];
    this.maxTurns = 20;
    this.currentTurn = 0;
    this.shouldStop = false;
  }

  async start(topic, maxTurns = 20) {
    this.state = 'running';
    this.maxTurns = maxTurns;
    this.currentTurn = 0;
    this.shouldStop = false;
    this.messages = [];
    this._emit('status', { state: 'running', topic });

    try {
      // İlk mesajı Claude'a gönder
      let currentMessage = `Konu: ${topic}. Bu konuda düşüncelerini paylaş ve önerilerini sun.`;

      for (let i = 0; i < maxTurns && !this.shouldStop; i++) {
        this.currentTurn = i + 1;

        // Claude'un sırası
        if (claudeService.isAvailable()) {
          const claudeResponse = await claudeService.sendMessage(this.messages, currentMessage);
          this._addMessage('claude', claudeResponse);

          if (this.shouldStop) break;

          // Gemini'nin sırası
          const geminiResponse = await geminiService.sendMessage(this.messages, `Claude şunu söyledi: ${claudeResponse}\n\nBu konuda senin düşüncelerin ne?`);
          this._addMessage('gemini', geminiResponse);
          currentMessage = `Gemini şunu söyledi: ${geminiResponse}\n\nBu konuda devam et veya yeni bir bakış açısı sun.`;
        } else {
          // Claude yoksa sadece Gemini
          const geminiResponse = await geminiService.sendMessage(this.messages, currentMessage);
          this._addMessage('gemini', geminiResponse);
          currentMessage = `Önceki cevabına devam et veya konuyu derinleştir.`;
        }

        // Pause kontrolü
        while (this.state === 'paused' && !this.shouldStop) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch (err) {
      this._emit('error', { message: err.message });
    }

    this.state = 'idle';
    this._emit('status', { state: 'idle', message: 'Konuşma tamamlandı' });
    this._saveConversation(topic);
  }

  stop() {
    this.shouldStop = true;
    this.state = 'idle';
    this._emit('status', { state: 'idle', message: 'Durduruldu' });
  }

  pause() {
    this.state = 'paused';
    this._emit('status', { state: 'paused' });
  }

  resume() {
    this.state = 'running';
    this._emit('status', { state: 'running' });
  }

  async injectMessage(text) {
    this._addMessage('user', text);
    // Gemini'ye gönder
    try {
      const geminiRes = await geminiService.sendMessage(this.messages, text);
      this._addMessage('gemini', geminiRes);
    } catch(e) {
      this._emit('error', { message: 'Gemini hatası: ' + e.message });
    }
    // Claude'a gönder (hata verirse atla)
    if (claudeService.isAvailable()) {
      try {
        const claudeRes = await claudeService.sendMessage(this.messages, text);
        this._addMessage('claude', claudeRes);
      } catch(e) {
        this._emit('error', { message: 'Claude hatası: ' + e.message });
      }
    }
  }

  async sendToGemini(text) {
    this._addMessage('user', text);
    const response = await geminiService.sendMessage(this.messages, text);
    this._addMessage('gemini', response);
    return response;
  }

  async sendToClaude(text) {
    if (!claudeService.isAvailable()) {
      throw new Error('Claude API key ayarlanmamış');
    }
    this._addMessage('user', text);
    const response = await claudeService.sendMessage(this.messages, text);
    this._addMessage('claude', response);
    return response;
  }

  _addMessage(sender, text) {
    const msg = { sender, text, timestamp: new Date().toISOString() };
    this.messages.push(msg);
    this._emit('message', msg);
    this._logMessage(msg);
  }

  async _logMessage(msg) {
    try {
      const logFile = path.join(__dirname, '..', 'chat-history.json');
      let history = [];
      try { history = JSON.parse(await fs.promises.readFile(logFile, 'utf8')); } catch(e) {}
      history.push({ from: msg.sender, text: msg.text, timestamp: msg.timestamp });
      if (history.length > 500) history = history.slice(-500);
      await fs.promises.writeFile(logFile, JSON.stringify(history, null, 2));
    } catch(e) {}
  }

  _emit(event, data) {
    if (this.io) this.io.emit(event, data);
  }

  _saveConversation(topic) {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const id = `conv-${Date.now()}`;
    const conv = {
      id,
      topic,
      startedAt: this.messages[0]?.timestamp,
      messages: this.messages
    };

    fs.writeFileSync(path.join(dataDir, `${id}.json`), JSON.stringify(conv, null, 2), 'utf8');
  }

  getHistory() {
    return this.messages;
  }

  getState() {
    return { state: this.state, turn: this.currentTurn, maxTurns: this.maxTurns, messageCount: this.messages.length };
  }
}

module.exports = ConversationManager;
