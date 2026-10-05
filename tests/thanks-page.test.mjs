// Eve Voice の購入完了ページ（/evevoice/thanks/）と、お問い合わせフォームの番号の差し込みのテスト（追加の npm パッケージなし）
//
//   node --test tests/thanks-page.test.mjs        # リポジトリのルートで
//
// 外部への通信はしない。fetch・タイマー・DOM は偽物に差し替える。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const require = createRequire(import.meta.url);
const T = require('../assets/eve-voice-thanks.js');

const PAGE = read('evevoice/thanks/index.html');
const JS = read('assets/eve-voice-thanks.js');
const LIVE_ID = 'cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ0123456789abcdefghijKLMN';
const TEST_ID = 'cs_test_a1B2c3D4e5F6g7H8i9J0';
const REF = 'Ab3dEf7h';
const CONTACT = '/contact/?subject=evevoice';

// --- 純粋な関数 ---------------------------------------------------------------------

test('maskEmail: ローカル部の先頭2文字（3文字以下なら1文字）＋***、ドメインは伏せない・コードポイント単位', () => {
  const table = [
    ['a@x.jp', 'a***@x.jp'],
    ['ab@example.com', 'a***@example.com'],
    ['abc@example.com', 'a***@example.com'],
    ['abcd@example.com', 'ab***@example.com'],
    ['daruma.taro@gmail.com', 'da***@gmail.com'],
    ['very.long.local.part.name+tag@sub.example.co.jp', 've***@sub.example.co.jp'],
    ['太郎さん@example.jp', '太郎***@example.jp'],
    ['😀😀😀😀@x.jp', '😀😀***@x.jp'],
    ['😀😀@x.jp', '😀***@x.jp'],
    ['"a@b"@x.jp', '"a***@x.jp'],
  ];
  for (const [input, expected] of table) assert.equal(T.maskEmail(input), expected, input);
  for (const bad of [null, undefined, 42, '', 'no-at-sign', 'trailing@']) assert.equal(T.maskEmail(bad), null, String(bad));
  // サーバーの伏せた形（4文字以上のローカル部）をもう一度伏せても変わらない
  assert.equal(T.maskEmail('da***@gmail.com'), 'da***@gmail.com');
});

test('typoHint: 主な受信先に近い打ち間違いだけ候補を出し、実在する近いドメインには出さない', () => {
  const hints = {
    'taro@gmial.com': 'gmail.com',
    'taro@gmai.com': 'gmail.com',
    'taro@gmail.co': 'gmail.com',
    'taro@gmail.cpm': 'gmail.com',
    'taro@gmali.con': 'gmail.com',
    'taro@yahoo.co.jpp': 'yahoo.co.jp',
    'taro@yaho.co.jp': 'yahoo.co.jp',
    'taro@icloud.co': 'icloud.com',
    'taro@iclod.com': 'icloud.com',
    'taro@docomo.ne.jo': 'docomo.ne.jp',
    'taro@ezweb.ne.j': 'ezweb.ne.jp',
    'taro@softbank.ne.j': 'softbank.ne.jp',
    'taro@outlok.jp': 'outlook.jp',
    'taro@outlook.cm': 'outlook.com',
    'taro@hotmail.co.jo': 'hotmail.co.jp',
    'taro@me.co': 'me.com',
    'taro@au.cm': 'au.com',
    'da***@gmial.com': 'gmail.com', // 伏せた形でもドメインで判定できる
  };
  for (const [email, suggestion] of Object.entries(hints)) {
    const hint = T.typoHint(email);
    assert.ok(hint, email);
    assert.equal(hint.suggestion, suggestion, email);
    assert.equal(hint.typed, email.split('@').pop());
  }
  assert.equal(T.typoHint('Taro@GMIAL.com').typed, 'GMIAL.com');
  for (const domain of T.COMMON_DOMAINS) assert.equal(T.typoHint(`taro@${domain}`), null, domain);
  assert.equal(T.typoHint('taro@GMAIL.COM'), null);
  for (const domain of [...T.REAL_NEARBY_DOMAINS, 'example.com', 'eivrad.com', 'proton.me', 'nifty.com', 'ocn.ne.jp', 'outlook.co.jp']) {
    assert.equal(T.typoHint(`taro@${domain}`), null, domain);
  }
  for (const bad of [null, '', 'no-at-sign', 'taro@']) assert.equal(T.typoHint(bad), null, String(bad));
});

test('editDistance: 入れ替えは1回', () => {
  assert.equal(T.editDistance('gmial.com', 'gmail.com'), 1);
  assert.equal(T.editDistance('gmail.com', 'gmail.com'), 0);
  assert.equal(T.editDistance('aol.com', 'au.com'), 2);
  assert.equal(T.editDistance('', 'abc'), 3);
});

