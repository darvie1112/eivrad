// お問い合わせ Worker の日次上限まわりのテスト（追加の npm パッケージなし）
//
//   node --test --disable-warning=ExperimentalWarning worker/test/
//
// 外部への通信はしない。fetch は差し替え、Turnstile / Resend / Slack 以外の宛先は失敗させる。
// Durable Object の SQL は node:sqlite（Node 22.5 以降）で本物の SQLite に流す。

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
