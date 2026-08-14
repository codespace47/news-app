/**
 * DeepSeek AI 新闻审查模块 (增量版)
 *
 * 设计目标: 最小化 API 调用与费用
 * 1. 判定库: 按标题缓存 AI 判定 (保留/剔除/分类/重要度), 同一标题 48 小时内不重复审查
 * 2. 增量审查: 每批只把"新出现的标题"发给 AI, 旧标题直接沿用判定库
 * 3. 频率闸: 距上次调用 AI 不足 aiReviewIntervalHours 小时时暂缓调用, 新标题先用启发式兜底,
 *            到期后自动补审 (不会丢失)
 * 4. 任何失败均降级: 返回已有判定, 未判定标题由调用方用启发式处理
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERDICT_FILE = process.env.REVIEW_VERDICT_FILE || path.join(__dirname, 'data', 'review-verdicts.json');
const VERDICT_TTL_MS = 48 * 3600 * 1000; // 判定 48 小时后过期 (新闻超 72h 已被时效过滤, 判定无用)
const MAX_VERDICTS = 3000;

/** API 地址: 默认 DeepSeek, 可用环境变量 DEEPSEEK_API_URL 覆盖 (测试用) */
function apiUrl() {
  return process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
}

const SYSTEM_PROMPT = `你是中文新闻编辑部的资深审稿人。你的任务是对一批候选新闻标题进行审查，输出 JSON。

判定标准：
1. "drop" 剔除：营销号软文、广告、标题党、纯娱乐八卦、低质问答、无信息量的琐事、与"新闻"无关的内容
2. "keep" 保留：真实新闻事件，有时效性、有信息量、对读者有用
3. "category" 分类：只能从 [时政, 财经, 科技, 社会, 国际, 体育, 综合] 中选择一个
4. "importance" 重要度：1-10 的整数。10=重大突发/国家级大事，1=几乎无信息量。普通新闻 5-7，地方小事 3-4。

注意：宁可保守（不确定就 keep），只剔除明显不合格的内容。娱乐圈新闻除非是重大事件（去世/被捕/判刑/偷税等），否则剔除。体育比赛、科技成果、政策变化都是有效新闻。
必须对输入的每一条都给出判定，不要遗漏。

输出格式（严格 JSON，不要输出其他内容）：
{"items":[{"index":0,"verdict":"keep","category":"时政","importance":7,"reason":"简要理由"}]}
其中 index 对应输入数组的下标，verdict 只能是 "keep" 或 "drop"，drop 时必须给出 reason。`;

/* ---------------- 判定库 (按标题) ---------------- */

let verdicts = null; // Map<title, {drop, reason, category, importance, at}>; null = 未加载
let lastApiCallAt = 0; // 上次真实调用 API 的时间 (进程内, 重启后立即补审一次)

function loadVerdicts() {
  if (verdicts) return;
  verdicts = new Map();
  try {
    if (fs.existsSync(VERDICT_FILE)) {
      const raw = JSON.parse(fs.readFileSync(VERDICT_FILE, 'utf8'));
      if (Array.isArray(raw.verdicts)) {
        for (const v of raw.verdicts) verdicts.set(v.title, v);
      }
      if (typeof raw.lastApiCallAt === 'number') lastApiCallAt = raw.lastApiCallAt;
    }
  } catch (e) {
    console.warn('[ai] 判定库加载失败, 从空开始:', e.message);
  }
}

function saveVerdicts() {
  try {
    fs.mkdirSync(path.dirname(VERDICT_FILE), { recursive: true });
    const tmp = VERDICT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      lastApiCallAt,
      verdicts: [...verdicts.entries()].map(([title, v]) => ({ title, ...v })),
    }), 'utf8');
    fs.renameSync(tmp, VERDICT_FILE);
  } catch (e) {
    console.warn('[ai] 判定库保存失败:', e.message);
  }
}

