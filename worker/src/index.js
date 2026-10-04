/**
 * eivrad.com お問い合わせフォーム受付 Worker
 *
 * ルート : eivrad.com/api/contact*
 * 経路   : ブラウザ -> (同一オリジン) Worker -> Turnstile 検証 -> 日次枠の確保 -> Resend で通知
 *
 * 必要なシークレット (wrangler secret put <NAME>)
 *   TURNSTILE_SECRET  Turnstile の Secret Key
 *   RESEND_API_KEY    Resend の API キー
 *   NOTIFY_TO         通知先アドレス (contact@eivrad.com)
 *   SLACK_WEBHOOK     任意。メールが迷惑判定された場合の取りこぼし防止
 *
 * wrangler.toml の設定
 *   CONTACT_DAILY_MAIL_CAP  通知メールの日次上限（UTC の1日あたり。既定 20）
 *   CONTACT_COUNTER         日次カウンタの Durable Object（counter.js の ContactMailCounter）
 *
 * 設計上の約束
 *   - 通知メールの From は必ず自ドメイン。問い合わせ者は Reply-To に入れる。
 *     From に問い合わせ者を入れると au (p=reject) / docomo (sp=reject) からの通知が消える。
 *   - シークレット未設定時は fail closed（通してしまうより落とす）。
 *   - 自動返信は送らない。バックスキャッタ源になり送信者評価を落とすため。
 *   - 日次上限に達したら Resend を呼ばず daily_limit を返す。フォーム側で contact@eivrad.com への
 *     直接メールを案内する（特商法表記・プライバシーポリシーの問い合わせ窓口を閉じない）。
 *     Resend が送れなかったとき（send_failed）も、フォーム側は同じく直接メールを案内する。
 *   - 日次カウンタが無い・壊れた場合は fail open（上限なしで送る）。問い合わせを届けることを優先する。
 *     その間はライセンスメールと共有の Resend 枠を食いうるので、Slack に警告する（isolate ごとに10分に1回まで）。
 *   - Resend の 429 は本文の name で分ける。送信枠切れ（daily/monthly_quota_exceeded）は daily_limit。
 *     毎秒の送信数制限（rate_limit_exceeded）は retry-after だけ待って1回だけ再送し、それでも駄目なら send_failed。
 */

import {
  ContactMailCounter,
  RELEASE_QUOTA,
  parseCap,
  reserveDailySlot,
  releaseDailySlot,
  takeCounterAlert,
} from './counter.js';

// Durable Object のクラスは main モジュールから export する必要がある
export { ContactMailCounter };

const ALLOWED_ORIGIN = 'https://eivrad.com';

const KINDS = new Set([
  '制作・開発のご相談',
  'ゲッコー天気について',
  'Eve Voice について',
  '取材・掲載のご依頼',
  '個人情報の開示等のご請求',
  'その他',
]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_ELAPSED_MS = 3000;

const RESEND_URL = 'https://api.resend.com/emails';
/** Resend の 429 のうち、送信枠（日次・月次）切れを表す name（Resend 公式のエラー一覧） */
const RESEND_QUOTA_ERRORS = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);
/** 毎秒の送信数制限で再送するまで待つ時間。retry-after が無ければ1秒。これより長く待てと言われたら再送しない */
const RESEND_RETRY_DEFAULT_MS = 1000;
const RESEND_RETRY_MAX_MS = 5000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'same-origin',
    },
  });

