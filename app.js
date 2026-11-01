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
  combine: 'and', hd: false, caption: false, ja: true, autoNext: true
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

/* キャッシュ（同じ条件の再検索でAPIを消費しないため・30分） */
const CACHE_TTL = 30 * 60 * 1000;
function cacheGet(key) {
  const c = store.get('cache', {});
  const e = c[key];
  if (!e || Date.now() - e.t > CACHE_TTL) return null;
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
  return p;
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

function card(v) {
  const thumb = el('div', { class: 'thumb', onclick: () => play(v, 'results') }, [
    el('img', { src: v.thumb || '', alt: '', loading: 'lazy' }),
    v.live ? el('span', { class: 'live', text: 'LIVE' }) : null,
    v.dur ? el('span', { class: 'dur', text: v.dur }) : null,
    el('span', { class: 'playicon', text: '▶' })
  ]);

  const favBtn = el('button', {
    class: 'mini fav' + (isFav(v.id) ? ' on' : ''),
    text: isFav(v.id) ? '♥' : '♡',
    title: 'お気に入り',
    type: 'button',
    onclick: (ev) => { ev.stopPropagation(); toggleFav(v); }
  });

  return el('article', { class: 'card' + (state.current === v.id ? ' playing' : ''), dataset: { id: v.id } }, [
    thumb,
    el('div', { class: 'cmeta' }, [
      el('h3', { class: 'ctitle', text: decodeEntities(v.title), title: decodeEntities(v.title), onclick: () => play(v, 'results') }),
      el('div', { class: 'csub' }, [
        decodeEntities(v.channel || ''),
        v.views ? ` ・ ${fmtCount(v.views)}回` : '',
        v.published ? ` ・ ${fmtAgo(v.published)}` : ''
      ].join('')),
      v.embeddable === false ? el('div', { class: 'noembed', text: '※ 埋め込み再生が制限された動画です' }) : null
    ]),
    el('div', { class: 'cacts' }, [
      el('button', { class: 'mini', text: '▶ 再生', type: 'button', onclick: () => play(v, 'results') }),
      el('button', { class: 'mini', text: '＋ キュー', type: 'button', onclick: () => addQueue(v) }),
      favBtn,
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

function renderResults() {
  const box = $('#results');
  box.textContent = '';
  if (!state.results.length) return;
  const frag = document.createDocumentFragment();
  for (const v of state.results) frag.appendChild(card(v));
  box.appendChild(frag);
  $('#btnQueueAll').classList.toggle('hidden', !state.results.length);
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
  const list = state.ctx === 'queue' ? state.queue : state.results;
  if (!list.length) return null;
  const i = list.findIndex(v => v.id === state.current);
  if (i < 0) return list[0];
  return list[i + dir] || null;
}

function onEnded() {
  if (!state.opts.autoNext) return;
  const nx = neighbor(1);
  if (nx) play(nx, state.ctx);
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
  return { id: v.id, title: v.title, channel: v.channel, thumb: v.thumb, dur: v.dur, views: v.views, published: v.published, embeddable: v.embeddable };
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
  const w = store.get('watched', []);
  store.set('watched', [slim(v), ...w.filter(x => x.id !== v.id)].slice(0, 50));
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
        if (data.opts) { Object.assign(state.opts, data.opts); store.set('opts', state.opts); }
        renderWords(); renderPresets(); renderFavs(); renderQueue(); syncFilters(); updateQuery();
        toast('読み込みました');
        closeModal();
      } catch (e) { alert('ファイルを読み込めませんでした: ' + e.message); }
    });
    body.appendChild(fileIn);
    body.appendChild(el('div', { class: 'btnrow' }, [
      el('button', {
        class: 'mini', text: '書き出し (JSON)', type: 'button', onclick: () => {
          const data = { words: state.words, presets: state.presets, favs: state.favs, queue: state.queue, opts: state.opts };
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
    state.results.forEach(v => addQueue(v, true));
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
  Object.assign(state.opts, store.get('opts', {}));

  seedWordsIfEmpty();
  syncFilters();
  bindFilters();
  wire();
  renderWords();
  renderPresets();
  renderQueue();
  renderFavs();
  renderHistory();
  renderQuota();
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
  if (!state.apiKey) renderSetup();
  else setStatus('ワードを選んで検索してください。');
}

document.addEventListener('DOMContentLoaded', init);
