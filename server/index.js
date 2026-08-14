/**
 * 新闻聚合服务 v2 —— 质量优先版
 *
 * 数据源:
 *  - 知乎日报: 头条(编辑精选) / 热榜 / 日报
 *  - 量子位 (RSS): AI/科技前沿, 时效性强
 *  - 少数派 (RSS): 科技数码/效率生活
 *  - 百度热搜 (API): 全网实时热点, 娱乐类严格过滤
 *
 * 过滤管线 (按顺序):
 *  1. 问答闲聊剔除 (知乎栏目特征)
 *  2. 营销号/标题党剔除
 *  3. 娱乐过滤: 硬娱乐词剔除, 命中重大事件词(去世/被查/判刑…)则保留但降权
 *  4. 时效剔除: 超过 72 小时的 RSS 内容剔除
 *
 * 重要度 = 来源基础分(已含热搜排名加成) + 重大关键词分 + 时效分 (+ 娱乐豁免降权)
 * 服务端 5 分钟缓存, 单飞锁防击穿, 上游全挂回退旧缓存。
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { classifyCategory } from './category.js';
import { reviewNews, pruneAiCache, summarizeGithubRepo, summarizeGithubTaglines } from './ai.js';
import { getSettings, saveSettings, publicSettings, testDeepSeekKey } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const CACHE_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_AGE_SECONDS = 72 * 3600; // 72 小时内才算"新鲜新闻"

const ZHIHU = {
  hot: 'https://news-at.zhihu.com/api/4/news/hot',
  latest: 'https://news-at.zhihu.com/api/4/news/latest',
};

const RSS_SOURCES = [
  { name: '量子位', url: 'https://www.qbitai.com/feed', baseScore: 60 },
  { name: '少数派', url: 'https://sspai.com/feed', baseScore: 42 },
];

const BAIDU_HOT_URL = 'https://top.baidu.com/api/board?platform=wise&tab=realtime';

/* ---------------- 过滤词表 ---------------- */

/** 知乎问答/闲聊栏目特征: 直接剔除 (全部来源) */
const QUIZ_PREFIX = [
  /^(瞎扯|段子|冷知识|荐书|随手记|日记)/,
  /^(如何看待|如何评价)/,
];

/** 问答句式: 仅对非头条来源严格过滤 (头条是编辑精选, 带问号的重大新闻如「XX有多难?」需保留) */
const QUIZ_STRICT = [
  /^(有哪些|如何|怎样|怎么|为什么|是不是|会不会|能不能|是怎样的|是什么样|是什么体验|什么水平|什么感受)/,
  /(你知道吗|你见过|你体验过|算不算|有没有可能|怎么办|聊聊|为啥|咋|是怎样的|是什么|有哪些|怎么回事|啥情况|有何不同|有什么不同|有何)/,
  /[?？]$/,
  /吗$/,
  /(如何|怎样|咋样|怎么样)$/,
];

/** 营销号/标题党特征: 直接剔除 */
const CLICKBAIT = [
  '震惊', '速看', '删前速看', '不转不是', '太神奇', '万万没想到', '惊呆', '不可思议',
  '赶紧看', '赶紧收藏', '必看', '逆天', '吓人', '99%的人', '医生提醒', '专家警告',
  '紧急通知', '刚刚确认', '重磅炸弹', '疯了', '绝了', '看完就', '再不看', '轰动',
  '爆火', '朋友圈疯传', '内部消息', '独家揭秘', '惊爆', '速转', '删前',
  '后悔', '破防', '绷不住了', '笑死', '绝绝子', 'yyds', 'YYDS', '无语', '离谱',
  '救救', '太狠了', '太猛了', '史诗级', '神了', '亮了', '服了', '汗颜',
  '狂测', '没想到', '这么火', '太火了', '出圈了',
];