/** ヘッダに入れる値から改行を除去する（件名インジェクション対策） */
const oneLine = (value, max) => String(value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

    // 別サイトに置かれたフォームからの投稿を弾く
    const origin = req.headers.get('Origin');
    if (origin && origin !== ALLOWED_ORIGIN) return json({ ok: false, error: 'origin' }, 403);

    // シークレットが欠けていたら通さない（fail closed）
    if (!env.TURNSTILE_SECRET || !env.RESEND_API_KEY || !env.NOTIFY_TO) {
      console.error('contact: 必要なシークレットが設定されていません');
      return json({ ok: false, error: 'send_failed' }, 503);
    }

    let form;
    try {
      form = await req.formData();
    } catch {
      return json({ ok: false, error: 'invalid' }, 400);
    }

    // (a) honeypot — 人には見えない項目。埋まっていたら成功を装って捨てる
    if (form.get('company_url')) return json({ ok: true });

    // (b) time-trap — クライアント側で計測した経過ミリ秒。時計ずれの影響を受けない
    const elapsed = Number(form.get('t') || 0);
    if (!Number.isFinite(elapsed) || elapsed < MIN_ELAPSED_MS) {
      return json({ ok: false, error: 'too_fast' }, 400);
    }

    // (c) IP あたりのレート制限（バインディングがある場合のみ）
    const ip = req.headers.get('CF-Connecting-IP') || '';
    if (env.RATE_LIMITER && ip) {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ ok: false, error: 'rate_limited' }, 429);
    }

    // (d) Turnstile のサーバ側検証。これを省くとウィジェットは飾りになる
    const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: String(form.get('cf-turnstile-response') || ''),
        remoteip: ip,
      }),
    })
      .then((r) => r.json())
      .catch(() => ({ success: false }));

    if (!verify.success) return json({ ok: false, error: 'captcha' }, 400);

    // (e) 入力の検証
    const name = oneLine(form.get('name') || '', 100);
    const email = oneLine(form.get('email') || '', 200);
    const company = oneLine(form.get('company') || '', 120);
    const kindRaw = oneLine(form.get('kind') || '', 60);
    const message = String(form.get('message') || '').trim().slice(0, 4000);

    // 未選択・不正値を 'その他' に丸めると「個人情報の開示等のご請求」が埋没する。弾く。
    if (!KINDS.has(kindRaw)) return json({ ok: false, error: 'invalid' }, 400);
    const kind = kindRaw;

    if (!name || !EMAIL_RE.test(email) || message.length < 10) {
      return json({ ok: false, error: 'invalid' }, 400);
    }
    if ((message.match(/https?:\/\//g) || []).length > 2) {
      return json({ ok: false, error: 'too_many_links' }, 400);
    }

    // (f) 日次上限の枠取り。ここまでの検査をすべて通った送信だけを数える。
    //     上限なら Resend を呼ばない。カウンタが使えなければ slot は null で、上限なしで送る（Slack に警告）。
    const cap = parseCap(env.CONTACT_DAILY_MAIL_CAP);
    const slot = await reserveDailySlot(env, cap);
    if (!slot) {
      await notifyCounterUnavailable(env);
    } else if (!slot.ok) {
      await notifyDailyLimit(env, `日次上限（${cap}通）`, slot.rejected);
      return json({ ok: false, error: 'daily_limit' }, 503);
    } else {
      // 件数だけを出す（wrangler tail で今日の消費を見るため）。個人データは出さない。
      console.log(`contact: 日次枠 ${slot.used}/${cap} (${slot.day} UTC)`);
    }

    // (g) 通知メール
    const country = req.cf && req.cf.country ? req.cf.country : '-';
    const text = [
      `種別   : ${kind}`,
      `お名前 : ${name}`,
      `会社名 : ${company || '-'}`,
      `メール : ${email}`,
      `発信国 : ${country}`,
      '',
      '----------------------------------------',
      message,
      '----------------------------------------',
      '',
      'このメールは eivrad.com のお問い合わせフォームから送信されました。',
      'そのまま返信すると、お問い合わせ者へ届きます。',
    ].join('\n');

    const mail = JSON.stringify({
      from: 'Eivrad お問い合わせ <form@send.eivrad.com>',
      to: [env.NOTIFY_TO],
      reply_to: email,
      subject: `[お問い合わせ/${kind}] ${name} 様`,
      text,
    });

    let sent = await postResend(env, mail);
    let limited = sent && sent.status === 429 ? await readResend429(sent) : null;
    let retried = false;
    // 毎秒の送信数制限（Commerce Worker と同じ Resend チームで共有）なら、少し待って1回だけ再送する。
    // 429 は Resend の枠を使っていないので、再送しても二重には数えられない。
    if (limited && limited.kind === 'rate' && limited.waitMs !== null) {
      await sleep(limited.waitMs);
      retried = true;
      sent = await postResend(env, mail);
      limited = sent && sent.status === 429 ? await readResend429(sent) : null;
    }

    // Resend が受け付けなかった1通は枠に数えない（確保した枠を返す）。
    // 送信枠切れの 429 は daily_limit、それ以外の失敗は send_failed。どちらもフォームは直接メールを案内する。
    if (!sent || !sent.ok) {
      const quota = Boolean(limited) && limited.kind === 'quota';
      const counts = await releaseDailySlot(env, slot, quota ? RELEASE_QUOTA : '');
      const status = sent ? sent.status : '-';
      const detail = limited ? limited.detail : sent ? await sent.text().catch(() => '') : 'network error';
      if (quota) {
        console.error('contact: Resend 送信枠切れ', status, limited.name, detail.slice(0, 300));
        await notifyDailyLimit(env, `Resend の送信枠（429 ${limited.name}）`, counts ? counts.quota_429 : null);
        return json({ ok: false, error: 'daily_limit' }, 503);
      }
      console.error('contact: Resend 送信失敗', status, detail.slice(0, 300));
      const why = limited
        ? `Resend 429 ${limited.name}${retried ? '・1回再送しても同じ' : '・待ち時間が長いため再送せず'}`
        : sent
          ? `Resend ${sent.status}`
          : 'Resend に接続できず';
      await notifySendFailed(env, kind, why);
      return json({ ok: false, error: 'send_failed' }, 502);
    }

    // (h) Slack への保険通知。メールが隔離されても「届いたこと」に気づけるようにする。
    //     氏名・メール・本文は載せない。載せると Slack (米国) への個人データの越境移転となり、
    //     プライバシーポリシーへの記載と DPA の締結が別途必要になるため。
    //     中身はメール本文で読む。ここで欲しいのは「来た」という事実だけ。
    await postSlack(
      env,
      `:mailbox_with_mail: eivrad.com にお問い合わせが1件届きました（種別: ${kind}）\ncontact@eivrad.com をご確認ください。`,
    );

    return json({ ok: true });
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resend に1通送る。通信例外は null */
const postResend = (env, body) =>
  fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body,
  }).catch(() => null);

