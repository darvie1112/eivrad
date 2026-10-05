/*
 * Eve Voice — 購入完了ページ（/evevoice/thanks/）
 *
 * Stripe の決済リンクの完了後のリダイレクトで開かれ、ライセンスキーの送信先と送信の状況を表示する。
 * - Checkout Session の ID は、head のインラインスクリプトが URL から読み取ってタブ単位の sessionStorage に
 *   {id, at（保存した時刻）} の形で移し、アドレスバーから消す。ここでは60分以内のものだけを読む。
 *   eivrad.com のほかのページへのリンクを押したとき（お問い合わせへのリンクは新しいタブで開く）と、全体の表示の期限が来たときは、
 *   sessionStorage から消す（ほかのページのスクリプトから読めないように。ID はこのページの変数には残る）。
 * - api.eivrad.com の POST /v1/orders/status に ID を本文で送る。URL・Referer には ID を載せない。
 * - サーバーのデータは textContent だけで画面に入れる（innerHTML は使わない）。
 * - メールアドレスの全体は、サーバーが返す fullSeconds の間だけ表示する。過ぎたら伏せた形に差し替え、変数からも消す。
 * - 打ち間違いの候補は、このブラウザの中だけで判定し、どこにも送らない。
 * - API に届かない・未配信のときも、ページは一般的な案内を表示する。
 *
 * 純粋な関数と start() は module.exports からも読める（tests/thanks-page.test.mjs）。
 */