function pruneVerdicts(now) {
  if (verdicts.size <= MAX_VERDICTS) {
    // 只清理过期项
    for (const [title, v] of verdicts) {
      if (now - v.at > VERDICT_TTL_MS) verdicts.delete(title);
    }
    return;
  }
  // 超容量: 删除最旧的 1/4
  const sorted = [...verdicts.entries()].sort((a, b) => a[1].at - b[1].at);
  const dropCount = Math.floor(verdicts.size / 4);
  for (let i = 0; i < dropCount; i++) verdicts.delete(sorted[i][0]);
}

/** 清理过期缓存 (供定时调用) */
export function pruneAiCache() {
  if (!verdicts) return;
  pruneVerdicts(Date.now());
}

/** 仅供测试: 重置上次调用时间 (模拟时间流逝) */
export function __resetLastApiCallForTests() {
  lastApiCallAt = 0;
}

/* ---------------- DeepSeek 调用 ---------------- */

function httpsPost(url, body, apiKey, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', (c) => {
        data += c;
        bytes += Buffer.byteLength(c);
        if (bytes > 4 * 1024 * 1024) req.destroy(new Error('响应过大'));
      });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.write(payload);
    req.end();
  });
}

/** 解析 AI 输出 JSON (容忍 markdown 代码块包裹) */
export function parseAiJson(text) {
  let t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
}

/** 调用 DeepSeek 审查一批标题, 返回校验后的条目数组 (与输入同序, 缺失的条目不在其中) */
async function callDeepSeek(items) {
  const settings = getSettings();
  const userContent = JSON.stringify(
    items.map((it, i) => ({
      index: i,
      title: it.title,
      desc: (it.desc || '').slice(0, 120),
    }))
  );
  const { status, text } = await httpsPost(apiUrl(), {
    model: settings.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 4096,
  }, settings.deepseekApiKey);

  if (status !== 200) {
    console.warn(`[ai] DeepSeek HTTP ${status}:`, text.slice(0, 200));
    return null;
  }

  const parsed = parseAiJson(JSON.parse(text).choices?.[0]?.message?.content || '');
  const list = parsed.items;
  if (!Array.isArray(list)) return null;

  const result = new Array(items.length).fill(null);
  for (const entry of list) {
    const idx = Number(entry.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) continue;
    // 保守策略: 只有显式 "drop" 才剔除, 未知/缺失判定一律按 keep
    if (entry.verdict !== 'keep' && entry.verdict !== 'drop') continue;
    const drop = entry.verdict === 'drop';
    if (drop && !entry.reason) continue; // drop 必须有理由
    result[idx] = {
      drop,
      reason: String(entry.reason || '').slice(0, 100),
      category: ['时政', '财经', '科技', '社会', '国际', '体育', '综合'].includes(entry.category) ? entry.category : undefined,
      importance: Number.isInteger(entry.importance) && entry.importance >= 1 && entry.importance <= 10 ? entry.importance : undefined,
    };
  }
  return result;
}

/**
 * 增量审查入口
 * @param {Array<{title:string, desc?:string}>} items 当前批次 (与调用方索引一致)
 * @returns {Promise<{byIndex: Map, usedAi: boolean, meta: object}|null>}
 *          null = AI 未启用/未配置; byIndex 只含有效判定, 未判定标题由调用方启发式兜底
 */
