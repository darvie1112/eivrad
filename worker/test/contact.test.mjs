// お問い合わせ Worker の日次上限まわりと、Cloudflare Email Sending → Resend の予備のテスト（追加の npm パッケージなし）
//
//   node --test --disable-warning=ExperimentalWarning worker/test/contact.test.mjs
//
// 外部への通信はしない。fetch は差し替え、Turnstile / Resend / Slack 以外の宛先は失敗させる。
// send_email 束縛（env.CONTACT_EMAIL）は偽物で、env のメソッドとして呼ばれなければ TypeError を投げる（本番の workerd と同じ）。
// 束縛は差出人しか絞らない（宛先の制限なし）ので、宛先が contact@eivrad.com に固定されていることもここで確かめる。
// Durable Object の SQL は node:sqlite（Node 22.5 以降）で本物の SQLite に流す。
// workerd（Miniflare）で束ねた Worker を動かす確認は workerd.test.mjs（miniflare の場所を渡したときだけ動く）。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker, { ContactMailCounter } from '../src/index.js';
import {
  parseCap,
  utcDayKey,
  DEFAULT_DAILY_MAIL_CAP,
  COUNTER_ALERT_INTERVAL_MS,
  resetCounterAlert,
} from '../src/counter.js';
import {
  CF_COUNTER_NAME,
  CF_SEND_TIMEOUT_MS,
  CODE_NOTIFY_TO_MISMATCH,
  DEFAULT_CF_DAILY_CAP,
  FALLBACK_ALERT_INTERVAL_MS,
  FROM,
  NOTIFY_ADDRESS,
  contactSubject,
  failureCode,
  isNotifyAddress,
  parseProvider,
  resetFallbackAlert,
  sendViaCloudflare,
  setCloudflareTimeoutForTest,
} from '../src/cfmail.js';
import { readFileSync } from 'node:fs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // 古い Node では SQLite を使うテストを飛ばす
}
const needsSqlite = { skip: DatabaseSync ? false : 'node:sqlite がないため省略' };

// --- Durable Object の土台（ctx.storage.sql の代わり） ---------------------------

/** Cloudflare の ctx.storage.sql.exec と同じ形（exec(query, ...bindings) -> cursor）で node:sqlite を包む */
function sqliteStorage() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
  return { db, ctx: { storage: { sql } } };
}

/** テスト用の時計 */
function clockAt(iso) {
  const clock = { ms: Date.parse(iso), now: () => clock.ms, set: (s) => { clock.ms = Date.parse(s); } };
  return clock;
}

/** env.CONTACT_COUNTER の代わり。get(id).fetch(...) を本物の ContactMailCounter に流し、呼び出しを数える */
function counterNamespace(counter) {
  const ns = {
    calls: [],
    names: [],
    idFromName(name) { ns.names.push(name); return { name }; },
    get() {
      return {
        fetch: async (url, init) => {
          ns.calls.push(`${(init && init.method) || 'GET'} ${new URL(url).pathname}`);
          return counter.fetch(new Request(url, init));
        },
      };
    },
  };
  return ns;
}

// --- 外部通信の差し替え ------------------------------------------------------------

const realFetch = globalThis.fetch;
const realConsole = { log: console.log, error: console.error };
let net;

function installFetch({ turnstile = true, resend = () => new Response('{"id":"x"}', { status: 200 }) } = {}) {
  net = { resend: [], slack: [], turnstile: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      net.turnstile += 1;
      return Response.json({ success: turnstile });
    }
    if (url === 'https://api.resend.com/emails') {
      net.resend.push(JSON.parse(init.body));
      return resend(net.resend.length); // 何通目の呼び出しか（1 から）
    }
    if (url === 'https://hooks.slack.test/T/B/X') {
      net.slack.push(JSON.parse(init.body).text);
      return new Response('ok');
    }
    throw new Error(`テストで想定していない宛先: ${url}`);
  };
}

beforeEach(() => {
  installFetch();
  resetCounterAlert();
  resetFallbackAlert();
  setCloudflareTimeoutForTest();
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realConsole.log;
  console.error = realConsole.error;
});

// --- リクエストの組み立て ----------------------------------------------------------

const PERSON = { name: '試験 太郎', email: 'taro@example.test', message: 'テスト用のお問い合わせ本文です。十分な長さ。' };

function contactRequest(overrides = {}) {
  const fields = {
    name: PERSON.name,
    email: PERSON.email,
    company: '',
    kind: '個人情報の開示等のご請求',
    message: PERSON.message,
    company_url: '',
    t: '5000',
    'cf-turnstile-response': 'token',
    ...overrides,
  };
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request('https://eivrad.com/api/contact', {
    method: 'POST',
    headers: { Origin: 'https://eivrad.com', 'CF-Connecting-IP': '203.0.113.7' },
    body,
  });
}

function baseEnv(extra = {}) {
  return {
    TURNSTILE_SECRET: 'test-turnstile',
    RESEND_API_KEY: 'test-resend',
    NOTIFY_TO: 'notify@example.test',
    SLACK_WEBHOOK: 'https://hooks.slack.test/T/B/X',
    ...extra,
  };
}

async function submit(env, overrides) {
  const res = await worker.fetch(contactRequest(overrides), env);
  return { status: res.status, body: await res.json() };
}

function setup({ cap = '2', at = '2026-10-04T05:00:00Z' } = {}) {
  const { db, ctx } = sqliteStorage();
  const clock = clockAt(at);
  const counter = new ContactMailCounter(ctx, {}, clock.now);
  const ns = counterNamespace(counter);
  const env = baseEnv({ CONTACT_DAILY_MAIL_CAP: cap, CONTACT_COUNTER: ns });
  return { db, clock, counter, ns, env };
}

const isArrivalNotice = (text) => text.includes('お問い合わせが1件届きました');
const isLimitNotice = (text) => text.includes('送信を受け付けませんでした');
const isFailureNotice = (text) => text.includes('メール通知に失敗しました');
const isCounterAlert = (text) => text.includes('日次カウンタが使えないため');

/** Resend の 429 応答（name は本文、retryAfter は retry-after ヘッダ） */
const resend429 = (name, retryAfter) =>
  new Response(name === undefined ? '{}' : JSON.stringify({ statusCode: 429, name, message: 'x' }), {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
  });
const resendOk = () => new Response('{"id":"x"}', { status: 200 });

/** Slack に個人データ（氏名・メール・本文・IP）が載っていないこと */
const assertNoPersonalData = () => {
  for (const text of net.slack) {
    for (const v of [...Object.values(PERSON), '203.0.113.7']) assert.ok(!text.includes(v), `Slack に個人データ: ${text}`);
  }
};

// --- 上限値・日付キー --------------------------------------------------------------

test('上限値の読み取り: 0 以上の整数だけ採用し、それ以外は既定の 20', () => {
  assert.equal(DEFAULT_DAILY_MAIL_CAP, 20);
  assert.equal(parseCap('20'), 20);
  assert.equal(parseCap('5'), 5);
  assert.equal(parseCap('0'), 0);
  for (const bad of [undefined, null, '', '  ', 'abc', '-1', '2.5', 'NaN']) {
    assert.equal(parseCap(bad), 20, `parseCap(${JSON.stringify(bad)})`);
  }
});

