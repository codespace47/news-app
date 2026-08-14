// 验证聚合 API: 排序、去重、字段完整、无乱码、无娱乐/问答/营销内容、板块字段
// 用法: node scripts/check-api.js
const ENTERTAINMENT = ['绯闻', '恋情', '官宣', '塌房', '饭圈', '爱豆', '综艺', '演唱会', '八卦', '出轨'];
const QUIZ = ['瞎扯', '段子', '冷知识', '累死吗', '同源吗'];
const CLICKBAIT = ['震惊', '速看', '万万没想到', '惊呆', '必看', '逆天'];
const CATEGORIES = ['时政', '简报', '财经', '科技', '社会', '国际', '体育', '综合'];

fetch('http://localhost:3001/api/news')
  .then((r) => r.json())
  .then((j) => {
    const items = j.items;
    const titles = new Set(items.map((i) => i.title));
    const has = (words) => words.some((w) => items.some((i) => i.title.includes(w)));
    const badCategory = items.some((i) => !CATEGORIES.includes(i.category));
    const valid =
      j.total > 0 &&
      titles.size === items.length &&
      items.every((i) => i.title && i.url && typeof i.score === 'number' && i.category) &&
      items.every((it, idx) => idx === 0 || items[idx - 1].score >= it.score) &&
      !items.some((i) => i.title.includes('\uFFFD')) &&
      !has(ENTERTAINMENT) &&
      !has(QUIZ) &&
      !has(CLICKBAIT) &&
      !badCategory;
    const dist = items.reduce((a, i) => { a[i.category] = (a[i.category] || 0) + 1; return a; }, {});
    console.log(
      `total: ${j.total} | top: ${items[0].title.slice(0, 16)} | score: ${items[0].score} | ` +
      `AI: ${j.aiUsed ? 'on' : 'off'} | 板块: ${JSON.stringify(dist)} | ` +
      `娱乐=${has(ENTERTAINMENT)} 问答=${has(QUIZ)} 营销=${has(CLICKBAIT)} 乱码=${items.some((i) => i.title.includes('\uFFFD'))} | valid: ${valid}`
    );
    process.exit(valid ? 0 : 1);
  })
  .catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
  });
