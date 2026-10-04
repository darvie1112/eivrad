// お問い合わせ Worker の日次上限まわりのテスト（追加の npm パッケージなし）
//
//   node --test --disable-warning=ExperimentalWarning worker/test/
//
// 外部への通信はしない。fetch は差し替え、Turnstile / Resend / Slack 以外の宛先は失敗させる。
// Durable Object の SQL は node:sqlite（Node 22.5 以降）で本物の SQLite に流す。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker, { ContactMailCounter } from '../src/index.js';
import { parseCap, utcDayKey, DEFAULT_DAILY_MAIL_CAP } from '../src/counter.js';

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
      return resend();
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
  assert.deepEqual(counter.reserve(2), { ok: true, day: '2026-10-04', cap: 2, used: 1, rejected: 0 });
  assert.deepEqual(counter.reserve(2), { ok: true, day: '2026-10-04', cap: 2, used: 2, rejected: 0 });
  assert.deepEqual(counter.reserve(2), { ok: false, day: '2026-10-04', cap: 2, used: 2, rejected: 1 });
  assert.deepEqual(counter.reserve(2), { ok: false, day: '2026-10-04', cap: 2, used: 2, rejected: 2 });
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 2, rejected: 2 });
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
  assert.deepEqual(counter.release(slot.day, false), { ok: true, day: '2026-10-04', used: 0, rejected: 1 });
  assert.deepEqual(counter.release(slot.day, false), { ok: true, day: '2026-10-04', used: 0, rejected: 1 });
  assert.equal(counter.reserve(1).ok, true);
  assert.deepEqual(counter.release('not-a-day', false), { ok: false, error: 'day' });
});

test('カウンタ: UTC 0時で件数が戻り、0時をまたいだ返却は前日の枠を減らす', needsSqlite, () => {
  const { counter, clock } = setup({ at: '2026-10-04T23:59:59Z' });
  const late = counter.reserve(1);
  assert.equal(counter.reserve(1).ok, false);

  clock.set('2026-10-05T00:00:00Z'); // JST 9:00
  const next = counter.reserve(1);
  assert.equal(next.ok, true);
  assert.equal(next.day, '2026-10-05');

  counter.release(late.day, false);
  assert.deepEqual(counter.counts('2026-10-04'), { used: 0, rejected: 1 });
  assert.deepEqual(counter.counts('2026-10-05'), { used: 1, rejected: 0 });
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
  assert.deepEqual(columns, ['day', 'used', 'rejected']);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name), ['daily']);
});

test('カウンタ: fetch 窓口（reserve / release / status / 不明な経路）', needsSqlite, async () => {
  const { counter } = setup();
  const r1 = await (await counter.fetch(new Request('https://counter/reserve?cap=1', { method: 'POST' }))).json();
  assert.equal(r1.ok, true);
  const r2 = await (await counter.fetch(new Request('https://counter/reserve?cap=1', { method: 'POST' }))).json();
  assert.equal(r2.ok, false);
  const rel = await (await counter.fetch(new Request(`https://counter/release?day=${r1.day}&turned_away=1`, { method: 'POST' }))).json();
  assert.deepEqual(rel, { ok: true, day: '2026-10-04', used: 0, rejected: 2 });
  const st = await (await counter.fetch(new Request('https://counter/status'))).json();
  assert.deepEqual(st, { ok: true, day: '2026-10-04', used: 0, rejected: 2 });
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
  for (const v of Object.values(PERSON)) assert.ok(!net.slack[0].includes(v), 'Slack に個人データを載せない');
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 2, rejected: 2 });
});

test('上限到達後も UTC 0時（JST 9時）を過ぎれば再び送れる', needsSqlite, async () => {
  const { env, clock } = setup({ cap: '1', at: '2026-10-04T23:58:00Z' });
  assert.equal((await submit(env)).status, 200);
  assert.equal((await submit(env)).body.error, 'daily_limit');
  clock.set('2026-10-05T00:00:01Z');
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 2);
});

test('Resend が失敗（500）: 枠を返し、従来どおり 502 send_failed', needsSqlite, async () => {
  installFetch({ resend: () => new Response('{"message":"boom"}', { status: 500 }) });
  const { env, ns, counter } = setup({ cap: '1' });
  const res = await submit(env);
  assert.deepEqual(res, { status: 502, body: { ok: false, error: 'send_failed' } });
  assert.deepEqual(ns.calls, ['POST /reserve', 'POST /release']);
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 0, rejected: 0 });
  assert.deepEqual(net.slack.map(isArrivalNotice), [true], 'Slack の保険通知は従来どおり');

  // 返した枠で次の送信が通る
  installFetch();
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
});

test('Resend への通信が例外: 枠を返し、502 send_failed', needsSqlite, async () => {
  installFetch({ resend: () => { throw new TypeError('network down'); } });
  const { env, counter } = setup({ cap: '1' });
  const res = await submit(env);
  assert.deepEqual(res, { status: 502, body: { ok: false, error: 'send_failed' } });
  assert.equal(counter.status().used, 0);
});

test('Resend が 429: 枠を返して 503 daily_limit、到着通知は出さず上限通知を1回', needsSqlite, async () => {
  installFetch({
    resend: () => new Response('{"name":"daily_quota_exceeded","message":"quota"}', { status: 429 }),
  });
  const { env, ns, counter } = setup({ cap: '20' });
  const first = await submit(env);
  assert.deepEqual(first, { status: 503, body: { ok: false, error: 'daily_limit' } });
  assert.deepEqual(ns.calls, ['POST /reserve', 'POST /release']);
  assert.deepEqual(counter.status(), { ok: true, day: '2026-10-04', used: 0, rejected: 1 });
  assert.equal(net.slack.length, 1);
  assert.ok(isLimitNotice(net.slack[0]));
  assert.ok(net.slack[0].includes('Resend の送信枠（429）'));

  const second = await submit(env);
  assert.equal(second.body.error, 'daily_limit');
  assert.equal(net.slack.length, 1, '2件目以降は Slack に送らない');
  assert.equal(net.slack.filter(isArrivalNotice).length, 0);
});

test('カウンタのバインディングが無い: fail open で従来どおり送る', async () => {
  const env = baseEnv({ CONTACT_DAILY_MAIL_CAP: '0' });
  assert.deepEqual(await submit(env), { status: 200, body: { ok: true } });
  assert.equal(net.resend.length, 1);
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
});

test('カウンタなしで Resend が 429: daily_limit を返し、件数不明なので毎回 Slack に知らせる', async () => {
  installFetch({ resend: () => new Response('{}', { status: 429 }) });
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