test('contactHref: 英数字8文字の番号だけ # 以下に付け、それ以外は付けない', () => {
  assert.equal(T.contactHref(REF), `${CONTACT}#ref=${REF}`);
  for (const bad of [null, undefined, '', 'abc', 'Ab3dEf7h9', 'Ab3d-f7h', 'Ab3dEf7 ', '<script>', 'taro@x.jp', 12345678]) {
    assert.equal(T.contactHref(bad), CONTACT, String(bad));
  }
});

test('nextDelay: 2,2,3,3,5,5,10,10,15,15,30 秒・最初と合わせて12回で止まる・pollAfter が null なら止まる', () => {
  const seq = [];
  for (let n = 1; n <= 20; n++) seq.push(T.nextDelay(n, 1));
  assert.deepEqual(seq.slice(0, 11), [2000, 2000, 3000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 30000]);
  assert.ok(seq.slice(11).every((d) => d === null));
  assert.equal(T.MAX_CHECKS, 12);
  // サーバーの pollAfter（3秒）より短くはしない
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => T.nextDelay(n, 3)), [3000, 3000, 3000, 3000, 5000]);
  const total = [...Array(11).keys()].reduce((sum, i) => sum + T.nextDelay(i + 1, 3), 0);
  assert.ok(total <= 120000, `合計 ${total}ms は約2分以内`);
  for (const stop of [null, undefined, 0, -1, 'x']) assert.equal(T.nextDelay(1, stop), null, String(stop));
  assert.equal(T.nextDelay(0, 3), null);
});

test('parseId: cs_live_ / cs_test_ と英数字10〜200文字だけ', () => {
  assert.equal(T.parseId(LIVE_ID), LIVE_ID);
  assert.equal(T.parseId(TEST_ID), TEST_ID);
  for (const bad of [null, undefined, 1, '', 'cs_live_', 'cs_live_short', 'pi_a1B2c3D4e5F6g7H8', 'cs_prod_a1B2c3D4e5F6g7H8',
    `cs_live_${'a'.repeat(201)}`, 'cs_live_a1B2c3D4e5-F6g7H8', 'cs_live_a1B2c3D4e5F6g7H8 ', ' cs_live_a1B2c3D4e5F6g7H8',
    'cs_live_a1B2c3D4e5F6g7H8\n']) {
    assert.equal(T.parseId(bad), null, JSON.stringify(bad));
  }
  assert.equal(T.parseId(`cs_live_${'a'.repeat(200)}`), `cs_live_${'a'.repeat(200)}`);
});

test('apiUrl・retryAfterSeconds', () => {
  assert.equal(T.apiUrl('eivrad.com'), 'https://api.eivrad.com/v1/orders/status');
  assert.equal(T.apiUrl('localhost'), 'http://localhost:8787/v1/orders/status');
  assert.equal(T.apiUrl('127.0.0.1'), 'http://localhost:8787/v1/orders/status');
  assert.equal(T.retryAfterSeconds('30'), 30);
  assert.equal(T.retryAfterSeconds(null), 60); // CORS で読めないときは60秒
  assert.equal(T.retryAfterSeconds('abc'), 60);
  assert.equal(T.retryAfterSeconds('99999'), 300);
});

test('normalizeOrder: 決まった形だけを受け取り、値を範囲に収める', () => {
  assert.equal(T.normalizeOrder(null), null);
  assert.equal(T.normalizeOrder({ status: 'delivered' }), null);
  const o = T.normalizeOrder({ status: 'sent', email: 'taro@example.com', emailMasked: 'ta***@example.com', fullSeconds: 99999,
    free: 'yes', shortRef: 'bad-ref!', reason: 'whatever', pollAfter: -1, licenseKey: 'EV1-XXXX' });
  assert.deepEqual(o, { status: 'sent', email: 'taro@example.com', emailMasked: 'ta***@example.com', fullSeconds: 3600,
    free: false, shortRef: null, reason: null, pollAfter: null });
  // 伏せた形が無ければ、ページの側で伏せる
  assert.equal(T.normalizeOrder({ status: 'sent', email: 'taro@example.com', fullSeconds: 10 }).emailMasked, 'ta***@example.com');
  // アドレスが無ければ全体の表示時間は0
  assert.equal(T.normalizeOrder({ status: 'unknown', email: null, fullSeconds: 100 }).fullSeconds, 0);
});

