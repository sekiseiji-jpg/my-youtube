/* ============================================================
   MyPlayer  -  好きなワードを組み合わせて検索・視聴するアプリ
   依存ライブラリなし / データは全てブラウザの localStorage に保存
   ============================================================ */
'use strict';

/* ---------------- 小さなユーティリティ ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of [].concat(kids)) {
    if (k === null || k === undefined || k === false) continue;
    n.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
  return n;
}

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

function fmtCount(n) {
  n = Number(n || 0);
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '億';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return n.toLocaleString('ja-JP');
}

function fmtDur(iso) {
  if (!iso) return '';
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return '';
  const h = (+(m[1] || 0)) * 24 + (+(m[2] || 0));
  const mi = +(m[3] || 0), s = +(m[4] || 0);
  if (!h && !mi && !s) return '';
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(mi)}:${p(s)}` : `${mi}:${p(s)}`;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}分前`;
  if (d < 86400) return `${Math.floor(d / 3600)}時間前`;
  if (d < 2592000) return `${Math.floor(d / 86400)}日前`;
  if (d < 31536000) return `${Math.floor(d / 2592000)}か月前`;
  return `${Math.floor(d / 31536000)}年前`;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- 画面幅・ドロワー ---------------- */
const isMobile = () => window.matchMedia('(max-width:860px)').matches;

/* ヘッダーの実高さを CSS 変数に入れる（スマホでは折り返して高さが変わるため） */
function setTopHeight() {
  const h = $('#top').offsetHeight;
  document.documentElement.style.setProperty('--topH', h + 'px');
}

function openDrawer() { document.body.classList.add('drawer'); }
function closeDrawer() { document.body.classList.remove('drawer'); }
function drawerOpen() { return document.body.classList.contains('drawer'); }

/* ---------------- 保存領域 ---------------- */
const PREFIX = 'myyt.v1.';
let storageOK = true;
const mem = {};

