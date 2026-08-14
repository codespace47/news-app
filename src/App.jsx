import { useCallback, useEffect, useRef, useState } from 'react';

const REFRESH_MS = 10 * 60 * 1000; // 每 10 分钟自动更新
const CATEGORIES = ['时政', '简报', '财经', '科技', '社会', '国际', '体育'];
const PER_CATEGORY = 3; // 主页每个板块展示条数
const TOP_COUNT = 6; // 主页重要新闻条数

/* ---------------- 工具 ---------------- */

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function badgeFor(score) {
  if (score >= 88) return { label: '重要', cls: 'badge-important' };
  if (score >= 78) return { label: '热点', cls: 'badge-hot' };
  return null;
}

const SOURCE_CLASS = { 头条: 'src-top', 热榜: 'src-hot', 日报: 'src-daily', 热搜: 'src-baidu', 量子位: 'src-tech', 少数派: 'src-tech' };

/** 轻量 hash 路由: #/ 主页, #/c/时政 板块页, #/github GitHub 热门, #/gh/owner-repo 项目 AI 总结 */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const m = hash.match(/^#\/c\/(.+)$/);
  if (m) {
    try {
      return { page: 'category', category: decodeURIComponent(m[1]) };
    } catch {
      return { page: 'home' }; // 非法编码回退主页
    }
  }
  if (hash.startsWith('#/github')) return { page: 'github' };
  const g = hash.match(/^#\/gh\/(.+)$/);
  if (g) {
    try {
      return { page: 'repo', fullName: decodeURIComponent(g[1]) };
    } catch {
      return { page: 'home' };
    }
  }
  return { page: 'home' };
}

function scrollTopOnRoute() {
  window.scrollTo({ top: 0 });
}

/* ---------------- 新闻卡片 ---------------- */

function CardMeta({ item, showCategory = true }) {
  const badge = badgeFor(item.score);
  return (
    <div className="card-meta">
      <span className={`src-badge ${SOURCE_CLASS[item.source] || ''}`}>{item.source}</span>
      {showCategory && item.category && item.category !== '综合' && (
        <span className="cat-badge">{item.category}</span>
      )}
      {badge && <span className={`score-badge ${badge.cls}`}>{badge.label}</span>}
      <span className="card-time">{relativeTime(item.time)}</span>
    </div>
  );
}

/** 带图卡片: 板块页使用 (有图显示缩略图, 无图纯文字) */
function NewsCard({ item }) {
  return (
    <a className="card" href={item.url} target="_blank" rel="noreferrer">
      {item.image ? (
        <div className="card-thumb">
          <img src={item.image} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = 'none')} />
        </div>
      ) : null}
      <div className="card-body">
        <CardMeta item={item} />
        <h3 className="card-title">{item.title}</h3>
      </div>
    </a>
  );
}

/** 主页大字头条 (第 1 条): 大图 + 渐变遮罩 + 大标题 */
function HeroCard({ item }) {
  const badge = badgeFor(item.score);
  return (
    <a className="hero-card" href={item.url} target="_blank" rel="noreferrer">
      {item.image ? (
        <div className="hero-media">
          <img src={item.image} alt="" loading="eager" onError={(e) => (e.currentTarget.style.display = 'none')} />
        </div>
      ) : null}
      <div className="hero-body">
        <div className="card-meta">
          <span className={`src-badge ${SOURCE_CLASS[item.source] || ''}`}>{item.source}</span>
          {item.category && item.category !== '综合' && (
            <span className="cat-badge">{item.category}</span>
          )}
          {badge && <span className={`score-badge ${badge.cls}`}>{badge.label}</span>}
          <span className="card-time">{relativeTime(item.time)}</span>
        </div>
        <h3 className="hero-title">{item.title}</h3>
      </div>
    </a>
  );
}

/** 主页文字行 (无图, 序号 + 标题 + 来源) */
function RowCard({ item, index }) {
  const badge = badgeFor(item.score);
  return (
    <a className="row-card" href={item.url} target="_blank" rel="noreferrer">
      <span className={`rank-num ${index < 3 ? 'rank-top' : ''}`}>{index + 1}</span>
      <div className="row-body">
        <h3 className="row-title">{item.title}</h3>
        <div className="card-meta">
          <span className={`src-badge ${SOURCE_CLASS[item.source] || ''}`}>{item.source}</span>
          {badge && <span className={`score-badge ${badge.cls}`}>{badge.label}</span>}
          <span className="card-time">{relativeTime(item.time)}</span>
        </div>
      </div>
    </a>
  );
}

