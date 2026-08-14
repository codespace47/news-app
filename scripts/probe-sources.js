// 探测候选新闻源的可达性与格式 (输出: 状态码 / 类型 / 字节数 / 前160字符)
// 用法: node scripts/probe-sources.js
import https from 'node:https';

const SOURCES = [
  ['财新-早报', 'https://rss.caixin.com/feed/morningnews'],
  ['财新-全部', 'https://rss.caixin.com/feed/all'],
  ['IT之家', 'https://www.ithome.com/rss/'],
  ['Solidot', 'https://www.solidot.org/index.rss'],
  ['36氪', 'https://36kr.com/feed'],
  ['少数派', 'https://sspai.com/feed'],
  ['虎嗅', 'https://www.huxiu.com/rss/0.xml'],
  ['联合早报', 'https://www.zaobao.com.sg/rss.xml'],
  ['BBC中文', 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml'],
  ['NYT中文', 'https://cn.nytimes.com/rss/'],
  ['DW中文', 'https://rss.dw.com/rdf/rss-cht-all'],
  ['中央社', 'https://www.cna.com.tw/rss/'],
  ['cnBeta', 'https://www.cnbeta.com.tw/backend.php'],
];

function probe(name, url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 400) req.destroy(); });
      res.on('end', () => resolve({ name, url, status: res.statusCode, type: res.headers['content-type'] || '', size: data.length, head: data.slice(0, 160).replace(/\s+/g, ' ') }));
      res.on('error', (e) => resolve({ name, url, error: e.message }));
    });
    req.on('error', (e) => resolve({ name, url, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ name, url, error: 'timeout' }); });
  });
}

(async () => {
  const results = await Promise.all(SOURCES.map(([n, u]) => probe(n, u)));
  for (const r of results) {
    if (r.error) { console.log(`✗ ${r.name} | ${r.error}`); continue; }
    const isXml = (r.type || '').includes('xml') || /^<\?xml|<rss|<feed/i.test(r.head);
    console.log(`✓ ${r.name} | ${r.status} | ${r.type} | ${r.size}B | xml=${isXml}`);
    console.log(`    ${r.head}`);
  }
})();