const store = {
  get(name, def) {
    try {
      if (!storageOK) return name in mem ? mem[name] : def;
      const v = localStorage.getItem(PREFIX + name);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  },
  set(name, val) {
    mem[name] = val;
    try { if (storageOK) localStorage.setItem(PREFIX + name, JSON.stringify(val)); }
    catch (e) { /* 容量超過などは無視（メモリ上には残る） */ }
  }
};

function checkStorage() {
  try {
    localStorage.setItem(PREFIX + 'test', '1');
    localStorage.removeItem(PREFIX + 'test');
    storageOK = true;
  } catch (e) {
    storageOK = false;
  }
}

/* ---------------- 状態 ---------------- */
const DEFAULT_OPTS = {
  order: 'relevance', duration: 'any', period: 'any', max: 24,
  combine: 'and', hd: false, caption: false, ja: true,
  autoNext: true, repeat: false,
  cacheMin: 30            // 検索結果をキャッシュする分数（APIの節約用）
};

const SAMPLE_WORDS = [
  ['ジャンル', ['作業用BGM', 'ライブ映像', '解説', 'ドキュメンタリー', 'Vlog']],
  ['気分・用途', ['おすすめ', '神回', '初心者向け', '最新', '睡眠']],
  ['条件', ['4K', '高音質', 'ノーカット', '日本語字幕']]
];

const state = {
  apiKey: '',
  words: [],          // {id, text, group}
  sel: {},            // id -> 'in' | 'ex'
  opts: { ...DEFAULT_OPTS },
  presets: [],        // {id, name, sel, extra, opts}
  history: [],        // {q, sel, extra, opts, t}
  queue: [],          // video
  favs: [],           // video
  watched: [],        // video（視聴履歴）
  playlists: [],      // {id, name, items:[video]}
  blocked: [],        // {id, title}（非表示チャンネル）
  channelFilter: null,// {id, title}（このチャンネルだけ検索）
  results: [],        // video
  nextPageToken: null,
  lastSearch: null,   // {q, params}
  current: null,      // 再生中の videoId
  ctx: 'results',     // 'results' | 'queue'
  loading: false
};

/* ---------------- クエリ組み立て ---------------- */
function quoteWord(t) {
  return /\s/.test(t) ? `"${t}"` : t;
}

function buildQuery() {
  const inc = [], exc = [];
  for (const w of state.words) {
    const m = state.sel[w.id];
    if (m === 'in') inc.push(quoteWord(w.text));
    else if (m === 'ex') exc.push('-' + quoteWord(w.text));
  }
  const joined = state.opts.combine === 'or' && inc.length > 1
    ? '(' + inc.join(' | ') + ')'
    : inc.join(' ');
  const extra = $('#extra').value.trim();
  return [joined, extra, exc.join(' ')].filter(Boolean).join(' ').trim();
}

function updateQuery() {
  const q = buildQuery();
  $('#qtext').textContent = q;
  const n = Object.values(state.sel).filter(v => v === 'in').length;
  const x = Object.values(state.sel).filter(v => v === 'ex').length;
  $('#selCount').textContent = n || x ? `選択 ${n} 件${x ? ` / 除外 ${x} 件` : ''}` : '未選択';
  return q;
}

/* ---------------- マイワード ---------------- */
function seedWordsIfEmpty() {
  if (state.words.length) return;
  for (const [g, list] of SAMPLE_WORDS) {
    for (const t of list) state.words.push({ id: uid(), text: t, group: g });
  }
  store.set('words', state.words);
}

function groupsOf() {
  const map = new Map();
  for (const w of state.words) {
    if (!map.has(w.group)) map.set(w.group, []);
    map.get(w.group).push(w);
  }
  return map;
}

function renderWords() {
  const box = $('#words');
  box.textContent = '';
  const groups = groupsOf();

  if (!groups.size) {
    box.appendChild(el('p', { class: 'muted', text: 'ワードがありません。下の入力欄から追加してください。' }));
  }

  for (const [gname, list] of groups) {
    const chips = el('div', { class: 'chips' });
    for (const w of list) {
      const mode = state.sel[w.id];
      const chip = el('div', {
        class: 'chip' + (mode === 'in' ? ' on' : '') + (mode === 'ex' ? ' ex' : ''),
        dataset: { id: w.id },
        title: 'クリック: 選択 / Shift+クリック: 除外'
      }, [
        el('span', { class: 'ctext', text: (mode === 'ex' ? '− ' : '') + w.text }),
        el('button', { class: 'cedit', text: '✎', title: '編集', type: 'button' }),
        el('button', { class: 'cdel', text: '×', title: '削除', type: 'button' })
      ]);
      chips.appendChild(chip);
    }
    box.appendChild(el('div', { class: 'wgroup' }, [
      el('div', { class: 'ghead' }, [
        el('span', { class: 'gname', text: gname }),
        el('div', { class: 'gacts' }, [
          el('button', { class: 'mini', text: '全選択', type: 'button', onclick: () => { list.forEach(w => state.sel[w.id] = 'in'); afterSelChange(); } }),
          el('button', { class: 'mini', text: '解除', type: 'button', onclick: () => { list.forEach(w => delete state.sel[w.id]); afterSelChange(); } })
        ])
      ]),
      chips
    ]));
  }

  const dl = $('#groupList');
  dl.textContent = '';
  for (const g of groups.keys()) dl.appendChild(el('option', { value: g }));
}

function afterSelChange() {
  store.set('sel', state.sel);
  renderWords();
  updateQuery();
}

function addWords(raw, group) {
  const g = (group || '').trim() || '未分類';
  const parts = raw.split(/[,、\n]/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  for (const text of parts) {
    if (state.words.some(w => w.text === text && w.group === g)) continue;
    state.words.push({ id: uid(), text, group: g });
    added++;
  }
  store.set('words', state.words);
  renderWords();
  updateQuery();
  if (added) toast(`${added} 件のワードを追加しました`);
}

/* ---------------- YouTube API ---------------- */
function quotaAdd(units) {
  const today = new Date().toISOString().slice(0, 10);
  const q = store.get('quota', { d: today, u: 0 });
  if (q.d !== today) { q.d = today; q.u = 0; }
  q.u += units;
  store.set('quota', q);
  renderQuota();
}

function renderQuota() {
  const today = new Date().toISOString().slice(0, 10);
  const q = store.get('quota', { d: today, u: 0 });
  const u = q.d === today ? q.u : 0;
  $('#quota').textContent = `本日 ${u.toLocaleString('ja-JP')} / 10,000 ユニット`;
}

async function api(path, params, cost) {
  const p = new URLSearchParams(params);
  p.set('key', state.apiKey);
  let res, data;
  try {
    res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${p.toString()}`);
  } catch (e) {
    throw Object.assign(new Error('ネットワークに接続できませんでした。'), { reason: 'network' });
  }
  quotaAdd(cost);
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const err = (data && data.error) || {};
    const reason = (err.errors && err.errors[0] && err.errors[0].reason) || '';
    throw Object.assign(new Error(err.message || `HTTP ${res.status}`), { reason, status: res.status });
  }
  return data;
}

function friendlyError(e) {
  switch (e.reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      return 'APIの1日あたりの上限に達しました。日付が変わるまで待つか、別のAPIキーを使ってください。（検索1回＝100ユニット／1日10,000）';
    case 'keyInvalid':
    case 'badRequest':
      return 'APIキーが正しくないようです。設定画面で確認してください。';
    case 'ipRefererBlocked':
      return 'APIキーの利用制限でブロックされました。Google Cloud コンソールでキーの「アプリケーションの制限」を「なし」にするか、このページのURLを許可してください。';
    case 'accessNotConfigured':
      return 'このプロジェクトで YouTube Data API v3 が有効になっていません。Google Cloud コンソールで有効化してください。';
    case 'network':
      return e.message;
    default:
      return `検索に失敗しました: ${e.message}`;
  }
}

/* キャッシュ（同じ条件の再検索でAPIを消費しないため）
   保持時間は設定画面で変更できる。0 にするとキャッシュを使わない。 */
function cacheTTL() { return Math.max(0, Number(state.opts.cacheMin) || 0) * 60000; }

function cacheGet(key) {
  const ttl = cacheTTL();
  if (!ttl) return null;
  const c = store.get('cache', {});
  const e = c[key];
  if (!e || Date.now() - e.t > ttl) return null;
  return e.v;
}
function cacheSet(key, v) {
  const c = store.get('cache', {});
  c[key] = { t: Date.now(), v };
  const keys = Object.keys(c);
  if (keys.length > 30) {
    keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - 30).forEach(k => delete c[k]);
  }
  store.set('cache', c);
}

/* ---------------- 検索 ---------------- */
function searchParams(q) {
  const o = state.opts;
  const p = {
    part: 'snippet', type: 'video', q,
    maxResults: String(o.max), order: o.order, safeSearch: 'none'
  };
  if (o.duration !== 'any') p.videoDuration = o.duration;
  if (o.period !== 'any') {
    const days = Number(o.period.slice(1));
    p.publishedAfter = new Date(Date.now() - days * 86400000).toISOString();
  }
  if (o.hd) p.videoDefinition = 'high';
  if (o.caption) p.videoCaption = 'closedCaption';
  if (o.ja) { p.relevanceLanguage = 'ja'; p.regionCode = 'JP'; }
  if (state.channelFilter) p.channelId = state.channelFilter.id;
  return p;
}

/* ---------------- チャンネルの絞り込み・非表示 ---------------- */
function isBlocked(channelId) {
  return !!channelId && state.blocked.some(c => c.id === channelId);
}

function renderChanChip() {
  const chip = $('#chanChip');
  if (!state.channelFilter) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  chip.textContent = `${decodeEntities(state.channelFilter.title)} ✕`;
}

function setChannelFilter(v) {
  if (!v || !v.channelId) { toast('チャンネル情報が取得できませんでした'); return; }
  state.channelFilter = { id: v.channelId, title: v.channel || 'チャンネル' };
  renderChanChip();
  toast(`${decodeEntities(state.channelFilter.title)} の動画に絞り込みます`);
  doSearch();
}

function clearChannelFilter() {
  if (!state.channelFilter) return;
  state.channelFilter = null;
  renderChanChip();
  doSearch();
}

function blockChannel(v) {
  if (!v.channelId) { toast('チャンネル情報が取得できませんでした'); return; }
  if (isBlocked(v.channelId)) return;
  state.blocked.push({ id: v.channelId, title: v.channel || 'チャンネル' });
  store.set('blocked', state.blocked);
  renderResults();
  toast(`${decodeEntities(v.channel || '')} を非表示にしました（設定で解除できます）`);
}

function setStatus(msg, isError) {
  const s = $('#status');
  s.textContent = msg || '';
  s.classList.toggle('error', !!isError);
}

async function doSearch({ append = false, force = false } = {}) {
  if (!state.apiKey) { renderSetup(); openSettings(); return; }
  const q = updateQuery();
  if (!q) { toast('ワードを選択するか、キーワードを入力してください'); return; }
  if (state.loading) return;

  const params = searchParams(q);
  const pageToken = append ? state.nextPageToken : '';
  if (append && !pageToken) return;
  if (pageToken) params.pageToken = pageToken;

  const ckey = JSON.stringify(params);
  state.loading = true;
  $('#btnMore').disabled = true;
  setStatus(append ? '読み込み中…' : `「${q}」を検索中…`);

  try {
    let payload = force ? null : cacheGet(ckey);
    if (!payload) {
      const sr = await api('search', params, 100);
      const items = (sr.items || []).filter(it => it.id && it.id.videoId).map(it => ({
        id: it.id.videoId,
        title: it.snippet.title,
        channel: it.snippet.channelTitle,
        channelId: it.snippet.channelId,
        published: it.snippet.publishedAt,
        thumb: (it.snippet.thumbnails.medium || it.snippet.thumbnails.default || {}).url,
        live: it.snippet.liveBroadcastContent === 'live'
      }));
      // 再生時間・再生回数・埋め込み可否を取得（1ユニット）
      if (items.length) {
        try {
          const dr = await api('videos', {
            part: 'contentDetails,statistics,status',
            id: items.map(v => v.id).join(',')
          }, 1);
          const byId = {};
          for (const d of (dr.items || [])) byId[d.id] = d;
          for (const v of items) {
            const d = byId[v.id];
            if (!d) continue;
            v.dur = fmtDur(d.contentDetails && d.contentDetails.duration);
            v.views = d.statistics && d.statistics.viewCount;
            v.embeddable = !(d.status && d.status.embeddable === false);
          }
        } catch (e) { /* 詳細が取れなくても一覧は出す */ }
      }
      payload = { items, nextPageToken: sr.nextPageToken || null, total: (sr.pageInfo || {}).totalResults };
      cacheSet(ckey, payload);
    }

    state.results = append ? state.results.concat(payload.items) : payload.items;
    state.nextPageToken = payload.nextPageToken;
    state.lastSearch = { q, params };

    if (!append) {
      pushHistory(q);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    renderResults();
    setStatus(state.results.length
      ? `${state.results.length} 件表示${payload.total ? `（全 ${fmtCount(payload.total)} 件くらい）` : ''}`
      : '結果が0件でした。ワードを減らすか、条件を緩めてみてください。');
  } catch (e) {
    setStatus(friendlyError(e), true);
  } finally {
    state.loading = false;
    $('#btnMore').disabled = false;
    $('#btnMore').classList.toggle('hidden', !state.nextPageToken);
  }
}

/* ---------------- 検索結果の描画 ---------------- */
function isFav(id) { return state.favs.some(v => v.id === id); }
function isWatched(id) { return state.watched.some(v => v.id === id); }

function card(v) {
  const thumb = el('div', { class: 'thumb', onclick: () => play(v, 'results') }, [
    el('img', { src: v.thumb || '', alt: '', loading: 'lazy' }),
    v.live ? el('span', { class: 'live', text: 'LIVE' }) : null,
    v.dur ? el('span', { class: 'dur', text: v.dur }) : null,
    el('span', { class: 'playicon', text: '▶' }),
    isWatched(v.id) ? el('span', { class: 'seenbadge', text: '視聴済み' }) : null
  ]);

  const favBtn = el('button', {
    class: 'mini fav' + (isFav(v.id) ? ' on' : ''),
    text: isFav(v.id) ? '♥' : '♡',
    title: 'お気に入り',
    type: 'button',
    onclick: (ev) => { ev.stopPropagation(); toggleFav(v); }
  });

  return el('article', {
    class: 'card' + (state.current === v.id ? ' playing' : '') + (isWatched(v.id) ? ' seen' : ''),
    dataset: { id: v.id }
  }, [
    thumb,
    el('div', { class: 'cmeta' }, [
      el('h3', { class: 'ctitle', text: decodeEntities(v.title), title: decodeEntities(v.title), onclick: () => play(v, 'results') }),
      el('div', { class: 'csub' }, [
        el('button', {
          class: 'chan', type: 'button', text: decodeEntities(v.channel || ''),
          title: 'このチャンネルの動画だけを検索',
          onclick: (ev) => { ev.stopPropagation(); setChannelFilter(v); }
        }),
        [v.views ? ` ・ ${fmtCount(v.views)}回` : '', v.published ? ` ・ ${fmtAgo(v.published)}` : ''].join('')
      ]),
      v.embeddable === false ? el('div', { class: 'noembed', text: '※ 埋め込み再生が制限された動画です' }) : null
    ]),
    el('div', { class: 'cacts' }, [
      el('button', { class: 'mini', text: '▶ 再生', type: 'button', onclick: () => play(v, 'results') }),
      el('button', { class: 'mini', text: '＋ キュー', type: 'button', onclick: () => addQueue(v) }),
      favBtn,
      el('button', {
        class: 'mini', text: '🚫', type: 'button', title: 'このチャンネルを今後非表示にする',
        onclick: (ev) => { ev.stopPropagation(); blockChannel(v); }
      }),
      el('a', { class: 'mini link', href: `https://www.youtube.com/watch?v=${v.id}`, target: '_blank', rel: 'noreferrer', text: 'YouTube' })
    ])
  ]);
}

