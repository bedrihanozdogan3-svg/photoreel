/**
 * Fenix AI — Circuit Breaker
 * AI API çağrılarını korur. Ardışık hata durumunda devre keser.
 * States: CLOSED (normal) → OPEN (hata) → HALF_OPEN (deneme)
 */

const logger = require('./logger');

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000; // 30sn
    this.halfOpenMax = options.halfOpenMax || 2;
    this.timeout = options.timeout || 15000; // İstek timeout

    this.state = STATES.CLOSED;
    this.failures = 0;
    this.lastFailure = null;
    this.halfOpenAttempts = 0;
  }

  async call(fn, fallback) {
    if (this.state === STATES.OPEN) {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = STATES.HALF_OPEN;
        this.halfOpenAttempts = 0;
        logger.info(`Circuit ${this.name}: OPEN → HALF_OPEN`);
      } else {
        logger.debug(`Circuit ${this.name}: OPEN — fallback kullanılıyor`);
        if (fallback) return fallback();
        throw new Error(`Circuit ${this.name} açık — servis geçici olarak kullanılamıyor`);
      }
    }

    if (this.state === STATES.HALF_OPEN && this.halfOpenAttempts >= this.halfOpenMax) {
      if (fallback) return fallback();
      throw new Error(`Circuit ${this.name} yarı açık — deneme limiti aşıldı`);
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), this.timeout))
      ]);

      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      if (fallback) return fallback();
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === STATES.HALF_OPEN) {
      logger.info(`Circuit ${this.name}: HALF_OPEN → CLOSED (başarılı)`);
    }
    this.failures = 0;
    this.state = STATES.CLOSED;
  }

  _onFailure(err) {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.state === STATES.HALF_OPEN) {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.halfOpenMax) {
        this.state = STATES.OPEN;
        logger.warn(`Circuit ${this.name}: HALF_OPEN → OPEN (deneme başarısız)`, { error: err.message });
      }
      return;
    }

    if (this.failures >= this.failureThreshold) {
      this.state = STATES.OPEN;
      logger.warn(`Circuit ${this.name}: CLOSED → OPEN (${this.failures} ardışık hata)`, { error: err.message });
    }
  }

  getState() {
    return { name: this.name, state: this.state, failures: this.failures, lastFailure: this.lastFailure };
  }

  reset() {
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.lastFailure = null;
    this.halfOpenAttempts = 0;
  }
}

// Önceden tanımlı circuit breaker'lar
const breakers = {
  gemini: new CircuitBreaker('gemini', { failureThreshold: 5, resetTimeout: 30000, timeout: 60000 }),
  claude: new CircuitBreaker('claude', { failureThreshold: 3, resetTimeout: 60000, timeout: 60000 }),
  firestore: new CircuitBreaker('firestore', { failureThreshold: 5, resetTimeout: 20000, timeout: 10000 }),
};

function getBreaker(name) {
  if (!breakers[name]) breakers[name] = new CircuitBreaker(name);
  return breakers[name];
}

function getAllStates() {
  return Object.values(breakers).map(b => b.getState());
}

module.exports = { CircuitBreaker, getBreaker, getAllStates };