test('view: 状態ごとの文言・ボタン・確認欄', () => {
  const order = (over = {}) => ({ status: 'pending', free: false, shortRef: REF, reason: null, ...over });
  let v = T.view({ kind: 'loading' });
  assert.deepEqual(v.messages, [T.TEXT.loading]);
  assert.equal(v.check, null);

  for (const kind of ['noid', 'notfound']) {
    v = T.view({ kind });
    assert.equal(v.heading, 'ご注文の情報を表示できませんでした');
    assert.equal(v.contact, CONTACT);
    assert.equal(v.address, null);
    assert.equal(v.check, null);
    assert.equal(v.retry, false);
  }

  v = T.view({ kind: 'unavailable' });
  assert.deepEqual(v.messages, ['ただいま送信先を確認できません。', T.TEXT.generic]);
  assert.equal(v.retry, true);

  v = T.view({ kind: 'order', order: order(), address: 'taro@example.com', full: true });
  assert.deepEqual(v.messages, ['送信の準備をしています…（通常は1分以内に送ります）']);
  assert.equal(v.windowNote, 'セキュリティのため、メールアドレスの全体は決済の完了から60分間だけ表示します。');
  assert.equal(v.check.href, `${CONTACT}#ref=${REF}`);
  assert.match(v.check.note, /^お問い合わせ番号（Ab3dEf7h）がフォームに入ります。/);
  assert.match(v.check.note, /カードの下4桁/);
  assert.equal(v.check.typo, null);
  assert.equal(v.retry, false);
  assert.equal(v.lead, 'Eve Voice をお買い上げいただき、ありがとうございます。');

  v = T.view({ kind: 'order', order: order(), address: 'taro@example.com', full: true, stalled: true });
  assert.equal(v.retry, true);
  assert.equal(v.messages.length, 2);

  v = T.view({ kind: 'order', order: order({ reason: 'awaiting_payment' }), address: 'taro@example.com', full: true });
  assert.match(v.messages[0], /お支払いの完了を確認しています/);

  v = T.view({ kind: 'order', order: order({ status: 'sent' }), address: 'ta***@gmial.com', full: false });
  assert.deepEqual(v.messages, ['送信しました。差出人は license@send.eivrad.com、件名は「Eve Voice ライセンスキー」です。']);
  assert.equal(v.windowNote, '決済の完了から60分を過ぎたため、一部を伏せて表示しています。');
  assert.equal(v.check.typo, '「gmial.com」は「gmail.com」の誤りではありませんか。');
  assert.equal(v.contact, null);
  assert.ok(!v.messages.join('').includes('届きました'), '「届きました」とは言わない');

  v = T.view({ kind: 'order', order: order({ status: 'failed', reason: 'address_rejected' }), address: 'taro@example', full: true });
  assert.equal(v.messages[0], 'このメールアドレスには送れませんでした。キーを自動でお送りできませんでした。お手数ですが、下のボタンからご連絡ください。お支払いを確認のうえ、キーをお送りします。');
  assert.equal(v.contact, `${CONTACT}#ref=${REF}`);
  assert.ok(v.check);

  v = T.view({ kind: 'order', order: order({ status: 'failed', reason: 'retry_exhausted' }), address: 'taro@example.com', full: true });
  assert.ok(v.messages[0].startsWith('キーを自動でお送りできませんでした。'));

  v = T.view({ kind: 'order', order: order({ status: 'failed', reason: 'not_issued', free: true }), address: 'taro@example.com', full: true });
  assert.equal(v.lead, 'Eve Voice の無料ライセンスをお申し込みいただき、ありがとうございます。');
  assert.match(v.messages[0], /お申し込みを確認のうえ/);
  assert.doesNotMatch(v.check.note, /カード/);
  assert.equal(v.free, true);

  v = T.view({ kind: 'order', order: order({ status: 'failed', reason: 'no_address', shortRef: null }), address: null, full: false });
  assert.equal(v.check, null);
  assert.equal(v.contact, CONTACT);

  v = T.view({ kind: 'order', order: order({ status: 'unknown' }), address: null, full: false });
  assert.deepEqual(v.messages, ['この注文のキーの状態は、このページでは表示できません。お問い合わせください。']);
  assert.equal(v.check, null);
  assert.equal(v.windowNote, null);
  assert.equal(v.contact, `${CONTACT}#ref=${REF}`);

  v = T.view({ kind: 'order', order: order({ status: 'sent' }), address: 'taro@example.com', full: true, stale: true });
  assert.equal(v.retry, true);
  assert.equal(v.messages.at(-1), T.TEXT.stale);
});

// --- ページの動き（偽物の DOM・fetch・タイマー） ---------------------------------------------

const PAGE_IDS = [...PAGE.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const PAGE_HIDDEN = new Set([...PAGE.matchAll(/<[a-z]+[^>]*\sid="([^"]+)"[^>]*\shidden[\s>]/g)].map((m) => m[1]));

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.hidden = PAGE_HIDDEN.has(id);
    this.disabled = false;
    this.attrs = {};
    this.listeners = {};
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  replaceChildren(...nodes) { this.replaced = (this.replaced || 0) + 1; this.textContent = nodes.map((n) => n.textContent).join('\n'); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ responses, sessionId = LIVE_ID }) {
  const elements = new Map(PAGE_IDS.map((id) => [id, new FakeElement(id)]));
  const doc = new FakeElement('#document');
  doc.visibilityState = 'visible';
  doc.getElementById = (id) => elements.get(id) || null;
  doc.createElement = (tag) => new FakeElement(tag);
  const win = new FakeElement('#window');
  let clock = 1_800_000_000_000;
  let timerSeq = 0;
  const timers = new Map();
  const calls = [];
  const queue = [...responses];
  const env = {
    document: doc,
    window: win,
    now: () => clock,
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    apiUrl: 'https://api.eivrad.com/v1/orders/status',
    sessionId,
    fetch: (url, init) => {
      calls.push({ url, init });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      if (next === 'hang') return new Promise(() => {});
      const [status, body, headers = {}] = next;
      return Promise.resolve({ status, headers: { get: (k) => headers[k] ?? null }, json: async () => body });
    },
  };
  const h = {
    env, calls, el: (id) => elements.get(id), timers,
    text: (id) => elements.get(id).textContent,
    allText: () => [...elements.values()].map((e) => `${e.textContent} ${Object.values(e.attrs).join(' ')}`).join('\n'),
    async start() { h.ctl = T.start(env); await flush(); await flush(); return h; },
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > end) break;
        clock = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush(); await flush();
      }
      clock = end;
      await flush();
    },
  };
  return h;
}