/* API が返すタイトルは &amp; などがそのまま来るのでデコードする */
const decoder = document.createElement('textarea');
function decodeEntities(s) {
  if (!s) return '';
  decoder.innerHTML = s;
  return decoder.value;
}

function visibleResults() {
  return state.results.filter(v => !isBlocked(v.channelId));
}

function renderResults() {
  const box = $('#results');
  box.textContent = '';
  const list = visibleResults();
  const hidden = state.results.length - list.length;
  if (list.length) {
    const frag = document.createDocumentFragment();
    for (const v of list) frag.appendChild(card(v));
    box.appendChild(frag);
  }
  if (hidden > 0) {
    box.appendChild(el('p', { class: 'muted', text: `非表示チャンネルの ${hidden} 件を隠しています` }));
  }
  $('#btnQueueAll').classList.toggle('hidden', !list.length);
}

function renderSetup() {
  const box = $('#results');
  box.textContent = '';
  box.appendChild(el('div', { class: 'setup' }, [
    el('h3', { text: 'はじめに YouTube API キーを設定してください' }),
    el('ol', {}, [
      el('li', { html: '<a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud コンソール</a> でプロジェクトを作成' }),
      el('li', { text: '「APIとサービス」→ ライブラリ →「YouTube Data API v3」を有効化' }),
      el('li', { text: '「認証情報」→「APIキーを作成」' }),
      el('li', { text: 'キーをコピーして、右上の ⚙ 設定 に貼り付けて保存' })
    ]),
    el('p', { class: 'muted', text: 'キーはこのブラウザ内にだけ保存され、外部には送信されません（YouTube API へのリクエストにのみ使用）。無料枠は1日10,000ユニットで、検索1回＝100ユニットなので約100回/日まで検索できます。' }),
    el('div', { class: 'btnrow' }, [
      el('button', { class: 'primary', text: '設定を開く', type: 'button', onclick: openSettings })
    ])
  ]));
}

/* ---------------- プレーヤー ---------------- */
let player = null, ytReady = false, pending = null;
let useFallback = false, fallbackFrame = null, fallbackNotified = false;

(function loadYT() {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => enableFallback();
  document.head.appendChild(s);
  // スクリプトが読めない環境（CSPや拡張機能でブロックされた場合など）に備える
  setTimeout(() => { if (!ytReady) enableFallback(); }, 4000);
})();

window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  if (pending && !useFallback) { const v = pending; pending = null; startPlayer(v); }
};

/* IFrame Player API が使えないときは素の埋め込みに切り替える
   （再生はできるが、終了を検知できないので連続再生は無効） */
function enableFallback() {
  if (ytReady || useFallback) return;
  useFallback = true;
  if (pending) { const v = pending; pending = null; startFallback(v); }
}

function startFallback(v) {
  const box = $('.playerbox');
  if (!fallbackFrame || !fallbackFrame.isConnected) {
    box.textContent = '';
    fallbackFrame = el('iframe', {
      id: 'player', frameborder: '0', allowfullscreen: true,
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen'
    });
    box.appendChild(fallbackFrame);
  }
  fallbackFrame.src = `https://www.youtube.com/embed/${encodeURIComponent(v.id)}?autoplay=1&playsinline=1&rel=0`;
  if (!fallbackNotified) {
    fallbackNotified = true;
    toast('簡易プレーヤーで再生します（連続再生は使えません）');
  }
}

function startPlayer(v) {
  const vars = { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 };
  if (location.protocol.startsWith('http')) vars.origin = location.origin;
  player = new YT.Player('player', {
    videoId: v.id,
    playerVars: vars,
    events: {
      onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) onEnded(); },
      onError: (e) => {
        const map = { 2: '動画IDが不正です', 5: 'この動画はこのプレーヤーで再生できません', 100: '動画が見つかりません（削除・非公開）', 101: '所有者が埋め込み再生を許可していません', 150: '所有者が埋め込み再生を許可していません' };
        showPlayerError((map[e.data] || `再生エラー (code ${e.data})`) + ' — 「YouTubeで開く」から視聴してください。');
      }
    }
  });
}

function showPlayerError(msg) {
  const box = $('#playerErr');
  box.textContent = msg;
  box.classList.remove('hidden');
}

