/**
 * お問い合わせ通知メールの日次カウンタ（Durable Object・SQLite 版）
 *
 * Resend Free の送信枠（1日100通・UTC 0時＝JST 9時に戻る）を Eve Voice のライセンス Worker と
 * 分け合うため、このフォームが Resend を呼んでよい通数を UTC の1日ごとに数える。
 * 2026-10-04 の決定: フォーム 20 通 / ライセンスメール 80 通。
 * 2026-10-05 から、Cloudflare Email Sending の経路も同じクラスの別オブジェクト（名前 CF_COUNTER_NAME = 'cf-daily'。
 * cfmail.js）で数える。Durable Object は名前ごとに別の実体なので、表は同じ形のまま、マイグレーションは要らない。
 *
 * 設計上の約束
 *   - 保存するのは日付キー（UTC の YYYY-MM-DD）と件数だけ。氏名・メール・本文・IP は渡さない。
 *   - オブジェクトは経路ごとに1個（Resend は名前 COUNTER_NAME、Cloudflare は 'cf-daily'）。1個の Durable Object は
 *     要求を1件ずつ処理し、SQL API は同期なので、「読む→判定→足す」の間に他の送信が割り込まない。
 *   - 呼び出し側（index.js）はカウンタが使えないとき fail open にする（届けることを優先する）。
 *     その間は上限が効かず、ライセンスメールと共有の Resend 枠を食いうるので、Slack に警告を送る
 *     （takeCounterAlert で isolate ごとに10分に1回まで）。
 */

export const DEFAULT_DAILY_MAIL_CAP = 20;

/** Resend 経路の全リクエストで共有する Durable Object の名前（idFromName に渡す） */
export const COUNTER_NAME = 'resend-daily';

/** これより古い日の行は消す（件数しか無いが、溜め込む理由も無い） */
const RETENTION_DAYS = 31;

/** カウンタが使えないことを Slack に知らせる最短の間隔（isolate ごと） */
export const COUNTER_ALERT_INTERVAL_MS = 10 * 60 * 1000;

/** release の reason。Resend の送信枠切れ（429 daily/monthly_quota_exceeded）で利用者に断った */
export const RELEASE_QUOTA = 'quota';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC の日付キー。Resend の日次枠と同じく UTC 0時で切り替わる */
export const utcDayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * 上限値を読む。0 以上の整数でなければ既定値（fallback。省略時は DEFAULT_DAILY_MAIL_CAP）。
 * CONTACT_DAILY_MAIL_CAP の 0 はフォームからの送信を止める（Cloudflare 経路も含めて。全員にメールを案内）。
 */
export const parseCap = (raw, fallback = DEFAULT_DAILY_MAIL_CAP) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export class ContactMailCounter {
  /**
   * @param {DurableObjectState} ctx
   * @param {object} env
   * @param {() => number} [now] テスト用の時計。本番では渡されない
   */
  constructor(ctx, env, now = Date.now) {
    this.sql = ctx.storage.sql;
    this.now = now;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS daily (' +
        'day TEXT PRIMARY KEY, ' +
        'used INTEGER NOT NULL DEFAULT 0, ' +
        'rejected INTEGER NOT NULL DEFAULT 0, ' +
        'quota_429 INTEGER NOT NULL DEFAULT 0)',
    );
  }

  /**
   * その日の件数。
   *   used      = 確保済みの枠（送信済み＋送信中）
   *   rejected  = このフォームの日次上限で断った件数
   *   quota_429 = Resend の送信枠切れ（429）で断った件数。rejected とは分けて数える
   *              （Slack の「1日1回」の通知を理由ごとに出すため）
   */
  counts(day) {
    const rows = this.sql.exec('SELECT used, rejected, quota_429 FROM daily WHERE day = ?', day).toArray();
    if (!rows.length) return { used: 0, rejected: 0, quota_429: 0 };
    return { used: Number(rows[0].used), rejected: Number(rows[0].rejected), quota_429: Number(rows[0].quota_429) };
  }

  /** 今日の枠を1通ぶん確保する。残っていなければ rejected を1つ進めて断る */
  reserve(cap) {
    const day = utcDayKey(this.now());
    this.sql.exec('INSERT INTO daily (day) VALUES (?) ON CONFLICT(day) DO NOTHING', day);
    const { used, rejected, quota_429 } = this.counts(day);
    if (used >= cap) {
      this.sql.exec('UPDATE daily SET rejected = rejected + 1 WHERE day = ?', day);
      return { ok: false, day, cap, used, rejected: rejected + 1, quota_429 };
    }
    this.sql.exec('UPDATE daily SET used = used + 1 WHERE day = ?', day);
    this.prune(day);
    return { ok: true, day, cap, used: used + 1, rejected, quota_429 };
  }

  /**
   * 確保した枠を返す（Resend が受け付けなかった1通は数えない）。
   * day は確保したときの日付。0時をまたいでも、翌日の枠を減らさない。
   * reason が RELEASE_QUOTA（Resend の送信枠切れの 429 で利用者に断った）なら quota_429 を1つ進める。
   * rejected（このフォームの上限で断った件数）には足さない。
   */
  release(day, reason) {
    if (!DAY_RE.test(String(day || ''))) return { ok: false, error: 'day' };
    this.sql.exec('UPDATE daily SET used = MAX(used - 1, 0) WHERE day = ?', day);
    if (reason === RELEASE_QUOTA) {
      this.sql.exec('INSERT INTO daily (day) VALUES (?) ON CONFLICT(day) DO NOTHING', day);
      this.sql.exec('UPDATE daily SET quota_429 = quota_429 + 1 WHERE day = ?', day);
    }
    return { ok: true, day, ...this.counts(day) };
  }

  /** 今日の件数（読むだけ） */
  status() {
    const day = utcDayKey(this.now());
    return { ok: true, day, ...this.counts(day) };
  }

  prune(today) {
    const cutoff = utcDayKey(Date.parse(`${today}T00:00:00Z`) - RETENTION_DAYS * DAY_MS);
    this.sql.exec('DELETE FROM daily WHERE day < ?', cutoff);
  }

  async fetch(req) {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    let result;
    if (route === 'POST /reserve') {
      result = this.reserve(parseCap(url.searchParams.get('cap')));
    } else if (route === 'POST /release') {
      result = this.release(url.searchParams.get('day'), url.searchParams.get('reason') || '');
    } else if (route === 'GET /status') {
      result = this.status();
    } else {
      return new Response('not found', { status: 404 });
    }
    return Response.json(result, { status: result.ok === false && result.error ? 400 : 200 });
  }
}

