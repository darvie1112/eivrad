// お問い合わせ Worker を、ローカルの workerd（Miniflare）で動かして確かめるテスト。メールは送らない。
//
//   CONTACT_NODE_MODULES=<miniflare が入った node_modules> \
//   CONTACT_WORKER_BUNDLE=<wrangler deploy --dry-run --outdir の index.js（省略時は src/index.js をそのまま読む）> \
//   node --test --disable-warning=ExperimentalWarning worker/test/workerd.test.mjs
//
// deploy-contact-worker.zsh は、Commerce の node_modules（wrangler 4.129.0 と同じ miniflare）と、dry-run で束ねた
// index.js（配信するものと同じ）を渡して実行する。CONTACT_NODE_MODULES が無ければ、このファイルのテストは省略になる。
//
// 確かめること（単体テストの偽の束縛では見つからない誤り）:
//   - 束ねた Worker が workerd で起動し、send_email 束縛 CONTACT_EMAIL（宛先・差出人を限定）を呼んで、Miniflare の束縛が
//     組み立て形式（from {name, email}・to・replyTo・subject・text）の送信を受け付けること。
//   - 束縛の宛先（destination_address）と違う宛先だと束縛が例外を投げ、Resend 経路に回ること。
//   - CONTACT_MAIL_PROVIDER = "resend" では束縛を呼ばないこと。
//   - Durable Object の別オブジェクト cf-daily が workerd（SQLite）でも数え、上限で Resend 経路に回ること。
// 確かめられないこと: Miniflare の束縛は RPC のスタブなので、env から取り出して呼んでも通ってしまう（本番の束縛では
// "Illegal invocation" になりうる。EveVoice の Commerce/src/mail.ts の前例）。これは contact.test.mjs の偽の束縛
// （this が束縛でなければ TypeError を投げる）で確かめる。また Miniflare の例外には code が無いので、ここでは E_UNKNOWN になる。
// Miniflare の send_email はローカルの模擬で、外部へは送らない（remote = true を付けない）。Turnstile・Resend・Slack は
// outboundService で受け、request.cf も固定するので、外部への通信はしない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(HERE, '..');

let mf = null;
let skipReason = false;
const nodeModules = process.env.CONTACT_NODE_MODULES || '';
if (!nodeModules) {
  skipReason = 'CONTACT_NODE_MODULES（miniflare の入った node_modules）が無いため省略';
} else {
  try {
    const require = createRequire(join(dirname(nodeModules), 'noop.js'));
    mf = await import(pathToFileURL(require.resolve('miniflare')).href);
  } catch (err) {
    skipReason = `miniflare を読み込めないため省略（${String((err && err.message) || err).slice(0, 120)}）`;
  }
}
// workerd が起動しないなどで止まったままにならないよう、1件ごとに時間を区切る
const needsMiniflare = { skip: skipReason, timeout: 60000 };

const NOTIFY_TO = 'contact@eivrad.com';
const PERSON = { name: '試験 花子', email: 'hanako@example.test', message: 'workerd で確かめるためのお問い合わせ本文です。' };