test('日付キーは UTC（JST 8:59 は前日、JST 9:00 から当日）', () => {
  assert.equal(utcDayKey(Date.parse('2026-10-04T23:59:59.999Z')), '2026-10-04');
  assert.equal(utcDayKey(Date.parse('2026-10-05T00:00:00Z')), '2026-10-05');
  assert.equal(utcDayKey(Date.parse('2026-10-05T08:59:00+09:00')), '2026-10-04');
  assert.equal(utcDayKey(Date.parse('2026-10-05T09:00:00+09:00')), '2026-10-05');
});

// --- カウンタ単体 ------------------------------------------------------------------

test('カウンタ: 上限まで確保でき、超えた分は断って rejected を数える', needsSqlite, () => {
  const { counter } = setup();
  assert.deepEqual(counter.reserve(2), { ok: true, day: '2026-10-04', cap: 2, used: 1, rejected: 0, quota_429: 0 });
  assert.deepEqual(counter.reserve(2), { ok: true, day: '2026-10-04', cap: 2, used: 2, rejected: 0, quota_429: 0 });
  assert.deepEqual(counter.reserve(2), { ok: false, day: '2026-10-04', cap: 2, used: 2, rejected: 1, quota_429: 0 });
  assert.deepEqual(counter.reserve(2), { ok: false, day: '2026-10-04', cap: 2, used: 2, rejected: 2, quota_429: 0 });
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 2, rejected: 2, quota_429: 0 });
});

test('カウンタ: 上限 0 はすべて断る', needsSqlite, () => {
  const { counter } = setup();
  assert.equal(counter.reserve(0).ok, false);
  assert.equal(counter.status().used, 0);
});

test('カウンタ: 返した枠は再び使え、0 未満にはならない', needsSqlite, () => {
  const { counter } = setup();
  const slot = counter.reserve(1);
  assert.equal(counter.reserve(1).ok, false);
  assert.deepEqual(counter.release(slot.day, ''), { ok: true, day: '2026-10-04', used: 0, rejected: 1, quota_429: 0 });
  assert.deepEqual(counter.release(slot.day, ''), { ok: true, day: '2026-10-04', used: 0, rejected: 1, quota_429: 0 });
  assert.equal(counter.reserve(1).ok, true);
  assert.deepEqual(counter.release('not-a-day', ''), { ok: false, error: 'day' });
});

test('カウンタ: Resend の送信枠切れで返した枠は quota_429 に数え、rejected には足さない', needsSqlite, () => {
  const { counter } = setup();
  const slot = counter.reserve(5);
  assert.deepEqual(counter.release(slot.day, 'quota'), { ok: true, day: '2026-10-04', used: 0, rejected: 0, quota_429: 1 });
  // 知らない reason は数えない
  const again = counter.reserve(5);
  assert.deepEqual(counter.release(again.day, 'other'), { ok: true, day: '2026-10-04', used: 0, rejected: 0, quota_429: 1 });
});

test('カウンタ: UTC 0時で件数が戻り、0時をまたいだ返却は前日の枠を減らす', needsSqlite, () => {
  const { counter, clock } = setup({ at: '2026-10-04T23:59:59Z' });
  const late = counter.reserve(1);
  assert.equal(counter.reserve(1).ok, false);

  clock.set('2026-10-05T00:00:00Z'); // JST 9:00
  const next = counter.reserve(1);
  assert.equal(next.ok, true);
  assert.equal(next.day, '2026-10-05');

  counter.release(late.day, '');
  assert.deepEqual(counter.counts('2026-10-04'), { used: 0, rejected: 1, quota_429: 0 });
  assert.deepEqual(counter.counts('2026-10-05'), { used: 1, rejected: 0, quota_429: 0 });
});

test('カウンタ: 31日より古い行は消え、保存するのは日付と件数だけ', needsSqlite, () => {
  const { counter, clock, db } = setup({ at: '2026-09-01T12:00:00Z' });
  counter.reserve(20);
  clock.set('2026-10-02T12:00:00Z');
  counter.reserve(20);
  assert.deepEqual(db.prepare('SELECT day FROM daily ORDER BY day').all().map((r) => r.day), ['2026-09-01', '2026-10-02']);
  clock.set('2026-10-03T12:00:00Z');
  counter.reserve(20);
  assert.deepEqual(db.prepare('SELECT day FROM daily ORDER BY day').all().map((r) => r.day), ['2026-10-02', '2026-10-03']);

  const columns = db.prepare('PRAGMA table_info(daily)').all().map((c) => c.name);
  assert.deepEqual(columns, ['day', 'used', 'rejected', 'quota_429']);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name), ['daily']);
});

test('カウンタ: fetch 窓口（reserve / release / status / 不明な経路）', needsSqlite, async () => {
  const { counter } = setup();
  const r1 = await (await counter.fetch(new Request('https://counter/reserve?cap=1', { method: 'POST' }))).json();
  assert.equal(r1.ok, true);
  const r2 = await (await counter.fetch(new Request('https://counter/reserve?cap=1', { method: 'POST' }))).json();
  assert.equal(r2.ok, false);
  const rel = await (await counter.fetch(new Request(`https://counter/release?day=${r1.day}&reason=quota`, { method: 'POST' }))).json();
  assert.deepEqual(rel, { ok: true, day: '2026-10-04', used: 0, rejected: 1, quota_429: 1 });
  const st = await (await counter.fetch(new Request('https://counter/status'))).json();
  assert.deepEqual(st, { ok: true, day: '2026-10-04', used: 0, rejected: 1, quota_429: 1 });
  assert.equal((await counter.fetch(new Request('https://counter/reserve'))).status, 404);
  assert.equal((await counter.fetch(new Request('https://counter/release?day=x', { method: 'POST' }))).status, 400);
});

// --- リクエストの流れ --------------------------------------------------------------

test('通常: 枠を1つ使って Resend に1通、Slack に到着通知', needsSqlite, async () => {
  const { env, ns, counter, db } = setup();
  const res = await submit(env);
  assert.deepEqual(res, { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 1);
  assert.equal(net.resend[0].reply_to, PERSON.email);
  assert.deepEqual(net.slack.map(isArrivalNotice), [true]);
  assert.deepEqual(ns.calls, ['POST /reserve']);
  assert.deepEqual(ns.names, ['resend-daily']);
  assert.equal(counter.status().used, 1);

  // カウンタに個人データが入っていない
  const dump = JSON.stringify(db.prepare('SELECT * FROM daily').all());
  for (const v of Object.values(PERSON)) assert.ok(!dump.includes(v));
  assert.ok(!dump.includes('203.0.113.7'));
});

test('上限到達: Resend を呼ばず 503 daily_limit、Slack の上限通知は1日1回だけ', needsSqlite, async () => {
  const { env, counter } = setup({ cap: '2' });
  await submit(env);
  await submit(env);
  assert.equal(net.resend.length, 2);
  net.slack.length = 0;

  const third = await submit(env);
  assert.deepEqual(third, { status: 503, body: { ok: false, error: 'daily_limit' } });
  const fourth = await submit(env);
  assert.deepEqual(fourth, { status: 503, body: { ok: false, error: 'daily_limit' } });

  assert.equal(net.resend.length, 2, '上限後は Resend を呼ばない');
  assert.equal(net.slack.length, 1);
  assert.ok(isLimitNotice(net.slack[0]));
  assert.ok(net.slack[0].includes('日次上限（2通）'));
  assertNoPersonalData();
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 2, rejected: 2, quota_429: 0 });
});