const ok = (over = {}) => [200, { status: 'pending', email: 'taro.yamada@example.com', emailMasked: 'ta***@example.com', masked: false,
  fullSeconds: 3600, free: false, shortRef: REF, reason: null, pollAfter: 3, ...over }];

test('JS が使う id は、すべてページにある（重複なし）', () => {
  const used = [...JS.matchAll(/byId\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 14);
  for (const id of used) assert.ok(PAGE_IDS.includes(id), id);
  assert.equal(new Set(PAGE_IDS).size, PAGE_IDS.length, '重複した id');
});

test('取得: POST の本文で ID を送り、URL・Referer・資格情報には載せない', async () => {
  const h = await harness({ responses: [ok({ status: 'sent', pollAfter: null })] }).start();
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, 'https://api.eivrad.com/v1/orders/status');
  assert.ok(!url.includes('cs_'));
  assert.equal(init.method, 'POST');
  assert.equal(init.mode, 'cors');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(init.body), { session_id: LIVE_ID });
});

test('準備中 → 送信済み: 確かめ直して表示が変わり、全体のアドレスと確認欄を出す', async () => {
  const h = await harness({ responses: [ok(), ok({ status: 'sent', pollAfter: null })] }).start();
  assert.equal(h.text('evt-address'), 'taro.yamada@example.com');
  assert.equal(h.el('evt-address').hidden, false);
  assert.match(h.text('evt-status'), /送信の準備をしています/);
  assert.equal(h.el('evt-check').hidden, false);
  assert.equal(h.el('evt-report').getAttribute('href'), `${CONTACT}#ref=${REF}`);
  assert.equal(h.el('evt-missing-contact').getAttribute('href'), `${CONTACT}#ref=${REF}`);
  assert.equal(h.text('evt-missing-ref'), `（お問い合わせ番号 ${REF}）`);
  assert.match(h.text('evt-window'), /60分間だけ表示します/);
  assert.equal(h.el('evt-retry').hidden, true);
  assert.equal(h.el('evt-contact').hidden, true);
  await h.advance(3000);
  assert.equal(h.calls.length, 2);
  assert.match(h.text('evt-status'), /^送信しました。差出人は license@send\.eivrad\.com/);
  await h.advance(10 * 60 * 1000);
  assert.equal(h.calls.length, 2, '送信済みの後は確かめない');
});

test('全体の表示は fullSeconds で終わり、伏せた形に差し替えて変数からも消す', async () => {
  const h = await harness({ responses: [ok({ status: 'sent', fullSeconds: 5, pollAfter: null })] }).start();
  assert.equal(h.text('evt-address'), 'taro.yamada@example.com');
  await h.advance(4000);
  assert.equal(h.text('evt-address'), 'taro.yamada@example.com');
  await h.advance(1500);
  assert.equal(h.text('evt-address'), 'ta***@example.com');
  assert.match(h.text('evt-window'), /一部を伏せて表示しています/);
  assert.equal(h.ctl.state.full, null);
  assert.ok(!JSON.stringify(h.ctl.state).includes('taro.yamada'), 'state に全体のアドレスが残らない');
  assert.ok(!h.allText().includes('taro.yamada'), '画面に全体のアドレスが残らない');
});

test('最初から伏せた応答（60分を過ぎた）は、伏せた形だけを表示する', async () => {
  const h = await harness({ responses: [ok({ status: 'sent', email: 'ta***@gmial.com', emailMasked: 'ta***@gmial.com', masked: true, fullSeconds: 0, pollAfter: null })] }).start();
  assert.equal(h.text('evt-address'), 'ta***@gmial.com');
  assert.match(h.text('evt-window'), /一部を伏せて/);
  assert.equal(h.el('evt-typo').hidden, false);
  assert.equal(h.text('evt-typo'), '「gmial.com」は「gmail.com」の誤りではありませんか。');
});