/** Miniflare の出力を捕まえる（send_email の模擬はここに「送った内容」を出す） */
function captureLog() {
  const lines = [];
  class CaptureLog extends mf.Log {
    constructor() {
      super(mf.LogLevel.INFO);
    }
    logWithLevel(level, message) {
      lines.push(String(message).replace(/\x1b\[[0-9;]*m/g, ''));
    }
    log(message) {
      lines.push(String(message).replace(/\x1b\[[0-9;]*m/g, ''));
    }
  }
  return { log: new CaptureLog(), lines };
}

async function start(vars) {
  const net = { turnstile: 0, resend: [], slack: [], other: [] };
  const { log, lines } = captureLog();
  const bundle = process.env.CONTACT_WORKER_BUNDLE || '';
  // modulesRoot はモジュール名の基準。今のフォルダ（node --test を実行した場所）の外にある束ねたファイルを
  // 「../…」の名前で読ませると、workerd が起動時に internal error で止まるため、ファイルのあるフォルダにする。
  // 束ねたファイルが無ければ src/ の各モジュールをそのまま渡す（index.js を先頭に。Miniflare は import をたどらない）
  const srcDir = join(WORKER_DIR, 'src');
  const source = bundle
    ? { modules: true, scriptPath: bundle, modulesRoot: dirname(bundle) }
    : {
        modulesRoot: srcDir,
        modules: ['index.js', ...readdirSync(srcDir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort()].map((f) => ({
          type: 'ESModule',
          path: join(srcDir, f),
        })),
      };
  const instance = new mf.Miniflare(
    mf.convertV4MiniflareOptions({
      ...source,
      log,
      compatibilityDate: '2026-09-01',
      // request.cf を固定する（既定では Miniflare が workers.cloudflare.com/cf.json を取りに行き、.wrangler/cache に置く）
      cf: { country: 'JP' },
      durableObjects: { CONTACT_COUNTER: { className: 'ContactMailCounter', useSQLite: true } },
      ratelimits: { RATE_LIMITER: { namespace_id: '1001', simple: { limit: 100, period: 60 } } },
      email: {
        send_email: [
          { name: 'CONTACT_EMAIL', destination_address: 'contact@eivrad.com', allowed_sender_addresses: ['form@send.eivrad.com'] },
        ],
      },
      bindings: {
        TURNSTILE_SECRET: 'test-turnstile',
        RESEND_API_KEY: 'test-resend',
        NOTIFY_TO,
        SLACK_WEBHOOK: 'https://hooks.slack.test/T/B/X',
        CONTACT_DAILY_MAIL_CAP: '20',
        CONTACT_MAIL_PROVIDER: 'cloudflare',
        CONTACT_CF_DAILY_CAP: '100',
        ...vars,
      },
      outboundService: async (request) => {
        const url = request.url;
        if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
          net.turnstile += 1;
          return Response.json({ success: true });
        }
        if (url === 'https://api.resend.com/emails') {
          net.resend.push(await request.json());
          return new Response('{"id":"x"}', { status: 200 });
        }
        if (url === 'https://hooks.slack.test/T/B/X') {
          net.slack.push((await request.json()).text);
          return new Response('ok');
        }
        net.other.push(url);
        return new Response('unexpected', { status: 599 });
      },
    }),
  );
  try {
    await instance.ready;
  } catch (err) {
    await instance.dispose(); // 起動に失敗しても workerd を残さない（残るとテストが終わらない）
    throw err;
  }
  return { instance, net, lines };
}

async function submit(instance) {
  const body = new URLSearchParams({
    name: PERSON.name,
    email: PERSON.email,
    company: '',
    kind: 'Eve Voice について',
    message: PERSON.message,
    company_url: '',
    t: '5000',
    'cf-turnstile-response': 'token',
  });
  const res = await instance.dispatchFetch('https://eivrad.com/api/contact', {
    method: 'POST',
    headers: { Origin: 'https://eivrad.com', 'CF-Connecting-IP': '203.0.113.9', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { status: res.status, body: await res.json() };
}

/** Miniflare の send_email 模擬の出力（送った1通ごとに1件） */
const sentByBinding = (lines) => lines.filter((l) => l.includes('send_email binding called with MessageBuilder'));

const assertNoPersonalData = (net) => {
  for (const text of net.slack) {
    for (const v of [...Object.values(PERSON), '203.0.113.9']) assert.ok(!text.includes(v), `Slack に個人データ: ${text}`);
  }
};

/** 模擬の出力は waitUntil の中で書かれるので、少しだけ待つ */
const settle = async (lines, count) => {
  for (let i = 0; i < 50 && sentByBinding(lines).length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
};

test('workerd: 束ねた Worker が send_email 束縛で送り、Resend を呼ばない（件名に氏名なし）', needsMiniflare, async () => {
  const { instance, net, lines } = await start({});
  try {
    assert.deepEqual(await submit(instance), { status: 200, body: { ok: true } });
    await settle(lines, 1);
    const sent = sentByBinding(lines);
    assert.equal(sent.length, 1, `束縛で1通: ${lines.join(' | ').slice(0, 600)}`);
    assert.match(sent[0], /From: "?Eivrad お問い合わせ"? <form@send\.eivrad\.com>/);
    assert.match(sent[0], /To: contact@eivrad\.com/);
    assert.match(sent[0], /Subject: \[お問い合わせ\/Eve Voice について\] \d{2}\/\d{2} \d{2}:\d{2} 受付/);
    assert.ok(!sent[0].includes(PERSON.name), '件名・宛先の行に氏名が無い');
    assert.equal(net.resend.length, 0, 'Resend は呼ばない');
    assert.equal(net.turnstile, 1);
    assert.equal(net.slack.length, 1);
    assert.ok(net.slack[0].includes('お問い合わせが1件届きました'));
    assert.deepEqual(net.other, []);
    assertNoPersonalData(net);
  } finally {
    await instance.dispose();
  }
});

test('workerd: 束縛の宛先と違う NOTIFY_TO では束縛が例外を投げ、同じ件名で Resend に回る', needsMiniflare, async () => {
  const { instance, net, lines } = await start({ NOTIFY_TO: 'someone-else@example.test' });
  try {
    assert.deepEqual(await submit(instance), { status: 200, body: { ok: true } });
    assert.equal(sentByBinding(lines).length, 0);
    assert.equal(net.resend.length, 1, 'Resend で1通');
    assert.match(net.resend[0].subject, /^\[お問い合わせ\/Eve Voice について\] \d{2}\/\d{2} \d{2}:\d{2} 受付$/);
    assert.equal(net.resend[0].reply_to, PERSON.email);
    const fallback = net.slack.filter((t) => t.includes('Cloudflare Email Sending で送れなかったため'));
    assert.equal(fallback.length, 1);
    assert.match(fallback[0], /（E_[A-Z0-9_]+）/, '理由はコードだけ');
    assert.ok(net.slack.some((t) => t.includes('お問い合わせが1件届きました')));
    assertNoPersonalData(net);
  } finally {
    await instance.dispose();
  }
});

test('workerd: CONTACT_MAIL_PROVIDER = "resend" では束縛を呼ばない', needsMiniflare, async () => {
  const { instance, net, lines } = await start({ CONTACT_MAIL_PROVIDER: 'resend' });
  try {
    assert.deepEqual(await submit(instance), { status: 200, body: { ok: true } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sentByBinding(lines).length, 0);
    assert.equal(net.resend.length, 1);
    assert.equal(net.slack.filter((t) => t.includes('Cloudflare')).length, 0);
  } finally {
    await instance.dispose();
  }
});

test('workerd: Cloudflare 経路の日次枠（オブジェクト cf-daily）が数え、上限で Resend 経路に回る', needsMiniflare, async () => {
  const { instance, net, lines } = await start({ CONTACT_CF_DAILY_CAP: '1' });
  try {
    assert.deepEqual(await submit(instance), { status: 200, body: { ok: true } });
    assert.deepEqual(await submit(instance), { status: 200, body: { ok: true } });
    await settle(lines, 1);
    assert.equal(sentByBinding(lines).length, 1, '1通目だけ束縛');
    assert.equal(net.resend.length, 1, '2通目は Resend');
    assert.equal(net.slack.filter((t) => t.includes('Cloudflare 経路の日次上限（1通）')).length, 1);
    assert.equal(net.slack.filter((t) => t.includes('日次カウンタが使えない')).length, 0, 'Durable Object は動いている');
    assertNoPersonalData(net);
  } finally {
    await instance.dispose();
  }
});
