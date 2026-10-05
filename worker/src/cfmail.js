/**
 * Cloudflare Email Sending（Workers の send_email 束縛 CONTACT_EMAIL）で通知メールを1通送る。
 *
 * 2026-10-05 の決定: 通知メールは Cloudflare を先に使い、送れなければ従来の Resend 経路（日次枠つき）に回す。
 * Cloudflare で送れれば、Resend の1日100通（Eve Voice のライセンスメールと共有）を使わずに済む。
 * Email Routing は使わず、contact@eivrad.com を確認済みの宛先にもしない（apex の eivrad.com の MX に触れる危険を避ける。
 * 同じ日の決定）。このため Cloudflare で送る通知は、確認済みの宛先への無料の送信ではなく、Email Sending の送信枠を使う。
 *
 * 設計上の約束
 *   - 宛先はこのファイルの NOTIFY_ADDRESS（contact@eivrad.com）に固定する。束縛は wrangler.toml で
 *     allowed_sender_addresses = [form@send.eivrad.com] だけに絞り、宛先の制限（destination_address・
 *     allowed_destination_addresses）は付けない（付けると確認済みの宛先が要る）。束縛が宛先を絞らないので、
 *     宛先を決めるのはコードだけ: sendViaCloudflare は呼び出し側から宛先を受け取らず、to には常に NOTIFY_ADDRESS を入れ、
 *     cc・bcc・headers は渡さない。secret NOTIFY_TO が NOTIFY_ADDRESS と違えば束縛を呼ばない（E_NOTIFY_TO_MISMATCH）。
 *   - 束縛は必ず env のメソッドとして呼ぶ（env.CONTACT_EMAIL.send(...)）。取り出して呼ぶと workerd では
 *     "Illegal invocation" になる（EveVoice の Commerce/src/mail.ts の fetch と同じ前例）。
 *   - 失敗はどれも呼び出し側で Resend に回す: 例外（e.code）・同期の例外・TypeError・時間切れ・束縛なし。
 *     自分宛ての通知なので、二重に届くことは許す。届かないほうを避ける。二重になりうるのは、Cloudflare が実は受け付けて
 *     いたかもしれない場合のすべて: 時間切れ（E_TIMEOUT）と、結果の分からないエラー（E_INTERNAL_SERVER_ERROR・
 *     E_DELIVERY_FAILED・E_UNKNOWN・E_TYPE_ERROR など、受け付けなかったことが確実とは言えないもの）。
 *   - 返すのはコード（E_…）だけ。e.message は記録しない・Slack に出さない（問い合わせ者のアドレスが入りうるため）。
 *   - 件名に氏名を入れない（Cloudflare の分析データには件名が残り、オフにできないため）。氏名は本文にだけ書く。
 */

/** 通知の宛先。Cloudflare の経路はこのアドレスにしか送らない（束縛は宛先を絞らないため、コードで固定する） */
export const NOTIFY_ADDRESS = 'contact@eivrad.com';

/** 差出人。Resend の経路と同じアドレス（form@send.eivrad.com）で、表示名も同じ */
export const FROM = Object.freeze({ name: 'Eivrad お問い合わせ', email: 'form@send.eivrad.com' });

/** Cloudflare 経路の日次カウンタの Durable Object の名前（Resend 経路の resend-daily とは別に数える） */
export const CF_COUNTER_NAME = 'cf-daily';

/** Cloudflare 経路の日次上限の既定値（CONTACT_CF_DAILY_CAP が無い・不正なとき） */
export const DEFAULT_CF_DAILY_CAP = 100;

/** send() を待つ最長の時間。これを過ぎたら結果不明として Resend に回す（二重に届くことはありうる。結果の分からないエラーも同じ） */
export const CF_SEND_TIMEOUT_MS = 8000;

/** Cloudflare で送れず Resend に回したことを Slack に知らせる最短の間隔（isolate ごと） */
export const FALLBACK_ALERT_INTERVAL_MS = 10 * 60 * 1000;

/** 自前の理由コード（Cloudflare のエラーコードと同じ形にそろえる） */
export const CODE_TIMEOUT = 'E_TIMEOUT';
export const CODE_BINDING_MISSING = 'E_BINDING_MISSING';
/** secret NOTIFY_TO が NOTIFY_ADDRESS と違う（束縛は呼ばない。Resend の経路は今までどおり NOTIFY_TO へ送る） */
export const CODE_NOTIFY_TO_MISMATCH = 'E_NOTIFY_TO_MISMATCH';
export const CODE_TYPE_ERROR = 'E_TYPE_ERROR';
export const CODE_UNKNOWN = 'E_UNKNOWN';