test('戻るボタンのキャッシュから表示されたとき、期限を過ぎていれば伏せ、確かめ直す', async () => {
  const h = await harness({ responses: [ok({ status: 'sent', fullSeconds: 60, pollAfter: null }), ok({ status: 'sent', fullSeconds: 0, email: 'ta***@example.com', pollAfter: null })] }).start();
  // タイマーが止まっていた（スリープなど）想定: 時計だけ進め、タイマーは動かさない
  h.timers.clear();
  h.env.now = ((t) => () => t + 61_000)(h.env.now());
  h.env.window.fire('pageshow', { persisted: false });
  assert.equal(h.text('evt-address'), 'taro.yamada@example.com', 'persisted でなければ何もしない');
  h.env.window.fire('pageshow', { persisted: true });
  assert.equal(h.text('evt-address'), 'ta***@example.com', 'すぐに伏せる');
  await flush(); await flush();
  assert.equal(h.calls.length, 2, '確かめ直す');
});

test('タブに戻ったとき（visibilitychange）も期限を確かめる', async () => {
  const h = await harness({ responses: [ok({ status: 'sent', fullSeconds: 60, pollAfter: null })] }).start();
  h.timers.clear();
  h.env.now = ((t) => () => t + 60_001)(h.env.now());
  h.env.document.fire('visibilitychange');
  assert.equal(h.text('evt-address'), 'ta***@example.com');
});

test('準備中のままなら12回で自動の確かめ直しを止め、ボタンを出す（押すと1回だけ呼ぶ）', async () => {
  const h = await harness({ responses: [ok()] }).start();
  await h.advance(10 * 60 * 1000);
  assert.equal(h.calls.length, 12);
  assert.equal(h.el('evt-retry').hidden, false);
  assert.match(h.text('evt-status'), /まだ準備中です/);
  h.el('evt-retry').fire('click');
  await flush(); await flush();
  assert.equal(h.calls.length, 13);
  await h.advance(10 * 60 * 1000);
  assert.equal(h.calls.length, 13);
});

test('確かめ直しで文が変わらなければ、読み上げの欄を差し替えない', async () => {
  const h = await harness({ responses: [ok(), ok(), ok(), ok({ status: 'sent', pollAfter: null })] }).start();
  const first = h.el('evt-status').replaced;
  await h.advance(6000);
  assert.equal(h.calls.length, 3);
  assert.equal(h.el('evt-status').replaced, first, '準備中のままなら同じ欄のまま');
  await h.advance(3000);
  assert.equal(h.el('evt-status').replaced, first + 1);
  assert.match(h.text('evt-status'), /^送信しました/);
});

test('サーバーの pollAfter が null なら、準備中でも確かめ直さない', async () => {
  const h = await harness({ responses: [ok({ pollAfter: null })] }).start();
  await h.advance(5 * 60 * 1000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.el('evt-retry').hidden, false);
});

test('404: 「表示できませんでした」・番号なしの問い合わせ・確認欄なし', async () => {
  const h = await harness({ responses: [[404, { error: { code: 'not_found', message: 'x' } }]] }).start();
  assert.equal(h.text('evt-dest-title'), 'ご注文の情報を表示できませんでした');
  assert.equal(h.el('evt-contact').hidden, false);
  assert.equal(h.el('evt-contact').getAttribute('href'), CONTACT);
  assert.equal(h.el('evt-check').hidden, true);
  assert.equal(h.el('evt-address').hidden, true);
  assert.equal(h.el('evt-retry').hidden, true);
});

test('ID が無いときは API を呼ばずに「表示できませんでした」', async () => {
  for (const sessionId of [null, '', 'cs_live_bad id', 'javascript:alert(1)']) {
    const h = await harness({ responses: [ok()], sessionId }).start();
    assert.equal(h.calls.length, 0);
    assert.equal(h.text('evt-dest-title'), 'ご注文の情報を表示できませんでした');
  }
});

test('503・通信の失敗・形の違う応答・応答なし: 確認できない旨と一般的な案内、もう一度確かめるボタン', async () => {
  for (const response of [[503, { error: { code: 'unavailable' } }], [403, {}], [500, 'x'], 'network', [200, { status: 'weird' }], [200, null]]) {
    const h = await harness({ responses: [response, ok({ status: 'sent', pollAfter: null })] }).start();
    assert.match(h.text('evt-status'), /^ただいま送信先を確認できません。\nライセンスキーは、決済のときにご入力のメールアドレスへ自動でお送りしています/, JSON.stringify(response));
    assert.equal(h.el('evt-retry').hidden, false);
    assert.equal(h.el('evt-check').hidden, true);
    h.el('evt-retry').fire('click');
    assert.equal(h.text('evt-status'), '送信先を確認しています…');
    assert.equal(h.el('evt-retry').disabled, true);
    await flush(); await flush();
    assert.match(h.text('evt-status'), /^送信しました/);
  }
  const h = await harness({ responses: ['hang'] }).start();
  assert.equal(h.text('evt-status'), '送信先を確認しています…');
  await h.advance(15000);
  assert.match(h.text('evt-status'), /^ただいま送信先を確認できません/);
});