/**
 * Resend の 429 を読み分ける（本文を読み切る）。
 *   kind 'quota' : 送信枠切れ（daily_quota_exceeded / monthly_quota_exceeded）。待っても戻らない
 *   kind 'rate'  : 毎秒の送信数制限（rate_limit_exceeded）。waitMs 待てば再送できる（長すぎるなら null）
 * name が読めない 429 は、retry-after が長ければ送信枠切れ、そうでなければ毎秒の制限とみなす。
 */
async function readResend429(res) {
  const raw = await res.text().catch(() => '');
  let name = '';
  try {
    const body = JSON.parse(raw);
    if (body && typeof body.name === 'string') name = body.name.slice(0, 60);
  } catch {
    // 本文が JSON でない
  }
  const header = res.headers.get('retry-after');
  const seconds = header === null || header.trim() === '' ? NaN : Number(header);
  const afterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  let kind;
  if (RESEND_QUOTA_ERRORS.has(name)) kind = 'quota';
  else if (name === 'rate_limit_exceeded') kind = 'rate';
  else kind = afterMs !== null && afterMs > RESEND_RETRY_MAX_MS ? 'quota' : 'rate';
  const wait = afterMs === null ? RESEND_RETRY_DEFAULT_MS : afterMs;
  return {
    kind,
    name: name || '名前なし',
    waitMs: kind === 'rate' && wait <= RESEND_RETRY_MAX_MS ? wait : null,
    detail: raw.slice(0, 300),
  };
}

/** Slack に1行送る（任意の設定。失敗しても利用者への応答は変えない） */
async function postSlack(env, text) {
  if (!env.SLACK_WEBHOOK) return;
  await fetch(env.SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => null);
}

/**
 * 上限で断ったことを Slack に知らせる。理由ごとに1日1回（その日の最初の1件）だけ。
 * count はその理由の今日の件数（日次上限なら rejected、Resend の送信枠切れなら quota_429）。
 * カウンタが使えず件数が分からないとき（count = null）は毎回送る。
 * 送るのは事実だけ。氏名・メール・本文・種別は載せない。
 */
async function notifyDailyLimit(env, reason, count) {
  if (count !== null && count !== undefined && count !== 1) return;
  await postSlack(
    env,
    `:warning: eivrad.com のお問い合わせフォームが${reason}に達したため、送信を受け付けませんでした。\nフォームでは contact@eivrad.com への直接メールを案内しています（フォームの枠は UTC 0時＝JST 9時に戻ります）。`,
  );
}

/**
 * メール通知に失敗したことを Slack に知らせる（毎回）。届いたという通知と取り違えないよう文言を分ける。
 * 載せるのは種別（決まった選択肢）と失敗の理由だけ。氏名・メール・本文は載せない。
 */
async function notifySendFailed(env, kind, why) {
  await postSlack(
    env,
    `:warning: eivrad.com のお問い合わせフォームに送信がありましたが、メール通知に失敗しました（種別: ${kind}・${why}）。\n` +
      '送信者には contact@eivrad.com への直接メールを案内しています。フォームの内容は保存していないため、こちらでは確認できません。' +
      '続く場合は Resend の API キー・送信ドメインの状態を確認してください。',
  );
}

/**
 * 日次カウンタが使えず、上限なしで送っていることを Slack に知らせる。isolate ごとに最短10分に1回。
 * Workers Logs は無効なので、これが無いと wrangler tail を開いている間しか気づけない。
 */
async function notifyCounterUnavailable(env) {
  if (!env.SLACK_WEBHOOK || !takeCounterAlert(Date.now())) return;
  const why = env.CONTACT_COUNTER ? '応答しない・異常な応答' : 'バインディング CONTACT_COUNTER が未設定';
  await postSlack(
    env,
    `:rotating_light: eivrad.com のお問い合わせフォーム: 日次カウンタが使えないため（${why}）、上限なしで送信しています。\n` +
      'Resend の1日100通はライセンスメール（eve-voice-commerce）と共有しているため、続くと購入メールが送れなくなるおそれがあります。' +
      '`wrangler tail eivrad-contact` で原因を確認してください（この通知は最短10分に1回）。',
  );
}
