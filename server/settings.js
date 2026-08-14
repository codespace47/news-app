/**
 * 设置存储: DeepSeek API key / AI 审查开关
 * 存储位置: server/data/settings.json (明文, 个人局域网使用)
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
// 可用 SETTINGS_FILE 环境变量覆盖存储位置 (测试隔离用)
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  deepseekApiKey: '',
  aiReviewEnabled: false,
  model: 'deepseek-chat',
  aiReviewIntervalHours: 3, // AI 审查最小间隔 (小时): 1/3/6/24
};

let cached = null;

export function getSettings() {
  if (cached) return cached;
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      cached = { ...DEFAULT_SETTINGS, ...raw };
    } else {
      cached = { ...DEFAULT_SETTINGS };
    }
  } catch (e) {
    console.warn('[settings] 读取失败, 使用默认:', e.message);
    cached = { ...DEFAULT_SETTINGS };
  }
  return cached;
}

/** 更新设置 (部分更新)。key 显式传空串表示清除。原子写: 先写临时文件再 rename */
export function saveSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  cached = next;
  return next;
}

/** 脱敏后的设置视图 (不泄露完整 key) */
export function publicSettings() {
  const s = getSettings();
  const k = s.deepseekApiKey || '';
  const masked = k.length > 8 ? `${k.slice(0, 4)}****${k.slice(-4)}` : k ? '****' : '';
  return {
    aiReviewEnabled: !!s.aiReviewEnabled,
    model: s.model,
    aiReviewIntervalHours: Number(s.aiReviewIntervalHours) || 3,
    hasKey: !!k,
    keyMasked: masked,
  };
}

/** 测试 key 是否可用: 向 DeepSeek 发一次最小请求 */
export async function testDeepSeekKey(apiKey) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    });
    const req = httpsReq('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body,
      timeoutMs: 15000,
    });
    req.then(({ status, text }) => {
      if (status === 200) resolve({ ok: true, message: '连接成功' });
      else {
        let detail = '';
        try { detail = JSON.parse(text).error?.message || ''; } catch { /* ignore */ }
        resolve({ ok: false, message: `HTTP ${status} ${detail}`.trim() });
      }
    }).catch((e) => resolve({ ok: false, message: e.message }));
  });
}

function httpsReq(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', (c) => {
        data += c;
        bytes += Buffer.byteLength(c);
        if (bytes > maxBytes) req.destroy(new Error('响应过大'));
      });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}