export async function reviewNews(items) {
  const settings = getSettings();
  if (!settings.aiReviewEnabled || !settings.deepseekApiKey) return null;
  if (items.length === 0) return null;

  loadVerdicts();
  const now = Date.now();
  const intervalMs = (settings.aiReviewIntervalHours || 3) * 3600 * 1000;

  // 1) 找出未判定的新标题
  const pending = [];
  items.forEach((it, i) => {
    const v = verdicts.get(it.title);
    if (!v || now - v.at > VERDICT_TTL_MS) pending.push({ index: i, item: it });
  });

  // 2) 频率闸: 有新标题且距上次调用足够久 → 增量调用 API
  let usedAi = false;
  let intervalSkipped = false;
  if (pending.length > 0 && now - lastApiCallAt >= intervalMs) {
    const judged = await callDeepSeek(pending.map((p) => p.item));
    if (judged) {
      usedAi = true;
      lastApiCallAt = now;
      pending.forEach((p, k) => {
        const entry = judged[k];
        if (entry) {
          verdicts.set(p.item.title, { ...entry, at: now });
        } else {
          // AI 未对该条给出判定: 保守按 keep 入库, 防止无限重审
          verdicts.set(p.item.title, { drop: false, at: now });
        }
      });
      saveVerdicts();
      console.log(`[ai] 增量审查: ${pending.length} 条新标题, 剔除 ${judged.filter(Boolean).filter((j) => j.drop).length} 条`);
    }
  } else if (pending.length > 0) {
    intervalSkipped = true;
    console.log(`[ai] 频率闸: ${pending.length} 条待审, 距上次 ${((now - lastApiCallAt) / 3600000).toFixed(1)}h, 暂缓 (${intervalMs / 3600000}h 间隔)`);
  }

  // 3) 汇总判定
  pruneVerdicts(now);
  const byIndex = new Map();
  items.forEach((it, i) => {
    const v = verdicts.get(it.title);
    if (v && now - v.at <= VERDICT_TTL_MS && v.drop !== undefined) {
      byIndex.set(i, { drop: v.drop, reason: v.reason || '', category: v.category, importance: v.importance });
    }
  });

  return {
    byIndex,
    usedAi,
    meta: {
      cached: byIndex.size - (usedAi ? pending.length : 0),
      pending: intervalSkipped ? pending.length : 0,
      intervalSkipped,
    },
  };
}

/* ---------------- GitHub 项目 AI 总结 ---------------- */

const GITHUB_SUMMARY_PROMPT = `你是一位资深开源技术编辑。请为给定的 GitHub 项目写一篇简洁的中文介绍, 面向想快速了解该项目的开发者。

要求:
1. 第一句话用一句话说清"这是什么" (不超过 40 字)
2. 随后用 3-5 条要点列出核心功能与亮点, 每条以 "- " 开头
3. 最后一行说明技术栈与适用场景
4. 全文不超过 250 字, 用简体中文, 直接输出正文
5. 不要输出标题、不要 markdown 代码块、不要客套话; 项目名等英文术语保持原文, 可用 \`反引号\` 标注代码/命令`;

/**
 * 为 GitHub 项目生成 AI 中文总结 (DeepSeek)
 * @param {{fullName:string, desc?:string, language?:string, topics?:string[], stars?:number}} repo
 * @returns {Promise<string|null>} 总结文本; 未配置 key 或调用失败返回 null
 */
export async function summarizeGithubRepo(repo) {
  const settings = getSettings();
  if (!settings.deepseekApiKey) return null;
  const userContent = [
    `项目: ${repo.fullName}`,
    `简介: ${repo.desc || '(无)'}`,
    `主要语言: ${repo.language || '未知'}`,
    `主题标签: ${(repo.topics || []).join(', ') || '无'}`,
    `Star 数: ${repo.stars || 0}`,
  ].join('\n');
  const { status, text } = await httpsPost(apiUrl(), {
    model: settings.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: GITHUB_SUMMARY_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  }, settings.deepseekApiKey, 90000);

  if (status !== 200) {
    console.warn(`[ai] GitHub 总结 HTTP ${status}:`, text.slice(0, 200));
    return null;
  }
  const content = JSON.parse(text).choices?.[0]?.message?.content;
  if (!content || !content.trim()) return null;
  const out = content.trim();
  return out.length <= 2000 ? out : out.slice(0, 2000);
}

/* ---------------- GitHub 项目一句话概括 (批量) ---------------- */

const GITHUB_TAGLINE_PROMPT = `你是资深开源技术编辑。下面是一批近期热门的 GitHub 项目, 请为每个项目写一句中文概括。

要求:
1. 用一句话说清"这是什么、做什么" (不超过 35 字), 面向快速浏览列表的开发者
2. 不要翻译项目名, 保留原文; 可用英文技术名词 (如 LLM、RAG)
3. 概括要具体、有信息量, 避免"这是一个开源项目"这类空话
4. 必须覆盖输入中的每一个项目, 不要遗漏

输出严格 JSON (不要输出其他内容):
{"items":[{"fullName":"owner/repo","tagline":"一句话概括"}]}`;