test('429: Retry-After（読めなければ60秒）の後に1回だけ試し直し、だめならボタン', async () => {
  let h = await harness({ responses: [[429, { error: { code: 'rate_limited' } }], ok({ status: 'sent', pollAfter: null })] }).start();
  assert.equal(h.calls.length, 1);
  await h.advance(59_000);
  assert.equal(h.calls.length, 1);
  await h.advance(1000);
  assert.equal(h.calls.length, 2);
  assert.match(h.text('evt-status'), /^送信しました/);

  h = await harness({ responses: [[429, {}, { 'Retry-After': '5' }], [429, {}], ok()] }).start();
  await h.advance(5000);
  assert.equal(h.calls.length, 2);
  assert.match(h.text('evt-status'), /^ただいま送信先を確認できません/);
  assert.equal(h.el('evt-retry').hidden, false);
  await h.advance(10 * 60 * 1000);
  assert.equal(h.calls.length, 2);
});

test('表示中の注文の確かめ直しに失敗したら、表示を残して「最新の状況を確認できません」', async () => {
  const h = await harness({ responses: [ok(), [503, {}]] }).start();
  await h.advance(3000);
  assert.equal(h.text('evt-address'), 'taro.yamada@example.com');
  assert.match(h.text('evt-status'), /送信の準備をしています[\s\S]*最新の状況を確認できません/);
  assert.equal(h.el('evt-retry').hidden, false);
});

test('送れなかった（address_rejected）・状態を出せない（返金後）・無料の注文', async () => {
  let h = await harness({ responses: [ok({ status: 'failed', reason: 'address_rejected', pollAfter: null })] }).start();
  assert.match(h.text('evt-status'), /^このメールアドレスには送れませんでした。キーを自動でお送りできませんでした。/);
  assert.equal(h.el('evt-contact').hidden, false);
  assert.equal(h.el('evt-contact').getAttribute('href'), `${CONTACT}#ref=${REF}`);
  assert.equal(h.el('evt-check').hidden, false);

  h = await harness({ responses: [ok({ status: 'unknown', email: null, emailMasked: null, fullSeconds: 0, pollAfter: null })] }).start();
  assert.match(h.text('evt-status'), /このページでは表示できません/);
  assert.equal(h.el('evt-address').hidden, true);
  assert.equal(h.el('evt-check').hidden, true);
  assert.equal(h.el('evt-window').hidden, true);
  assert.equal(h.el('evt-contact').getAttribute('href'), `${CONTACT}#ref=${REF}`);

  h = await harness({ responses: [ok({ status: 'sent', free: true, pollAfter: null })] }).start();
  assert.equal(h.text('evt-lead'), 'Eve Voice の無料ライセンスをお申し込みいただき、ありがとうございます。');
  assert.equal(h.el('evt-receipt').hidden, true, '無料の注文には Stripe の領収書が無い');
});

test('サーバーが余計な値を返しても、画面には出さない', async () => {
  const h = await harness({ responses: [ok({ status: 'sent', pollAfter: null, licenseKey: 'EV1-SECRET', paymentIntent: 'pi_123', amount: 4980 })] }).start();
  const all = h.allText();
  for (const leak of ['EV1-SECRET', 'pi_123', '4980', LIVE_ID]) assert.ok(!all.includes(leak), leak);
});

test('JS: innerHTML・外部への送信・ログを使わない', () => {
  const code = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(code, /console\.|sendBeacon|localStorage/);
  const urls = [...code.matchAll(/https?:\/\/[^'"\s)]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)].sort(), ['http://localhost:8787/v1/orders/status', 'https://api.eivrad.com/v1/orders/status']);
});

// --- ページの HTML（静的な検査） -------------------------------------------------------------

const head = PAGE.slice(PAGE.indexOf('<head>') + 6, PAGE.indexOf('</head>'));
const headTags = [...head.matchAll(/<(meta|script|link|title)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2], index: m.index }));
const inlineScripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const CSP = (head.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/) || [])[1];

test('head の順番: charset → viewport → CSP → referrer → robots → インラインスクリプト → そのほか', () => {
  const first = headTags.slice(0, 6).map((t) => `${t.tag}${(t.attrs.match(/(?:name|http-equiv)="([^"]+)"/) || [, t.attrs.includes('charset') ? 'charset' : ''])[1]}`);
  assert.deepEqual(first, ['metacharset', 'metaviewport', 'metaContent-Security-Policy', 'metareferrer', 'metarobots', 'script']);
  assert.match(head, /<meta name="referrer" content="no-referrer">/);
  assert.match(head, /<meta name="robots" content="noindex,nofollow">/);
  const inlineIndex = headTags[5].index;
  for (const t of headTags.slice(6)) assert.ok(t.index > inlineIndex);
  assert.ok(headTags.filter((t) => t.tag === 'link' || (t.tag === 'script' && /src=/.test(t.attrs))).every((t) => t.index > inlineIndex),
    'link や script src はインラインスクリプトより後');
});