test('上限到達後も UTC 0時（JST 9時）を過ぎれば再び送れる', needsSqlite, async () => {
  const { env, clock } = setup({ cap: '1', at: '2026-10-04T23:58:00Z' });
  assert.equal((await submit(env)).status, 200);
  assert.equal((await submit(env)).body.error, 'daily_limit');
  clock.set('2026-10-05T00:00:01Z');
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 2);
});

test('Resend が失敗（500）: 枠を返して 502 send_failed、Slack は「届いた」ではなく「通知に失敗」', needsSqlite, async () => {
  installFetch({ resend: () => new Response('{"message":"boom"}', { status: 500 }) });
  const { env, ns, counter } = setup({ cap: '1' });
  const res = await submit(env);
  assert.deepEqual(res, { status: 502, body: { ok: false, error: 'send_failed' } });
  assert.equal(net.resend.length, 1, '429 以外は再送しない');
  assert.deepEqual(ns.calls, ['POST /reserve', 'POST /release']);
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 0, rejected: 0, quota_429: 0 });
  assert.equal(net.slack.length, 1);
  assert.ok(isFailureNotice(net.slack[0]));
  assert.ok(!isArrivalNotice(net.slack[0]), '失敗したのに「届きました」と送らない');
  assert.ok(net.slack[0].includes('種別: 個人情報の開示等のご請求・Resend 500'));
  assert.ok(net.slack[0].includes('直接メールを案内'));
  assertNoPersonalData();

  // 返した枠で次の送信が通る
  installFetch();
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
});

test('Resend への通信が例外: 枠を返し、502 send_failed、Slack に「通知に失敗」', needsSqlite, async () => {
  installFetch({ resend: () => { throw new TypeError('network down'); } });
  const { env, counter } = setup({ cap: '1' });
  const res = await submit(env);
  assert.deepEqual(res, { status: 502, body: { ok: false, error: 'send_failed' } });
  assert.equal(counter.status().used, 0);
  assert.equal(net.slack.length, 1);
  assert.ok(isFailureNotice(net.slack[0]) && net.slack[0].includes('Resend に接続できず'));
});

test('Resend が 429 daily_quota_exceeded: 再送せず枠を返して 503 daily_limit、quota_429 に数え、上限通知を1回', needsSqlite, async () => {
  installFetch({ resend: () => resend429('daily_quota_exceeded', 3600) });
  const { env, ns, counter } = setup({ cap: '20' });
  const first = await submit(env);
  assert.deepEqual(first, { status: 503, body: { ok: false, error: 'daily_limit' } });
  assert.equal(net.resend.length, 1, '送信枠切れは再送しない');
  assert.deepEqual(ns.calls, ['POST /reserve', 'POST /release']);
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 0, rejected: 0, quota_429: 1 });
  assert.equal(net.slack.length, 1);
  assert.ok(isLimitNotice(net.slack[0]));
  assert.ok(net.slack[0].includes('Resend の送信枠（429 daily_quota_exceeded）'));

  const second = await submit(env);
  assert.equal(second.body.error, 'daily_limit');
  assert.equal(net.slack.length, 1, '2件目以降は Slack に送らない');
  assert.equal(net.slack.filter(isArrivalNotice).length, 0);
});

test('Resend が 429 monthly_quota_exceeded も daily_limit（retry-after が無くても再送しない）', needsSqlite, async () => {
  installFetch({ resend: () => resend429('monthly_quota_exceeded') });
  const { env } = setup();
  assert.deepEqual(await submit(env), { status: 503, body: { ok: false, error: 'daily_limit' } });
  assert.equal(net.resend.length, 1);
  assert.ok(net.slack[0].includes('429 monthly_quota_exceeded'));
});

test('Resend の送信枠切れ（429）の後でも、フォーム自身の上限に達した日の通知は消えない', needsSqlite, async () => {
  installFetch({ resend: (n) => (n === 1 ? resend429('daily_quota_exceeded') : resendOk()) });
  const { env, counter } = setup({ cap: '1' });
  assert.equal((await submit(env)).body.error, 'daily_limit'); // Resend の 429（quota_429 = 1）
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } }); // 枠 1/1
  assert.equal((await submit(env)).body.error, 'daily_limit'); // フォームの上限（rejected = 1）
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 1, rejected: 1, quota_429: 1 });
  const limits = net.slack.filter(isLimitNotice);
  assert.equal(limits.length, 2);
  assert.ok(limits[0].includes('Resend の送信枠'));
  assert.ok(limits[1].includes('日次上限（1通）'));
});

test('Resend が 429 rate_limit_exceeded: retry-after だけ待って1回だけ再送し、通れば成功', needsSqlite, async () => {
  installFetch({ resend: (n) => (n === 1 ? resend429('rate_limit_exceeded', 0) : resendOk()) });
  const { env, ns, counter } = setup({ cap: '1' });
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 2);
  assert.deepEqual(net.resend[0], net.resend[1], '同じ内容を再送する');
  assert.deepEqual(ns.calls, ['POST /reserve'], '枠は1つだけ使う');
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 1, rejected: 0, quota_429: 0 });
  assert.deepEqual(net.slack.map(isArrivalNotice), [true]);
});

test('Resend の毎秒の制限が再送後も続く: send_failed（直接メールの案内）で、上限の件数には数えない', needsSqlite, async () => {
  installFetch({ resend: () => resend429('rate_limit_exceeded', 0) });
  const { env, counter } = setup({ cap: '2' });
  assert.deepEqual(await submit(env), { status: 502, body: { ok: false, error: 'send_failed' } });
  assert.equal(net.resend.length, 2, '再送は1回だけ');
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 0, rejected: 0, quota_429: 0 });
  assert.equal(net.slack.length, 1);
  assert.ok(isFailureNotice(net.slack[0]));
  assert.ok(net.slack[0].includes('Resend 429 rate_limit_exceeded・1回再送しても同じ'));
  assert.ok(!isLimitNotice(net.slack[0]), '「上限に達した」とは送らない');

  // その後に本当に上限へ達したら、上限の通知が出る
  installFetch();
  await submit(env);
  await submit(env);
  assert.equal((await submit(env)).body.error, 'daily_limit');
  assert.equal(net.slack.filter(isLimitNotice).length, 1);
});

test('Resend の毎秒の制限で retry-after が長すぎる: 待たずに send_failed', needsSqlite, async () => {
  installFetch({ resend: () => resend429('rate_limit_exceeded', 60) });
  const { env } = setup();
  assert.deepEqual(await submit(env), { status: 502, body: { ok: false, error: 'send_failed' } });
  assert.equal(net.resend.length, 1);
  assert.ok(net.slack[0].includes('待ち時間が長いため再送せず'));
});