const CODE_RE = /^E_[A-Z0-9_]{1,60}$/;
/** 記録してよい messageId の形（英数字と記号だけ。形が違えば記録しない） */
const MESSAGE_ID_RE = /^[A-Za-z0-9._@<>+=-]{1,200}$/;
const TIMED_OUT = Symbol('timed out');
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 送り方を読む。"cloudflare" のときだけ Cloudflare を先に使う。
 * 無い・それ以外の値は "resend"（従来どおり Resend だけ。束縛は呼ばない）。前後の空白と大文字小文字は問わない。
 */
export const parseProvider = (raw) =>
  String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase() === 'cloudflare' ? 'cloudflare' : 'resend';

/**
 * secret NOTIFY_TO が通知の宛先 NOTIFY_ADDRESS と同じか。前後の空白と大文字小文字だけは問わない。
 * 文字列でない・複数のアドレス・改行入りなどは、すべて違うものとして扱う（そのとき Cloudflare の経路は使わない）。
 */
export const isNotifyAddress = (raw) => typeof raw === 'string' && raw.trim().toLowerCase() === NOTIFY_ADDRESS;

/** 件名。氏名は入れず、種別（決まった選択肢）と受付の時刻（日本時間の MM/DD HH:MM）だけ */
export const contactSubject = (kind, ms) => {
  const s = new Date(ms + JST_OFFSET_MS).toISOString();
  return `[お問い合わせ/${kind}] ${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)} 受付`;
};

/**
 * 例外を理由コードにする。e.code が E_… の形ならそのまま、TypeError は E_TYPE_ERROR、それ以外は E_UNKNOWN。
 * e.message は見ない（問い合わせ者のアドレスが入りうるため）。
 */
export const failureCode = (err) => {
  if (err && typeof err === 'object' && typeof err.code === 'string' && CODE_RE.test(err.code)) return err.code;
  if (err instanceof TypeError) return CODE_TYPE_ERROR;
  return CODE_UNKNOWN;
};

let timeoutMs = CF_SEND_TIMEOUT_MS;

/** テスト用。時間切れまでの時間を変える（引数なしで既定に戻す） */
export const setCloudflareTimeoutForTest = (ms) => {
  timeoutMs = ms === undefined ? CF_SEND_TIMEOUT_MS : ms;
};

/**
 * NOTIFY_ADDRESS に1通送る。宛先は引数で受け取らない（渡されても使わない）。
 * 戻り値: { ok: true, messageId }  受け付けられた（配達は非同期。Cloudflare の Activity log で確認）
 *         { ok: false, code }      送れなかった・結果が分からない（呼び出し側は Resend に回す）
 */
export async function sendViaCloudflare(env, { replyTo, subject, text }) {
  if (!env.CONTACT_EMAIL) return { ok: false, code: CODE_BINDING_MISSING };
  if (!isNotifyAddress(env.NOTIFY_TO)) return { ok: false, code: CODE_NOTIFY_TO_MISMATCH };
  // 束縛に渡すのはこの5つだけ。to は固定の文字列1つ（配列・cc・bcc・headers にしない）
  const message = { from: { name: FROM.name, email: FROM.email }, to: NOTIFY_ADDRESS, replyTo, subject, text };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    // env のメソッドとして呼ぶ（取り出さない）。同期の例外もこの try で受ける。
    const result = await Promise.race([env.CONTACT_EMAIL.send(message), timeout]);
    if (result === TIMED_OUT) return { ok: false, code: CODE_TIMEOUT };
    const id = result && typeof result.messageId === 'string' ? result.messageId : '';
    return { ok: true, messageId: MESSAGE_ID_RE.test(id) ? id : '' };
  } catch (err) {
    return { ok: false, code: failureCode(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cloudflare で送れず Resend に回したことを Slack に知らせてよいか。
 * isolate ごとのモジュール変数で、最短 FALLBACK_ALERT_INTERVAL_MS に1回へ間引く（厳密な1回ではない）。
 */
const fallbackAlert = { lastAt: null };

export const takeFallbackAlert = (now) => {
  if (fallbackAlert.lastAt !== null && now - fallbackAlert.lastAt < FALLBACK_ALERT_INTERVAL_MS) return false;
  fallbackAlert.lastAt = now;
  return true;
};

/** テスト用。間引きの記録を消す */
export const resetFallbackAlert = () => {
  fallbackAlert.lastAt = null;
};