/** 娱乐硬词: 命中即剔除, 除非同时命中 EXEMPT 大事件词 */
const ENTERTAINMENT = [
  '绯闻', '恋情', '官宣', '塌房', '饭圈', '爱豆', '综艺', '演唱会', '新歌', '专辑',
  'MV', '代言', '同款', '私服', '机场照', '生图', '站姐', '八卦', '婚变', '出轨',
  '劈腿', '复合', '分手', 'CP', '磕CP', '吃瓜', '应援', '打榜', '选秀', '出道',
  '热恋', '约会', '视帝', '视后', '影帝', '影后', '剧组', '票房', '上映', '开播',
  '定档', '预告片', '剧照', '路透', '杀青', '开机仪式', '粉丝', '网红', '直播带货',
  '粉丝团', '明星', '艺人', '偶像', '综艺节目', '真人秀', '男团', '女团', '练习生',
  '导演', '演员', '首映', '路演', '宣传片', '片酬', '番位',
];

/** 娱乐圈大事件豁免词: 命中则保留 (降权), 如「某明星被查/去世」 */
const ENTERTAINMENT_EXEMPT = [
  '去世', '逝世', '病逝', '离世', '遇难', '罹难', '被捕', '被查', '判刑', '判决',
  '涉嫌', '偷税', '漏税', '地震', '车祸', '坠机', '自杀', '失踪', '警方', '法院',
  '立案', '调查', '拘留', '逮捕', '起诉',
  '癌症', '重病', '紧急', '事故', '火灾', '爆炸', '枪击', '袭击', '身亡', '死亡',
  '声明', '道歉', '致歉',
];

/** 重大新闻关键词 → 加分 */
const MAJOR_KEYWORDS = [
  '突发', '发布', '宣布', '公布', '重大', '首次', '国务院', '央行', '发改委',
  '正式', '出台', '新规', '地震', '遇难', '坠机', '爆炸', '起火', '战争', '冲突',
  '选举', '峰会', '关税', '利率', '制裁', '发射', '突破', '创纪录', '遇袭',
  '台风', '洪水', '暴雨', '预警', '召回', '停产', '破产', '查处', '通报',
  '诺贝尔', '两会', '草案', '立法', '审判', '判决', '会谈', '访华', '中美',
  '俄乌', '以色列', '加沙', '奥运', '世锦赛', '决赛', '夺冠',
];

/* ---------------- 过滤逻辑 ---------------- */

function isQuizTitle(title, strict) {
  if (QUIZ_PREFIX.some((re) => re.test(title))) return true;
  return strict && QUIZ_STRICT.some((re) => re.test(title));
}

function isClickbait(title) {
  return CLICKBAIT.some((w) => title.includes(w));
}

/** 娱乐过滤: 返回 { drop: true } 或 { drop: false, exempt: boolean } */
function filterEntertainment(title) {
  const hit = ENTERTAINMENT.some((w) => title.includes(w));
  if (!hit) return { drop: false, exempt: false };
  const exempt = ENTERTAINMENT_EXEMPT.some((w) => title.includes(w));
  return { drop: !exempt, exempt };
}

function keywordScore(title) {
  let s = 0;
  for (const w of MAJOR_KEYWORDS) if (title.includes(w)) s += 4;
  return Math.min(s, 12); // 防止多个关键词堆叠失控
}

/**
 * 统一过滤入口: 返回 { drop: boolean, reason?: string }
 * desc 用于营销号内容辅助判断 (可选)
 */
function filterItem(item) {
  const title = item.title || '';
  if (isQuizTitle(title, true)) {
    // 头条中带问号的重大新闻 (如「…获菲尔兹奖有多难?」) 含重大关键词, 保留但降权
    if (item.source === '头条' && keywordScore(title) > 0) {
      item.quizExempt = true;
    } else {
      return { drop: true, reason: '问答闲聊' };
    }
  }
  if (isClickbait(title)) return { drop: true, reason: '营销号/标题党' };
  const ent = filterEntertainment(title);
  if (ent.drop) return { drop: true, reason: '娱乐八卦' };
  return { drop: false, exempt: ent.exempt };
}

/* ---------------- 时间工具 ---------------- */