/**
 * 为一批 GitHub 项目批量生成一句话中文概括 (一次 API 调用)
 * @param {Array<{fullName:string, desc?:string, language?:string, topics?:string[]}>} repos
 * @returns {Promise<Map<string,string>|null>} fullName -> tagline; 未配置 key 或失败返回 null
 */
export async function summarizeGithubTaglines(repos) {
  const settings = getSettings();
  if (!settings.deepseekApiKey) return null;
  if (repos.length === 0) return new Map();
  const userContent = JSON.stringify(repos.map((r) => ({
    fullName: r.fullName,
    desc: (r.desc || '').slice(0, 150),
    language: r.language || '',
    topics: (r.topics || []).slice(0, 5),
  })));
  const { status, text } = await httpsPost(apiUrl(), {
    model: settings.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: GITHUB_TAGLINE_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 2048,
  }, settings.deepseekApiKey, 60000);

  if (status !== 200) {
    console.warn(`[ai] GitHub 概括 HTTP ${status}:`, text.slice(0, 200));
    return null;
  }
  const parsed = parseAiJson(JSON.parse(text).choices?.[0]?.message?.content || '');
  const list = parsed.items;
  if (!Array.isArray(list)) return null;
  const want = new Set(repos.map((r) => r.fullName));
  const result = new Map();
  for (const entry of list) {
    const name = String(entry?.fullName || '');
    if (!want.has(name)) continue;
    const tagline = String(entry?.tagline || '').trim();
    if (tagline && tagline.length <= 60) result.set(name, tagline);
  }
  return result;
}

/* ---------------- GitHub 项目质量筛选 (批量) ---------------- */

const GITHUB_PICK_PROMPT = `你是开源项目推荐编辑。下面是一批近 30 天创建的 GitHub 项目, 其中部分项目 Star 数不高。

请判断每个项目是否"值得推荐给开发者浏览"。值得推荐的标准(满足其一即可):
1. 创新性: 解决新问题或用新方式解决老问题
2. 实用性: 能直接用在真实开发/工作/生活中, 工程质量迹象明显
3. 话题性: 在某个领域有代表性, 值得关注

不值得推荐: 纯套壳、玩具 demo、明显营销/引流项目、内容空洞、和现有知名项目比没有差异化的重复轮子。

要求:
- 对每个项目都必须给出 recommend (true/false)
- 拿不准时倾向 recommend=false (宁缺毋滥)
- reason 用不超过 12 字的中文说明理由

输出严格 JSON (不要输出其他内容):
{"items":[{"fullName":"owner/repo","recommend":true,"reason":"理由"}]}`;

/**
 * AI 批量判断一批 GitHub 项目是否值得推荐
 * @param {Array<{fullName:string, desc?:string, language?:string, stars?:number}>} repos
 * @returns {Promise<Map<string,{picked:boolean, reason:string}>|null>}
 */
export async function pickGithubProjects(repos) {
  const settings = getSettings();
  if (!settings.deepseekApiKey) return null;
  if (repos.length === 0) return new Map();
  const userContent = JSON.stringify(repos.map((r) => ({
    fullName: r.fullName,
    desc: (r.desc || '').slice(0, 120),
    language: r.language || '',
    stars: r.stars || 0,
  })));
  const { status, text } = await httpsPost(apiUrl(), {
    model: settings.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: GITHUB_PICK_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 4096,
  }, settings.deepseekApiKey, 60000);

  if (status !== 200) {
    console.warn(`[ai] GitHub 筛选 HTTP ${status}:`, text.slice(0, 200));
    return null;
  }
  const parsed = parseAiJson(JSON.parse(text).choices?.[0]?.message?.content || '');
  const list = parsed.items;
  if (!Array.isArray(list)) return null;
  const want = new Set(repos.map((r) => r.fullName));
  const result = new Map();
  for (const entry of list) {
    const name = String(entry?.fullName || '');
    if (!want.has(name)) continue;
    result.set(name, {
      picked: entry?.recommend === true,
      reason: String(entry?.reason || '').slice(0, 20),
    });
  }
  return result;
}