function play(v, ctx) {
  state.ctx = ctx || 'results';
  state.current = v.id;
  closeDrawer();
  $('#theater').classList.remove('hidden');
  $('#playerErr').classList.add('hidden');
  $('#nowTitle').textContent = decodeEntities(v.title);
  $('#nowSub').textContent = [decodeEntities(v.channel || ''), v.views ? `${fmtCount(v.views)}回` : '', v.published ? fmtAgo(v.published) : ''].filter(Boolean).join(' ・ ');
  $('#linkNow').href = `https://www.youtube.com/watch?v=${v.id}`;
  $('#btnFavNow').textContent = isFav(v.id) ? '♥ お気に入り済み' : '♡ お気に入り';

  try {
    if (useFallback) { startFallback(v); }
    else if (!ytReady) { pending = v; }
    else if (!player) { startPlayer(v); }
    else { player.loadVideoById(v.id); }
  } catch (e) {
    showPlayerError('この動画を再生できませんでした。「YouTubeで開く」から視聴してください。');
  }

  pushWatched(v);
  markPlaying();
  setTopHeight();
  // スマホではプレーヤーが上部に固定されるのでページ先頭へ
  if (isMobile()) window.scrollTo({ top: 0, behavior: 'smooth' });
  else $('#theater').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function markPlaying() {
  $$('#results .card').forEach(c => c.classList.toggle('playing', c.dataset.id === state.current));
  $$('#queue .row').forEach(r => r.classList.toggle('playing', r.dataset.id === state.current));
}

function neighbor(dir) {
  const list = state.ctx === 'queue' ? state.queue : visibleResults();
  if (!list.length) return null;
  const i = list.findIndex(v => v.id === state.current);
  if (i < 0) return list[0];
  return list[i + dir] || null;
}

function onEnded() {
  if (!state.opts.autoNext) return;
  const nx = neighbor(1);
  if (nx) { play(nx, state.ctx); return; }
  // 最後まで来たらリピート設定に従って先頭へ戻る
  if (state.opts.repeat) {
    const list = state.ctx === 'queue' ? state.queue : visibleResults();
    if (list.length) play(list[0], state.ctx);
  }
}

function closeTheater() {
  if (player && player.stopVideo) { try { player.stopVideo(); } catch (e) { } }
  if (fallbackFrame) fallbackFrame.src = 'about:blank';   // 閉じたら音を止める
  state.current = null;
  $('#theater').classList.add('hidden');
  markPlaying();
}

/* ---------------- キュー / お気に入り / 履歴 ---------------- */
function slim(v) {
  return {
    id: v.id, title: v.title, channel: v.channel, channelId: v.channelId,
    thumb: v.thumb, dur: v.dur, views: v.views, published: v.published, embeddable: v.embeddable
  };
}

function addQueue(v, quiet) {
  if (state.queue.some(x => x.id === v.id)) { if (!quiet) toast('すでにキューにあります'); return; }
  state.queue.push(slim(v));
  store.set('queue', state.queue);
  if (!quiet) { renderQueue(); toast('キューに追加しました'); }
}

function renderQueue() {
  const box = $('#queue');
  box.textContent = '';
  state.queue.forEach((v, i) => {
    box.appendChild(el('div', { class: 'row' + (state.current === v.id ? ' playing' : ''), dataset: { id: v.id } }, [
      el('img', { src: v.thumb || '', alt: '' }),
      el('div', { class: 'rowcol' }, [
        el('div', { class: 'rt', text: decodeEntities(v.title), title: decodeEntities(v.title), onclick: () => play(v, 'queue') }),
        el('div', { class: 'rsub', text: decodeEntities(v.channel || '') })
      ]),
      el('button', { class: 'ract', text: '↑', title: '上へ', type: 'button', onclick: () => moveQueue(i, -1) }),
      el('button', { class: 'ract', text: '↓', title: '下へ', type: 'button', onclick: () => moveQueue(i, 1) }),
      el('button', { class: 'ract', text: '×', title: '削除', type: 'button', onclick: () => { state.queue.splice(i, 1); store.set('queue', state.queue); renderQueue(); } })
    ]));
  });
  $('#queueCount').textContent = state.queue.length ? `${state.queue.length}件` : '';
}

function moveQueue(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.queue.length) return;
  const [x] = state.queue.splice(i, 1);
  state.queue.splice(j, 0, x);
  store.set('queue', state.queue);
  renderQueue();
}

function toggleFav(v) {
  const i = state.favs.findIndex(x => x.id === v.id);
  if (i >= 0) { state.favs.splice(i, 1); toast('お気に入りから削除しました'); }
  else { state.favs.unshift(slim(v)); toast('お気に入りに追加しました'); }
  store.set('favs', state.favs);
  renderFavs();
  renderResults();
  markPlaying();
  if (state.current) $('#btnFavNow').textContent = isFav(state.current) ? '♥ お気に入り済み' : '♡ お気に入り';
}

function renderFavs() {
  const box = $('#favs');
  box.textContent = '';
  state.favs.forEach((v) => {
    box.appendChild(el('div', { class: 'row', dataset: { id: v.id } }, [
      el('img', { src: v.thumb || '', alt: '' }),
      el('div', { class: 'rowcol' }, [
        el('div', { class: 'rt', text: decodeEntities(v.title), title: decodeEntities(v.title), onclick: () => play(v, 'results') }),
        el('div', { class: 'rsub', text: decodeEntities(v.channel || '') })
      ]),
      el('button', { class: 'ract', text: '＋', title: 'キューへ', type: 'button', onclick: () => addQueue(v) }),
      el('button', { class: 'ract', text: '×', title: '削除', type: 'button', onclick: () => toggleFav(v) })
    ]));
  });
  $('#favCount').textContent = state.favs.length ? `${state.favs.length}件` : '';
}

function pushHistory(q) {
  const entry = { q, sel: { ...state.sel }, extra: $('#extra').value.trim(), opts: { ...state.opts }, t: Date.now() };
  state.history = [entry, ...state.history.filter(h => h.q !== q)].slice(0, 30);
  store.set('history', state.history);
  renderHistory();
}

function renderHistory() {
  const box = $('#hist');
  box.textContent = '';
  for (const h of state.history) {
    box.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'rowcol' }, [
        el('div', { class: 'rt', text: h.q, title: h.q, onclick: () => applyCombo(h) })
      ]),
      el('button', { class: 'ract', text: '★', title: '組み合わせとして保存', type: 'button', onclick: () => savePreset(h) })
    ]));
  }
}

function pushWatched(v) {
  state.watched = [Object.assign(slim(v), { at: Date.now() }), ...state.watched.filter(x => x.id !== v.id)].slice(0, 100);
  store.set('watched', state.watched);
  renderWatched();
  renderResults();      // 「視聴済み」の印を反映する
}

function renderWatched() {
  const box = $('#watched');
  box.textContent = '';
  for (const v of state.watched) {
    box.appendChild(el('div', { class: 'row' + (state.current === v.id ? ' playing' : ''), dataset: { id: v.id } }, [
      el('img', { src: v.thumb || '', alt: '' }),
      el('div', { class: 'rowcol' }, [
        el('div', { class: 'rt', text: decodeEntities(v.title), title: decodeEntities(v.title), onclick: () => play(v, 'results') }),
        el('div', { class: 'rsub', text: [decodeEntities(v.channel || ''), v.at ? fmtAgo(new Date(v.at).toISOString()) : ''].filter(Boolean).join(' ・ ') })
      ]),
      el('button', { class: 'ract', text: '＋', title: 'キューへ', type: 'button', onclick: () => addQueue(v) }),
      el('button', { class: 'ract', text: '×', title: '履歴から削除', type: 'button', onclick: () => {
        state.watched = state.watched.filter(x => x.id !== v.id);
        store.set('watched', state.watched);
        renderWatched(); renderResults();
      } })
    ]));
  }
  $('#watchedCount').textContent = state.watched.length ? `${state.watched.length}件` : '';
}

/* ---------------- プレイリスト ---------------- */
function saveQueueAsPlaylist() {
  if (!state.queue.length) { toast('キューが空です'); return; }
  const name = prompt('プレイリストの名前', `プレイリスト${state.playlists.length + 1}`);
  if (name === null) return;
  state.playlists.unshift({ id: uid(), name: name.trim() || `プレイリスト${state.playlists.length + 1}`, items: state.queue.map(slim) });
  store.set('playlists', state.playlists);
  renderPlaylists();
  toast('プレイリストに保存しました');
}

function loadPlaylist(p, append) {
  if (!p.items || !p.items.length) { toast('中身が空です'); return; }
  state.queue = append ? state.queue.concat(p.items.filter(v => !state.queue.some(q => q.id === v.id))) : p.items.slice();
  store.set('queue', state.queue);
  renderQueue();
  toast(append ? 'キューに追加しました' : `「${p.name}」をキューに読み込みました`);
}

function shuffleQueue() {
  if (state.queue.length < 2) { toast('キューが足りません'); return; }
  for (let i = state.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  }
  store.set('queue', state.queue);
  renderQueue();
  toast('キューをシャッフルしました');
}

