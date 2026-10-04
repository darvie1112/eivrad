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
 *   - 日次カウンタが無い・壊れた場合は fail open（上限なしで送る）。窓口を閉じるよりましなため。
 */

import { ContactMailCounter, parseCap, reserveDailySlot, releaseDailySlot } from './counter.js';

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
    //     上限なら Resend を呼ばない。カウンタが使えなければ slot は null で、上限なしで送る。
    const cap = parseCap(env.CONTACT_DAILY_MAIL_CAP);
    const slot = await reserveDailySlot(env, cap);
    if (slot && !slot.ok) {
      await notifyDailyLimit(env, `日次上限（${cap}通）`, slot.rejected);
      return json({ ok: false, error: 'daily_limit' }, 503);
    }
    // 件数だけを出す（wrangler tail で今日の消費を見るため）。個人データは出さない。
    if (slot) console.log(`contact: 日次枠 ${slot.used}/${cap} (${slot.day} UTC)`);

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

    const sent = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Eivrad お問い合わせ <form@send.eivrad.com>',
        to: [env.NOTIFY_TO],
        reply_to: email,
        subject: `[お問い合わせ/${kind}] ${name} 様`,
        text,
      }),
    }).catch(() => null);

    // Resend が受け付けなかった1通は枠に数えない（確保した枠を返す）。
    // 429 は Resend 側の送信枠切れ（日次・月次。毎秒の送信数制限でも返る）。利用者には daily_limit を返し、
    // 直接メールを案内する。どの場合も、フォームで再送を繰り返させるより確実に届く。
    if (!sent || !sent.ok) {
      const quota = Boolean(sent) && sent.status === 429;
      const counts = await releaseDailySlot(env, slot, quota);
      if (quota) {
        const detail = await sent.text().catch(() => '');
        console.error('contact: Resend 送信枠超過', sent.status, detail.slice(0, 300));
        await notifyDailyLimit(env, 'Resend の送信枠（429）', counts ? counts.rejected : null);
        return json({ ok: false, error: 'daily_limit' }, 503);
      }
    }

    // (h) Slack への保険通知。メールが隔離されても「届いたこと」に気づけるようにする。
    //     氏名・メール・本文は載せない。載せると Slack (米国) への個人データの越境移転となり、
    //     プライバシーポリシーへの記載と DPA の締結が別途必要になるため。
    //     中身はメール本文で読む。ここで欲しいのは「来た」という事実だけ。
    if (env.SLACK_WEBHOOK) {
      await fetch(env.SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `:mailbox_with_mail: eivrad.com にお問い合わせが1件届きました（種別: ${kind}）\ncontact@eivrad.com をご確認ください。`,
        }),
      }).catch(() => null);
    }

    if (!sent || !sent.ok) {
      const detail = sent ? await sent.text().catch(() => '') : 'network error';
      console.error('contact: Resend 送信失敗', sent ? sent.status : '-', detail.slice(0, 300));
      return json({ ok: false, error: 'send_failed' }, 502);
    }

    return json({ ok: true });
  },
};

/**
 * 日次上限で断ったことを Slack に知らせる。1日1回（その日の最初の1件）だけ。
 * カウンタが使えず件数が分からないとき（rejected = null）は毎回送る。
 * 送るのは事実だけ。氏名・メール・本文・種別は載せない。
 */
async function notifyDailyLimit(env, reason, rejected) {
  if (!env.SLACK_WEBHOOK) return;
  if (rejected !== null && rejected !== undefined && rejected !== 1) return;
  await fetch(env.SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `:warning: eivrad.com のお問い合わせフォームが${reason}に達したため、送信を受け付けませんでした。\nフォームでは contact@eivrad.com への直接メールを案内しています（フォームの枠は UTC 0時＝JST 9時に戻ります）。`,
    }),
  }).catch(() => null);
}