function Skeleton() {
  return (
    <div className="cards" aria-label="加载中">
      {Array.from({ length: 6 }).map((_, i) => (
        <div className="card card-skeleton" key={i}>
          <div className="skeleton-line w40" />
          <div className="skeleton-line w90" />
          <div className="skeleton-line w70" />
        </div>
      ))}
    </div>
  );
}

/* ---------------- 页面 ---------------- */

function HomePage({ items }) {
  const top = items.slice(0, TOP_COUNT);
  const [hero, ...rest] = top;
  return (
    <>
      <section className="home-section">
        <h2 className="section-title">要闻</h2>
        {hero && <HeroCard item={hero} />}
        <div className="row-list">
          {rest.map((it, i) => <RowCard key={it.id} item={it} index={i + 1} />)}
        </div>
      </section>
      {CATEGORIES.map((cat) => {
        const list = items.filter((it) => it.category === cat).slice(0, PER_CATEGORY);
        if (list.length === 0) return null;
        return (
          <section className="home-section" key={cat}>
            <div className="section-head">
              <h2 className="section-title">{cat}</h2>
              <a className="section-more" href={`#/c/${encodeURIComponent(cat)}`}>查看全部 →</a>
            </div>
            <div className="row-list">
              {list.map((it, i) => <RowCard key={it.id} item={it} index={i} />)}
            </div>
          </section>
        );
      })}
    </>
  );
}

function CategoryPage({ items, category }) {
  const list = items.filter((it) => it.category === category);
  return (
    <section className="home-section">
      <h2 className="section-title">{category}</h2>
      <p className="section-count">{list.length} 条新闻 · 按重要度排序</p>
      {list.length > 0 ? (
        <div className="cards">
          {list.map((it) => <NewsCard key={it.id} item={it} />)}
        </div>
      ) : (
        <div className="empty">该板块暂无新闻</div>
      )}
    </section>
  );
}

/* ---------------- GitHub 热门 ---------------- */

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Go: '#00ADD8',
  Rust: '#dea584', Java: '#b07219', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600',
  Shell: '#89e051', HTML: '#e34c26', CSS: '#563d7c', Vue: '#41b883', Swift: '#F05138',
  Kotlin: '#A97BFF', Dart: '#00B4AB', Ruby: '#701516', PHP: '#4F5D95', Zig: '#ec915c',
  'Jupyter Notebook': '#DA5B0B', Dockerfile: '#384d54', 'Objective-C': '#438eff',
  Scala: '#c22d40', Elixir: '#6e4a7e', Clojure: '#db5855', Haskell: '#5e5086',
  Lua: '#000080', R: '#198CE7', Markdown: '#083fa1', Solidity: '#AA6746', Nix: '#7e7eff',
  OCaml: '#ef7a08', Perl: '#0298c3', PowerShell: '#012456', Assembly: '#6E4C13',
  TeX: '#3D6117', Makefile: '#427819', JSON: '#292929', YAML: '#cb171e',
};

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function GhCard({ item }) {
  const color = LANG_COLORS[item.language] || '#8a93a3';
  const createdTs = item.createdAt ? Date.parse(item.createdAt) : null;
  return (
    <a className="gh-card" href={`#/gh/${encodeURIComponent(item.fullName)}`}>
      <span className={`rank-num ${item.rank <= 3 ? 'rank-top' : ''}`}>{item.rank}</span>
      <div className="gh-body">
        <div className="gh-head">
          <h3 className="gh-name">{item.fullName}</h3>
          {item.language && (
            <span className="gh-lang">
              <span className="lang-dot" style={{ background: color }} aria-hidden="true" />
              {item.language}
            </span>
          )}
        </div>
        {item.tagline
          ? <p className="gh-tagline" title={item.tagline}>{item.tagline}</p>
          : item.desc && <p className="gh-desc">{item.desc}</p>}
        <div className="gh-meta">
          <span className="gh-stat" title="Star 数">★ {fmtCount(item.stars)}</span>
          <span className="gh-stat" title="Fork 数">⑂ {fmtCount(item.forks)}</span>
          {createdTs && <span className="gh-time">创建于 {relativeTime(createdTs)}</span>}
          <span className="gh-summary-hint">AI 总结 →</span>
        </div>
      </div>
    </a>
  );
}