test('name の無い 429: retry-after が長ければ送信枠切れ、無ければ既定の1秒待って再送', needsSqlite, async () => {
  installFetch({ resend: () => resend429(undefined, 7200) });
  const quota = setup();
  assert.deepEqual(await submit(quota.env), { status: 503, body: { ok: false, error: 'daily_limit' } });
  assert.equal(net.resend.length, 1);
  assert.equal(quota.counter.status().quota_429, 1);

  installFetch({ resend: (n) => (n === 1 ? resend429(undefined) : resendOk()) });
  const rate = setup();
  const started = Date.now();
  assert.deepEqual(await submit(rate.env), { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 2);
  assert.ok(Date.now() - started >= 900, '既定の待ち時間（1秒）');
});

test('カウンタのバインディングが無い: fail open で送り、Slack に警告（個人データなし）', async () => {
  const env = baseEnv({ CONTACT_DAILY_MAIL_CAP: '0' });
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 1);
  const alerts = net.slack.filter(isCounterAlert);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes('上限なしで送信しています'));
  assert.ok(alerts[0].includes('バインディング CONTACT_COUNTER が未設定'));
  assertNoPersonalData();
});

test('カウンタの警告は isolate ごとに最短10分に1回', async () => {
  const realNow = Date.now;
  let now = Date.parse('2026-10-04T05:00:00Z');
  Date.now = () => now;
  try {
    const env = baseEnv();
    await submit(env);
    await submit(env);
    now += COUNTER_ALERT_INTERVAL_MS - 1;
    await submit(env);
    assert.equal(net.slack.filter(isCounterAlert).length, 1);
    now += 1;
    await submit(env);
    assert.equal(net.slack.filter(isCounterAlert).length, 2);
    assert.equal(net.resend.length, 4, '警告を出しても送信は止めない');
  } finally {
    Date.now = realNow;
  }
});

test('SLACK_WEBHOOK が無ければ、カウンタの警告は出さずに送る', async () => {
  const env = baseEnv();
  delete env.SLACK_WEBHOOK;
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(net.slack.length, 0);
});

test('カウンタが例外を投げる・異常応答: fail open で送る', async () => {
  const throwing = { idFromName: () => ({}), get: () => ({ fetch: async () => { throw new Error('DO down'); } }) };
  assert.deepEqual(await submit(baseEnv({ CONTACT_COUNTER: throwing })), { status: 200, body: { ok: true } });

  const broken = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response('err', { status: 500 }) }) };
  assert.deepEqual(await submit(baseEnv({ CONTACT_COUNTER: broken })), { status: 200, body: { ok: true } });

  const garbage = { idFromName: () => ({}), get: () => ({ fetch: async () => Response.json({ hello: 1 }) }) };
  assert.deepEqual(await submit(baseEnv({ CONTACT_COUNTER: garbage })), { status: 200, body: { ok: true } });

  const throwsOnGet = { idFromName: () => { throw new Error('bad ns'); }, get: () => null };
  assert.deepEqual(await submit(baseEnv({ CONTACT_COUNTER: throwsOnGet })), { status: 200, body: { ok: true } });

  assert.equal(net.resend.length, 4);
  const alerts = net.slack.filter(isCounterAlert);
  assert.equal(alerts.length, 1, '同じ isolate では10分に1回');
  assert.ok(alerts[0].includes('応答しない・異常な応答'));
});

test('カウンタなしで Resend が送信枠切れ: daily_limit を返し、件数不明なので毎回 Slack に知らせる', async () => {
  installFetch({ resend: () => resend429('daily_quota_exceeded') });
  const env = baseEnv();
  assert.equal((await submit(env)).body.error, 'daily_limit');
  assert.equal((await submit(env)).body.error, 'daily_limit');
  assert.equal(net.slack.filter(isLimitNotice).length, 2);
});

test('既存の検査で落ちた送信はカウンタに触れない', needsSqlite, async () => {
  const cases = [
    [{ company_url: 'https://spam.example' }, 200, true], // honeypot は成功を装う
    [{ t: '100' }, 400, 'too_fast'],
    [{ kind: '' }, 400, 'invalid'],
    [{ email: 'not-an-email' }, 400, 'invalid'],
    [{ message: '短い' }, 400, 'invalid'],
    [{ message: 'https://a.example https://b.example https://c.example 本文' }, 400, 'too_many_links'],
  ];
  for (const [overrides, status, expected] of cases) {
    const { env, ns } = setup();
    const res = await submit(env, overrides);
    assert.equal(res.status, status, JSON.stringify(overrides));
    if (expected === true) assert.equal(res.body.ok, true);
    else assert.equal(res.body.error, expected);
    assert.deepEqual(ns.calls, [], `カウンタ未使用: ${JSON.stringify(overrides)}`);
  }

  installFetch({ turnstile: false });
  const { env, ns } = setup();
  assert.deepEqual(await submit(env), { status: 400, body: { ok: false, error: 'captcha' } });
  assert.deepEqual(ns.calls, []);

  installFetch();
  const limited = setup();
  limited.env.RATE_LIMITER = { limit: async () => ({ success: false }) };
  assert.deepEqual(await submit(limited.env), { status: 429, body: { ok: false, error: 'rate_limited' } });
  assert.deepEqual(limited.ns.calls, []);

  const noSecret = setup();
  delete noSecret.env.RESEND_API_KEY;
  assert.deepEqual(await submit(noSecret.env), { status: 503, body: { ok: false, error: 'send_failed' } });
  assert.deepEqual(noSecret.ns.calls, []);
  assert.equal(net.resend.length, 0);
});

// --- Cloudflare Email Sending（CONTACT_MAIL_PROVIDER = "cloudflare"）→ 送れなければ Resend --------------------

/**
 * env.CONTACT_EMAIL（send_email 束縛）の代わり。behavior(message, 何通目) の戻り値・例外をそのまま send が返す・投げる
 * （同期で投げれば同期の例外）。send は env のメソッドとして呼ばれたときだけ動く。取り出して呼ぶと、本番の workerd と
 * 同じく TypeError（Illegal invocation）を投げる。
 */
function fakeBinding(behavior = async () => ({ messageId: '<m1@send.eivrad.com>' })) {
  const binding = {
    calls: [],
    send(message) {
      if (this !== binding) throw new TypeError('Illegal invocation');
      binding.calls.push(message);
      return behavior(message, binding.calls.length);
    },
  };
  return binding;
}

/** env.CONTACT_COUNTER の代わり。本物の Durable Object と同じく、名前ごとに別の ContactMailCounter を持つ */
function namedCounters(clock) {
  const objects = new Map();
  const ns = {
    calls: [],
    names: [],
    of(name) {
      if (!objects.has(name)) objects.set(name, new ContactMailCounter(sqliteStorage().ctx, {}, clock.now));
      return objects.get(name);
    },
    idFromName(name) {
      ns.names.push(name);
      return { name };
    },
    get(id) {
      return {
        fetch: async (url, init) => {
          ns.calls.push(`${id.name} ${(init && init.method) || 'GET'} ${new URL(url).pathname}`);
          return ns.of(id.name).fetch(new Request(url, init));
        },
      };
    },
  };
  return ns;
}

