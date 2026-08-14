// 第二轮探测: 国内可达新闻源 (跟随重定向)
// 用法: node scripts/probe-sources2.js
import https from 'node:https';

const SOURCES = [
  ['联合早报(重定向)', 'https://www.zaobao.com.sg/rss.xml'],
  ['cnBeta(重定向)', 'https://www.cnbeta.com.tw/backend.php'],
  ['网易-要闻', 'https://news.163.com/special/00011K6L/rss_newstop.xml'],
  ['网易-国际', 'https://news.163.com/special/00011K6L/rss_international.xml'],
  ['中新网-滚动', 'https://www.chinanews.com.cn/rss/scroll-news.xml'],
  ['凤凰网', 'https://news.ifeng.com/rss/index.xml'],
  ['新浪-滚动', 'https://rss.sina.com.cn/news/marquee/ddt.xml'],
  ['观察者网', 'https://www.guancha.cn/rss/all.xml'],
  ['界面新闻', 'https://www.jiemian.com/rss.xml'],
  ['澎湃-首页', 'https://www.thepaper.cn/rss.xml'],
  ['腾讯新闻', 'https://rss.qq.com/news/feeds.xml'],
  ['经济观察网', 'https://www.eeo.com.cn/rss/'],
  ['第一财经', 'https://www.yicai.com/rss.xml'],
];

function get(url, redirects = 0) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120', 'Accept': '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        const loc = new URL(res.headers.location, url).href;
        return get(loc, redirects + 1).then(resolve);
      }
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 400) req.destroy(); });
      res.on('end', () => resolve({ url, status: res.statusCode, type: res.headers['content-type'] || '', size: data.length, head: data.slice(0, 200).replace(/\s+/g, ' ') }));
      res.on('error', (e) => resolve({ url, error: e.message }));
    });
    req.on('error', (e) => resolve({ url, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ url, error: 'timeout' }); });
  });
}

(async () => {
  for (const [name, u] of SOURCES) {
    const r = await get(u);
    if (r.error) { console.log(`✗ ${name} | ${r.error}`); continue; }
    const isXml = (r.type || '').includes('xml') || /^<\?xml|<rss|<feed/i.test(r.head);
    console.log(`${isXml ? '✓' : '·'} ${name} | ${r.status} | ${r.type} | ${r.size}B | xml=${isXml}`);
    console.log(`    ${r.head}`);
  }
})();
