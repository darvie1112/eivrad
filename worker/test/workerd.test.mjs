// お問い合わせ Worker を、ローカルの workerd（Miniflare）で動かして確かめるテスト。メールは送らない。
//
//   CONTACT_NODE_MODULES=<miniflare と wrangler が入った node_modules> \
//   CONTACT_WORKER_BUNDLE=<wrangler deploy --dry-run --outdir の index.js（省略時は src/index.js をそのまま読む）> \
//   node --test --disable-warning=ExperimentalWarning worker/test/workerd.test.mjs
//
// deploy-contact-worker.zsh は、Commerce の node_modules（wrangler 4.129.0 と、それと同じ miniflare）と、dry-run で束ねた
// index.js（配信するものと同じ）を渡して実行する。CONTACT_NODE_MODULES が無ければ、このファイルのテストは省略になる。
//
// 設定は worker/wrangler.toml から読む（写しを持たない）: compatibility_date・[vars]・send_email 束縛・Durable Object・
// レート制限を、その node_modules の wrangler（unstable_readConfig と unstable_getMiniflareWorkerOptions。wrangler dev と同じ変換）で
// Miniflare の設定にする。[vars] は wrangler.toml の値だけを使い、.dev.vars・.env は読み込まない。テストで足すのは secret の
// 試験用の値・request.cf・外部への通信の受け口だけ。
//
// 確かめること（単体テストの偽の束縛では見つからない誤り）:
//   - 束ねた Worker が workerd で起動し、send_email 束縛 CONTACT_EMAIL（差出人だけを限定・宛先の制限なし）を呼んで、
//     Miniflare の束縛が組み立て形式（from {name, email}・to・replyTo・subject・text）の送信を contact@eivrad.com 宛てに受け付けること。
//   - NOTIFY_TO が contact@eivrad.com でなければ、コードが束縛を呼ばずに Resend 経路に回すこと（宛先はコードで固定）。
//   - 束縛の差出人の制限（allowed_sender_addresses）が効くこと（別の差出人だけを許す束縛では断られ、Resend 経路に回る）。
//   - CONTACT_MAIL_PROVIDER = "resend" では束縛を呼ばないこと。
//   - Durable Object の別オブジェクト cf-daily が workerd（SQLite）でも数え、上限で Resend 経路に回ること。
// 確かめられないこと: Miniflare の束縛は RPC のスタブなので、env から取り出して呼んでも通ってしまう（本番の束縛では
// "Illegal invocation" になりうる。EveVoice の Commerce/src/mail.ts の前例）。これは contact.test.mjs の偽の束縛
// （this が束縛でなければ TypeError を投げる）で確かめる。また Miniflare の例外には code が無いので、ここでは E_UNKNOWN になる。
// 宛先の制限を付けない束縛で、確認済みでない宛先に本番で送れるか（アカウントの条件）も、ここでは確かめられない。
// Miniflare の send_email はローカルの模擬で、外部へは送らない（remote = true を付けない）。Turnstile・Resend・Slack は
// outboundService で受け、request.cf も固定するので、外部への通信はしない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(HERE, '..');
const WRANGLER_TOML = join(WORKER_DIR, 'wrangler.toml');

let mf = null;
let fromToml = null;
let skipReason = false;
const nodeModules = process.env.CONTACT_NODE_MODULES || '';
if (!nodeModules) {
  skipReason = 'CONTACT_NODE_MODULES（miniflare と wrangler の入った node_modules）が無いため省略';
} else {
  try {
    const require = createRequire(join(dirname(nodeModules), 'noop.js'));
    mf = await import(pathToFileURL(require.resolve('miniflare')).href);
    fromToml = readWranglerToml(require('wrangler'));
  } catch (err) {
    skipReason = `miniflare か wrangler を読み込めないため省略（${String((err && err.message) || err).slice(0, 160)}）`;
  }
}
// workerd が起動しないなどで止まったままにならないよう、1件ごとに時間を区切る
const needsMiniflare = { skip: skipReason, timeout: 60000 };

/**
 * worker/wrangler.toml を wrangler で読み、Miniflare の設定（束縛の部分）にする。
 * [vars] は readConfig の値（wrangler.toml だけ）。unstable_getMiniflareWorkerOptions の bindings は .dev.vars・.env も
 * 混ぜるので使わない。
 */
function readWranglerToml(wrangler) {
  const config = wrangler.unstable_readConfig({ config: WRANGLER_TOML }, { hideWarnings: true });
  const { workerOptions } = wrangler.unstable_getMiniflareWorkerOptions(config);
  return {
    config,
    options: {
      compatibilityDate: workerOptions.compatibilityDate,
      compatibilityFlags: workerOptions.compatibilityFlags,
      durableObjects: workerOptions.durableObjects,
      ratelimits: workerOptions.ratelimits,
      email: workerOptions.email,
    },
    vars: { ...(config.vars || {}) },
  };
}

const NOTIFY_TO = 'contact@eivrad.com';
const SENDER = 'form@send.eivrad.com';
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

/**
 * vars: wrangler.toml の [vars] と secret の試験値に上書きする値。
 * sendEmail: 束縛の設定を差し替える（差出人の制限が効くことの確認だけで使う。ふだんは wrangler.toml のまま）。
 */
