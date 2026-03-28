/**
 * Fenix AI — Video İşleme Servisi
 * Ham video yükleme, ses ayırma, format dönüşüm, kurgu pipeline.
 * FFmpeg tabanlı — Cloud Run'da çalışır.
 *
 * Pipeline: Video yükle → Ses ayır → Görüntü analiz → Kurgu → Export
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('../utils/logger');

const TEMP_DIR = path.join(os.tmpdir(), 'fenix-video');
const FORMATS = {
  'reels':   { width: 1080, height: 1920, ratio: '9:16', label: 'Instagram Reels / TikTok' },
  'story':   { width: 1080, height: 1920, ratio: '9:16', label: 'Instagram Story' },
  'square':  { width: 1080, height: 1080, ratio: '1:1',  label: 'Instagram Post / Kare' },
  'landscape': { width: 1920, height: 1080, ratio: '16:9', label: 'YouTube / Yatay' },
  'shorts':  { width: 1080, height: 1920, ratio: '9:16', label: 'YouTube Shorts' },
};

// Temp klasörü oluştur
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch(e) {}

/**
 * FFmpeg mevcut mu kontrol et
 */
async function checkFFmpeg() {
  return new Promise((resolve) => {
    exec('ffmpeg -version', { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ available: false, error: 'FFmpeg bulunamadı. Yüklemek için: https://ffmpeg.org/download.html' });
      } else {
        const version = stdout.split('\n')[0];
        resolve({ available: true, version });
      }
    });
  });
}

/**
 * Video bilgilerini al (süre, çözünürlük, codec, fps)
 */
async function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
    exec(cmd, { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(new Error('Video bilgisi alınamadı: ' + err.message));
      try {
        const info = JSON.parse(stdout);
        const videoStream = info.streams?.find(s => s.codec_type === 'video');
        const audioStream = info.streams?.find(s => s.codec_type === 'audio');
        resolve({
          duration: parseFloat(info.format?.duration || 0),
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          fps: eval(videoStream?.r_frame_rate || '30/1'),
          codec: videoStream?.codec_name || 'unknown',
          hasAudio: !!audioStream,
          audioCodec: audioStream?.codec_name || null,
          fileSize: parseInt(info.format?.size || 0),
          bitrate: parseInt(info.format?.bit_rate || 0),
        });
      } catch(e) { reject(new Error('Video bilgisi parse hatası')); }
    });
  });
}

/**
 * Videodan ses ayır (FFmpeg)
 * @returns {string} Ses dosyası yolu (.wav)
 */
async function extractAudio(videoPath, outputPath) {
  const out = outputPath || path.join(TEMP_DIR, `audio_${Date.now()}.wav`);
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 44100 -ac 2 "${out}" -y`;
    exec(cmd, { timeout: 60000 }, (err) => {
      if (err) return reject(new Error('Ses ayırma hatası: ' + err.message));
      resolve(out);
    });
  });
}

/**
 * Ses + Video birleştir
 */
async function mergeAudioVideo(videoPath, audioPath, outputPath) {
  const out = outputPath || path.join(TEMP_DIR, `merged_${Date.now()}.mp4`);
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -b:a 192k "${out}" -y`;
    exec(cmd, { timeout: 120000 }, (err) => {
      if (err) return reject(new Error('Birleştirme hatası: ' + err.message));
      resolve(out);
    });
  });
}

/**
 * Video formatını değiştir (crop + scale)
 * @param {string} format - 'reels' | 'square' | 'landscape' | 'shorts' | 'story'
 */
async function convertFormat(videoPath, format, outputPath) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error('Geçersiz format: ' + format);

  const out = outputPath || path.join(TEMP_DIR, `${format}_${Date.now()}.mp4`);
  // Smart crop: center crop + scale
  const filter = `scale=${fmt.width}:${fmt.height}:force_original_aspect_ratio=decrease,pad=${fmt.width}:${fmt.height}:(ow-iw)/2:(oh-ih)/2:black`;

  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoPath}" -vf "${filter}" -c:a copy "${out}" -y`;
    exec(cmd, { timeout: 120000 }, (err) => {
      if (err) return reject(new Error('Format dönüşüm hatası: ' + err.message));
      resolve({ path: out, format: fmt });
    });
  });
}

/**
 * Video kırp (start → end)
 */
async function trimVideo(videoPath, startSec, endSec, outputPath) {
  const out = outputPath || path.join(TEMP_DIR, `trim_${Date.now()}.mp4`);
  const duration = endSec - startSec;
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoPath}" -ss ${startSec} -t ${duration} -c copy "${out}" -y`;
    exec(cmd, { timeout: 60000 }, (err) => {
      if (err) return reject(new Error('Kırpma hatası: ' + err.message));
      resolve(out);
    });
  });
}

/**
 * Videoları birleştir (concat)
 */
async function concatVideos(videoPaths, outputPath) {
  const out = outputPath || path.join(TEMP_DIR, `concat_${Date.now()}.mp4`);
  const listFile = path.join(TEMP_DIR, `list_${Date.now()}.txt`);
  const listContent = videoPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listFile, listContent);

  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${out}" -y`;
    exec(cmd, { timeout: 180000 }, (err) => {
      fs.unlinkSync(listFile);
      if (err) return reject(new Error('Birleştirme hatası: ' + err.message));
      resolve(out);
    });
  });
}

/**
 * Kamera tipi tespit (dosya metadata + çözünürlük analizi)
 */
function detectCameraType(videoInfo) {
  const { width, height, codec } = videoInfo;
  const ratio = width / height;

  if (width >= 5000 || (width === 4096 && height === 2048)) {
    return { type: '360', label: '360° Kamera (GoPro Max / Insta360)', needsReframe: true };
  }
  if (ratio > 2.0) {
    return { type: 'ultrawide', label: 'Ultra Geniş Açı', needsFisheyeCorrection: true };
  }
  if (width >= 3840) {
    return { type: '4k', label: '4K Kamera', needsDownscale: true };
  }
  if (ratio > 1.5 && ratio < 1.9 && width >= 1920) {
    return { type: 'action', label: 'Aksiyon Kamera (GoPro)', needsStabilization: true };
  }
  if (height > width) {
    return { type: 'phone_vertical', label: 'Telefon (Dikey)', format: 'reels' };
  }
  if (width > height) {
    return { type: 'phone_horizontal', label: 'Telefon (Yatay)', format: 'landscape' };
  }
  return { type: 'standard', label: 'Standart Kamera' };
}

/**
 * Temp dosyalarını temizle (1 saatten eski)
 */
function cleanupTemp() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const cutoff = Date.now() - 3600000;
    files.forEach(f => {
      const fp = path.join(TEMP_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch(e) {}
    });
  } catch(e) {}
}

// 30 dakikada bir temp temizle
setInterval(cleanupTemp, 30 * 60 * 1000);

module.exports = {
  FORMATS,
  checkFFmpeg,
  getVideoInfo,
  extractAudio,
  mergeAudioVideo,
  convertFormat,
  trimVideo,
  concatVideos,
  detectCameraType,
  cleanupTemp,
  TEMP_DIR
};