function cfSetup({ cap = '20', cfCap = '100', provider = 'cloudflare', at = '2026-10-04T05:00:00Z', binding = fakeBinding() } = {}) {
  const clock = clockAt(at);
  const ns = namedCounters(clock);
  const env = baseEnv({
    NOTIFY_TO: NOTIFY_ADDRESS, // 本番の secret と同じ contact@eivrad.com（Cloudflare の経路はこれと同じときだけ使う）
    CONTACT_DAILY_MAIL_CAP: cap,
    CONTACT_CF_DAILY_CAP: cfCap,
    CONTACT_MAIL_PROVIDER: provider,
    CONTACT_COUNTER: ns,
    CONTACT_EMAIL: binding,
  });
  return { clock, ns, env, binding };
}

const isFallbackNotice = (text) => text.includes('Cloudflare Email Sending で送れなかったため');
const isCfCapNotice = (text) => text.includes('Cloudflare 経路の日次上限');
const SUBJECT_RE = /^\[お問い合わせ\/個人情報の開示等のご請求\] \d{2}\/\d{2} \d{2}:\d{2} 受付$/;

/** Cloudflare のエラー（本番の束縛と同じく Error に code。message には問い合わせ者のアドレスと氏名を入れておく） */
const cfError = (code) => Object.assign(new Error(`delivery for ${PERSON.email} (${PERSON.name}) failed`), { code });

test('送り方の読み取り: "cloudflare" だけ Cloudflare、無い・不正な値は "resend"', () => {
  assert.equal(parseProvider('cloudflare'), 'cloudflare');
  assert.equal(parseProvider(' Cloudflare '), 'cloudflare');
  for (const v of ['resend', undefined, null, '', ' ', 'sendgrid', 'cf', 'cloudflare_all', 'cloudflare,resend']) {
    assert.equal(parseProvider(v), 'resend', `parseProvider(${JSON.stringify(v)})`);
  }
  assert.equal(DEFAULT_CF_DAILY_CAP, 100);
  assert.equal(parseCap(undefined, DEFAULT_CF_DAILY_CAP), 100);
  assert.equal(parseCap('abc', DEFAULT_CF_DAILY_CAP), 100);
  assert.equal(parseCap('0', DEFAULT_CF_DAILY_CAP), 0);
  assert.equal(parseCap('7', DEFAULT_CF_DAILY_CAP), 7);
  assert.equal(CF_COUNTER_NAME, 'cf-daily');
  assert.ok(CF_SEND_TIMEOUT_MS > 0 && CF_SEND_TIMEOUT_MS <= 10000, '時間切れは短く（10秒以内）');
});

test('理由のコード: E_… の形だけを通し、TypeError は E_TYPE_ERROR、それ以外は E_UNKNOWN（message は見ない）', () => {
  assert.equal(failureCode(cfError('E_RECIPIENT_SUPPRESSED')), 'E_RECIPIENT_SUPPRESSED');
  assert.equal(failureCode({ code: 'E_INTERNAL_SERVER_ERROR' }), 'E_INTERNAL_SERVER_ERROR');
  assert.equal(failureCode(new TypeError('Illegal invocation')), 'E_TYPE_ERROR');
  for (const bad of [new Error('x'), cfError(`E_X ${PERSON.email}`), cfError('e_lower'), cfError(''), 'E_STRING', null, undefined, 42]) {
    assert.equal(failureCode(bad), 'E_UNKNOWN');
  }
});

test('件名: 種別と受付の時刻（日本時間）だけで、氏名を入れない', () => {
  assert.equal(contactSubject('その他', Date.parse('2026-10-04T05:07:00Z')), '[お問い合わせ/その他] 10/04 14:07 受付');
  assert.equal(contactSubject('その他', Date.parse('2026-10-04T15:30:00Z')), '[お問い合わせ/その他] 10/05 00:30 受付');
  assert.equal(contactSubject('その他', Date.parse('2026-12-31T15:00:00Z')), '[お問い合わせ/その他] 01/01 00:00 受付');
});

test('偽の束縛は、env から取り出して呼ぶと TypeError（本番の Illegal invocation と同じ）', () => {
  const binding = fakeBinding();
  const { send } = binding;
  assert.throws(() => send({}), TypeError);
  assert.equal(binding.calls.length, 0);
});

test('Cloudflare: 束縛で1通送り、Resend も Resend の日次枠も使わない（差出人・宛先・Reply-To・件名・本文）', needsSqlite, async () => {
  const { env, binding, ns } = cfSetup();
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(binding.calls.length, 1);
  const m = binding.calls[0];
  assert.deepEqual(Object.keys(m).sort(), ['from', 'replyTo', 'subject', 'text', 'to'], 'html・headers・cc・bcc は渡さない');
  assert.deepEqual(m.from, { name: 'Eivrad お問い合わせ', email: 'form@send.eivrad.com' });
  assert.deepEqual(m.from, { ...FROM });
  assert.equal(m.to, 'contact@eivrad.com', '宛先はコードで固定した contact@eivrad.com（文字列1つ）');
  assert.equal(NOTIFY_ADDRESS, 'contact@eivrad.com');
  assert.equal(m.replyTo, PERSON.email, '問い合わせ者は Reply-To');
  assert.match(m.subject, SUBJECT_RE);
  assert.ok(!m.subject.includes(PERSON.name), '件名に氏名を入れない');
  assert.ok(m.text.includes(`お名前 : ${PERSON.name}`));
  assert.ok(m.text.includes(`メール : ${PERSON.email}`));
  assert.ok(m.text.includes(PERSON.message));
  assert.equal(net.resend.length, 0, 'Resend は呼ばない');
  assert.deepEqual(ns.calls, ['cf-daily POST /reserve'], 'Resend の日次枠（resend-daily）には触れない');
  assert.deepEqual(ns.of('cf-daily').status(), { ok: true, day: '2026-10-04', used: 1, rejected: 0, quota_429: 0 });
  assert.deepEqual(net.slack.map(isArrivalNotice), [true], 'Slack は従来どおり「届きました」だけ');
  assertNoPersonalData();
});