(function () {
  'use strict';

  var API_URL = 'https://api.eivrad.com/v1/orders/status';
  // サンドボックスの確認用（手元の wrangler dev）。ページを localhost で開いたときだけ使う。
  var LOCAL_API_URL = 'http://localhost:8787/v1/orders/status';
  var STORAGE_KEY = 'evThanksSession';
  var ID_PATTERN = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;
  var REF_PATTERN = /^[A-Za-z0-9]{8}$/;
  var CONTACT_PATH = '/contact/?subject=evevoice';
  // sessionStorage の ID を読む期限（保存から60分。全体のアドレスを表示する時間と同じ）。
  var STORAGE_TTL_MS = 60 * 60 * 1000;
  // 送信の準備中に確かめ直す間隔（秒）。最初の1回と合わせて最大12回（約2分）。その後はボタンで確かめる。
  var POLL_DELAYS = [2, 2, 3, 3, 5, 5, 10, 10, 15, 15, 30];
  var MAX_CHECKS = POLL_DELAYS.length + 1;
  var REQUEST_TIMEOUT_MS = 15000;
  var FULL_WINDOW_MAX = 3600;
  var STATUSES = ['pending', 'sent', 'failed', 'unknown'];
  var REASONS = ['address_rejected', 'no_address', 'not_issued', 'retry_exhausted', 'awaiting_payment'];

  // 打ち間違いの候補として示す、主な受信先。
  var COMMON_DOMAINS = ['gmail.com', 'yahoo.co.jp', 'icloud.com', 'me.com', 'outlook.jp', 'outlook.com', 'hotmail.co.jp',
    'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'ymobile.ne.jp'];
  // 上の一覧に近いが、それ自体が実在する受信先。誤りとは言わない。
  var REAL_NEARBY_DOMAINS = ['mail.com', 'email.com', 'ymail.com', 'gmx.com', 'aol.com', 'mac.com', 'msn.com', 'live.com',
    'live.jp', 'yahoo.com', 'hotmail.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.co.id', 'hotmail.co.uk', 'outlook.fr',
    'outlook.de', 'outlook.it', 'outlook.es', 'outlook.kr'];

  var TEXT = {
    // 応答が来るまで・注文を表示できないときの文（有料と無料のどちらにも合う）。HTML の最初の文と同じ。
    leadDefault: 'Eve Voice をご注文いただき、ありがとうございます。',
    leadPaid: 'Eve Voice をお買い上げいただき、ありがとうございます。',
    leadFree: 'Eve Voice の無料ライセンスをお申し込みいただき、ありがとうございます。',
    heading: 'ライセンスキーの送信先',
    notFoundHeading: 'ご注文の情報を表示できませんでした',
    loading: '送信先を確認しています…',
    pending: '送信の準備をしています…（通常は数分以内にお送りします）',
    // 無料のキーのメールは1日の上限（RUNBOOK §6）で翌日以降に回ることがある。
    pendingFree: '送信の準備をしています…（お申し込みが多い日は、翌日以降のお届けになることがあります）',
    awaitingPayment: 'お支払いの完了を確認しています。完了すると、キーを自動でお送りします。',
    pendingLater: 'まだ準備中です。しばらくしてから、下のボタンでもう一度お確かめください。',
    sent: '送信しました。差出人は license@send.eivrad.com、件名は「Eve Voice ライセンスキー」です。',
    rejected: 'このメールアドレスには送れませんでした。',
    failed: 'キーを自動でお送りできませんでした。お手数ですが、下のボタンからご連絡ください。',
    confirmPaid: 'お支払いを確認のうえ、キーをお送りします。',
    confirmFree: 'お申し込みを確認のうえ、キーをお送りします。',
    unknown: 'この注文のキーの状態は、このページでは表示できません。お問い合わせください。',
    notFound: '決済の完了から30日を過ぎた場合や、ページのアドレスが途中で切れた場合は表示できません。' +
      'ライセンスキーは、決済のときにご入力のメールアドレスへ自動でお送りしています。届いていない場合は、お問い合わせください。',
    noId: 'ご注文の情報は、ご注文の直後に開いたこのページでだけ表示します（ほかのページへ移った後や、60分を過ぎてから開き直した場合は表示できません）。' +
      'ライセンスキーは、ご注文のときにご入力のメールアドレスへ自動でお送りしています。届いていない場合は、お問い合わせください。',
    unavailable: 'ただいま送信先を確認できません。',
    generic: 'ライセンスキーは、決済のときにご入力のメールアドレスへ自動でお送りしています（通常は数分以内）。',
    stale: 'ただいま最新の状況を確認できません。少し待ってから、もう一度お確かめください。',
    windowFull: 'セキュリティのため、メールアドレスの全体は決済の完了から60分間だけ表示します。',
    windowMasked: '決済の完了から60分を過ぎたため、一部を伏せて表示しています。'
  };

  function parseId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
  }

  // ローカル部（@の前）の先頭2文字（3文字以下なら1文字）＋「***」＋「@」＋ドメインの全体。文字はコードポイントで数える。
  // ドメインは伏せない（gmial.com のような打ち間違いに、60分を過ぎても気づけるように）。
  function maskEmail(email) {
    if (typeof email !== 'string') return null;
    var at = email.lastIndexOf('@');
    if (at < 0 || at === email.length - 1) return null;
    var local = Array.from(email.slice(0, at));
    return local.slice(0, local.length <= 3 ? 1 : 2).join('') + '***@' + email.slice(at + 1);
  }

  // 隣り合う2文字の入れ替えも1回と数える編集距離（gmial → gmail は1）。
  function editDistance(a, b) {
    var x = Array.from(a);
    var y = Array.from(b);
    var d = [];
    var i;
    var j;
    for (i = 0; i <= x.length; i++) d[i] = [i];
    for (j = 0; j <= y.length; j++) d[0][j] = j;
    for (i = 1; i <= x.length; i++) {
      for (j = 1; j <= y.length; j++) {
        var v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
        d[i][j] = v;
      }
    }
    return d[x.length][y.length];
  }

  // 主な受信先のどれでもなく、どれかとの編集距離が2以下なら、その受信先を候補として返す。
  // 短い受信先（me.com・au.com）は1以下に限る（aol.com・mac.com などを誤りと言わないため）。
  function typoHint(email) {
    if (typeof email !== 'string') return null;
    var at = email.lastIndexOf('@');
    if (at < 0) return null;
    var typed = email.slice(at + 1).trim();
    var domain = typed.toLowerCase();
    if (!domain || domain.length > 255) return null;
    if (COMMON_DOMAINS.indexOf(domain) >= 0 || REAL_NEARBY_DOMAINS.indexOf(domain) >= 0) return null;
    var best = null;
    var bestDistance = Infinity;
    COMMON_DOMAINS.forEach(function (candidate) {
      var distance = editDistance(domain, candidate);
      if (distance <= (candidate.length >= 9 ? 2 : 1) && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    });
    return best ? { typed: typed, suggestion: best } : null;
  }

  // お問い合わせへのリンク（届かない・送れなかった・状態を出せない、など誤りの連絡ではないもの）。
  // 番号（英数字8文字）だけを #ref= に付ける。フォームは本文に「お問い合わせ番号: <番号>」の1行だけを入れる。
  // メールアドレスは URL に入れない。
  function contactHref(ref) {
    return typeof ref === 'string' && REF_PATTERN.test(ref) ? CONTACT_PATH + '#ref=' + ref : CONTACT_PATH;
  }

  // 「メールアドレスの誤りを連絡する」のボタンだけのリンク。#addr=<番号>（無料ライセンスは &f=1）。
  // フォームは、この印のときだけ誤りの連絡のひな形（ご本人の確認の欄つき）を入れる。運用者は、ひな形の見出しと、
  // フォームの正しいアドレスが注文のアドレスと違うことの両方を見て、アドレスの訂正（RUNBOOK §7）として扱う。
  function reportHref(ref, free) {
    return typeof ref === 'string' && REF_PATTERN.test(ref) ? CONTACT_PATH + '#addr=' + ref + (free ? '&f=1' : '') : CONTACT_PATH;
  }

  // checksDone 回確かめた後、次に確かめるまでの待ち時間（ミリ秒）。null なら自動では確かめない。
  function nextDelay(checksDone, pollAfter) {
    if (typeof pollAfter !== 'number' || !(pollAfter > 0)) return null;
    if (!(checksDone >= 1) || checksDone >= MAX_CHECKS) return null;
    return Math.max(POLL_DELAYS[checksDone - 1], Math.min(pollAfter, 60)) * 1000;
  }

  function apiUrl(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' ? LOCAL_API_URL : API_URL;
  }

  function retryAfterSeconds(header) {
    var seconds = Number(header);
    return header && isFinite(seconds) && seconds >= 1 ? Math.min(Math.floor(seconds), 300) : 60;
  }

  // 200 の本文を、決まった形に揃える。形が違えば null（「確認できません」として扱う）。
  function normalizeOrder(body) {
    if (!body || typeof body !== 'object' || STATUSES.indexOf(body.status) < 0) return null;
    var text = function (value) {
      return typeof value === 'string' && value.length > 0 && value.length <= 320 ? value : null;
    };
    var email = text(body.email);
    var seconds = typeof body.fullSeconds === 'number' && isFinite(body.fullSeconds)
      ? Math.max(0, Math.min(FULL_WINDOW_MAX, Math.floor(body.fullSeconds)))
      : 0;
    return {
      status: body.status,
      email: email,
      emailMasked: text(body.emailMasked) || (email ? maskEmail(email) : null),
      fullSeconds: email ? seconds : 0,
      free: body.free === true,
      shortRef: typeof body.shortRef === 'string' && REF_PATTERN.test(body.shortRef) ? body.shortRef : null,
      reason: REASONS.indexOf(body.reason) >= 0 ? body.reason : null,
      pollAfter: typeof body.pollAfter === 'number' && isFinite(body.pollAfter) && body.pollAfter > 0 ? body.pollAfter : null
    };
  }

  // 誤りの連絡の案内。ご本人の確認（RUNBOOK §7）は、有料は決済の日時とカードの番号の下4桁の両方、無料はお申し込みの日時。
  // Apple Pay などのウォレットでも、Stripe が記録するのはカードの番号の下4桁（card.last4）で、
  // デバイスアカウント番号の下4桁（card.wallet.dynamic_last4）ではない。
  function reportNote(ref, free) {
    return (ref ? 'お問い合わせフォームが新しいタブで開き、お問い合わせ番号（' + ref + '）とご記入の欄が入ります。' : 'お問い合わせフォームが新しいタブで開きます。') +
      '正しいメールアドレスは「メールアドレス」の欄にご入力ください。' +
      (free
        ? 'ご本人の確認のため、お申し込みの日時（何時何分ごろ）を本文にお書きください。'
        : 'ご本人の確認のため、決済の日時（何時何分ごろ）と、お支払いに使ったカードの番号の下4桁の両方を本文にお書きください' +
          '（Apple Pay などでお支払いの場合も、ウォレットのアプリでそのカードの詳細に表示される、カードの番号の下4桁です。デバイスアカウント番号ではありません）。') +
      '確認のうえ、正しいアドレスへ新しいキーをお送りし、誤ったアドレスに送られたキーは使えないようにします。';
  }

  /*
   * 画面に出す内容を決める（DOM に触れない）。
   * input.kind: 'loading' | 'noid' | 'notfound' | 'unavailable' | 'order'
   * リンク: 誤りの連絡（check.href）だけ #addr=、ほか（contact・ref を使うリンク）は #ref=。
   * 'order' のとき: order（normalizeOrder の結果から email を除いたもの）、address（表示するアドレス）、
   *   full（全体を表示しているか）、stalled（自動の確かめ直しを終えた）、stale（最新の確かめ直しに失敗した）。
   */
  function view(input) {
    var v = { lead: TEXT.leadDefault, heading: TEXT.heading, address: null, windowNote: null, messages: [], retry: false,
      contact: null, check: null, ref: null, free: false };
    var kind = input && input.kind;
    if (kind === 'loading') {
      v.messages = [TEXT.loading];
      return v;
    }
    if (kind === 'noid' || kind === 'notfound') {
      v.heading = TEXT.notFoundHeading;
      v.messages = [kind === 'noid' ? TEXT.noId : TEXT.notFound];
      v.contact = CONTACT_PATH;
      return v;
    }
    if (kind !== 'order' || !input.order) {
      v.messages = [TEXT.unavailable, TEXT.generic];
      v.retry = true;
      return v;
    }
    var order = input.order;
    v.free = order.free;
    v.lead = order.free ? TEXT.leadFree : TEXT.leadPaid;
    v.ref = order.shortRef;
    v.address = input.address || null;
    if (v.address) {
      var hint = typoHint(v.address);
      v.windowNote = input.full ? TEXT.windowFull : TEXT.windowMasked;
      v.check = {
        href: reportHref(order.shortRef, order.free),
        typo: hint ? '「' + hint.typed + '」は「' + hint.suggestion + '」の誤りではありませんか。' : null,
        note: reportNote(order.shortRef, order.free)
      };
    }
    if (order.status === 'pending') {
      v.messages = [order.reason === 'awaiting_payment' ? TEXT.awaitingPayment : order.free ? TEXT.pendingFree : TEXT.pending];
      if (input.stalled) {
        v.messages.push(TEXT.pendingLater);
        v.retry = true;
      }
    } else if (order.status === 'sent') {
      v.messages = [TEXT.sent];
    } else if (order.status === 'failed') {
      v.messages = [(order.reason === 'address_rejected' ? TEXT.rejected : '') + TEXT.failed +
        (order.free ? TEXT.confirmFree : TEXT.confirmPaid)];
      v.contact = contactHref(order.shortRef);
    } else {
      v.messages = [TEXT.unknown];
      v.contact = contactHref(order.shortRef);
    }
    if (input.stale) {
      v.messages.push(TEXT.stale);
      v.retry = true;
    }
    return v;
  }

  function setText(el, text) {
    if (el) el.textContent = text;
  }
  function setHidden(el, hidden) {
    if (el) el.hidden = hidden;
  }

  function paint(els, doc, v) {
    setText(els.lead, v.lead);
    setText(els.heading, v.heading);
    setText(els.address, v.address || '');
    setHidden(els.address, !v.address);
    // 確かめ直しのたびに同じ文を読み上げ直さないよう、文が変わったときだけ差し替える。
    var statusKey = v.messages.join('\n');
    if (els.statusKey !== statusKey) {
      els.statusKey = statusKey;
      els.status.replaceChildren.apply(els.status, v.messages.map(function (message) {
        var p = doc.createElement('p');
        p.textContent = message;
        return p;
      }));
    }
    setText(els.windowNote, v.windowNote || '');
    setHidden(els.windowNote, !v.windowNote);
    if (els.retry) {
      els.retry.hidden = !v.retry;
      els.retry.disabled = false;
    }
    if (els.contact) {
      els.contact.hidden = !v.contact;
      els.contact.setAttribute('href', v.contact || CONTACT_PATH);
    }
    setHidden(els.check, !v.check);
    setText(els.typo, v.check && v.check.typo ? v.check.typo : '');
    setHidden(els.typo, !(v.check && v.check.typo));
    if (els.report) els.report.setAttribute('href', v.check ? v.check.href : CONTACT_PATH);
    setText(els.reportNote, v.check ? v.check.note : '');
    if (els.missingContact) els.missingContact.setAttribute('href', contactHref(v.ref));
    setText(els.missingRef, v.ref ? '（お問い合わせ番号 ' + v.ref + '）' : '');
    setHidden(els.receipt, v.free);
  }

  function request(env, id) {
    return env.fetch(env.apiUrl, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: id })
    }).then(function (response) {
      if (response.status === 200) {
        return response.json().then(function (body) {
          var order = normalizeOrder(body);
          return order ? { kind: 'order', order: order } : { kind: 'unavailable' };
        }, function () {
          return { kind: 'unavailable' };
        });
      }
      if (response.status === 404 || response.status === 400) return { kind: 'notfound' };
      if (response.status === 429) {
        return { kind: 'limited', retryAfter: retryAfterSeconds(response.headers && response.headers.get('Retry-After')) };
      }
      return { kind: 'unavailable' };
    });
  }

  /*
   * ページを動かす。env: { document, window, fetch, setTimeout, clearTimeout, now, apiUrl, sessionId, forgetStoredId }
   * （ブラウザでは下の起動部分が渡す。テストは偽物を渡す。forgetStoredId は sessionStorage の ID を消す。）
   */
  function start(env) {
    var doc = env.document;
    var byId = function (id) { return doc.getElementById(id); };
    var els = {
      lead: byId('evt-lead'), heading: byId('evt-dest-title'), address: byId('evt-address'), status: byId('evt-status'),
      windowNote: byId('evt-window'), retry: byId('evt-retry'), contact: byId('evt-contact'), check: byId('evt-check'),
      typo: byId('evt-typo'), report: byId('evt-report'), reportNote: byId('evt-report-note'),
      missingContact: byId('evt-missing-contact'), missingRef: byId('evt-missing-ref'), receipt: byId('evt-receipt')
    };
    if (!els.status) return null;

    // 全体のアドレスは state.full にだけ持ち、期限が来たら null にする。order にはアドレスを残さない。
    var state = { id: parseId(env.sessionId), order: null, full: null, masked: null, deadline: 0, checks: 0,
      inflight: false, limited: false, stalled: false, stale: false, seq: 0, pollTimer: null, expiryTimer: null };

    function render(input) {
      paint(els, doc, view(input));
    }
    function forgetStored() {
      if (typeof env.forgetStoredId === 'function') env.forgetStoredId();
    }
    function renderOrder() {
      var full = state.full !== null;
      render({ kind: 'order', order: state.order, address: full ? state.full : state.masked, full: full,
        stalled: state.stalled, stale: state.stale });
    }
    function forgetFull() {
      state.full = null;
      state.deadline = 0;
      if (state.expiryTimer !== null) {
        env.clearTimeout(state.expiryTimer);
        state.expiryTimer = null;
      }
    }
    function expireIfDue() {
      if (state.full !== null && env.now() >= state.deadline) {
        forgetFull();
        forgetStored();
        if (state.order) renderOrder();
      }
    }
    function accept(order) {
      forgetFull();
      state.masked = order.emailMasked;
      if (order.email && order.fullSeconds > 0) {
        state.full = order.email;
        state.deadline = env.now() + order.fullSeconds * 1000;
        state.expiryTimer = env.setTimeout(expireIfDue, order.fullSeconds * 1000 + 250);
      }
      state.order = { status: order.status, free: order.free, shortRef: order.shortRef, reason: order.reason };
    }
    function handle(result) {
      if (result.kind === 'order') {
        state.limited = false;
        state.stale = false;
        state.stalled = false;
        accept(result.order);
        if (result.order.status === 'pending') {
          var delay = nextDelay(state.checks, result.order.pollAfter);
          if (delay === null) state.stalled = true;
          else state.pollTimer = env.setTimeout(check, delay);
        }
        renderOrder();
        return;
      }
      if (result.kind === 'limited' && !state.limited) {
        // 混み合っているときは、Retry-After の後に1回だけ試し直す。
        state.limited = true;
        state.pollTimer = env.setTimeout(check, result.retryAfter * 1000);
        return;
      }
      state.limited = false;
      if (result.kind === 'notfound') {
        forgetFull();
        state.order = null;
        state.masked = null;
        render({ kind: 'notfound' });
        return;
      }
      if (state.order) {
        state.stale = true;
        renderOrder();
      } else {
        render({ kind: 'unavailable' });
      }
    }
    function check() {
      if (state.inflight || !state.id) return;
      if (state.pollTimer !== null) {
        env.clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
      var seq = ++state.seq;
      var timeout = null;
      var settle = function (result) {
        if (seq !== state.seq || !state.inflight) return;
        state.inflight = false;
        if (timeout !== null) env.clearTimeout(timeout);
        handle(result);
      };
      state.inflight = true;
      state.checks += 1;
      if (els.retry) els.retry.disabled = true;
      timeout = env.setTimeout(function () { settle({ kind: 'unavailable' }); }, REQUEST_TIMEOUT_MS);
      var pending;
      try {
        pending = request(env, state.id);
      } catch (e) {
        pending = Promise.reject(e);
      }
      pending.then(settle, function () { settle({ kind: 'unavailable' }); });
    }

    if (els.retry) {
      els.retry.addEventListener('click', function () {
        state.limited = false;
        if (!state.order) render({ kind: 'loading' });
        check();
      });
    }
    // 戻るボタンのキャッシュから表示されたとき・タブに戻ったときも、全体を表示してよい時間かを確かめ直す。
    env.window.addEventListener('pageshow', function (event) {
      if (!event || !event.persisted) return;
      expireIfDue();
      check();
    });
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState !== 'hidden') expireIfDue();
    });
    // ページのリンク（/contact/ など、同じ eivrad.com のページ）を押したら、sessionStorage の ID を消す。
    // 開いた先のページのスクリプト（Turnstile・Cloudflare のビーコンなど）から読めないように。
    // お問い合わせへのリンクは新しいタブ（rel=noopener）で開くので、このページはそのまま残り、変数の ID で表示と確かめ直しを続ける
    // （新しいタブが作られる前に消すので、sessionStorage を写すブラウザでも写らない）。# だけのリンク（ページ内の移動）では消さない。
    doc.addEventListener('click', function (event) {
      var target = event && event.target;
      var link = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
      var href = link ? link.getAttribute('href') : null;
      if (typeof href === 'string' && href.charAt(0) === '/' && href.charAt(1) !== '/') forgetStored();
    });

    if (!state.id) {
      render({ kind: 'noid' });
    } else {
      render({ kind: 'loading' });
      check();
    }
    return { state: state, check: check, expireIfDue: expireIfDue };
  }

  function forgetStoredId(win) {
    try {
      win.sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // 使えないなら、残っているものも無い
    }
  }

  // ID を決める。このページを開いたときの値（window）を優先し、無ければ sessionStorage の {id, at} を読む。
  // 保存から60分を過ぎたもの・形の違うもの・時計が大きく戻ったものは捨てる（sessionStorage からも消す）。
  function readSessionId(win, now) {
    if (typeof win.__evThanksSession === 'string') return parseId(win.__evThanksSession);
    var raw = null;
    try {
      raw = win.sessionStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
    if (raw === null || raw === undefined) return null;
    var saved = null;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      saved = null;
    }
    var id = saved && typeof saved === 'object' ? parseId(saved.id) : null;
    var age = (typeof now === 'number' ? now : Date.now()) - (saved && typeof saved.at === 'number' ? saved.at : NaN);
    if (id && age >= -5 * 60 * 1000 && age < STORAGE_TTL_MS) return id;
    forgetStoredId(win);
    return null;
  }

  var api = {
    parseId: parseId, maskEmail: maskEmail, editDistance: editDistance, typoHint: typoHint, contactHref: contactHref,
    reportHref: reportHref, forgetStoredId: forgetStoredId, STORAGE_TTL_MS: STORAGE_TTL_MS, nextDelay: nextDelay,
    apiUrl: apiUrl, retryAfterSeconds: retryAfterSeconds, normalizeOrder: normalizeOrder,
    view: view, start: start, readSessionId: readSessionId, TEXT: TEXT, COMMON_DOMAINS: COMMON_DOMAINS,
    REAL_NEARBY_DOMAINS: REAL_NEARBY_DOMAINS, MAX_CHECKS: MAX_CHECKS
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;

  if (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-ev-thanks') === 'v1') {
    start({
      document: document,
      window: window,
      fetch: typeof window.fetch === 'function' ? window.fetch.bind(window) : function () { return Promise.reject(new Error('no fetch')); },
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      now: function () { return Date.now(); },
      apiUrl: apiUrl(window.location.hostname),
      sessionId: readSessionId(window, Date.now()),
      forgetStoredId: function () { forgetStoredId(window); }
    });
  }
})();