const stubOf = (env, name) => env.CONTACT_COUNTER.get(env.CONTACT_COUNTER.idFromName(name));

const errorText = (err) => String((err && err.message) || err).slice(0, 200);

/**
 * 今日の枠を1通ぶん確保する（index.js から呼ぶ）。name はオブジェクトの名前（既定は Resend 経路の COUNTER_NAME）。
 * 戻り値: { ok: true, day, ..., counter } 確保できた / { ok: false, rejected, ..., counter } 上限 /
 *         null カウンタが使えない（呼び出し側は上限なしで送る = fail open）
 * counter はオブジェクトの名前（releaseDailySlot が同じオブジェクトへ返すため）。
 */
export const reserveDailySlot = async (env, cap, name = COUNTER_NAME) => {
  if (!env.CONTACT_COUNTER) {
    console.error(`contact: 日次カウンタ（CONTACT_COUNTER・${name}）が未設定のため、上限なしで送信します`);
    return null;
  }
  try {
    const res = await stubOf(env, name).fetch(`https://counter/reserve?cap=${cap}`, { method: 'POST' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    if (!body || typeof body.ok !== 'boolean' || !DAY_RE.test(String(body.day || ''))) {
      throw new Error('unexpected response');
    }
    return { ...body, counter: name };
  } catch (err) {
    console.error(`contact: 日次カウンタ（${name}）に接続できないため、上限なしで送信します`, errorText(err));
    return null;
  }
};

/**
 * reserveDailySlot で確保した枠を、確保したのと同じオブジェクト（slot.counter）へ返す。確保していなければ何もしない。
 * reason は RELEASE_QUOTA か ''。戻り値はその日の件数（取れなければ null）。
 */
export const releaseDailySlot = async (env, slot, reason = '') => {
  if (!slot || !slot.ok || !env.CONTACT_COUNTER) return null;
  try {
    const query = new URLSearchParams({ day: slot.day });
    if (reason) query.set('reason', reason);
    const res = await stubOf(env, slot.counter || COUNTER_NAME).fetch(`https://counter/release?${query}`, { method: 'POST' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('contact: 日次カウンタの枠を返せませんでした', errorText(err));
    return null;
  }
};

/**
 * カウンタが使えない（fail open で上限なしに送っている）ことを Slack に知らせてよいか。
 * isolate ごとのモジュール変数で、最短 COUNTER_ALERT_INTERVAL_MS に1回へ間引く。
 * isolate が入れ替われば数え直すので、間隔は「最短」であって厳密な1回ではない。
 */
const counterAlert = { lastAt: null };

export const takeCounterAlert = (now) => {
  if (counterAlert.lastAt !== null && now - counterAlert.lastAt < COUNTER_ALERT_INTERVAL_MS) return false;
  counterAlert.lastAt = now;
  return true;
};

/** テスト用。間引きの記録を消す */
export const resetCounterAlert = () => {
  counterAlert.lastAt = null;
};