/** 解析 ga_prefix "MMDDHH"(月日时) → 时间戳 (秒)。修正: 完整解析月日时, 而非用 date 当天 */
function parseGaPrefix(prefix, dateStr) {
  if (!/^\d{6}$/.test(prefix || '')) return null;
  if (!dateStr || dateStr.length < 8) return null;
  const year = Number(dateStr.slice(0, 4));
  const month = Number(prefix.slice(0, 2));
  const day = Number(prefix.slice(2, 4));
  const hour = Number(prefix.slice(4, 6));
  const pad = (n) => String(n).padStart(2, '0');
  let ts = Date.parse(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:00:00+08:00`);
  if (Number.isNaN(ts)) return null;
  // 跨年容错: 解析出的日期比 date 晚 200 天以上时, 年份减 1 (如 12月→次年1月)
  const curTs = Date.parse(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T00:00:00+08:00`);
  if (!Number.isNaN(curTs) && ts - curTs > 200 * 86400 * 1000) {
    ts = Date.parse(`${year - 1}-${pad(month)}-${pad(day)}T${pad(hour)}:00:00+08:00`);
  }
  return Number.isNaN(ts) ? null : ts / 1000;
}

function parsePubDate(s) {
  const ts = Date.parse(s || '');
  return Number.isNaN(ts) ? null : ts / 1000;
}

/* ---------------- HTTP 工具 ---------------- */

function httpGet(url, { maxBytes = 2 * 1024 * 1024, accept = 'application/json, text/xml, application/rss+xml, */*', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': accept,
        'Referer': 'https://top.baidu.com/',
        ...headers,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, url).href, { maxBytes, accept }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`上游 ${res.statusCode}`));
      }
      let data = '';
      let bytes = 0;
      res.on('data', (c) => {
        data += c;
        bytes += Buffer.byteLength(c);
        if (bytes > maxBytes) req.destroy(new Error('上游响应过大'));
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('上游超时')));
  });
}

function httpGetJson(url, opts) {
  return httpGet(url, opts).then((text) => {
    try { return JSON.parse(text); } catch { throw new Error('上游返回非 JSON'); }
  });
}

/* ---------------- RSS 解析 ---------------- */

function stripHtml(s) {
  return (s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 轻量 RSS 2.0 解析: 提取 item 的 title/link/pubDate/description */
function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const grab = (tag) => {
      const mm = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
      return mm ? mm[1].trim() : '';
    };
    const title = stripHtml(grab('title'));
    const desc = stripHtml(grab('description'));
    items.push({
      title,
      link: stripHtml(grab('link')).trim(), // 实体解码 (&amp; 等), 防链接参数错位
      pubDate: grab('pubDate').trim(),
      desc: desc.slice(0, 300),
    });
  }
  return items.filter((it) => it.title);
}

/* ---------------- 数据源 ---------------- */