async function start(vars, { sendEmail } = {}) {
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
      // compatibility_date・束縛（send_email・Durable Object・レート制限）は wrangler.toml から
      ...fromToml.options,
      ...(sendEmail ? { email: { send_email: sendEmail } } : {}),
      log,
      // request.cf を固定する（既定では Miniflare が workers.cloudflare.com/cf.json を取りに行き、.wrangler/cache に置く）
      cf: { country: 'JP' },
      bindings: {
        ...fromToml.vars,
        TURNSTILE_SECRET: 'test-turnstile',
        RESEND_API_KEY: 'test-resend',
        NOTIFY_TO,
        SLACK_WEBHOOK: 'https://hooks.slack.test/T/B/X',
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
const fallbackNotices = (net) => net.slack.filter((t) => t.includes('Cloudflare Email Sending で送れなかったため'));

const assertNoPersonalData = (net) => {
  for (const text of net.slack) {
    for (const v of [...Object.values(PERSON), '203.0.113.9']) assert.ok(!text.includes(v), `Slack に個人データ: ${text}`);
  }
};

/** 模擬の出力は waitUntil の中で書かれるので、少しだけ待つ */
const settle = async (lines, count) => {
  for (let i = 0; i < 50 && sentByBinding(lines).length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
};

test('workerd の設定は worker/wrangler.toml から読む（互換日付・[vars]・差出人だけを限定した send_email 束縛）', needsMiniflare, () => {
  const text = readFileSync(WRANGLER_TOML, 'utf8');
  const date = (text.match(/^compatibility_date = "(\d{4}-\d{2}-\d{2})"$/m) || [])[1];
  assert.ok(date, 'wrangler.toml に compatibility_date がある');
  assert.equal(fromToml.config.compatibility_date, date);
  assert.equal(fromToml.options.compatibilityDate, date, 'workerd に渡す互換日付は wrangler.toml の値');
  // 値が undefined の鍵（remote など）は落として比べる
  assert.deepEqual(JSON.parse(JSON.stringify(fromToml.options.email)), { send_email: [{ name: 'CONTACT_EMAIL', allowed_sender_addresses: [SENDER] }] },
    '宛先の制限（destination_address・allowed_destination_addresses）は無く、差出人だけを限定');
  assert.deepEqual(fromToml.vars, {
    CONTACT_DAILY_MAIL_CAP: '20',
    CONTACT_MAIL_PROVIDER: 'cloudflare',
    CONTACT_CF_DAILY_CAP: '100',
  });
  assert.deepEqual(Object.keys(fromToml.options.durableObjects), ['CONTACT_COUNTER']);
  assert.equal(fromToml.options.durableObjects.CONTACT_COUNTER.className, 'ContactMailCounter');
  assert.equal(fromToml.options.durableObjects.CONTACT_COUNTER.useSQLite, true, 'migrations の new_sqlite_classes から');
  assert.deepEqual(Object.keys(fromToml.options.ratelimits), ['RATE_LIMITER']);
});

test('workerd: 束ねた Worker が send_email 束縛で contact@eivrad.com に送り、Resend を呼ばない（件名に氏名なし）', needsMiniflare, async () => {
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

test('workerd: NOTIFY_TO が contact@eivrad.com でなければ、束縛を呼ばずに同じ件名で Resend に回る（E_NOTIFY_TO_MISMATCH）', needsMiniflare, async () => {
  const { instance, net, lines } = await start({ NOTIFY_TO: 'someone-else@example.test' });
  try {
    assert.deepEqual(await submit(instance), { status: 200, body: { ok: true } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sentByBinding(lines).length, 0, '束縛を呼ばない');
    assert.equal(net.resend.length, 1, 'Resend で1通');
    assert.deepEqual(net.resend[0].to, ['someone-else@example.test'], 'Resend の経路は今までどおり NOTIFY_TO へ');
    assert.match(net.resend[0].subject, /^\[お問い合わせ\/Eve Voice について\] \d{2}\/\d{2} \d{2}:\d{2} 受付$/);
    assert.equal(net.resend[0].reply_to, PERSON.email);
    const fallback = fallbackNotices(net);
    assert.equal(fallback.length, 1);
    assert.ok(fallback[0].includes('（E_NOTIFY_TO_MISMATCH）'), fallback[0]);
    assert.ok(net.slack.some((t) => t.includes('お問い合わせが1件届きました')));
    assertNoPersonalData(net);
  } finally {
    await instance.dispose();
  }
});

test('workerd: 束縛の差出人の制限が効く（別の差出人だけを許す束縛では断られ、Resend に回る）', needsMiniflare, async () => {
  const { instance, net, lines } = await start({}, {
    sendEmail: [{ name: 'CONTACT_EMAIL', allowed_sender_addresses: ['someone-else@send.eivrad.com'] }],
  });
  try {
    assert.deepEqual(await submit(instance), { status: 200, body: { ok: true } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sentByBinding(lines).length, 0, '束縛は送らない');
    assert.equal(net.resend.length, 1, 'Resend で1通');
    const fallback = fallbackNotices(net);
    assert.equal(fallback.length, 1);
    assert.match(fallback[0], /（E_[A-Z0-9_]+）/, '理由はコードだけ');
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