function renderPlaylists() {
  const box = $('#playlists');
  box.textContent = '';
  for (const p of state.playlists) {
    box.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'rowcol' }, [
        el('div', { class: 'rt', text: p.name, title: `${p.name}（${p.items.length}件）`, onclick: () => loadPlaylist(p, false) }),
        el('div', { class: 'rsub', text: `${p.items.length}件` })
      ]),
      el('button', { class: 'ract', text: '＋', title: 'キューに追加', type: 'button', onclick: () => loadPlaylist(p, true) }),
      el('button', { class: 'ract', text: '✎', title: '名前を変更', type: 'button', onclick: () => {
        const n = prompt('名前', p.name); if (n === null) return;
        p.name = n.trim() || p.name; store.set('playlists', state.playlists); renderPlaylists();
      } }),
      el('button', { class: 'ract', text: '×', title: '削除', type: 'button', onclick: () => {
        if (!confirm(`「${p.name}」を削除しますか？`)) return;
        state.playlists = state.playlists.filter(x => x.id !== p.id);
        store.set('playlists', state.playlists); renderPlaylists();
      } })
    ]));
  }
  $('#plCount').textContent = state.playlists.length ? `${state.playlists.length}件` : '';
}

/* ---------------- 組み合わせプリセット ---------------- */
function savePreset(src) {
  const base = src || { sel: { ...state.sel }, extra: $('#extra').value.trim(), opts: { ...state.opts }, q: buildQuery() };
  const def = base.q || '無題';
  const name = prompt('この組み合わせの名前', def);
  if (name === null) return;
  state.presets.unshift({ id: uid(), name: name.trim() || def, sel: base.sel, extra: base.extra, opts: base.opts });
  store.set('presets', state.presets);
  renderPresets();
  toast('組み合わせを保存しました');
}

function applyCombo(p) {
  state.sel = { ...(p.sel || {}) };
  $('#extra').value = p.extra || '';
  Object.assign(state.opts, p.opts || {});
  store.set('sel', state.sel);
  store.set('opts', state.opts);
  syncFilters();
  renderWords();
  updateQuery();
  doSearch();
}

function renderPresets() {
  const box = $('#presets');
  box.textContent = '';
  for (const p of state.presets) {
    box.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'rowcol' }, [
        el('div', { class: 'rt', text: p.name, title: p.name, onclick: () => applyCombo(p) })
      ]),
      el('button', { class: 'ract', text: '✎', title: '名前を変更', type: 'button', onclick: () => {
        const n = prompt('名前', p.name); if (n === null) return;
        p.name = n.trim() || p.name; store.set('presets', state.presets); renderPresets();
      } }),
      el('button', { class: 'ract', text: '×', title: '削除', type: 'button', onclick: () => {
        state.presets = state.presets.filter(x => x.id !== p.id);
        store.set('presets', state.presets); renderPresets();
      } })
    ]));
  }
}

/* ---------------- 家族用セットアップリンク ----------------
   APIキーとマイワードをパスワードで「暗号化」してURLの # 以降に載せる。
   パスワード判定ではなく実際の暗号化（PBKDF2 + AES-GCM）なので、
   パスワードを知らない人はリンクを入手しても中身を取り出せない。
   # 以降はサーバーに送信されないため、通信経路にも残らない。        */
const SETUP_ITER = 310000;      // PBKDF2 の反復回数（総当たりを遅くする）
const LOCK_TRIES = 3;           // 何回間違えたらロックするか
const LOCK_MS = 10 * 60 * 1000; // ロックする時間

function cryptoOK() {
  return !!(window.crypto && window.crypto.subtle && window.isSecureContext);
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: SETUP_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function buildSetupLink(password, withKey, withWords) {
  const payload = {
    k: withKey ? state.apiKey : '',
    w: withWords ? state.words : [],
    p: withWords ? state.presets : []
  };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  const out = new Uint8Array(29 + ct.length);
  out[0] = 1;                 // 形式バージョン
  out.set(salt, 1);
  out.set(iv, 17);
  out.set(ct, 29);
  return location.origin + location.pathname + '#s=' + b64url(out);
}

/* パスワードが違えば AES-GCM の認証が失敗して例外になる */
async function openSetupPayload(password, bytes) {
  if (bytes.length < 30 || bytes[0] !== 1) throw new Error('形式が違います');
  const key = await deriveKey(password, bytes.slice(1, 17));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(17, 29) }, key, bytes.slice(29));
  return JSON.parse(new TextDecoder().decode(pt));
}

function lockInfo() {
  const l = store.get('setupLock', { fails: 0, until: 0 });
  return { fails: l.fails || 0, left: Math.max(0, (l.until || 0) - Date.now()) };
}

function applySetup(data) {
  if (data.k) { state.apiKey = data.k; store.set('apiKey', state.apiKey); }

  // 同じワードが二重に増えないように、グループ+文字列で照合して追加する。
  // プリセットがワードIDを参照しているので、IDは送り主のものをそのまま使う。
  if (Array.isArray(data.w) && data.w.length) {
    const sig = new Set(state.words.map(w => w.group + '\n' + w.text));
    const ids = new Set(state.words.map(w => w.id));
    for (const w of data.w) {
      if (!w || !w.text) continue;
      if (sig.has(w.group + '\n' + w.text)) continue;
      sig.add(w.group + '\n' + w.text);
      state.words.push({ id: ids.has(w.id) ? uid() : (w.id || uid()), text: w.text, group: w.group || '未分類' });
    }
    store.set('words', state.words);
  }
  if (Array.isArray(data.p) && data.p.length) {
    const have = new Set(state.presets.map(p => p.id));
    for (const p of data.p) if (p && !have.has(p.id)) state.presets.push(p);
    store.set('presets', state.presets);
  }

  renderWords(); renderPresets(); updateQuery();
  history.replaceState(null, '', location.pathname + location.search);
  setStatus('設定を読み込みました。ワードを選んで検索してください。');
}

/* URL に共有リンクが付いていれば読み込みダイアログを出す。
   すでにアプリを開いている状態でリンクを踏むとハッシュだけが変わり
   ページが再読込されないので、hashchange からも呼ぶ。 */