test('CSP: インラインスクリプトの sha256 が一致し、接続先は api.eivrad.com（と手元の確認用）だけ', () => {
  assert.ok(CSP);
  assert.equal(inlineScripts.length, 1, 'インラインスクリプトは1つだけ');
  const digest = createHash('sha256').update(inlineScripts[0][1], 'utf8').digest('base64');
  const directives = Object.fromEntries(CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(directives['script-src'], ["'self'", `'sha256-${digest}'`]);
  assert.deepEqual(directives['connect-src'], ['https://api.eivrad.com', 'http://localhost:8787']);
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['style-src'], ["'self'"]);
  assert.deepEqual(directives['img-src'], ["'self'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
});

test('HTML: 読み込み先は自分のドメインだけ・style 属性やイベント属性なし・目印あり・アドレスを書かない', () => {
  assert.match(PAGE, /<body [^>]*data-ev-thanks="v1"/);
  assert.doesNotMatch(PAGE, /\sstyle="/, 'CSP の style-src で効かなくなる');
  assert.doesNotMatch(PAGE, /\son[a-z]+="/);
  assert.doesNotMatch(PAGE, /<(iframe|form|object|embed|base)\b/);
  for (const [, attr, value] of PAGE.matchAll(/\s(src|href)="([^"]+)"/g)) {
    assert.ok(value.startsWith('/') || value.startsWith('#'), `${attr}=${value}`);
    assert.ok(!value.startsWith('//'), value);
  }
  for (const [, value] of PAGE.matchAll(/\s(?:src|href)="(\/[^"#?]*)/g)) {
    const file = value.endsWith('/') ? `${value}index.html` : value;
    assert.ok(existsSync(path.join(root, file)), `${value} が無い`);
  }
  assert.doesNotMatch(PAGE.replace(/<script>[\s\S]*?<\/script>/, ''), /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    'HTML にメールアドレスを書かない（Cloudflare の難読化で書き換わる）');
  // 「次にすること」のリンク先が LP にある
  const lp = read('evevoice/index.html');
  for (const id of ['price', 'faq-activate', 'features', 'help']) assert.match(lp, new RegExp(`id="${id}"`), id);
});

test('HTML: 要素の入れ子が閉じていて、aria の参照先と見出しが揃っている', () => {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const body = PAGE.replace(/<!doctype html>/i, '').replace(/<script>[\s\S]*?<\/script>/g, '<script></script>')
    .replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const [, close, name] of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    const tag = name.toLowerCase();
    if (VOID.has(tag)) continue;
    if (close) {
      assert.equal(stack.pop(), tag, `</${tag}> の対応`);
    } else {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, []);
  for (const [, ref] of PAGE.matchAll(/aria-(?:labelledby|controls|describedby)="([^"]+)"/g)) {
    for (const id of ref.split(/\s+/)) assert.ok(PAGE_IDS.includes(id), id);
  }
  assert.equal((PAGE.match(/<h1\b/g) || []).length, 1);
  assert.match(PAGE, /<html lang="ja">/);
  assert.match(PAGE, /<div class="evt-status" id="evt-status" role="status" aria-live="polite">/);
  for (const [, img] of PAGE.matchAll(/<img\b([^>]*)>/g)) assert.match(img, /\salt="/);
  // JS が動かない場合の案内
  assert.match(PAGE, /<noscript><p class="evt-noscript">送信先の表示には JavaScript が必要です。<\/p><\/noscript>/);
  assert.match(PAGE, /id="evt-status"[^>]*><p>ライセンスキーは、決済のときにご入力のメールアドレスへ自動でお送りしています/);
});

function runInline(location, { storageThrows = false } = {}) {
  const store = new Map([['evThanksSession', 'cs_live_OLDOLDOLDOLDOLD']]);
  const calls = [];
  const storage = {
    getItem: (k) => { if (storageThrows) throw new Error('blocked'); return store.get(k) ?? null; },
    setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); store.set(k, v); },
    removeItem: (k) => { if (storageThrows) throw new Error('blocked'); store.delete(k); },
  };
  const window = {};
  const context = {
    location, sessionStorage: storage, window, URLSearchParams,
    history: { replaceState: (...args) => calls.push(args) },
  };
  vm.runInNewContext(inlineScripts[0][1], context);
  return { store, calls, window };
}

test('インラインスクリプト: 有効な ID だけを sessionStorage に移し、アドレスバーからクエリを消す', () => {
  let r = runInline({ search: `?session_id=${LIVE_ID}&utm_source=stripe`, hash: '', pathname: '/evevoice/thanks/' });
  assert.equal(r.store.get('evThanksSession'), LIVE_ID);
  assert.equal(r.window.__evThanksSession, LIVE_ID);
  assert.deepEqual(r.calls, [[null, '', '/evevoice/thanks/']]);

  r = runInline({ search: '?session_id=cs_live_<script>', hash: '', pathname: '/evevoice/thanks/' });
  assert.equal(r.store.has('evThanksSession'), false, '無効な ID なら古い ID も消す');
  assert.equal(r.window.__evThanksSession, undefined);
  assert.equal(r.calls.length, 1);

  r = runInline({ search: `?session_id=${TEST_ID}`, hash: '', pathname: '/evevoice/thanks/' }, { storageThrows: true });
  assert.equal(r.window.__evThanksSession, TEST_ID, 'sessionStorage が使えなければ window に置く');
  assert.equal(r.calls.length, 1);

  r = runInline({ search: '', hash: '', pathname: '/evevoice/thanks/' });
  assert.equal(r.store.get('evThanksSession'), 'cs_live_OLDOLDOLDOLDOLD', '再読み込みでは残す');
  assert.equal(r.calls.length, 0);

  r = runInline({ search: '', hash: '#x', pathname: '/evevoice/thanks/' });
  assert.equal(r.calls.length, 1);
});

test('readSessionId: window の値を優先し、無ければ sessionStorage', () => {
  assert.equal(T.readSessionId({ __evThanksSession: LIVE_ID }), LIVE_ID);
  assert.equal(T.readSessionId({ __evThanksSession: 'bad' }), null);
  assert.equal(T.readSessionId({ sessionStorage: { getItem: () => TEST_ID } }), TEST_ID);
  assert.equal(T.readSessionId({ sessionStorage: { getItem: () => { throw new Error('blocked'); } } }), null);
  assert.equal(T.readSessionId({}), null);
});

// --- お問い合わせフォームの番号の差し込み ----------------------------------------------------

const CONTACT_PAGE = read('contact/index.html');
const CONTACT_SCRIPT = [...CONTACT_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

function runContact({ search = '?subject=evevoice', hash = '', message = '' } = {}) {
  const field = (extra = {}) => ({ value: '', addEventListener() {}, setAttribute() {}, ...extra });
  const elements = {
    'contact-form': { addEventListener() {}, querySelector: () => field(), querySelectorAll: () => [] },
    'eiv-status': field(),
    'eiv-t': field(),
    'f-kind': field({ selectedIndex: 0 }),
    'f-message': field({ value: message }),
  };
  const replaced = [];
  const window = {
    location: { search, hash, pathname: '/contact/' },
    history: { replaceState: (...args) => replaced.push(args) },
  };
  const context = { document: { getElementById: (id) => elements[id] || null }, window, URLSearchParams, Date, Object, FormData: class {}, fetch() {} };
  vm.runInNewContext(CONTACT_SCRIPT, context);
  return { message: elements['f-message'].value, kind: elements['f-kind'].value, replaced };
}

test('お問い合わせ: 有効な番号・ご用件が Eve Voice・本文が空のときだけ、ひな形を入れて # を消す', () => {
  const r = runContact({ hash: `#ref=${REF}` });
  assert.equal(r.kind, 'Eve Voice について');
  assert.equal(r.message, [
    '【ライセンスキーの送信先のメールアドレスの誤り】',
    `お問い合わせ番号: ${REF}`,
    '決済のおおよその日時:',
    'お支払い方法（カードの下4桁、または Apple Pay）:',
    '（正しいメールアドレスは、上の「メールアドレス」の欄にご入力ください）',
  ].join('\n'));
  assert.doesNotMatch(r.message, /https?:|@/, '本文に URL もアドレスも入れない（リンク数の検査にもかからない）');
  assert.ok(r.message.trim().length >= 10);
  assert.deepEqual(r.replaced, [[null, '', '/contact/?subject=evevoice']]);
});

test('お問い合わせ: 無効な番号・入力済みの本文・ほかのご用件では入れない', () => {
  for (const hash of ['#ref=abc', '#ref=Ab3dEf7h9', '#ref=Ab3d-f7h', '#ref=', `#ref=${REF}&email=taro@example.com`, '#REF=Ab3dEf7h']) {
    const r = runContact({ hash });
    assert.equal(r.message, '', hash);
  }
  assert.equal(runContact({ hash: `#ref=${REF}`, message: '自分で書いた本文' }).message, '自分で書いた本文');
  assert.equal(runContact({ hash: `#ref=${REF}`, search: '?subject=gecko-weather' }).message, '');
  assert.equal(runContact({ hash: `#ref=${REF}`, search: '' }).message, '');
  // # が番号の形でなければ、アドレスバーはそのまま
  assert.deepEqual(runContact({ hash: '#form' }).replaced, []);
  assert.deepEqual(runContact({ hash: '' }).replaced, []);
  // 既存の ?subject の動きは変わらない
  assert.equal(runContact({ search: '?subject=gecko-weather' }).kind, 'ゲッコー天気について');
  assert.equal(runContact({ search: '?subject=unknown' }).kind, '');
});