test('Cloudflare の失敗はどれも Resend に回す（各エラーコード・同期の例外・TypeError・コードなし・Error 以外）', needsSqlite, async () => {
  const cases = [
    ...[
      'E_VALIDATION_ERROR',
      'E_FIELD_MISSING',
      'E_SENDER_NOT_VERIFIED',
      'E_SENDER_DOMAIN_NOT_AVAILABLE',
      'E_RECIPIENT_NOT_ALLOWED',
      'E_RECIPIENT_SUPPRESSED',
      'E_CONTENT_TOO_LARGE',
      'E_DELIVERY_FAILED',
      'E_RATE_LIMIT_EXCEEDED',
      'E_DAILY_LIMIT_EXCEEDED',
      'E_INTERNAL_SERVER_ERROR',
      'E_HEADER_NOT_ALLOWED',
    ].map((code) => [code, 'reject', async () => { throw cfError(code); }]),
    ['E_SENDER_NOT_VERIFIED', '同期の例外', () => { throw cfError('E_SENDER_NOT_VERIFIED'); }],
    ['E_TYPE_ERROR', '同期の TypeError', () => { throw new TypeError(`Illegal invocation ${PERSON.email}`); }],
    ['E_TYPE_ERROR', 'TypeError の reject', async () => { throw new TypeError('x'); }],
    ['E_UNKNOWN', 'code なし', async () => { throw new Error(`no code ${PERSON.email}`); }],
    ['E_UNKNOWN', '形のおかしい code', async () => { throw cfError(`E_BAD ${PERSON.email}`); }],
    ['E_UNKNOWN', '文字列を投げる', async () => { throw `string ${PERSON.email}`; }],
    ['E_UNKNOWN', 'null を投げる', async () => { throw null; }],
    ['E_INTERNAL_SERVER_ERROR', 'Error でない object', async () => { throw { code: 'E_INTERNAL_SERVER_ERROR', message: PERSON.email }; }],
  ];
  for (const [code, how, behavior] of cases) {
    const label = `${code}（${how}）`;
    installFetch();
    resetFallbackAlert();
    const { env, binding, ns } = cfSetup({ binding: fakeBinding(behavior) });
    assert.deepEqual(await submit(env), { status: 200, body: { ok: true } }, label);
    assert.equal(binding.calls.length, 1, label);
    assert.equal(net.resend.length, 1, `Resend で1通: ${label}`);
    assert.equal(net.resend[0].subject, binding.calls[0].subject, `同じ件名: ${label}`);
    assert.equal(net.resend[0].text, binding.calls[0].text, `同じ本文: ${label}`);
    assert.equal(net.resend[0].reply_to, PERSON.email, label);
    assert.equal(net.resend[0].from, 'Eivrad お問い合わせ <form@send.eivrad.com>', label);
    assert.deepEqual(ns.calls, ['cf-daily POST /reserve', 'cf-daily POST /release', 'resend-daily POST /reserve'], label);
    assert.equal(ns.of('cf-daily').status().used, 0, `受け付けられなかった1通は Cloudflare の枠に数えない: ${label}`);
    assert.equal(ns.of('resend-daily').status().used, 1, label);
    const fallback = net.slack.filter(isFallbackNotice);
    assert.equal(fallback.length, 1, label);
    assert.ok(fallback[0].includes(`（${code}）`), `理由のコード: ${label} → ${fallback[0]}`);
    assert.equal(net.slack.filter(isArrivalNotice).length, 1, label);
    assertNoPersonalData();
  }
});

test('Cloudflare が時間切れ: 結果不明として Resend に回し、Cloudflare の枠は数えたまま（二重に届くことは許す）', needsSqlite, async () => {
  setCloudflareTimeoutForTest(30);
  const { env, binding, ns } = cfSetup({ binding: fakeBinding(() => new Promise(() => {})) });
  const started = Date.now();
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.ok(Date.now() - started < 2000, '時間切れで待つのをやめる');
  assert.equal(binding.calls.length, 1);
  assert.equal(net.resend.length, 1);
  assert.deepEqual(ns.calls, ['cf-daily POST /reserve', 'resend-daily POST /reserve'], '時間切れは枠を返さない');
  assert.equal(ns.of('cf-daily').status().used, 1);
  assert.ok(net.slack.filter(isFallbackNotice)[0].includes('（E_TIMEOUT）'));
  assert.equal(net.slack.filter(isArrivalNotice).length, 1);
  assertNoPersonalData();
});

test('CONTACT_DAILY_MAIL_CAP = "0" はフォームを止める: Cloudflare も Resend も呼ばず daily_limit', needsSqlite, async () => {
  const { env, binding, ns } = cfSetup({ cap: '0' });
  assert.deepEqual(await submit(env), { status: 503, body: { ok: false, error: 'daily_limit' } });
  assert.deepEqual(await submit(env), { status: 503, body: { ok: false, error: 'daily_limit' } });
  assert.equal(binding.calls.length, 0, 'Cloudflare を呼ばない');
  assert.equal(net.resend.length, 0, 'Resend を呼ばない');
  assert.ok(!ns.calls.some((c) => c.startsWith('cf-daily')), 'Cloudflare の枠に触れない');
  assert.equal(net.slack.length, 1);
  assert.ok(isLimitNotice(net.slack[0]) && net.slack[0].includes('日次上限（0通）'));
  assert.equal(net.slack.filter(isFallbackNotice).length, 0);
});

test('Cloudflare 経路の日次枠（cf-daily）: 上限で Resend 経路に回し、通知は1日1回、UTC 0時で戻る', needsSqlite, async () => {
  const { env, binding, ns, clock } = cfSetup({ cfCap: '2', cap: '20', at: '2026-10-04T23:50:00Z' });
  for (let i = 0; i < 2; i += 1) assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(binding.calls.length, 2);
  assert.equal(net.resend.length, 0);

  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(binding.calls.length, 2, '上限の後は Cloudflare を呼ばない');
  assert.equal(net.resend.length, 2, '上限の後は Resend');
  const capNotices = net.slack.filter(isCfCapNotice);
  assert.equal(capNotices.length, 1, '上限の通知は1日1回');
  assert.ok(capNotices[0].includes('Cloudflare 経路の日次上限（2通）'));
  assert.ok(capNotices[0].includes('フォームの日次上限 20通'));
  assert.equal(net.slack.filter(isFallbackNotice).length, 0, '上限は「送れなかった」の通知にしない');
  assert.deepEqual(ns.of('cf-daily').status(), { ok: true, day: '2026-10-04', used: 2, rejected: 2, quota_429: 0 });
  assert.equal(ns.of('resend-daily').status().used, 2);

  clock.set('2026-10-05T00:00:01Z'); // JST 9:00
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(binding.calls.length, 3, 'UTC 0時を過ぎれば Cloudflare に戻る');
  assert.equal(net.resend.length, 2);
  assertNoPersonalData();
});

test('CONTACT_CF_DAILY_CAP = "0" は Cloudflare を使わない（Resend だけ・通知なし）', needsSqlite, async () => {
  const { env, binding, ns } = cfSetup({ cfCap: '0' });
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(binding.calls.length, 0);
  assert.equal(net.resend.length, 1);
  assert.deepEqual(ns.calls, ['resend-daily POST /reserve']);
  assert.deepEqual(net.slack.map(isArrivalNotice), [true]);
});

test('Cloudflare 経路の日次カウンタが使えない: fail open で Cloudflare から送り、Slack に警告（10分に1回）', async () => {
  const noCounter = cfSetup().env;
  delete noCounter.CONTACT_COUNTER;
  assert.deepEqual(await submit(noCounter), { status: 200, body: { ok: true } });
  assert.equal(noCounter.CONTACT_EMAIL.calls.length, 1);
  assert.equal(net.resend.length, 0);
  const alerts = net.slack.filter(isCounterAlert);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes('Cloudflare 経路の日次カウンタが使えないため（バインディング CONTACT_COUNTER が未設定）'));

  for (const broken of [
    { idFromName: () => ({}), get: () => ({ fetch: async () => { throw new Error('DO down'); } }) },
    { idFromName: () => ({}), get: () => ({ fetch: async () => new Response('err', { status: 500 }) }) },
    { idFromName: () => { throw new Error('bad ns'); }, get: () => null },
  ]) {
    const { env, binding } = cfSetup();
    env.CONTACT_COUNTER = broken;
    assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
    assert.equal(binding.calls.length, 1, 'カウンタが壊れていても Cloudflare で送る');
  }
  assert.equal(net.resend.length, 0);
  assert.equal(net.slack.filter(isCounterAlert).length, 1, '同じ isolate では10分に1回');
  assert.equal(net.slack.filter(isArrivalNotice).length, 4);
  assertNoPersonalData();
});

