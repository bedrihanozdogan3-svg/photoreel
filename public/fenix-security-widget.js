/**
 * Fenix Güvenlik Widget
 * Tüm sayfalara eklenir. Admin ise canlı alarm sayacı gösterir.
 * Her 30 saniyede güncellenir, yeni alarm gelince ses çalar.
 */
(function() {
  // Admin kontrolü
  async function isAdmin() {
    try {
      const r = await fetch('/api/security/alarms', { credentials: 'include' });
      return r.status !== 401 && r.status !== 403;
    } catch { return false; }
  }

  // Alarm tonu
  function playAlarm() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.35].forEach(delay => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, ctx.currentTime + delay);
        gain.gain.setValueAtTime(0.25, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.3);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.3);
      });
    } catch(e) {}
  }

  // Widget HTML oluştur
  function createWidget() {
    const el = document.createElement('div');
    el.id = 'fenix-sec-widget';
    el.innerHTML = `
      <style>
        #fenix-sec-widget {
          position: fixed;
          top: 12px;
          right: 16px;
          z-index: 99999;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        #sec-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: 20px;
          background: rgba(10,10,15,0.9);
          border: 1px solid rgba(239,68,68,0.3);
          color: #ef4444;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          text-decoration: none;
          backdrop-filter: blur(12px);
          transition: all 0.2s;
          font-family: -apple-system, sans-serif;
        }
        #sec-btn:hover {
          background: rgba(239,68,68,0.2);
          border-color: #ef4444;
        }
        #sec-btn.alarm {
          animation: secPulse 1s ease-in-out infinite;
          border-color: #ef4444;
          background: rgba(239,68,68,0.2);
        }
        #sec-count {
          background: #ef4444;
          color: white;
          border-radius: 50%;
          width: 18px;
          height: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 900;
        }
        #sec-live {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #10b981;
          animation: secBlink 2s ease-in-out infinite;
        }
        #sec-live.alarm { background: #ef4444; }
        @keyframes secPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
          50% { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
        }
        @keyframes secBlink {
          0%,100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      </style>
      <a id="sec-btn" href="/guvenlik" target="_blank">
        <div id="sec-live"></div>
        🛡
        <span id="sec-status">Temiz</span>
        <span id="sec-count" style="display:none">0</span>
      </a>
    `;
    document.body.appendChild(el);
  }

  let lastCount = 0;

  async function checkAlarms() {
    try {
      const r = await fetch('/api/security/alarms', { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      const count = d.count ?? 0;

      const btn = document.getElementById('sec-btn');
      const status = document.getElementById('sec-status');
      const badge = document.getElementById('sec-count');
      const live = document.getElementById('sec-live');

      if (count > 0) {
        btn.classList.add('alarm');
        live.classList.add('alarm');
        status.textContent = count + ' Alarm!';
        badge.textContent = count;
        badge.style.display = 'flex';
      } else {
        btn.classList.remove('alarm');
        live.classList.remove('alarm');
        status.textContent = 'Temiz';
        badge.style.display = 'none';
      }

      // Yeni alarm bildirimi
      if (count > lastCount) {
        playAlarm();
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('🚨 Fenix Güvenlik Alarmı', {
            body: `${count - lastCount} yeni alarm. Kontrol et.`,
            icon: '/fenix-icon-192.png',
            tag: 'fenix-sec',
            requireInteraction: true
          });
        }
        // Ekran kısa flash
        document.body.style.outline = '2px solid #ef4444';
        setTimeout(() => document.body.style.outline = '', 800);
      }

      lastCount = count;
    } catch(e) {}
  }

  // Başlat
  async function init() {
    const admin = await isAdmin();
    if (!admin) return; // Admin değilse widget gösterme

    createWidget();

    // Bildirim izni iste
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // İlk kontrol
    await checkAlarms();

    // Her 30 saniyede kontrol
    setInterval(checkAlarms, 30_000);
  }

  // DOM hazır olunca başlat
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
