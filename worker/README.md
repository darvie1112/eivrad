# eivrad-contact — お問い合わせフォーム受付 Worker

`https://eivrad.com/contact/` のフォームから POST を受け、Turnstile で検証したうえで
`contact@eivrad.com` へ通知する Cloudflare Worker。通知メールは **Cloudflare Email Sending を先に使い、
送れなければ Resend で送る**（2026-10-05〜。[通知メールの送り方](#通知メールの送り方cloudflare-が主resend-が予備)）。

配信サイト本体は GitHub Pages（このリポジトリのルート）だが、eivrad.com は
Cloudflare のプロキシ配下にあるため、`/api/contact` だけを Worker が横取りしている。

Resend で送る通知メールは **UTC の1日あたり 20 通まで**（`CONTACT_DAILY_MAIL_CAP`）。上限に達したら
Resend を呼ばず、フォームに `contact@eivrad.com` への直接メールを案内する（[日次上限](#日次上限フォーム-20-通日)）。
Resend が送れなかったとき（`send_failed`）も、フォームは同じく直接メールを案内する。
Cloudflare で送る分は別に **UTC の1日あたり 100 通まで**（`CONTACT_CF_DAILY_CAP`）数え、超えたら Resend の経路に回す。

## 構成の在り処

Worker のコードはこのディレクトリにあるが、**設定値は Cloudflare 側にしか存在しない**。
サイトを触る人が迷わないよう、下表を最新に保つこと。

| 置き場所 | 名前 | 用途 |
|---|---|---|
| Worker ルート | `eivrad.com/api/contact*` | フォームの送信先 |
| Worker シークレット | `TURNSTILE_SECRET` | Turnstile の Secret Key |
| Worker シークレット | `RESEND_API_KEY` | Resend の API キー |
| Worker シークレット | `NOTIFY_TO` | 通知先。`contact@eivrad.com`（下の束縛 `CONTACT_EMAIL` の宛先と同じであること。違うと毎回 Resend に回る） |
| Worker シークレット | `SLACK_WEBHOOK` | 任意。取りこぼし防止の保険通知 |
| Worker 変数（`wrangler.toml` の `[vars]`） | `CONTACT_DAILY_MAIL_CAP` | Resend で送る通知メールの日次上限。`"20"`。`"0"` はフォームを止める（Cloudflare も呼ばない） |
| Worker 変数（`wrangler.toml` の `[vars]`） | `CONTACT_MAIL_PROVIDER` | 送り方。`"cloudflare"`（Cloudflare が主・Resend が予備）／`"resend"`（Resend だけ）。無い・不正な値は `"resend"` |
| Worker 変数（`wrangler.toml` の `[vars]`） | `CONTACT_CF_DAILY_CAP` | Cloudflare で送る通知メールの日次上限。`"100"`。`"0"` は Cloudflare を使わない |
| send_email 束縛（`wrangler.toml`） | `CONTACT_EMAIL` | Cloudflare Email Sending。宛先 `contact@eivrad.com`・差出人 `form@send.eivrad.com` だけに限定 |
| Durable Object（`wrangler.toml`） | `CONTACT_COUNTER` → クラス `ContactMailCounter` | 日次カウンタ（SQLite 版・マイグレーション `v1`）。オブジェクト名 `resend-daily`（Resend の経路）と `cf-daily`（Cloudflare の経路） |
| Turnstile | サイト名 `eivrad.com` | Site Key は `contact/index.html` に直書き（公開情報） |
| Cloudflare Email Sending | ドメイン `send.eivrad.com` | Cloudflare の送信元（`form@send.eivrad.com`）。apex の `eivrad.com` は登録しない。Email preview はオフ |
| Cloudflare Email Routing | 確認済みの宛先 `contact@eivrad.com` | 束縛の宛先。`eivrad.com` の Email Routing 自体は有効にしない（MX を ConoHa のままにする） |
| Resend | ドメイン `send.eivrad.com` | 予備の送信元（同じ `form@send.eivrad.com`）。ルートドメインとは分離している |
| DNS | `_dmarc.eivrad.com` | `p=quarantine` + `rua`。rua が唯一の可視化手段 |
| DNS | `cf-bounce.send.eivrad.com`・`cf-bounce._domainkey.send.eivrad.com` | Cloudflare Email Sending の登録で作られる MX・SPF・DKIM（Resend の `bounce.send.eivrad.com`・`resend._domainkey.send.eivrad.com` とは別名） |

**シークレットの値をこのリポジトリに書かないこと。**

## デプロイ

まず **`contact/index.html` の `data-sitekey="TURNSTILE_SITE_KEY"` を、
Turnstile ウィジェット作成時に発行された Site Key へ差し替えること。**
差し替えを忘れると、公開しても全送信が `400 captcha` で落ち、問い合わせが1件も届かない。
Site Key は公開情報なので HTML への直書きでよい。

```sh
cd worker
npm i -D wrangler          # もしくは brew の wrangler をそのまま使う
wrangler login
wrangler secret put TURNSTILE_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put NOTIFY_TO
wrangler secret put SLACK_WEBHOOK   # 任意
wrangler deploy
```

`CONTACT_DAILY_MAIL_CAP`・`CONTACT_MAIL_PROVIDER`・`CONTACT_CF_DAILY_CAP`・send_email 束縛・Durable Object は `wrangler.toml` に
書いてあるので、`wrangler deploy` だけで入る（シークレットは消えない）。Durable Object の作成は最初の deploy で
マイグレーション `v1` として1回だけ行われた（2026-10-04）。Cloudflare の経路の `cf-daily` は同じクラスの別オブジェクトなので、
マイグレーションは要らない。KV は使っていない（現在の API トークンに KV の権限がないため）。
本番への配信は運用者が `deploy-contact-worker.zsh`（EveVoice リポジトリの `Commerce/ops/`）で行う。

デプロイ前の確認（外部へは何も送らない）:

```sh
node --test --disable-warning=ExperimentalWarning worker/test/contact.test.mjs   # リポジトリのルートで。Node 22.5 以降
cd worker && wrangler deploy --dry-run --outdir /tmp/eivrad-contact-dryrun        # 束ねられるかだけ確認
# 束ねた Worker を workerd（Miniflare）で動かす。send_email はローカルの模擬で、メールは送らない
CONTACT_NODE_MODULES=<miniflare の入った node_modules> CONTACT_WORKER_BUNDLE=/tmp/eivrad-contact-dryrun/index.js \
  node --test --disable-warning=ExperimentalWarning worker/test/workerd.test.mjs
```

`workerd.test.mjs` は `CONTACT_NODE_MODULES` が無ければ省略になる。`deploy-contact-worker.zsh` は EveVoice の
`Commerce/node_modules`（wrangler 4.129.0 と同じ miniflare）と dry-run の `index.js` を渡して実行し、省略を合格にしない。

## 設計上の約束（変更する前に読むこと）

- **通知メールの From は必ず `form@send.eivrad.com`。** 問い合わせ者は `Reply-To` に入れる（Cloudflare では `replyTo`、
  Resend では `reply_to`。どちらも専用の欄で、ヘッダとしては渡さない）。
  From に問い合わせ者のアドレスを入れると、au（`p=reject`）や docomo（`sp=reject`）から
  届いた問い合わせの通知を自分で消すことになる。
- **件名に氏名を入れない。** 件名は `[お問い合わせ/<種別>] MM/DD HH:MM 受付`（日本時間）。Cloudflare の分析データには
  件名が残り、オフにできないため。氏名・メール・本文はメールの本文にだけ書く。
- **Cloudflare で送れなかったら、どの理由でも Resend に回す。** 自分宛ての通知なので、時間切れの後に両方から届く
  （二重になる）ことは許し、届かないことを避ける。理由はコード（`E_…`）だけを記録・Slack に出し、
  例外の `message` は出さない（問い合わせ者のアドレスが入りうるため）。
- **send_email 束縛は env のメソッドとして呼ぶ（`env.CONTACT_EMAIL.send(...)`）。** 取り出して呼ぶと本番の workerd では
  `Illegal invocation` になりうる（EveVoice の `Commerce/src/mail.ts` の前例）。単体テストの偽の束縛は、取り出して呼ばれると
  `TypeError` を投げる。
- **自動返信は送らない。** ボットが第三者のアドレスを入力した場合にバックスキャッタ源となり、
  Google の送信者要件「スパム率 0.3% 未満」を直撃する。受付は送信完了画面で伝える。
- **シークレットが欠けたら fail closed。** 検証を素通りさせるより 503 で落とす。
- **Slack 通知に氏名・メール・本文を載せない。** 載せた瞬間 Slack (米国) への個人データの
  越境移転となり、privacy.html への事業者追記と DPA の締結が別途必要になる。
  ここで欲しいのは「届いた」という事実だけなので、種別のみを流している。中身はメールで読む。
- **Resend Free は日次 100 通で 429 停止し、従量課金では逃げられない。** JST 午前9時（UTC 0時）まで復旧しない。
  Turnstile・time-trap・レート制限はいずれも「あった方がいい」ではなく必須。
  この 100 通は Eve Voice のライセンス Worker（`eve-voice-commerce`）と同じアカウント・同じ送信ドメインで分け合っている。
- **日次上限に達しても、送信に失敗しても、問い合わせ窓口は閉じない。** フォームは特定商取引法に基づく表記（3営業日以内に回答）と
  プライバシーポリシー（開示等のご請求の受付）の窓口なので、`daily_limit`・`send_failed`・通信の失敗のときは
  `contact@eivrad.com` への直接メールを案内する。privacy.html・tokushoho.html にも、送信できない場合は画面で案内する
  電子メールアドレス宛に送れる旨を書いてある（アドレス自体はそこには書かない）。
- **日次カウンタは fail open。ただし必ず Slack に警告する。** バインディングが無い・Durable Object が応答しない場合は、
  上限なしで従来どおり送る（問い合わせを届けることを優先する）。その間はライセンスメールと共有の Resend 枠を食いうるので、
  Slack に個人データなしの警告「日次カウンタが使えないため…上限なしで送信しています」を送る（isolate ごとに最短10分に1回）。
  Workers Logs は無効なので、これが無いと `wrangler tail` を開いている間しか気づけない。
  シークレット欠落（fail closed）とは逆。カウンタの故障だけで送信を止める（直接メールへ回す）方式も検討したが、
  一時的な不調でも利用者を直接メールへ回すことになるため採らなかった。
- **カウンタに個人データを入れない。** 保存するのは UTC の日付と件数だけ。

## 通知メールの送り方（Cloudflare が主、Resend が予備）

### 決めたこと（2026-10-05）

- `CONTACT_MAIL_PROVIDER = "cloudflare"` のとき、通知メールはまず Cloudflare Email Sending（send_email 束縛 `CONTACT_EMAIL`）で送る。
  宛先は Email Routing の確認済みの宛先 `contact@eivrad.com` だけに、差出人は `form@send.eivrad.com` だけに束縛で限定している。
  Cloudflare で送れれば、Resend の1日100通（ライセンスメールと共有）も、Resend の日次枠（20通）も使わない。
- Cloudflare で送れなければ、同じ件名・本文で従来の Resend の経路（日次枠 20通 → Resend → 429 の読み分け）に回す。
  回す理由: Cloudflare のどのエラーコードでも、同期の例外・`TypeError`（コードなし）・8秒の時間切れ・束縛が無い・
  Cloudflare の経路の日次上限（`CONTACT_CF_DAILY_CAP`、既定 100 通）。
- `CONTACT_DAILY_MAIL_CAP = "0"` は今までどおりフォームを止める非常手段で、Cloudflare も呼ばない（日次カウンタが動いていれば
  全員に `daily_limit` で直接メールを案内する。カウンタ自体が使えないときは、今までどおり fail open で Resend から送る）。
- `CONTACT_MAIL_PROVIDER = "resend"`（または無い・不正な値）なら、束縛を呼ばず、今までの Resend だけの動きに戻る。
  コードを変えずに `wrangler.toml` のこの値だけで戻せる。
- `RESEND_API_KEY` が無ければ（予備が無いので）今までどおり fail closed で、Cloudflare でも送らない。

### 流れ

1. 既存の検査（Origin・シークレット・honeypot・time-trap・IP レート制限・Turnstile・入力検証）をすべて通った送信だけが先へ進む。
2. `CONTACT_MAIL_PROVIDER = "cloudflare"`・`CONTACT_DAILY_MAIL_CAP` が 1 以上・`CONTACT_CF_DAILY_CAP` が 1 以上なら、
   Durable Object のオブジェクト `cf-daily` で今日（UTC）の Cloudflare の枠を1つ確保し、`env.CONTACT_EMAIL.send()` で送る。
   - 受け付けられたら Slack に「届きました」を出して `200` を返す。
   - 枠が残っていなければ Cloudflare を呼ばずに 3. へ（Slack に「Cloudflare 経路の日次上限」をその日の最初の1件だけ）。
   - 失敗したら、確保した枠を返して 3. へ（時間切れだけは送られたかもしれないので返さない）。Slack に
     「Cloudflare Email Sending で送れなかったため（E_…）、Resend で送っています」（isolate ごとに最短10分に1回）。
   - `cf-daily` が使えなければ上限なしで Cloudflare から送り（fail open）、Slack に警告する（カウンタの警告と共通で10分に1回）。
3. Resend の経路は[日次上限](#日次上限フォーム-20-通日)の流れのまま。両方とも失敗したときの Slack の失敗通知には、
   `Cloudflare E_… → Resend 500` のように両方の理由を載せる。

### 前提となるダッシュボードの作業（運用者）

配信の前に済ませる。済んでいなくても配信はでき、その間は毎回 `E_SENDER_…` や `E_RECIPIENT_NOT_ALLOWED` で Resend に回る
（Slack に理由のコードが出る）。

1. Compute > Email Service > Email Sending で `send.eivrad.com` だけを登録する（`eivrad.com` は選ばない）。作られる記録は
   `cf-bounce.send.eivrad.com`（MX・SPF）・`cf-bounce._domainkey.send.eivrad.com`（DKIM）・`_dmarc.send.eivrad.com` だけで、
   apex の MX・SPF・`_dmarc.eivrad.com`・Resend の記録が変わらないこと。
2. 何も送らないうちに、`send.eivrad.com` の Email preview をオフにする（問い合わせの本文を Cloudflare に残さない）。
3. Email Routing の Destination Addresses で `contact@eivrad.com` を追加し、確認メールのリンクを開く。
   `eivrad.com` の Email Routing を有効にする・MX を足す画面が出たら、そこで止める（ConoHa の受信を守るため）。

### 配信の後の確認

- 自分宛てに1件送り、届いたメールの「メッセージのソースを表示」で `Authentication-Results:` が
  `dkim=pass header.d=send.eivrad.com`・`spf=pass`（`cf-bounce.send.eivrad.com`）・`dmarc=pass` であること、
  件名に氏名が無く Reply-To が入力したアドレスであること、日本語の差出人名と件名が化けないことを確かめる。
- Slack には「届きました」だけが出て、「Cloudflare Email Sending で送れなかったため」が出ないこと。
  Resend の Emails に新しい送信が無いこと。
- **Cloudflare が受け付けた後の不達は、この Worker からは見えない。** 受け付けた時点で「届きました」を出すため、
  その後に ConoHa が拒否した・再試行が尽きた場合は、Slack とメールの件数の食い違いでしか気づけない（Email preview がオフなので
  本文も取り戻せない）。切り替えてから7日間は、Cloudflare の Email Sending の Activity log の Bounced・Failed を毎日見て、
  Slack の「届きました」の件数と受信箱の件数を突き合わせる。

### Resend だけに戻すとき

- **すぐ戻す:** `deploy-contact-worker.zsh --rollback`（この切り替えの前の版へ。間に Durable Object のマイグレーションは無いので戻せる）。
- **落ち着いて戻す:** `wrangler.toml` の `CONTACT_MAIL_PROVIDER` を `"resend"` にしたコミットを `deploy-contact-worker.zsh <コミット>` で配信する
  （コードの変更は要らない）。ダッシュボードで変数だけを書き換えると、次の配信で `wrangler.toml` の値に戻る。

## 日次上限（フォーム 20 通／日）

### 決めたこと（2026-10-04）

Resend Free（アカウント1つ・1日100通・月3,000通）を2つの Worker で分ける。

| Worker | 1日の上限 | 数えている場所 |
|---|---|---|
| `eivrad-contact`（このフォーム） | 20 通 | `CONTACT_DAILY_MAIL_CAP`・Durable Object `ContactMailCounter` |
| `eve-voice-commerce`（ライセンスメール） | 80 通 | EveVoice リポジトリ `Commerce/src/index.ts` の上限定数 |

それぞれ自分の分しか数えていないので、合計が 100 を超えない保証は両方の設定値だけ。
どちらかの上限を変えるときは、もう片方と合わせて 100 以内に収めること。
月の上限（3,000 通）は 1日100通×31日より小さいので、月末に Resend が 429 を返すことはあり得る（下記のとおり扱う）。

### 流れ

この流れは Resend で送る分だけに効く（`CONTACT_MAIL_PROVIDER = "resend"` のとき、または Cloudflare で送れなかったとき）。

1. 既存の検査（Origin・シークレット・honeypot・time-trap・IP レート制限・Turnstile・入力検証）をすべて通った送信だけが、
   Durable Object（オブジェクト `resend-daily`）で今日（UTC）の枠を1つ確保する。検査で落ちた送信は数えない。
2. 枠が残っていなければ Resend を呼ばず、`503 {"ok":false,"error":"daily_limit"}` を返す。
3. Resend が失敗したら（2xx 以外・通信例外）確保した枠を返す。失敗した1通は Resend の枠を使っていないため。
   Resend の 429 は本文の `name`（Resend 公式のエラー一覧）で分ける。
   - `daily_quota_exceeded`・`monthly_quota_exceeded`（送信枠切れ）: 再送せず `503 daily_limit`。ライセンスメール側で
     枠を使い切った、月の上限に達した、などの場合。件数は `quota_429` に数える（`rejected` には足さない）。
   - `rate_limit_exceeded`（毎秒の送信数制限。Commerce Worker と同じ Resend チームで共有）: `retry-after` の秒数
     （無ければ1秒。5秒より長ければ待たない）だけ待って1回だけ再送する。通れば成功、駄目なら `502 send_failed`。
     上限に達したわけではないので `daily_limit` にはしない（「本日は上限に達しました」と事実と違う表示になるため）。
   - `name` が読めない 429: `retry-after` が5秒より長ければ送信枠切れ、そうでなければ毎秒の制限として扱う。
   - その他の失敗（5xx・401/403/422・通信例外）: `502 send_failed`。
   - `send_failed` でもフォームは直接メールを案内する（下記）。
4. 枠を返すときは確保した日付を指定するので、UTC 0時をまたいでも翌日の枠を減らさない。

### 上限に達したとき・送信できなかったときの画面

フォームの状態欄（`role="status"`・`aria-live="polite"`）に次を表示する。入力内容は消さない。冒頭の一文だけが状態で変わる。

> 本日はフォームの受付数が上限に達しました。お手数ですが contact@eivrad.com へ直接メールでお送りください
> （件名にご用件をお書き添えください）。原則として3営業日以内に回答いたします。
> 個人情報の開示等のご請求も、件名を「個人情報の開示等のご請求」として、こちらのメールで承ります。

| 状態 | 冒頭の一文 |
|---|---|
| `daily_limit` | 本日はフォームの受付数が上限に達しました。 |
| `send_failed`・想定外の応答 | 送信できませんでした。 |
| 通信の失敗（応答が読めない） | 通信に失敗し、送信できませんでした。 |

- アドレスは `mailto:` リンク。**これらの状態のときだけ** JavaScript で組み立てて表示し、HTML には平文で置かない（収集対策）。
  JS 無効時の `noscript` は従来どおり `contact [at] eivrad.com` 表記。
- リンクの件名は、選ばれたご用件で `【個人情報の開示等のご請求】` のように自動で入る（未選択なら `【お問い合わせ】`）。
  ご用件は決まった選択肢の値だけなので、URL に個人データは入らない（氏名・メール・本文は入れない）。
  privacy.html 第7項(1) の「ご用件として『個人情報の開示等のご請求』を選ぶ」手順を、直接のメールでは件名で引き継ぐ。
- `captcha`・`too_fast`・`invalid`・`too_many_links`・`rate_limited`・`origin` は従来どおり、入力や操作の見直しを促す文言。
- 直接のメールは ConoHa のメールサーバへ届き、Resend を通らない。日次上限の影響を受けない。
- 3営業日以内の回答の約束は、直接のメールにも同じく適用する。

### Slack への通知

どれも氏名・メール・本文・IP は載せない。

| いつ | 文言の頭 | 回数 |
|---|---|---|
| メールの通知が送れた | 「お問い合わせが1件届きました（種別: …）」 | 毎回（従来どおり） |
| メールの通知に失敗した（`send_failed`） | 「送信がありましたが、メール通知に失敗しました（種別: …・Resend 500 など）」 | 毎回 |
| フォームの日次上限で断った | 「日次上限（20通）に達したため、送信を受け付けませんでした」 | その日の `rejected` が 1 のときだけ |
| Resend の送信枠切れ（429）で断った | 「Resend の送信枠（429 daily_quota_exceeded）に達したため…」 | その日の `quota_429` が 1 のときだけ |
| 日次カウンタが使えない（fail open） | 「日次カウンタが使えないため…上限なしで送信しています」（Cloudflare の経路は「Cloudflare 経路の日次カウンタが使えないため…」） | isolate ごとに最短10分に1回（両方の経路で共通） |
| Cloudflare で送れず Resend に回した | 「通知メールを Cloudflare Email Sending で送れなかったため（E_…）、Resend で送っています」 | isolate ごとに最短10分に1回 |
| Cloudflare の経路の日次上限で Resend に回した | 「Cloudflare 経路の日次上限（100通）に達したため、以降は Resend…」 | その日の `cf-daily` の `rejected` が 1 のときだけ |

上限の通知は理由ごとに数えるので、Resend の 429 が先にあった日でも、フォーム自身の上限に達したときの通知は消えない。
カウンタが使えず件数が分からないまま Resend の送信枠切れに当たった場合は、その都度送る。
メールの通知に失敗したときは、フォームの内容をどこにも保存していないため、Slack の通知が唯一の手がかりになる
（送信者には直接メールを案内している）。

### 今日の件数の見方

カウンタの表 `daily` は `day`（UTC の `YYYY-MM-DD`）・`used`（確保した枠＝送信済み）・`rejected`（フォームの上限で断った件数）・
`quota_429`（Resend の送信枠切れで断った件数）の4列だけ。31日より古い行は自動で消える。

- **送信のたびに見る:** `cd worker && wrangler tail eivrad-contact --format pretty`。受け付けた送信ごとに
  `contact: 日次枠 3/20 (2026-10-04 UTC)` の1行が流れる（Workers Logs は無効にしてあるので、tail で見ている間だけ・保存されない）。
- **表を直接見る:** Cloudflare ダッシュボードの Durable Objects から `eivrad-contact` の `ContactMailCounter` を開き、
  Data Studio でオブジェクト名 `resend-daily`（Resend の経路）または `cf-daily`（Cloudflare の経路）を指定して
  `SELECT * FROM daily ORDER BY day DESC LIMIT 7;`（画面の名称・場所は Cloudflare 側で変わることがある）。
  Cloudflare の経路では `used` が送った数、`rejected` が上限で Resend に回した数（`quota_429` は使わない）。
- **Cloudflare で送った分:** `wrangler tail` では `contact: Cloudflare 枠 3/100 (2026-10-05 UTC)` の行。
  Cloudflare の Email Sending の Activity log（Sent・Delivered・Bounced）でも見える。
- **Resend 全体の消費:** Resend ダッシュボードの Emails。ライセンスメールを含めた合計が見える。

### 上限の変え方

`wrangler.toml` の `CONTACT_DAILY_MAIL_CAP` を書き換えて `wrangler deploy`。ダッシュボードで変数を変えても、
次の `wrangler deploy` で `wrangler.toml` の値に戻る。0 以上の整数だけが有効で、数字でない値は既定の 20 として扱う。

- **20 より上げない。** Resend Free の1日100通のうち 80 通はライセンスメール（Commerce の `MAIL_DAILY_CAP`）の分で、
  そのうち最後の10通は購入メール用に残してある（`MAIL_DAILY_CAP` − `MAIL_NON_PURCHASE_CAP` = 10）。フォームの上限を上げると、
  スパムが Turnstile を抜けてまとめて来た日にフォームだけで枠を使い切り、購入メールが Resend の 429 で送れなくなる
  （12回失敗すると運用者の対応が要り、その通知メールも 429 で出ない）。上げるなら、同じ日の Commerce の上限と合わせて
  100 以内に収まるよう Commerce 側を下げるか、先に Resend のプランを上げる。
- **下げる・止めるのは安全。** `"0"` にするとフォームからの送信を止め（Cloudflare の経路も呼ばない）、全員に直接メールを案内する
  （Resend も Cloudflare も使えないときの非常手段）。
  ただし `deploy-contact-worker.zsh` は上限 `"20"` を前提に確かめるので、値を変えるときは開発側がスクリプトの `CAP` も合わせる。
- **Cloudflare の経路の上限（`CONTACT_CF_DAILY_CAP`、`"100"`）** は、普段の件数（1日数件）より十分に大きく、Turnstile を抜けた
  スパムがライセンスメールと同じ Cloudflare アカウントの送信枠を食い尽くさないための値。変えるときは開発側がスクリプトの `CF_CAP` も
  合わせる。`"0"` にすると Cloudflare を使わない（Resend だけ）。

### 戻し方（カウンタを入れた最初の配信は wrangler rollback で戻せない）

Cloudflare の経路を足した配信（2026-10-05〜）は、カウンタが入った後の版どうしなので `deploy-contact-worker.zsh --rollback` で戻せる
（[Resend だけに戻すとき](#resend-だけに戻すとき)）。以下は、カウンタそのものに不具合があったときの話。

**カウンタを入れる最初の配信（マイグレーション `v1`）は、`wrangler rollback` で前の版に戻せない。**
Cloudflare の仕様で、稼働中の版と戻し先の版の間に Durable Object のマイグレーション（クラスの作成・削除）があると
rollback は断られる。カウンタを撤去する配信（`v2`）も同じく、それより前の版へは戻せない。
カウンタが入った後の版どうし（間にマイグレーションが無い）なら、`wrangler rollback` で戻せる。

不具合があったときは、前に進めて直す配信で対処する。どちらも `deploy-contact-worker.zsh` のゲートを通る。

1. **コードを直す（カウンタは残す）:** 開発側が直したコミットを用意し、`deploy-contact-worker.zsh <コミット>` で普通に配信する。
   カウンタが壊れていても、その間は fail open（上限なし）で送り、Slack に警告が出る。直すまで上限は効かない。
2. **カウンタを撤去する（最後の手段）:** 開発側が次の形のコミットを用意し、`deploy-contact-worker.zsh --remove-counter <コミット>` で配信する。
   1. `src/index.js` から `counter.js` の利用（import・export・枠の確保と返却・カウンタの警告）を外し、`src/counter.js` を削除する。
   2. `wrangler.toml` から `[[durable_objects.bindings]]` を消し、`[vars]` の `CONTACT_DAILY_MAIL_CAP` と `CONTACT_CF_DAILY_CAP` も消す
      （Cloudflare の経路は上限なしになる。`CONTACT_MAIL_PROVIDER` と send_email 束縛は残してよい）。
   3. `[[migrations]]` の `v1` は残したまま、`tag = "v2"`・`deleted_classes = ["ContactMailCounter"]` を追記する。
   消えるのは日付と件数の記録だけ。**撤去するとフォームの上限もなくなり、20/80 の配分は守られない**（Resend の 429 だけが歯止めで、
   そのときは直接メールを案内する）。なるべく 1. で直し、撤去したら早めにカウンタを入れ直す。
- 上限を一時的に外すために `CONTACT_DAILY_MAIL_CAP` を上げることはしない（上の「20 より上げない」）。
- `contact/index.html` の直接メールの案内は、Worker を戻しても残して差し支えない（`daily_limit`・`send_failed` が返らなければ表示されない）。

## 動作確認

```sh
# 認証設定
for r in "MX eivrad.com" "TXT eivrad.com" "TXT _dmarc.eivrad.com" \
         "TXT resend._domainkey.send.eivrad.com" \
         "MX cf-bounce.send.eivrad.com" "TXT cf-bounce.send.eivrad.com" \
         "TXT cf-bounce._domainkey.send.eivrad.com" "TXT _dmarc.send.eivrad.com"; do
  echo "--- $r"; dig +short $r @1.1.1.1; done
```

フォームから自分宛に1件送り、届いた通知の「メッセージのソースを表示」で
`Authentication-Results:` を確認する。**`dkim=pass` かつ `dmarc=pass` が合格条件。**
（Cloudflare から届いたものは `header.d=send.eivrad.com`・`smtp.mailfrom` が `cf-bounce.send.eivrad.com`。
ConoHa から転送された後も `dkim=pass` が残ること。）

日次上限の動き（上限到達・Resend 失敗時の枠の返却・429 の読み分けと再送・Slack の通知・カウンタ故障時の fail open と警告・
UTC 0時の切り替わり）と、Cloudflare の経路（成功・各エラーコード／同期の例外／TypeError／時間切れで Resend に回る・
`cf-daily` の上限・上限 0 で両方止まる・`"resend"` で束縛を呼ばない・件名に氏名が無い・Slack に個人データが無い）は
`worker/test/contact.test.mjs` で、束ねた Worker が workerd で束縛を呼べることは `worker/test/workerd.test.mjs` で確認する。
本番に送って試さないこと（Resend の枠を使う）。