test('カウンタが使えず Cloudflare も失敗: Resend へ fail open で送り、警告は1回', async () => {
  const { env, binding } = cfSetup({ binding: fakeBinding(async () => { throw cfError('E_INTERNAL_SERVER_ERROR'); }) });
  delete env.CONTACT_COUNTER;
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(binding.calls.length, 1);
  assert.equal(net.resend.length, 1);
  assert.equal(net.slack.filter(isCounterAlert).length, 1);
  assert.equal(net.slack.filter(isFallbackNotice).length, 1);
  assertNoPersonalData();
});

test('CONTACT_MAIL_PROVIDER が "resend"・無い・不正な値: 束縛を呼ばず、従来どおり Resend だけ', needsSqlite, async () => {
  for (const provider of ['resend', undefined, '', 'sendgrid', 'cf', 'cloudflare_all']) {
    installFetch();
    const { env, binding, ns } = cfSetup({ provider });
    if (provider === undefined) delete env.CONTACT_MAIL_PROVIDER;
    assert.deepEqual(await submit(env), { status: 200, body: { ok: true } }, String(provider));
    assert.equal(binding.calls.length, 0, `束縛を呼ばない: ${provider}`);
    assert.equal(net.resend.length, 1);
    assert.match(net.resend[0].subject, SUBJECT_RE);
    assert.deepEqual(ns.calls, ['resend-daily POST /reserve'], `Cloudflare の枠に触れない: ${provider}`);
    assert.deepEqual(net.slack.map(isArrivalNotice), [true], `「送れなかった」の通知も出さない: ${provider}`);
  }
});

test('件名に氏名を入れない（Cloudflare・Resend とも同じ件名。時刻は日本時間）', needsSqlite, async () => {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-04T05:07:00Z'); // JST 14:07
  try {
    const viaCf = cfSetup();
    await submit(viaCf.env);
    assert.equal(viaCf.binding.calls[0].subject, '[お問い合わせ/個人情報の開示等のご請求] 10/04 14:07 受付');

    const viaResend = cfSetup({ provider: 'resend' });
    await submit(viaResend.env, { kind: 'その他' });
    assert.equal(net.resend[0].subject, '[お問い合わせ/その他] 10/04 14:07 受付');

    for (const subject of [viaCf.binding.calls[0].subject, net.resend[0].subject]) {
      assert.ok(!subject.includes(PERSON.name) && !subject.includes('試験') && !subject.includes('様'), subject);
    }
    assert.ok(net.resend[0].text.includes(`お名前 : ${PERSON.name}`), '氏名は本文にだけ書く');
  } finally {
    Date.now = realNow;
  }
});

test('Cloudflare も Resend も失敗: 502 send_failed、Slack の失敗通知に両方の理由（コードだけ）', needsSqlite, async () => {
  installFetch({ resend: () => new Response('{"message":"boom"}', { status: 500 }) });
  const { env, ns } = cfSetup({ binding: fakeBinding(async () => { throw cfError('E_INTERNAL_SERVER_ERROR'); }) });
  assert.deepEqual(await submit(env), { status: 502, body: { ok: false, error: 'send_failed' } });
  assert.equal(net.resend.length, 1);
  assert.equal(ns.of('resend-daily').status().used, 0, 'Resend の枠も返す');
  assert.equal(ns.of('cf-daily').status().used, 0);
  const failures = net.slack.filter(isFailureNotice);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes('種別: 個人情報の開示等のご請求・Cloudflare E_INTERNAL_SERVER_ERROR → Resend 500'), failures[0]);
  assert.equal(net.slack.filter(isArrivalNotice).length, 0);
  assertNoPersonalData();
});

test('Cloudflare が失敗し、Resend の日次上限・送信枠切れに当たる: daily_limit（直接メールの案内）', needsSqlite, async () => {
  const failing = () => fakeBinding(async () => { throw cfError('E_SENDER_NOT_VERIFIED'); });
  const { env, binding } = cfSetup({ cap: '1', binding: failing() });
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } }); // Resend の枠 1/1
  assert.deepEqual(await submit(env), { status: 503, body: { ok: false, error: 'daily_limit' } });
  assert.equal(binding.calls.length, 2, 'Cloudflare は毎回先に試す');
  assert.equal(net.resend.length, 1);
  assert.equal(net.slack.filter(isLimitNotice).length, 1);

  installFetch({ resend: () => resend429('daily_quota_exceeded') });
  const quota = cfSetup({ binding: failing() });
  assert.deepEqual(await submit(quota.env), { status: 503, body: { ok: false, error: 'daily_limit' } });
  assert.ok(net.slack.some((t) => t.includes('Resend の送信枠（429 daily_quota_exceeded）')));
  assertNoPersonalData();
});

test('「Resend に回した」通知は isolate ごとに最短10分に1回（送信はその都度 Resend で行う）', needsSqlite, async () => {
  const realNow = Date.now;
  let now = Date.parse('2026-10-04T05:00:00Z');
  Date.now = () => now;
  try {
    const { env } = cfSetup({ binding: fakeBinding(async () => { throw cfError('E_RECIPIENT_NOT_ALLOWED'); }) });
    await submit(env);
    await submit(env);
    now += FALLBACK_ALERT_INTERVAL_MS - 1;
    await submit(env);
    assert.equal(net.slack.filter(isFallbackNotice).length, 1);
    now += 1;
    await submit(env);
    assert.equal(net.slack.filter(isFallbackNotice).length, 2);
    assert.equal(net.resend.length, 4);
    assert.equal(net.slack.filter(isArrivalNotice).length, 4, '「届きました」は毎回');
  } finally {
    Date.now = realNow;
  }
});

test('"cloudflare" なのに束縛が無い: E_BINDING_MISSING として Resend に回す（Cloudflare の枠に触れない）', needsSqlite, async () => {
  const { env, ns } = cfSetup();
  delete env.CONTACT_EMAIL;
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 1);
  assert.deepEqual(ns.calls, ['resend-daily POST /reserve']);
  assert.ok(net.slack.filter(isFallbackNotice)[0].includes('（E_BINDING_MISSING）'));
});

// --- 宛先の固定（束縛は差出人しか絞らないので、宛先はコードだけが決める） --------------------------------

test('通知の宛先: NOTIFY_TO が contact@eivrad.com のときだけ（前後の空白・大文字小文字は問わない）', () => {
  for (const ok of ['contact@eivrad.com', ' Contact@Eivrad.COM ', 'contact@eivrad.com\n']) {
    assert.equal(isNotifyAddress(ok), true, JSON.stringify(ok));
  }
  for (const bad of [
    undefined,
    null,
    '',
    'notify@example.test',
    'contact@eivrad.co',
    'xcontact@eivrad.com',
    'contact@eivrad.com.evil.test',
    'contact@eivrad.com, evil@example.test',
    'contact@eivrad.com\r\nBcc: evil@example.test',
    '<contact@eivrad.com>',
    ['contact@eivrad.com'],
    { email: 'contact@eivrad.com' },
  ]) {
    assert.equal(isNotifyAddress(bad), false, JSON.stringify(bad));
  }
});