function GithubPage({ items, updatedAt }) {
  return (
    <section className="home-section">
      <div className="section-head">
        <h2 className="section-title">GitHub 热门</h2>
        {updatedAt && <span className="section-count">近 30 天新项目 · 按 Star 排序</span>}
      </div>
      {items.length > 0 ? (
        <div className="gh-list">
          {items.map((it) => <GhCard key={it.id} item={it} />)}
        </div>
      ) : (
        <div className="empty">GitHub 热门暂不可用, 请稍后刷新</div>
      )}
    </section>
  );
}

/* ---------------- 项目 AI 总结页 ---------------- */

/** 极简 markdown 行内渲染: **加粗** / `代码` / [链接](url) */
function inlineMd(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

/** AI 总结正文 → 段落 / 要点列表 */
function SummaryBody({ text }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  let list = null;
  for (const line of lines) {
    if (/^[-•*]\s+/.test(line) || /^\d+[.、]/.test(line)) {
      if (!list) { list = []; blocks.push(list); }
      list.push(<li key={`li-${blocks.length}-${list.length}`} dangerouslySetInnerHTML={{ __html: inlineMd(line.replace(/^[-•*]\s+/, '').replace(/^\d+[.、]\s*/, '')) }} />);
    } else {
      list = null;
      blocks.push(<p key={`p-${blocks.length}`} dangerouslySetInnerHTML={{ __html: inlineMd(line) }} />);
    }
  }
  return (
    <div className="summary-body">
      {blocks.map((b, i) => (Array.isArray(b) ? <ul key={`ul-${i}`}>{b}</ul> : b))}
    </div>
  );
}

function RepoPage({ fullName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/github/summary?fullName=${encodeURIComponent(fullName)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) throw new Error(j.error);
        setData(j);
      })
      .catch((e) => {
        if (alive) setError(e.message || '加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [fullName]);

  const repo = data?.repo;
  const color = repo?.language ? LANG_COLORS[repo.language] || '#8a93a3' : null;
  const createdTs = repo?.createdAt ? Date.parse(repo.createdAt) : null;

  return (
    <section className="home-section">
      <a className="back-link" href="#/github">← 返回 GitHub 热门</a>

      {loading && <Skeleton />}

      {!loading && error && !repo && (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          <button onClick={() => window.location.reload()}>重试</button>
        </div>
      )}

      {!loading && repo && (
        <article className="repo-card">
          <header className="repo-head">
            <div className="repo-title-row">
              <h2 className="repo-name">{repo.fullName}</h2>
              {repo.language && (
                <span className="gh-lang">
                  <span className="lang-dot" style={{ background: color }} aria-hidden="true" />
                  {repo.language}
                </span>
              )}
            </div>
            <div className="gh-meta">
              <span className="gh-stat" title="Star 数">★ {fmtCount(repo.stars)}</span>
              <span className="gh-stat" title="Fork 数">⑂ {fmtCount(repo.forks)}</span>
              {createdTs && <span className="gh-time">创建于 {relativeTime(createdTs)}</span>}
              {data?.cached && <span className="gh-cached" title="7 天内生成过, 直接复用">AI 总结已缓存</span>}
            </div>
          </header>

          {data?.summary ? (
            <>
              <div className="repo-summary-label">AI 项目介绍</div>
              <SummaryBody text={data.summary} />
            </>
          ) : (
            <div className="repo-fallback">
              {repo.desc && <p className="gh-desc">{repo.desc}</p>}
              <p className="repo-noai">
                {data?.notFound
                  ? '该项目不在当前热门列表中, 未生成 AI 介绍。'
                  : 'AI 总结暂时不可用(未配置 DeepSeek Key 或生成失败), 可直接查看原项目。'}
              </p>
            </div>
          )}

          <footer className="repo-actions">
            <a className="primary-btn repo-github-btn" href={repo.url} target="_blank" rel="noreferrer">
              查看 GitHub 原始项目 ↗
            </a>
          </footer>
        </article>
      )}
    </section>
  );
}

/* ---------------- 设置弹窗 ---------------- */

function SettingsModal({ onClose, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [interval, setInterval] = useState(3);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {ok, text}

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setSettings(j);
        setEnabled(!!j.aiReviewEnabled);
        setInterval(Number(j.aiReviewIntervalHours) || 3);
      })
      .catch((e) => setLoadError(e.message || '读取设置失败'));
  }, []);

  const put = async (body) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '保存失败');
      setSettings(j);
      setApiKey('');
      onSaved(j);
      return j;
    } catch (e) {
      setMsg({ ok: false, text: e.message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const body = { aiReviewEnabled: enabled, aiReviewIntervalHours: interval };
    if (apiKey.trim()) body.deepseekApiKey = apiKey.trim(); // 仅输入新 key 时才更新, 避免误清
    const j = await put(body);
    if (j) setMsg({ ok: true, text: '已保存' });
  };

  const clearKey = async () => {
    const j = await put({ deepseekApiKey: '' }); // 显式清除
    if (j) setMsg({ ok: true, text: 'API Key 已清除' });
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deepseekApiKey: apiKey }),
      });
      const j = await r.json();
      setMsg({ ok: j.ok, text: j.message + (j.latencyMs ? ` (${j.latencyMs}ms)` : '') });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>设置</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="modal-body">
          {loadError && !settings && <div className="setting-msg err">{loadError}</div>}

          {settings && (
            <>
              <label className="field">
                <span className="field-label">DeepSeek API Key</span>
                <div className="key-row">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={settings.hasKey ? `已配置 ${settings.keyMasked}, 输入新 Key 可替换` : 'sk-...'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button className="mini-btn" onClick={() => setShowKey((v) => !v)}>{showKey ? '隐藏' : '显示'}</button>
                </div>
              </label>

              <label className="field switch-field">
                <div>
                  <span className="field-label">AI 审查</span>
                  <p className="field-hint">开启后由 AI 剔除无关新闻、不重要新闻与营销号, 并重新排序与分类</p>
                </div>
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              </label>

              {enabled && (
                <label className="field">
                  <span className="field-label">AI 审查频率(最小间隔)</span>
                  <select className="freq-select" value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
                    <option value={1}>每 1 小时(较费, 最多 24 次/天)</option>
                    <option value={3}>每 3 小时(推荐, 最多 8 次/天)</option>
                    <option value={6}>每 6 小时(最多 4 次/天)</option>
                    <option value={24}>每 24 小时(最省, 最多 1 次/天)</option>
                  </select>
                  <p className="field-hint">增量审查: 只对新出现的新闻调用 AI, 已审过的直接复用判定, 实际调用远少于上限</p>
                </label>
              )}
            </>
          )}

          {msg && <div className={`setting-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
        </div>

        <div className="modal-foot">
          {settings?.hasKey && (
            <button className="mini-btn danger-btn" onClick={clearKey} disabled={busy}>清除 Key</button>
          )}
          <button className="mini-btn" onClick={test} disabled={busy || !settings || (!apiKey && !settings.hasKey)}>测试连接</button>
          <button className="primary-btn" onClick={save} disabled={busy || !settings}>保存</button>
        </div>
        <p className="modal-note">
          Key 仅保存在本机 server/data/settings.json, 用于调用 DeepSeek API。
          获取 Key: platform.deepseek.com · 设置接口仅限本机访问, 手机端只读新闻。
        </p>
      </div>
    </div>
  );
}

/* ---------------- 主应用 ---------------- */

export default function App() {
  const [items, setItems] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(REFRESH_MS);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiUsed, setAiUsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newVersion, setNewVersion] = useState(false);
  const [ghItems, setGhItems] = useState([]);
  const [ghUpdatedAt, setGhUpdatedAt] = useState(null);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState(null);
  const abortRef = useRef(null);
  const versionRef = useRef(null); // 已加载的应用版本
  const route = useHashRoute();

  // 仅当页面/板块切换时滚动回顶 (不能依赖 route 对象: 每次渲染都是新引用, 会随倒计时每秒触发)
  useEffect(scrollTopOnRoute, [route.page, route.category, route.fullName]);

  // GitHub 热门: 独立拉取, 失败不影响新闻 (保留旧数据)
  const loadGithub = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setGhLoading(true);
    try {
      const r = await fetch('/api/github/trending');
      if (!r.ok) throw new Error('GitHub 热门暂时不可用');
      const j = await r.json();
      if (!j.items?.length) throw new Error('GitHub 热门暂无数据');
      setGhItems(j.items);
      setGhUpdatedAt(Date.now());
      setGhError(null);
    } catch (e) {
      if (!silent) setGhError(e.message || 'GitHub 热门加载失败');
    } finally {
      if (!silent) setGhLoading(false);
    }
  }, []);

  const load = useCallback(async ({ silent = false } = {}) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!silent) setLoading(true);
    try {
      const r = await fetch('/api/news', { signal: controller.signal });
      if (!r.ok) throw new Error('新闻服务暂时不可用');
      // 版本检测: 后端重启(代码更新)后提示刷新页面, 避免一直看旧版本
      const v = r.headers.get('X-App-Version');
      if (v && versionRef.current && v !== versionRef.current) setNewVersion(true);
      if (v) versionRef.current = v;
      const j = await r.json();
      if (!j.items?.length) throw new Error('暂无新闻');
      setItems(j.items);
      setUpdatedAt(Date.now());
      setError(null);
      setAiUsed(!!j.aiUsed);
      setAiEnabled(!!j.aiEnabled);
      setCountdown(REFRESH_MS);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!silent) setError(e.message || '加载失败');
    } finally {
      if (!silent && abortRef.current === controller) setLoading(false);
    }
    loadGithub({ silent }); // 与新闻并行刷新 (独立成败)
  }, [loadGithub]);

  useEffect(() => {
    load();
    const interval = setInterval(() => load({ silent: true }), REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) load({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      abortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1000 ? REFRESH_MS : c - 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const onSettingsSaved = (s) => {
    load({ silent: true }); // 设置变更后重新拉取 (后端已清缓存)
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-dot" aria-hidden="true" />
            <a href="#/" className="brand-name"><h1>今日要闻</h1></a>
            <span className="tagline">只推新闻 · 按重要度排序</span>
            {aiEnabled && <span className="ai-tag" title="AI 审查已启用">AI</span>}
          </div>
          <div className="header-right">
            {updatedAt && (
              <span className="update-info">
                更新于 {fmtClock(updatedAt)}
                <span className="countdown"> {fmtCountdown(countdown)} 后刷新</span>
              </span>
            )}
            <button className="refresh-btn" onClick={() => load()} disabled={loading} aria-label="立即刷新">
              {loading ? '刷新中…' : '刷新'}
            </button>
            <button className="gear-btn" onClick={() => setSettingsOpen(true)} aria-label="设置">⚙</button>
          </div>
        </div>
        <nav className="nav">
          <a className={`nav-item ${route.page === 'home' ? 'active' : ''}`} href="#/">首页</a>
          {CATEGORIES.map((cat) => (
            <a
              key={cat}
              className={`nav-item ${route.page === 'category' && route.category === cat ? 'active' : ''}`}
              href={`#/c/${encodeURIComponent(cat)}`}
            >
              {cat}
            </a>
          ))}
          <a className={`nav-item ${route.page === 'github' ? 'active' : ''}`} href="#/github">GitHub 热门</a>
        </nav>
      </header>

      <main className="main">
        {newVersion && (
          <div className="version-bar" role="status">
            <span>🎉 已发布新版本, 刷新后查看最新功能</span>
            <button onClick={() => window.location.reload()}>立即刷新</button>
          </div>
        )}
        {error && (
          <div className="error-bar" role="alert">
            <span>{error}</span>
            <button onClick={() => load()}>重试</button>
          </div>
        )}

        {route.page === 'repo' ? (
          <RepoPage fullName={route.fullName} />
        ) : route.page === 'github' ? (
          <>
            {ghError && !ghLoading && (
              <div className="error-bar" role="alert">
                <span>{ghError}</span>
                <button onClick={() => loadGithub()}>重试</button>
              </div>
            )}
            {ghLoading && ghItems.length === 0 ? <Skeleton /> : <GithubPage items={ghItems} updatedAt={ghUpdatedAt} />}
          </>
        ) : loading && items.length === 0 ? (
          <Skeleton />
        ) : items.length === 0 ? (
          <div className="empty">暂无新闻, 请稍后刷新</div>
        ) : route.page === 'home' ? (
          <HomePage items={items} />
        ) : (
          <CategoryPage items={items} category={route.category} />
        )}
      </main>

      <footer className="footer">
        数据来源: 知乎日报 / 百度热搜 / 量子位 / 少数派 / GitHub · 内容版权归原作者 · 每 10 分钟自动更新
        {aiUsed && ' · 本次内容经 AI 审查'}
      </footer>

      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} onSaved={onSettingsSaved} />
      )}
    </div>
  );
}