async function fetchZhihu() {
  const [hot, latest] = await Promise.all([
    httpGetJson(ZHIHU.hot).catch((e) => { console.warn('[upstream] zhihu-hot:', e.message); return { recent: [] }; }),
    httpGetJson(ZHIHU.latest).catch((e) => { console.warn('[upstream] zhihu-latest:', e.message); return { stories: [], top_stories: [] }; }),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const items = [];
  const seen = new Set();

  const push = (item) => {
    if (seen.has(item.zhihuId)) return;
    seen.add(item.zhihuId);
    items.push(item);
  };

  (latest.top_stories || []).forEach((s, i) => {
    const ts = parseGaPrefix(s.ga_prefix, latest.date);
    push({
      id: `top-${s.id}`,
      zhihuId: s.id,
      title: s.title,
      image: (s.image || s.images?.[0] || '').replace(/^http:/, 'https:'),
      url: `https://daily.zhihu.com/story/${s.id}`,
      source: '头条',
      rank: i + 1,
      baseScore: 90,
      time: ts || now - i * 300,
      timeTrusted: !!ts,
    });
  });

  (hot.recent || []).forEach((s, i) => {
    push({
      id: `hot-${s.news_id}`,
      zhihuId: s.news_id,
      title: s.title,
      image: (s.thumbnail || '').replace(/^http:/, 'https:'),
      url: `https://daily.zhihu.com/story/${s.news_id}`,
      source: '热榜',
      rank: i + 1,
      baseScore: 45,
      time: now - i * 600,
      timeTrusted: false, // 热榜无真实时间戳
    });
  });

  (latest.stories || []).forEach((s, i) => {
    const ts = parseGaPrefix(s.ga_prefix, latest.date);
    push({
      id: `daily-${s.id}`,
      zhihuId: s.id,
      title: s.title,
      image: (s.images?.[0] || '').replace(/^http:/, 'https:'),
      url: `https://daily.zhihu.com/story/${s.id}`,
      source: '日报',
      rank: i + 1,
      baseScore: 40,
      time: ts || now - i * 1800,
      timeTrusted: !!ts,
    });
  });

  return items;
}

async function fetchRssAll() {
  const results = await Promise.all(
    RSS_SOURCES.map((src) =>
      httpGet(src.url, { accept: 'application/rss+xml, application/xml, text/xml, */*' })
        .then(parseRss)
        .then((items) => items.map((it, i) => {
          const t = parsePubDate(it.pubDate);
          // 少数派「派早报/派晚报」: 独立分流, 专属板块展示
          const isBriefing = src.name === '少数派' && /^派(早报|晚报)/.test(it.title);
          return {
            id: `rss-${src.name}-${i}`,
            title: it.title,
            image: '',
            url: it.link,
            source: isBriefing ? it.title.startsWith('派早报') ? '派早报' : '派晚报' : src.name,
            rank: i + 1,
            baseScore: isBriefing ? 68 : src.baseScore, // 编辑精选日报, 权重高于普通科技源
            time: t || Date.now() / 1000 - i * 3600,
            timeTrusted: !!t,
            briefing: isBriefing,
            desc: it.desc,
          };
        }))
        .catch((e) => { console.warn(`[upstream] ${src.name}:`, e.message); return []; })
    )
  );
  return results.flat();
}

async function fetchBaiduHot() {
  try {
    const j = await httpGetJson(BAIDU_HOT_URL, { accept: 'application/json, */*' });
    const content = j?.data?.cards?.[0]?.content?.[0]?.content || [];
    const now = Math.floor(Date.now() / 1000);
    return content
      .filter((c) => c.word && !c.word.includes('\uFFFD')) // 剔除源头乱码条目
      .map((c, i) => {
        // 强制桌面端链接: wise 接口返回的 c.url 是 m.baidu.com 移动端页面,
        // 在电脑上打开会是手机版布局, 统一改写为 PC 版搜索结果页
        const url = `https://www.baidu.com/s?wd=${encodeURIComponent(c.word.trim())}`;
        return {
          id: `baidu-${i}`,
          title: c.word.trim(),
          image: '',
          url,
          source: '热搜',
          rank: i + 1,
          baseScore: 55 + (i < 5 ? 6 : i < 15 ? 3 : 0),
          time: now - i * 300,
          timeTrusted: false, // 热搜无真实时间戳
          desc: '',
        };
      });
  } catch (e) {
    console.warn('[upstream] baidu-hot:', e.message);
    return [];
  }
}

/* ---------------- GitHub 热门项目 ---------------- */

const GITHUB_TRENDING_DAYS = 30; // "近期" = 近 30 天创建的新项目
const GITHUB_PER_PAGE = 20;      // 20 个左右

const githubCache = { data: null, at: 0 };
const GITHUB_CACHE_TTL_MS = 30 * 60 * 1000; // GitHub search API 限流 10 次/分钟, 缓存 30 分钟
let githubInflight = null;

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * 近 30 天创建、star 数最多的 20 个项目 (GitHub 官方 search API, 免费无需 key)
 * 注意: 项目不是新闻, 不走新闻过滤/时效管线, 独立缓存与接口。
 */
async function fetchGithubTrending() {
  const q = encodeURIComponent(`created:>${isoDaysAgo(GITHUB_TRENDING_DAYS)}`);
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${GITHUB_PER_PAGE}`;
  const j = await httpGetJson(url, {
    headers: { 'User-Agent': 'NewsApp/1.0 (github trending)', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const items = (j.items || []).map((r, i) => ({
    rank: i + 1,
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    url: r.html_url,
    desc: (r.description || '').slice(0, 200),
    stars: r.stargazers_count || 0,
    forks: r.forks_count || 0,
    language: r.language || '',
    topics: r.topics || [],
    owner: r.owner?.login || '',
    createdAt: r.created_at || '',
    pushedAt: r.pushed_at || '',
  }));
  return { items, total: items.length };
}

async function getGithubTrending() {
  const now = Date.now();
  if (githubCache.data && now - githubCache.at < GITHUB_CACHE_TTL_MS) return githubCache.data;
  if (githubInflight) return githubInflight;
  githubInflight = (async () => {
    const data = await fetchGithubTrending();
    const items = await enrichTaglines(data.items); // 补中文一句话概括 (有 AI key 时)
    githubCache.data = { ...data, items, fetchedAt: new Date().toISOString() };
    githubCache.at = Date.now();
    return githubCache.data;
  })().finally(() => { githubInflight = null; });
  return githubInflight;
}

/* ---------------- GitHub 项目一句话概括 (批量生成 + 持久化缓存) ---------------- */

const TAGLINE_FILE = path.join(__dirname, 'data', 'github-taglines.json');
const TAGLINE_TTL_MS = 7 * 86400 * 1000;       // 概括 7 天内不重复生成
const TAGLINE_MIN_INTERVAL_MS = 60 * 60 * 1000; // 批量生成频率闸: 至少间隔 1 小时
const TAGLINE_TIMEOUT_MS = 20000;               // 生成超时则先返回 (不阻塞列表)

let taglineCache = null; // Map<fullName, {text, at}>
let lastTaglineCallAt = 0;

function loadTaglineCache() {
  if (taglineCache) return;
  taglineCache = new Map();
  try {
    if (fs.existsSync(TAGLINE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TAGLINE_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) taglineCache.set(k, { text: v.text, at: Number(v.at) || 0 });
    }
  } catch (e) {
    console.warn('[tagline] 缓存加载失败:', e.message);
  }
}

function saveTaglineCache() {
  try {
    fs.mkdirSync(path.dirname(TAGLINE_FILE), { recursive: true });
    const obj = {};
    const keepBefore = Date.now() - TAGLINE_TTL_MS;
    taglineCache.forEach((v, k) => { if (v.at >= keepBefore) obj[k] = v; });
    const tmp = TAGLINE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, TAGLINE_FILE);
  } catch (e) {
    console.warn('[tagline] 缓存保存失败:', e.message);
  }
}

/** 为没有缓存概括的项目批量生成 (一次 API 调用), 带频率闸与超时兜底 */
async function enrichTaglines(items) {
  loadTaglineCache();
  const now = Date.now();
  const need = items.filter((it) => {
    const v = taglineCache.get(it.fullName);
    return !v || now - v.at > TAGLINE_TTL_MS;
  });
  if (need.length > 0 && now - lastTaglineCallAt >= TAGLINE_MIN_INTERVAL_MS) {
    lastTaglineCallAt = now;
    const map = await Promise.race([
      summarizeGithubTaglines(need),
      new Promise((res) => setTimeout(() => res(null), TAGLINE_TIMEOUT_MS)),
    ]);
    if (map && map.size > 0) {
      const at = Date.now();
      for (const [k, text] of map) taglineCache.set(k, { text, at });
      saveTaglineCache();
      console.log(`[tagline] 批量生成 ${map.size} 条项目概括`);
    } else {
      console.log('[tagline] 本轮未生成 (无 AI key 或生成失败), 列表回退英文简介');
    }
  }
  return items.map((it) => {
    const v = taglineCache.get(it.fullName);
    return { ...it, tagline: v && now - v.at <= TAGLINE_TTL_MS ? v.text : '' };
  });
}

/* ---------------- GitHub 项目 AI 总结 (按需生成 + 持久化缓存) ---------------- */

const SUMMARY_FILE = path.join(__dirname, 'data', 'github-summaries.json');
const SUMMARY_TTL_MS = 7 * 86400 * 1000; // 项目介绍 7 天内不重复调用 AI
let summaryCache = null; // Map<fullName, {text, at}>
let summaryInflight = new Map(); // fullName -> Promise (并发去重)

function loadSummaryCache() {
  if (summaryCache) return;
  summaryCache = new Map();
  try {
    if (fs.existsSync(SUMMARY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) summaryCache.set(k, { text: v.text, at: Number(v.at) || 0 });
    }
  } catch (e) {
    console.warn('[ghsummary] 缓存加载失败:', e.message);
  }
}

function saveSummaryCache() {
  try {
    fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
    const obj = {};
    const keepBefore = Date.now() - SUMMARY_TTL_MS;
    summaryCache.forEach((v, k) => {
      if (v.at >= keepBefore) obj[k] = v;
    });
    const tmp = SUMMARY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, SUMMARY_FILE);
  } catch (e) {
    console.warn('[ghsummary] 缓存保存失败:', e.message);
  }
}

/**
 * 获取项目 AI 总结: 优先内存/文件缓存, 未命中才调用 AI (同项目并发去重)
 * 项目不在热门列表中时不生成总结, 避免 AI 凭空编造
 * @returns {Promise<{summary: string|null, cached: boolean, notFound?: boolean}>}
 */
async function getGithubSummary(fullName) {
  loadSummaryCache();
  const now = Date.now();
  const hit = summaryCache.get(fullName);
  if (hit && now - hit.at < SUMMARY_TTL_MS) return { summary: hit.text, cached: true };

  if (summaryInflight.has(fullName)) return summaryInflight.get(fullName);
  const p = (async () => {
    // 项目信息: 优先用 trending 缓存 (过期则刷新一次)
    let repo = (githubCache.data?.items || []).find((it) => it.fullName === fullName);
    if (!repo && githubCache.data) {
      await getGithubTrending().catch(() => {});
      repo = (githubCache.data?.items || []).find((it) => it.fullName === fullName);
    }
    if (!repo) return { summary: null, cached: false, notFound: true }; // 不在热门列表, 不生成
    const text = await summarizeGithubRepo(repo);
    if (text) {
      summaryCache.set(fullName, { text, at: Date.now() });
      saveSummaryCache();
    }
    return { summary: text, cached: false };
  })().finally(() => summaryInflight.delete(fullName));
  summaryInflight.set(fullName, p);
  return p;
}

/* ---------------- 标题时效追踪 ---------------- */
// 记录标题首次出现时间: 即使上游(如知乎头条)把旧闻长期置顶, 也能准确老化并剔除
const TITLE_SEEN_FILE = path.join(__dirname, 'data', 'title-seen.json');
let titleSeen = new Map(); // title -> 首次出现时间戳 (秒)
let titleSeenLoaded = false;

function loadTitleSeen() {
  if (titleSeenLoaded) return;
  titleSeenLoaded = true;
  try {
    if (fs.existsSync(TITLE_SEEN_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TITLE_SEEN_FILE, 'utf8'));
      for (const [t, ts] of Object.entries(raw)) titleSeen.set(t, Number(ts));
    }
  } catch (e) {
    console.warn('[titleseen] 加载失败:', e.message);
  }
}

function saveTitleSeen(nowSec) {
  try {
    // 只保留 7 天内的记录, 防止无限膨胀
    const keepBefore = nowSec - 7 * 86400;
    for (const [t, ts] of titleSeen) if (ts < keepBefore) titleSeen.delete(t);
    fs.mkdirSync(path.dirname(TITLE_SEEN_FILE), { recursive: true });
    const obj = {};
    titleSeen.forEach((ts, t) => { obj[t] = ts; });
    const tmp = TITLE_SEEN_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, TITLE_SEEN_FILE);
  } catch (e) {
    console.warn('[titleseen] 保存失败:', e.message);
  }
}

/** 标题的"已知年龄"(秒): 首次见到时, 若来源时间可信则用之作为首次出现时间, 否则用当前时间 */
function seenAge(title, nowSec, trustedTimeSec) {
  loadTitleSeen();
  const ts = titleSeen.get(title);
  if (ts === undefined) {
    const first = trustedTimeSec && trustedTimeSec > 0 ? Math.min(trustedTimeSec, nowSec) : nowSec;
    titleSeen.set(title, first);
    return Math.max(0, nowSec - first);
  }
  return nowSec - ts;
}

/* ---------------- 评分 ---------------- */

function scoreItem(item, now, seenAgeSec) {
  // 时效基于"已知年龄": 从标题首次出现起算, 不受上游置顶/无时间戳影响
  const ageMin = Math.max(0, seenAgeSec / 60);
  let freshness = 0;
  if (ageMin < 360) freshness = 10;        // 6 小时内
  else if (ageMin < 720) freshness = 5;    // 12 小时内
  else if (ageMin < 1440) freshness = 2;   // 24 小时内
  else if (ageMin < 2880) freshness = -8;  // 24-48 小时: 明显降权
  else freshness = -20;                    // 48-72 小时: 大幅降权 (72h+ 在过滤阶段剔除)

  let s = item.baseScore + keywordScore(item.title) + freshness;
  if (item.exempt) s -= 8; // 娱乐大事件豁免: 保留但降权
  if (item.quizExempt) s -= 5; // 头条带问号的重大新闻: 保留但降权
  // 简报(用户订阅的每日栏目): 以时效为主排序, AI 仅轻微影响 (AI 容易误判早报不重要)
  if (item.briefing) {
    s = item.baseScore + freshness + (item.aiImportance || 4) * 2;
    return Math.round(s * 10) / 10;
  }
  // AI 审查启用时: 重要度与 AI 评分混合, AI 权重随时间衰减 (旧闻的 AI 高分不再霸榜)
  if (item.aiImportance) {
    const aiFactor = ageMin < 720 ? 5.5 : ageMin < 1440 ? 4.5 : 3;
    s = s * 0.45 + item.aiImportance * aiFactor;
  }
  return Math.round(s * 10) / 10;
}

/* ---------------- 缓存与主流程 ---------------- */

const cache = { data: null, at: 0 };
let inflight = null;

async function buildPayload() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const fetchedAt = Math.floor(now / 1000);
    const [zhihu, rss, baidu] = await Promise.all([fetchZhihu(), fetchRssAll(), fetchBaiduHot()]);
    let all = [...zhihu, ...rss, ...baidu];

    // 过滤管线
    const dropped = { 问答闲聊: 0, '营销号/标题党': 0, 娱乐八卦: 0, 过期内容: 0, 无效链接: 0 };
    all = all.filter((it) => {
      // 链接必须是 http(s) 绝对地址
      if (!/^https?:\/\//.test(it.url || '')) {
        dropped.无效链接 += 1;
        return false;
      }
      const f = filterItem(it);
      if (f.drop) { dropped[f.reason] = (dropped[f.reason] || 0) + 1; return false; }
      if (f.exempt) it.exempt = true;
      return true;
    });
    console.log(`[filter] 保留 ${all.length} 条 | 剔除:`, JSON.stringify(dropped));

    // AI 审查 (可选): 剔除无关/不重要/营销号软文, 并给出分类与重要度
    let aiUsed = false;
    const ai = await reviewNews(all);
    if (ai) {
      const next = [];
      all.forEach((it, i) => {
        const r = ai.byIndex.get(i);
        if (r?.drop) {
          if (it.briefing) {
            // 简报(派早报/晚报)是用户订阅栏目: 不被 AI 剔除, 但重要度仍参与排序
            if (r?.importance) it.aiImportance = r.importance;
            next.push(it);
            return;
          }
          dropped['AI 审查'] = (dropped['AI 审查'] || 0) + 1;
          return;
        }
        if (r?.category && !it.briefing) it.category = r.category; // 简报板块固定分类, 不被 AI 覆盖
        if (r?.importance) it.aiImportance = r.importance;
        if (r?.reason) it.aiReason = r.reason;
        next.push(it);
      });
      all = next;
      aiUsed = true;
      console.log(`[filter] AI 审查后保留 ${all.length} 条 | 累计剔除:`, JSON.stringify(dropped));
    }

    // 板块分类: AI 未覆盖的用规则分类; 派早报/晚报固定为简报板块
    for (const it of all) {
      if (it.briefing) it.category = '简报';
      else if (!it.category) it.category = classifyCategory(it.title);
    }

    if (all.length === 0) {
      if (cache.data) {
        console.warn('[cache] 过滤后为空, 使用上次缓存 (stale)');
        return { ...cache.data, stale: true };
      }
      return { items: [], fetchedAt: new Date().toISOString(), total: 0, stale: true };
    }

    // 同标题去重 (跨源) + 时效剔除 (按标题首次出现时间老化)
    const byTitle = new Map();
    for (const it of all) {
      const t = it.title.trim();
      const ageSec = seenAge(t, fetchedAt, it.timeTrusted ? it.time : null);
      if (ageSec > MAX_AGE_SECONDS) {
        dropped.过期内容 += 1;
        continue;
      }
      const scored = { ...it, score: scoreItem(it, fetchedAt, ageSec), time: (it.time || fetchedAt) * 1000 };
      if (!byTitle.has(t) || scored.score > byTitle.get(t).score) byTitle.set(t, scored);
    }
    saveTitleSeen(fetchedAt);
    const scored = [...byTitle.values()].sort((a, b) => b.score - a.score);

    const payload = { items: scored, fetchedAt: new Date().toISOString(), total: scored.length, stale: false, aiUsed, aiEnabled: getSettings().aiReviewEnabled && !!getSettings().deepseekApiKey };
    cache.data = payload;
    cache.at = Date.now();
    return payload;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/* ---------------- 服务 ---------------- */

const app = express();
app.use(express.json());

// 应用版本号: 每次重启变化; 前端据此检测"新版本已发布", 提示用户刷新
const APP_VERSION = String(Date.now());
app.use((req, res, next) => {
  res.set('X-App-Version', APP_VERSION);
  next();
});

// 设置: 读取 (脱敏) / 保存 / 测试 DeepSeek key
// 仅允许本机访问 (手机等局域网设备只读新闻, 防止他人篡改配置)
const localOnly = (req, res, next) => {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).json({ error: '设置接口仅允许本机访问' });
};

app.get('/api/settings', localOnly, (_req, res) => res.json(publicSettings()));

app.put('/api/settings', localOnly, (req, res) => {
  try {
    const patch = {};
    if (typeof req.body?.deepseekApiKey === 'string') patch.deepseekApiKey = req.body.deepseekApiKey.trim();
    if (typeof req.body?.aiReviewEnabled === 'boolean') patch.aiReviewEnabled = req.body.aiReviewEnabled;
    if ([1, 3, 6, 24].includes(Number(req.body?.aiReviewIntervalHours))) {
      patch.aiReviewIntervalHours = Number(req.body.aiReviewIntervalHours);
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: '没有可保存的字段' });
    saveSettings(patch);
    cache.data = null; // 设置变更后清缓存, 让 AI 审查立即生效
    res.json(publicSettings());
  } catch (e) {
    res.status(500).json({ error: '保存失败: ' + e.message });
  }
});

app.post('/api/settings/test', localOnly, async (req, res) => {
  const submitted = typeof req.body?.deepseekApiKey === 'string' ? req.body.deepseekApiKey.trim() : '';
  const key = submitted || getSettings().deepseekApiKey;
  if (!key) return res.json({ ok: false, message: '未配置 API key' });
  const t0 = Date.now();
  const result = await testDeepSeekKey(key);
  result.latencyMs = Date.now() - t0;
  res.json(result);
});

app.get('/api/news', async (_req, res) => {
  try {
    const payload = await buildPayload();
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  } catch (e) {
    console.error('[api] /api/news failed:', e);
    res.status(502).json({ error: '新闻源暂时不可用, 请稍后重试', detail: e.message });
  }
});

app.get('/api/github/trending', async (_req, res) => {
  try {
    const payload = await getGithubTrending();
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  } catch (e) {
    console.error('[api] /api/github/trending failed:', e);
    res.status(502).json({ error: 'GitHub 热门暂时不可用, 请稍后重试', detail: e.message });
  }
});

app.get('/api/github/summary', async (req, res) => {
  const fullName = String(req.query.fullName || '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    return res.status(400).json({ error: '项目名不合法, 应为 owner/repo 格式' });
  }
  try {
    const { summary, cached, notFound } = await getGithubSummary(fullName);
    const repo = (githubCache.data?.items || []).find((it) => it.fullName === fullName)
      || { fullName, url: `https://github.com/${fullName}`, desc: '', stars: 0, forks: 0, language: '', topics: [] };
    res.set('Cache-Control', 'no-store');
    res.json({ repo, summary, cached, notFound: !!notFound, aiEnabled: !!getSettings().deepseekApiKey });
  } catch (e) {
    console.error('[api] /api/github/summary failed:', e);
    res.status(502).json({ error: 'AI 总结暂时不可用, 请稍后重试', detail: e.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, cached: !!cache.data, cacheAgeMs: Date.now() - cache.at }));

// 生产模式: 托管前端构建产物
const dist = path.join(__dirname, '..', 'dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/api') return next();
  if (req.path.includes('.')) return next();
  res.sendFile(path.join(dist, 'index.html'), (err) => err && next());
});

app.listen(PORT, () => {
  console.log(`[news] 服务已启动: http://localhost:${PORT} (板块版 v3)`);
  setInterval(pruneAiCache, 10 * 60 * 1000).unref?.(); // 定期清理 AI 审查缓存
});