test('sendViaCloudflare は呼び出し側の宛先・cc・bcc・headers を使わず、contact@eivrad.com だけに送る', async () => {
  const binding = fakeBinding();
  const env = { CONTACT_EMAIL: binding, NOTIFY_TO: ' Contact@Eivrad.com ' };
  const res = await sendViaCloudflare(env, {
    to: 'evil@example.test',
    cc: 'evil@example.test',
    bcc: ['evil@example.test'],
    headers: { Bcc: 'evil@example.test' },
    replyTo: PERSON.email,
    subject: 's',
    text: 't',
  });
  assert.equal(res.ok, true);
  assert.equal(binding.calls.length, 1);
  const m = binding.calls[0];
  assert.deepEqual(Object.keys(m).sort(), ['from', 'replyTo', 'subject', 'text', 'to']);
  assert.equal(m.to, 'contact@eivrad.com');
  assert.ok(!JSON.stringify(m).includes('evil'), JSON.stringify(m));

  // NOTIFY_TO が違えば、束縛を呼ばない（宛先を NOTIFY_TO に変えて送ることもしない）
  const other = fakeBinding();
  const mismatch = await sendViaCloudflare({ CONTACT_EMAIL: other, NOTIFY_TO: 'evil@example.test' }, { replyTo: PERSON.email, subject: 's', text: 't' });
  assert.deepEqual(mismatch, { ok: false, code: CODE_NOTIFY_TO_MISMATCH });
  assert.equal(other.calls.length, 0);
});

test('NOTIFY_TO が contact@eivrad.com でない: 束縛を呼ばず E_NOTIFY_TO_MISMATCH で Resend（NOTIFY_TO 宛て）に回す', needsSqlite, async () => {
  for (const notifyTo of ['notify@example.test', 'contact@eivrad.com, evil@example.test', 'contact@eivrad.co', 'contact@eivrad.com\r\nBcc: evil@example.test']) {
    installFetch();
    resetFallbackAlert();
    const { env, binding, ns } = cfSetup();
    env.NOTIFY_TO = notifyTo;
    assert.deepEqual(await submit(env), { status: 200, body: { ok: true } }, notifyTo);
    assert.equal(binding.calls.length, 0, `束縛を呼ばない: ${notifyTo}`);
    assert.equal(net.resend.length, 1);
    assert.deepEqual(net.resend[0].to, [notifyTo], 'Resend の経路は今までどおり NOTIFY_TO へ');
    assert.deepEqual(ns.calls, ['resend-daily POST /reserve'], 'Cloudflare の枠に触れない');
    const fallback = net.slack.filter(isFallbackNotice);
    assert.equal(fallback.length, 1);
    assert.ok(fallback[0].includes('（E_NOTIFY_TO_MISMATCH）'), fallback[0]);
    assertNoPersonalData();
  }
});

test('wrangler.toml の send_email 束縛は差出人だけを絞り、宛先の制限（destination_address 等）を付けない', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const blocks = toml.split(/^(?=\[)/m).filter((b) => b.startsWith('[[send_email]]'));
  assert.equal(blocks.length, 1, 'send_email 束縛は1つ');
  const keys = blocks[0]
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')[0].trim());
  assert.deepEqual(keys.sort(), ['allowed_sender_addresses', 'name']);
  assert.match(blocks[0], /^name = "CONTACT_EMAIL"$/m);
  assert.match(blocks[0], /^allowed_sender_addresses = \["form@send\.eivrad\.com"\]$/m);
  assert.ok(!/^\s*(destination_address|allowed_destination_addresses)\s*=/m.test(toml), '宛先の制限は付けない');
  assert.equal(FROM.email, 'form@send.eivrad.com', 'コードの差出人と束縛の差出人が同じ');
});

test('SLACK_WEBHOOK が無くても Cloudflare の失敗は Resend で送る', needsSqlite, async () => {
  const { env } = cfSetup({ binding: fakeBinding(async () => { throw cfError('E_DELIVERY_FAILED'); }) });
  delete env.SLACK_WEBHOOK;
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 1);
  assert.equal(net.slack.length, 0);
});

test('既存の検査で落ちた送信は Cloudflare も呼ばない（改行の注入も含む）', needsSqlite, async () => {
  const cases = [
    [{ company_url: 'https://spam.example' }, 200, true],
    [{ t: '100' }, 400, 'too_fast'],
    [{ kind: '' }, 400, 'invalid'],
    [{ kind: 'その他\r\nBcc: evil@example.test' }, 400, 'invalid'],
    [{ email: 'not-an-email' }, 400, 'invalid'],
    [{ email: 'taro@example.test\r\nBcc: evil@example.test' }, 400, 'invalid'],
    [{ message: '短い' }, 400, 'invalid'],
    [{ message: 'https://a.example https://b.example https://c.example 本文' }, 400, 'too_many_links'],
  ];
  for (const [overrides, status, expected] of cases) {
    const { env, ns, binding } = cfSetup();
    const res = await submit(env, overrides);
    assert.equal(res.status, status, JSON.stringify(overrides));
    if (expected === true) assert.equal(res.body.ok, true);
    else assert.equal(res.body.error, expected);
    assert.equal(binding.calls.length, 0, `束縛を呼ばない: ${JSON.stringify(overrides)}`);
    assert.deepEqual(ns.calls, []);
  }
  installFetch({ turnstile: false });
  const captcha = cfSetup();
  assert.deepEqual(await submit(captcha.env), { status: 400, body: { ok: false, error: 'captcha' } });
  assert.equal(captcha.binding.calls.length, 0);

  installFetch();
  const limited = cfSetup();
  limited.env.RATE_LIMITER = { limit: async () => ({ success: false }) };
  assert.deepEqual(await submit(limited.env), { status: 429, body: { ok: false, error: 'rate_limited' } });
  assert.equal(limited.binding.calls.length, 0);

  const noSecret = cfSetup();
  delete noSecret.env.RESEND_API_KEY;
  assert.deepEqual(await submit(noSecret.env), { status: 503, body: { ok: false, error: 'send_failed' } });
  assert.equal(noSecret.binding.calls.length, 0, 'RESEND_API_KEY が無ければ（予備が無いので）Cloudflare でも送らない');

  // 氏名の改行は1行にまとめ、本文にだけ入る（件名・Reply-To には入らない）
  const crlf = cfSetup();
  assert.deepEqual(await submit(crlf.env, { name: '試験\r\nBcc: evil@example.test' }), { status: 200, body: { ok: true } });
  const m = crlf.binding.calls[0];
  assert.ok(m.text.includes('お名前 : 試験 Bcc: evil@example.test'));
  assert.ok(!/[\r\n]/.test(m.subject) && !m.subject.includes('evil'));
  assert.equal(m.replyTo, PERSON.email);
});