function checkSharedLink() {
  const m = /[#&]s=([A-Za-z0-9\-_]+)/.exec(location.hash || '');
  if (!m) return false;
  if (!cryptoOK()) {
    setStatus('共有リンクを開くには https:// のURLでアクセスしてください。', true);
    return true;
  }
  try { askSetupPassword(unb64url(m[1])); }
  catch (e) { setStatus('共有リンクの形式が正しくありません。', true); }
  return true;
}

function askSetupPassword(bytes) {
  openModal((body) => {
    body.appendChild(el('h3', { text: '共有された設定を読み込む' }));

    const lk = lockInfo();
    if (lk.left > 0) {
      body.appendChild(el('p', { class: 'err', text:
        `パスワードを${LOCK_TRIES}回間違えたため、あと ${Math.ceil(lk.left / 60000)} 分は試せません。` }));
      return;
    }

    body.appendChild(el('p', { text: '家族から共有された設定です。教えてもらったパスワードを入力してください。' }));
    const input = el('input', { type: 'password', placeholder: 'パスワード', autocomplete: 'off' });
    const note = el('p', { class: 'muted' });
    const btn = el('button', { class: 'primary', text: '読み込む', type: 'button' });

    const go = async () => {
      if (lockInfo().left > 0) return;
      const pw = input.value;
      if (!pw) { note.textContent = 'パスワードを入力してください。'; return; }
      btn.disabled = true; note.textContent = '確認中…';
      try {
        const data = await openSetupPayload(pw, bytes);
        store.set('setupLock', { fails: 0, until: 0 });
        applySetup(data);
        closeModal();
        toast('設定を読み込みました');
      } catch (e) {
        const fails = lockInfo().fails + 1;
        if (fails >= LOCK_TRIES) {
          store.set('setupLock', { fails: 0, until: Date.now() + LOCK_MS });
          note.textContent = `パスワードが違います。${LOCK_TRIES}回間違えたので10分間ロックされました。`;
          note.className = 'err';
          input.disabled = true;
          return;                       // ボタンは無効のまま
        }
        store.set('setupLock', { fails, until: 0 });
        note.textContent = `パスワードが違います（あと ${LOCK_TRIES - fails} 回）`;
        input.select();
        btn.disabled = false;
      }
    };

    btn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    body.appendChild(el('div', { class: 'field' }, [input, btn]));
    body.appendChild(note);
    setTimeout(() => input.focus(), 60);
  });
}

/* ---------------- フィルタUIの同期 ---------------- */
function syncFilters() {
  const o = state.opts;
  $('#fOrder').value = o.order;
  $('#fDuration').value = o.duration;
  $('#fPeriod').value = o.period;
  $('#fMax').value = String(o.max);
  $('#fCombine').value = o.combine;
  $('#fHd').checked = !!o.hd;
  $('#fCaption').checked = !!o.caption;
  $('#fJa').checked = !!o.ja;
  $('#autoNext').checked = !!o.autoNext;
  $('#repeatAll').checked = !!o.repeat;
}

function bindFilters() {
  const pairs = [
    ['#fOrder', 'order', 'value'], ['#fDuration', 'duration', 'value'],
    ['#fPeriod', 'period', 'value'], ['#fCombine', 'combine', 'value'],
    ['#fHd', 'hd', 'checked'], ['#fCaption', 'caption', 'checked'], ['#fJa', 'ja', 'checked']
  ];
  for (const [sel, key, prop] of pairs) {
    $(sel).addEventListener('change', () => {
      state.opts[key] = $(sel)[prop];
      store.set('opts', state.opts);
      updateQuery();
      if (state.lastSearch) doSearch();
    });
  }
  $('#fMax').addEventListener('change', () => {
    state.opts.max = Number($('#fMax').value);
    store.set('opts', state.opts);
    if (state.lastSearch) doSearch();
  });
  $('#autoNext').addEventListener('change', () => {
    state.opts.autoNext = $('#autoNext').checked;
    store.set('opts', state.opts);
  });
  $('#repeatAll').addEventListener('change', () => {
    state.opts.repeat = $('#repeatAll').checked;
    store.set('opts', state.opts);
  });
}

/* ---------------- モーダル（設定・使い方） ---------------- */
function openModal(build) {
  $('#modalBody').textContent = '';
  build($('#modalBody'));
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

function openSettings() {
  openModal((body) => {
    body.appendChild(el('h3', { text: '設定' }));
    body.appendChild(el('h4', { text: 'YouTube Data API v3 キー' }));
    const input = el('input', { type: 'password', value: state.apiKey, placeholder: 'AIza...', id: 'apiKeyInput', autocomplete: 'off', spellcheck: 'false' });
    body.appendChild(el('div', { class: 'field' }, [
      input,
      el('button', { class: 'mini', text: '表示', type: 'button', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } })
    ]));
    const msg = el('p', { class: 'muted', text: 'キーはこのブラウザ内（localStorage）にのみ保存されます。' });
    body.appendChild(el('div', { class: 'btnrow' }, [
      el('button', {
        class: 'primary', text: '保存', type: 'button', onclick: () => {
          state.apiKey = input.value.trim();
          store.set('apiKey', state.apiKey);
          toast('APIキーを保存しました');
          if (state.apiKey) { if (!state.results.length) $('#results').textContent = ''; setStatus(''); }
          closeModal();
        }
      }),
      el('button', {
        class: 'mini', text: '接続テスト', type: 'button', onclick: async (ev) => {
          const key = input.value.trim();
          if (!key) { msg.textContent = 'キーを入力してください。'; return; }
          const prev = state.apiKey; state.apiKey = key;
          ev.target.disabled = true; msg.textContent = 'テスト中…';
          try {
            await api('videos', { part: 'id', id: 'dQw4w9WgXcQ' }, 1);
            msg.textContent = '✓ 接続できました。このキーで検索できます。';
          } catch (e) {
            msg.textContent = '× ' + friendlyError(e);
          } finally { state.apiKey = prev; ev.target.disabled = false; }
        }
      })
    ]));
    body.appendChild(msg);

    body.appendChild(el('h4', { text: '検索キャッシュ' }));
    body.appendChild(el('p', { class: 'muted', text:
      '同じ条件で検索し直したとき、ここで決めた時間内ならAPIを使わずに前の結果を表示します。長くするほど1日の検索回数を節約できますが、新しい動画は出てきにくくなります（↻ 再取得でいつでも最新を取得できます）。' }));
    const cacheSel = el('select', { id: 'fCache' }, [
      el('option', { value: '0', text: 'キャッシュしない' }),
      el('option', { value: '30', text: '30分' }),
      el('option', { value: '180', text: '3時間' }),
      el('option', { value: '1440', text: '24時間' }),
      el('option', { value: '10080', text: '1週間' })
    ]);
    cacheSel.value = String(state.opts.cacheMin);
    cacheSel.addEventListener('change', () => {
      state.opts.cacheMin = Number(cacheSel.value);
      store.set('opts', state.opts);
      toast('キャッシュの保持時間を変更しました');
    });
    const cacheCount = Object.keys(store.get('cache', {})).length;
    body.appendChild(el('div', { class: 'btnrow' }, [
      el('label', { class: 'chk mini' }, ['保持時間 ', cacheSel]),
      el('span', { class: 'muted', text: `保存中 ${cacheCount} 件` })
    ]));

    body.appendChild(el('h4', { text: '非表示チャンネル' }));
    if (!state.blocked.length) {
      body.appendChild(el('p', { class: 'muted', text: '非表示にしたチャンネルはありません。検索結果の 🚫 ボタンで追加できます。' }));
    } else {
      const list = el('div', { class: 'list' });
      const drawBlocked = () => {
        list.textContent = '';
        for (const c of state.blocked) {
          list.appendChild(el('div', { class: 'row' }, [
            el('div', { class: 'rowcol' }, [el('div', { class: 'rt', text: decodeEntities(c.title) })]),
            el('button', { class: 'ract', text: '×', title: '解除', type: 'button', onclick: () => {
              state.blocked = state.blocked.filter(x => x.id !== c.id);
              store.set('blocked', state.blocked);
              drawBlocked(); renderResults();
              toast('非表示を解除しました');
            } })
          ]));
        }
        if (!state.blocked.length) list.appendChild(el('p', { class: 'muted', text: 'すべて解除しました。' }));
      };
      drawBlocked();
      body.appendChild(list);
    }

    body.appendChild(el('h4', { text: '家族用セットアップリンク' }));
    if (!cryptoOK()) {
      body.appendChild(el('p', { class: 'muted', text:
        'この機能は https:// か localhost で開いたときだけ使えます（暗号化のため）。' }));
    } else {
      body.appendChild(el('p', { class: 'muted', text:
        'APIキーとマイワードをパスワードで暗号化したリンクを作ります。家族はリンクを開いてパスワードを入れるだけで設定が完了します。パスワードを知らない人はリンクを入手しても中身を取り出せません。' }));

      const pw = el('input', { type: 'password', placeholder: 'パスワード', autocomplete: 'new-password' });
      const chkKey = el('input', { type: 'checkbox', checked: true });
      const chkWords = el('input', { type: 'checkbox', checked: true });
      const out = el('textarea', { class: 'linkout hidden', readonly: true, rows: '3' });
      const note = el('p', { class: 'muted' });

      const make = async (ev) => {
        const p = pw.value.trim();
        if (p.length < 4) { note.textContent = 'パスワードは4文字以上にしてください。'; return; }
        if (chkKey.checked && !state.apiKey) { note.textContent = 'APIキーが未設定です。先に上の欄で保存してください。'; return; }
        ev.target.disabled = true;
        note.textContent = '暗号化しています…';
        try {
          const link = await buildSetupLink(p, chkKey.checked, chkWords.checked);
          out.value = link;
          out.classList.remove('hidden');
          note.textContent = 'リンクを作成しました。リンクとパスワードは別々の手段で伝えてください（例：リンクはLINE、パスワードは口頭）。'
            + (link.length > 7000 ? ' ※リンクが長すぎます。ワードを減らすか「マイワードを含める」を外してください。' : '');
        } catch (e) {
          note.textContent = '作成に失敗しました: ' + e.message;
        } finally {
          ev.target.disabled = false;
        }
      };

      body.appendChild(el('div', { class: 'field' }, [
        pw,
        el('button', { class: 'mini', text: '表示', type: 'button',
          onclick: () => { pw.type = pw.type === 'password' ? 'text' : 'password'; } })
      ]));
      body.appendChild(el('div', { class: 'btnrow' }, [
        el('label', { class: 'chk mini' }, [chkKey, ' APIキーを含める']),
        el('label', { class: 'chk mini' }, [chkWords, ' マイワード・組み合わせを含める'])
      ]));
      body.appendChild(el('div', { class: 'btnrow' }, [
        el('button', { class: 'primary', text: 'リンクを作成', type: 'button', onclick: make }),
        el('button', { class: 'mini', text: 'コピー', type: 'button', onclick: async () => {
          if (!out.value) { note.textContent = '先にリンクを作成してください。'; return; }
          try { await navigator.clipboard.writeText(out.value); toast('リンクをコピーしました'); }
          catch (e) { out.select(); note.textContent = 'コピーできなかったので、選択してコピーしてください。'; }
        } })
      ]));
      body.appendChild(out);
      body.appendChild(note);
    }

    body.appendChild(el('h4', { text: 'データ' }));
    body.appendChild(el('p', { class: 'muted', text: `ワード ${state.words.length} 件 / 組み合わせ ${state.presets.length} 件 / お気に入り ${state.favs.length} 件` }));
    const fileIn = el('input', { type: 'file', accept: '.json', class: 'hidden' });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (Array.isArray(data.words)) { state.words = data.words; store.set('words', state.words); }
        if (Array.isArray(data.presets)) { state.presets = data.presets; store.set('presets', state.presets); }
        if (Array.isArray(data.favs)) { state.favs = data.favs; store.set('favs', state.favs); }
        if (Array.isArray(data.queue)) { state.queue = data.queue; store.set('queue', state.queue); }
        if (Array.isArray(data.playlists)) { state.playlists = data.playlists; store.set('playlists', state.playlists); }
        if (Array.isArray(data.blocked)) { state.blocked = data.blocked; store.set('blocked', state.blocked); }
        if (data.opts) { Object.assign(state.opts, data.opts); store.set('opts', state.opts); }
        renderWords(); renderPresets(); renderFavs(); renderQueue(); renderPlaylists(); syncFilters(); updateQuery();
        toast('読み込みました');
        closeModal();
      } catch (e) { alert('ファイルを読み込めませんでした: ' + e.message); }
    });
    body.appendChild(fileIn);
    body.appendChild(el('div', { class: 'btnrow' }, [
      el('button', {
        class: 'mini', text: '書き出し (JSON)', type: 'button', onclick: () => {
          const data = {
            words: state.words, presets: state.presets, favs: state.favs,
            queue: state.queue, playlists: state.playlists, blocked: state.blocked, opts: state.opts
          };
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
          const a = el('a', { href: url, download: `myplayer-backup-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }),
      el('button', { class: 'mini', text: '読み込み (JSON)', type: 'button', onclick: () => fileIn.click() }),
      el('button', {
        class: 'mini', text: '検索キャッシュを削除', type: 'button', onclick: () => {
          store.set('cache', {}); toast('キャッシュを削除しました');
        }
      }),
      el('button', {
        class: 'mini', text: 'すべてのデータを削除', type: 'button', onclick: () => {
          if (!confirm('ワード・組み合わせ・お気に入り・APIキーをすべて削除します。よろしいですか？')) return;
          try { Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => localStorage.removeItem(k)); } catch (e) { }
          location.reload();
        }
      })
    ]));
  });
}

function openHelp() {
  openModal((body) => {
    body.innerHTML = `
      <h3>使い方</h3>
      <ol>
        <li><b>マイワードを登録</b>：左の入力欄に好きな言葉を入れて ＋（「作業用BGM, ジャズ, 1時間」のようにカンマ区切りで一気に追加できます）。グループ名を入れると分類されます。</li>
        <li><b>クリックで組み合わせ</b>：ワードをクリックすると選択（AND）、Shift+クリックで除外（−）。選択した内容が上の「検索クエリ」に反映されます。</li>
        <li><b>検索</b>：検索ボタン、または上の入力欄で <kbd>Enter</kbd>。並び順・長さ・期間などで絞り込めます。</li>
        <li><b>視聴</b>：サムネイルかタイトルをクリックでその場で再生。「＋ キュー」で順番に溜めておけば、連続再生がオンのとき自動で次に進みます。</li>
        <li><b>よく使う条件は保存</b>：「今の条件を保存」で選択ワード＋絞り込みをまとめて保存。次回はクリック1回で同じ検索ができます。</li>
      </ol>
      <h4>APIキーについて</h4>
      <ol>
        <li><a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud コンソール</a>でプロジェクトを作成</li>
        <li>「YouTube Data API v3」を有効化</li>
        <li>「認証情報」→「APIキーを作成」してコピー</li>
        <li>⚙ 設定 に貼り付けて保存</li>
      </ol>
      <p>無料枠は<b>1日10,000ユニット</b>。検索1回=100ユニット＋詳細取得1ユニットなので、1日およそ<b>100回</b>検索できます。同じ条件の再検索は30分間キャッシュを使うのでユニットを消費しません。右上に本日の推定消費量が出ます。</p>
      <h4>スマホ（Android / iPhone）で使う</h4>
      <ul>
        <li>左上の <b>☰</b> か右下の <b>ワード</b> ボタンでマイワードを開き、選び終えたら下の「この条件で検索」。</li>
        <li>ワードの<b>長押し</b>で除外（PCの Shift+クリックと同じ）。</li>
        <li>再生中はプレーヤーが画面上部に固定されるので、下の一覧をスクロールしながら次の動画を選べます。</li>
        <li><b>ホーム画面に追加</b>すると全画面のアプリとして起動します。iPhone は Safari の共有ボタン →「ホーム画面に追加」、Android は Chrome のメニュー →「ホーム画面に追加」。</li>
        <li>PCと同じWi-Fiにつないで、PC側で <code>serve-lan.cmd</code> を実行すると、表示されたURL（例 http://192.168.x.x:8787/）でスマホから開けます。</li>
      </ul>
      <h4>プレイリストと連続再生</h4>
      <ul>
        <li>キューに動画を貯めたら「名前を付けて保存」で<b>プレイリスト</b>になります。次回はプレイリスト名をタップでキューに読み込み、＋ で追記できます。</li>
        <li><b>シャッフル</b>でキューの順番をランダムに並べ替えます。</li>
        <li>プレーヤーの<b>連続再生</b>で次の動画へ自動で進み、<b>リピート</b>を入れると最後まで行ったら先頭に戻ります。</li>
      </ul>
      <h4>視聴履歴とチャンネルの整理</h4>
      <ul>
        <li>一度再生した動画は検索結果に「<b>視聴済み</b>」と表示され、サムネイルが暗くなります。サイドバーの<b>視聴履歴</b>からいつでも再生できます。</li>
        <li>動画の<b>チャンネル名</b>をタップすると、そのチャンネルの動画だけを検索します。解除は検索クエリ欄のチャンネル名（✕付き）をタップ。</li>
        <li><b>🚫</b> ボタンでそのチャンネルを今後の検索結果から隠せます。解除は ⚙設定 の「非表示チャンネル」から。</li>
      </ul>
      <h4>家族と設定を共有する</h4>
      <p>⚙設定 →「家族用セットアップリンク」でパスワードを決めてリンクを作ります。家族はそのリンクを開いてパスワードを入れるだけで、APIキーとマイワードが入ります。中身はパスワードで暗号化されているので、リンクだけ見られても設定は取り出せません。パスワードを3回間違えると10分間ロックされます。</p>
      <p>リンクとパスワードは別々の手段で伝えてください（例：リンクはLINE、パスワードは口頭）。</p>
      <h4>ショートカット（PC）</h4>
      <ul>
        <li><kbd>/</kbd> … 検索欄へ移動</li>
        <li><kbd>Enter</kbd> … 検索（検索欄にフォーカス中）</li>
        <li><kbd>Esc</kbd> … ダイアログ／プレーヤーを閉じる</li>
      </ul>
      <h4>データの保存場所</h4>
      <p>すべてこのブラウザの localStorage に保存されます（サーバーには何も送りません）。別のPCに移すときは設定の「書き出し／読み込み」を使ってください。</p>`;
  });
}

/* ---------------- イベント配線 ---------------- */
function wire() {
  $('#btnSearch').addEventListener('click', () => doSearch());
  $('#extra').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  $('#extra').addEventListener('input', () => updateQuery());
  $('#btnRefresh').addEventListener('click', () => doSearch({ force: true }));
  $('#btnMore').addEventListener('click', () => doSearch({ append: true }));
  $('#btnQueueAll').addEventListener('click', () => {
    visibleResults().forEach(v => addQueue(v, true));
    renderQueue();
    toast('表示中の動画をキューに追加しました');
  });
  $('#btnMenu').addEventListener('click', () => {
    if (isMobile()) { drawerOpen() ? closeDrawer() : openDrawer(); }
    else document.body.classList.toggle('nosidebar');
  });
  $('#fabWords').addEventListener('click', openDrawer);
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);
  $('#backdrop').addEventListener('click', closeDrawer);
  $('#btnDrawerSearch').addEventListener('click', () => { closeDrawer(); doSearch(); });
  $('#btnFilters').addEventListener('click', () => {
    const on = document.body.classList.toggle('showfilters');
    $('#btnFilters').textContent = on ? '絞り込み ▴' : '絞り込み ▾';
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnHelp').addEventListener('click', openHelp);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  $('#btnEditWords').addEventListener('click', () => {
    const on = document.body.classList.toggle('editwords');
    $('#btnEditWords').textContent = on ? '完了' : '編集';
  });

  $('#addWord').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#newWord').value.trim();
    if (!t) return;
    addWords(t, $('#newGroup').value);
    $('#newWord').value = '';
    $('#newWord').focus();
  });

  /* 長押しで除外（タッチ端末には Shift キーがないため） */
  let lpTimer = null, lpFired = false, lpX = 0, lpY = 0;
  const lpCancel = () => { clearTimeout(lpTimer); lpTimer = null; };
  $('#words').addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || document.body.classList.contains('editwords')) return;
    if (e.target.classList.contains('cedit') || e.target.classList.contains('cdel')) return;
    lpFired = false; lpX = e.clientX; lpY = e.clientY;
    const id = chip.dataset.id;
    lpTimer = setTimeout(() => {
      lpFired = true;
      if (state.sel[id] === 'ex') delete state.sel[id]; else state.sel[id] = 'ex';
      afterSelChange();
      if (navigator.vibrate) navigator.vibrate(15);
    }, 450);
  });
  $('#words').addEventListener('pointermove', (e) => {
    if (lpTimer && (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10)) lpCancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => $('#words').addEventListener(ev, lpCancel));
  $('#words').addEventListener('contextmenu', (e) => { if (e.target.closest('.chip')) e.preventDefault(); });

  $('#words').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (lpFired) { lpFired = false; return; }   // 長押し直後のクリックは無視
    const id = chip.dataset.id;
    const w = state.words.find(x => x.id === id);
    if (!w) return;

    if (e.target.classList.contains('cdel')) {
      if (!confirm(`「${w.text}」を削除しますか？`)) return;
      state.words = state.words.filter(x => x.id !== id);
      delete state.sel[id];
      store.set('words', state.words); store.set('sel', state.sel);
      renderWords(); updateQuery();
      return;
    }
    if (e.target.classList.contains('cedit')) {
      const t = prompt('ワード', w.text);
      if (t === null) return;
      const g = prompt('グループ', w.group);
      if (g === null) return;
      w.text = t.trim() || w.text;
      w.group = g.trim() || w.group;
      store.set('words', state.words);
      renderWords(); updateQuery();
      return;
    }
    if (document.body.classList.contains('editwords')) return;

    const cur = state.sel[id];
    if (e.shiftKey) {
      if (cur === 'ex') delete state.sel[id]; else state.sel[id] = 'ex';
    } else {
      if (cur === 'in') delete state.sel[id]; else state.sel[id] = 'in';
    }
    afterSelChange();
  });

  $('#btnClearSel').addEventListener('click', () => { state.sel = {}; afterSelChange(); });
  $('#btnSavePreset').addEventListener('click', () => savePreset(null));
  $('#btnClearQueue').addEventListener('click', () => {
    if (!state.queue.length || !confirm('キューを空にしますか？')) return;
    state.queue = []; store.set('queue', state.queue); renderQueue();
  });
  $('#btnSaveQueue').addEventListener('click', saveQueueAsPlaylist);
  $('#btnShuffleQueue').addEventListener('click', shuffleQueue);
  $('#btnClearWatched').addEventListener('click', () => {
    if (!state.watched.length || !confirm('視聴履歴を消去しますか？')) return;
    state.watched = []; store.set('watched', state.watched); renderWatched(); renderResults();
  });
  $('#chanChip').addEventListener('click', clearChannelFilter);
  $('#btnClearHist').addEventListener('click', () => {
    state.history = []; store.set('history', state.history); renderHistory();
  });

  $('#btnPrev').addEventListener('click', () => { const v = neighbor(-1); if (v) play(v, state.ctx); else toast('前の動画がありません'); });
  $('#btnNext').addEventListener('click', () => { const v = neighbor(1); if (v) play(v, state.ctx); else toast('次の動画がありません'); });
  $('#btnCloseTheater').addEventListener('click', closeTheater);
  $('#btnFavNow').addEventListener('click', () => {
    const list = state.ctx === 'queue' ? state.queue : state.results;
    const v = list.find(x => x.id === state.current) || state.favs.find(x => x.id === state.current);
    if (v) toggleFav(v);
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (!$('#modal').classList.contains('hidden')) closeModal();
      else if (drawerOpen()) closeDrawer();
      else if (!$('#theater').classList.contains('hidden')) closeTheater();
    } else if (e.key === '/' && !typing) {
      e.preventDefault(); $('#extra').focus();
    }
  });
}

/* ---------------- 起動 ---------------- */
function init() {
  checkStorage();
  state.apiKey = store.get('apiKey', '');
  state.words = store.get('words', []);
  state.sel = store.get('sel', {});
  state.presets = store.get('presets', []);
  state.history = store.get('history', []);
  state.queue = store.get('queue', []);
  state.favs = store.get('favs', []);
  state.watched = store.get('watched', []);
  state.playlists = store.get('playlists', []);
  state.blocked = store.get('blocked', []);
  Object.assign(state.opts, store.get('opts', {}));

  seedWordsIfEmpty();
  syncFilters();
  bindFilters();
  wire();
  renderWords();
  renderPresets();
  renderQueue();
  renderPlaylists();
  renderFavs();
  renderWatched();
  renderHistory();
  renderQuota();
  renderChanChip();
  updateQuery();

  setTopHeight();
  window.addEventListener('resize', () => {
    setTopHeight();
    if (!isMobile()) closeDrawer();
  });
  window.addEventListener('orientationchange', () => setTimeout(setTopHeight, 200));

  // PWA（ホーム画面に追加／オフラインでの起動）。https か localhost でのみ有効
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 未対応環境では無視 */ });
    });
  }

  if (!storageOK) {
    setStatus('このページでは設定を保存できません（localStorage が使えない状態です）。付属の serve.cmd で http://localhost から開くと保存できます。', true);
  }
  // 家族から共有されたセットアップリンク（#s=...）で開かれた場合
  checkSharedLink();
  window.addEventListener('hashchange', checkSharedLink);

  if (!state.apiKey) renderSetup();
  else setStatus('ワードを選んで検索してください。');
}

document.addEventListener('DOMContentLoaded', init);
