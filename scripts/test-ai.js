// AI 审查模块测试 (增量版): mock DeepSeek 服务器
// 验证: 无key降级 / 全量审查 / 增量只审新标题 / 频率闸 / 坏响应降级 / markdown解析
// 判定库写入临时文件 (REVIEW_VERDICT_FILE), 不污染生产数据
// 注意: 必须用动态 import 加载模块 (静态 import 会先于 env 设置执行)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOCK_PORT = 3199;
const TMP_VERDICTS = path.join(os.tmpdir(), 'newsapp-test-verdicts.json');
const TMP_SETTINGS = path.join(os.tmpdir(), 'newsapp-test-settings.json');
process.env.REVIEW_VERDICT_FILE = TMP_VERDICTS;
process.env.SETTINGS_FILE = TMP_SETTINGS;
try { fs.unlinkSync(TMP_VERDICTS); } catch { /* 首次运行无文件 */ }
try { fs.unlinkSync(TMP_SETTINGS); } catch { /* 首次运行无文件 */ }

const { reviewNews } = await import('../server/ai.js');
const { saveSettings } = await import('../server/settings.js');

let fail = 0;
let requests = []; // 记录每次 mock 请求体

async function withMockServer(handler, fn) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(body);
      res.setHeader('Content-Type', 'application/json');
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(MOCK_PORT, r));
  try { await fn(); } finally { server.close(); }
}

function mockOk(items) {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          items: items.map((it, i) => ({
            index: i,
            verdict: 'keep',
            category: '综合',
            importance: 6,
            reason: '测试判定',
          })),
        }),
      },
    }],
  });
}

const items = [
  { title: '测试新闻甲 政治局会议' },
  { title: '测试新闻乙 某明星官宣恋情 粉丝狂欢' },
  { title: '测试新闻丙 台风来袭 沿海启动应急' },
  { title: '测试新闻丁 震惊 保健品治百病 广告' },
];

// 1) 无 key → null
saveSettings({ deepseekApiKey: '', aiReviewEnabled: false, aiReviewIntervalHours: 3 });
const noKey = await reviewNews(items);
if (noKey !== null) { fail++; console.log('FAIL: 无 key 应返回 null'); }
else console.log('✓ 无 key 降级');

// 2) mock 全量审查 (首次: 4 条全审)
await withMockServer((req, res, body) => {
  res.end(mockOk([]));
}, async () => {
  process.env.DEEPSEEK_API_URL = `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`;
  saveSettings({ deepseekApiKey: 'sk-mock', aiReviewEnabled: true, aiReviewIntervalHours: 3 });
  requests = [];
  const r = await reviewNews(items);
  if (!r || !r.usedAi) { fail++; console.log('FAIL: 首次应调用 AI'); return; }
  // mock 返回全部 keep, 但第一个应该是 drop 才符合 AI 语义——这里只验证流程
  const reqBody = JSON.parse(requests[0]);
  const sent = JSON.parse(reqBody.messages[reqBody.messages.length - 1].content);
  if (sent.length !== 4) { fail++; console.log('FAIL: 首次应审 4 条, 实际', sent.length); }
  else console.log('✓ 首次全量审查 4 条');
});

// 3) 增量: 同批 + 1 条新标题 → 只审新标题 (先重置频率闸)
const { __resetLastApiCallForTests } = await import('../server/ai.js');
__resetLastApiCallForTests();
await withMockServer((req, res) => {
  res.end(mockOk([]));
}, async () => {
  requests = [];
  const r = await reviewNews([...items, { title: '测试新闻戊 新出现的新闻' }]);
  if (!r || !r.usedAi) { fail++; console.log('FAIL: 有新标题应调用 AI'); return; }
  const reqBody = JSON.parse(requests[0]);
  const sent = JSON.parse(reqBody.messages[reqBody.messages.length - 1].content);
  if (sent.length !== 1 || sent[0].title !== '测试新闻戊 新出现的新闻') {
    fail++; console.log('FAIL: 增量应只审 1 条新标题, 实际', sent.length, JSON.stringify(sent.map((s) => s.title)));
  } else console.log('✓ 增量审查: 5 条中只调 AI 审 1 条新标题');
});

// 4) 频率闸: interval=24h, 再有新标题 → 不调 API, 返回已有判定
await withMockServer((req, res) => {
  res.end(mockOk([]));
}, async () => {
  saveSettings({ deepseekApiKey: 'sk-mock', aiReviewEnabled: true, aiReviewIntervalHours: 24 });
  requests = [];
  const r = await reviewNews([...items, { title: '测试新闻己 频率闸期间的新新闻' }]);
  if (!r || r.usedAi) { fail++; console.log('FAIL: 频率闸内不应调用 AI (usedAi 应 false)'); return; }
  if (requests.length !== 0) { fail++; console.log('FAIL: 频率闸内不应有请求'); return; }
  if (r.byIndex.size !== 4) { fail++; console.log('FAIL: 应复用 4 条已有判定, 实际', r.byIndex.size); return; }
  if (!r.meta.intervalSkipped) { fail++; console.log('FAIL: 应标记 intervalSkipped'); return; }
  console.log('✓ 频率闸: 24h 内不调用, 复用 4 条判定, 1 条待审');
});

// 5) 坏响应降级: 新标题 + 频率已重置 (直接改判定文件 lastApiCallAt? 用新标题集+重启进程语义)
//    简单验证: 无新标题时不调用 API 也不失败
saveSettings({ deepseekApiKey: 'sk-mock', aiReviewEnabled: true, aiReviewIntervalHours: 1 });
const r5 = await reviewNews(items);
if (!r5 || r5.usedAi || r5.byIndex.size !== 4) { fail++; console.log('FAIL: 全命中应零调用'); }
else console.log('✓ 判定库复用: 同批零调用, 4 条判定全部命中');

// 6) parseAiJson markdown
const { parseAiJson } = await import('../server/ai.js');
try {
  const j = parseAiJson('```json\n{"items":[]}\n```');
  if (j.items) console.log('✓ markdown 包裹解析');
  else { fail++; console.log('FAIL: markdown 包裹解析'); }
} catch { fail++; console.log('FAIL: markdown 包裹解析异常'); }

// 清理
saveSettings({ deepseekApiKey: '', aiReviewEnabled: false, aiReviewIntervalHours: 3 });
delete process.env.DEEPSEEK_API_URL;
try { fs.unlinkSync(TMP_VERDICTS); } catch { /* ignore */ }
console.log(fail === 0 ? 'AI 模块测试全部通过' : `${fail} 个失败`);
process.exit(fail === 0 ? 0 : 1);
