# eivrad-contact — お問い合わせフォーム受付 Worker

`https://eivrad.com/contact/` のフォームから POST を受け、Turnstile で検証したうえで
Resend 経由で `contact@eivrad.com` へ通知する Cloudflare Worker。

配信サイト本体は GitHub Pages（このリポジトリのルート）だが、eivrad.com は
Cloudflare のプロキシ配下にあるため、`/api/contact` だけを Worker が横取りしている。

通知メールは **UTC の1日あたり 20 通まで**（`CONTACT_DAILY_MAIL_CAP`）。上限に達したら
Resend を呼ばず、フォームに `contact@eivrad.com` への直接メールを案内する（[日次上限](#日次上限フォーム-20-通日)）。

## 構成の在り処

Worker のコードはこのディレクトリにあるが、**設定値は Cloudflare 側にしか存在しない**。
サイトを触る人が迷わないよう、下表を最新に保つこと。

| 置き場所 | 名前 | 用途 |
|---|---|---|
| Worker ルート | `eivrad.com/api/contact*` | フォームの送信先 |
| Worker シークレット | `TURNSTILE_SECRET` | Turnstile の Secret Key |
| Worker シークレット | `RESEND_API_KEY` | Resend の API キー |
| Worker シークレット | `NOTIFY_TO` | 通知先。`contact@eivrad.com` |
| Worker シークレット | `SLACK_WEBHOOK` | 任意。取りこぼし防止の保険通知 |
| Worker 変数（`wrangler.toml` の `[vars]`） | `CONTACT_DAILY_MAIL_CAP` | 通知メールの日次上限。`"20"` |
| Durable Object（`wrangler.toml`） | `CONTACT_COUNTER` → クラス `ContactMailCounter` | 日次カウンタ（SQLite 版・マイグレーション `v1`）。オブジェクト名 `resend-daily` |
| Turnstile | サイト名 `eivrad.com` | Site Key は `contact/index.html` に直書き（公開情報） |
| Resend | ドメイン `send.eivrad.com` | 送信元。ルートドメインとは分離している |
| DNS | `_dmarc.eivrad.com` | `p=quarantine` + `rua`。rua が唯一の可視化手段 |

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

`CONTACT_DAILY_MAIL_CAP` と Durable Object は `wrangler.toml` に書いてあるので、`wrangler deploy` だけで入る
（シークレットは消えない）。Durable Object の作成は最初の deploy でマイグレーション `v1` として1回だけ行われる。
KV は使っていない（現在の API トークンに KV の権限がないため）。

デプロイ前の確認（外部へは何も送らない）:

```sh
node --test --disable-warning=ExperimentalWarning worker/test/contact.test.mjs   # リポジトリのルートで。Node 22.5 以降
cd worker && wrangler deploy --dry-run --outdir /tmp/eivrad-contact-dryrun        # 束ねられるかだけ確認
```

## 設計上の約束（変更する前に読むこと）

- **通知メールの From は必ず `form@send.eivrad.com`。** 問い合わせ者は `Reply-To` に入れる。
  From に問い合わせ者のアドレスを入れると、au（`p=reject`）や docomo（`sp=reject`）から
  届いた問い合わせの通知を自分で消すことになる。
- **自動返信は送らない。** ボットが第三者のアドレスを入力した場合にバックスキャッタ源となり、
  Google の送信者要件「スパム率 0.3% 未満」を直撃する。受付は送信完了画面で伝える。
- **シークレットが欠けたら fail closed。** 検証を素通りさせるより 503 で落とす。
- **Slack 通知に氏名・メール・本文を載せない。** 載せた瞬間 Slack (米国) への個人データの
  越境移転となり、privacy.html への事業者追記と DPA の締結が別途必要になる。
  ここで欲しいのは「届いた」という事実だけなので、種別のみを流している。中身はメールで読む。
- **Resend Free は日次 100 通で 429 停止し、従量課金では逃げられない。** JST 午前9時（UTC 0時）まで復旧しない。
  Turnstile・time-trap・レート制限はいずれも「あった方がいい」ではなく必須。
  この 100 通は Eve Voice のライセンス Worker（`eve-voice-commerce`）と同じアカウント・同じ送信ドメインで分け合っている。
- **日次上限に達しても問い合わせ窓口は閉じない。** フォームは特定商取引法に基づく表記（3営業日以内に回答）と
  プライバシーポリシー（開示等のご請求の受付）の窓口なので、上限時は `contact@eivrad.com` への直接メールを案内する。
- **日次カウンタは fail open。** バインディングが無い・Durable Object が応答しない場合は、上限なしで従来どおり送る。
  シークレット欠落（fail closed）とは逆。カウンタの故障で窓口を閉じるより、Resend の 429 に当たる方がましなため。
- **カウンタに個人データを入れない。** 保存するのは UTC の日付と件数だけ。

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

1. 既存の検査（Origin・シークレット・honeypot・time-trap・IP レート制限・Turnstile・入力検証）をすべて通った送信だけが、
   Durable Object で今日（UTC）の枠を1つ確保する。検査で落ちた送信は数えない。
2. 枠が残っていなければ Resend を呼ばず、`503 {"ok":false,"error":"daily_limit"}` を返す。
3. Resend が失敗したら（2xx 以外・通信例外）確保した枠を返す。失敗した1通は Resend の枠を使っていないため。
   - 通常の失敗は従来どおり `502 send_failed`（利用者は時間をおいて再送する）。
   - **Resend が 429 を返したら `503 daily_limit`。** ライセンスメール側で枠を使い切った、月の上限に達した、などの場合も
     利用者を直接メールへ案内できる。
4. 枠を返すときは確保した日付を指定するので、UTC 0時をまたいでも翌日の枠を減らさない。

### 上限に達したときの画面

フォームの状態欄（`role="status"`・`aria-live="polite"`）に次を表示する。入力内容は消さない。

> 本日はフォームの受付数が上限に達しました。お手数ですが contact@eivrad.com へ直接メールでお送りください。
> 原則として3営業日以内に回答いたします。個人情報の開示等のご請求も、こちらのメールで承ります。

- アドレスは `mailto:` リンク。**この状態のときだけ** JavaScript で組み立てて表示し、HTML には平文で置かない（収集対策）。
  JS 無効時の `noscript` は従来どおり `contact [at] eivrad.com` 表記。
- 直接のメールは ConoHa のメールサーバへ届き、Resend を通らない。日次上限の影響を受けない。
- 3営業日以内の回答の約束は、直接のメールにも同じく適用する。

### Slack への通知

上限で断った最初の1件（その日の `rejected` が 1 になったとき）だけ、Slack に「上限に達した」ことを送る。
氏名・メール・本文・種別は載せない。カウンタが使えず件数が分からないまま Resend の 429 に当たった場合は、その都度送る。
問い合わせが届いたときの従来の通知（種別のみ）はそのまま。

### 今日の件数の見方

カウンタの表 `daily` は `day`（UTC の `YYYY-MM-DD`）・`used`（確保した枠＝送信済み）・`rejected`（上限で断った件数）の3列だけ。
31日より古い行は自動で消える。

- **送信のたびに見る:** `cd worker && wrangler tail eivrad-contact --format pretty`。受け付けた送信ごとに
  `contact: 日次枠 3/20 (2026-10-04 UTC)` の1行が流れる（Workers Logs は無効にしてあるので、tail で見ている間だけ・保存されない）。
- **表を直接見る:** Cloudflare ダッシュボードの Durable Objects から `eivrad-contact` の `ContactMailCounter` を開き、
  Data Studio でオブジェクト名 `resend-daily` を指定して `SELECT * FROM daily ORDER BY day DESC LIMIT 7;`
  （画面の名称・場所は Cloudflare 側で変わることがある）。
- **Resend 全体の消費:** Resend ダッシュボードの Emails。ライセンスメールを含めた合計が見える。

### 上限の変え方

`wrangler.toml` の `CONTACT_DAILY_MAIL_CAP` を書き換えて `wrangler deploy`。ダッシュボードで変数を変えても、
次の `wrangler deploy` で `wrangler.toml` の値に戻る。0 以上の整数だけが有効で、数字でない値は既定の 20 として扱う。
`"0"` にするとフォームからの送信を止め、全員に直接メールを案内する（Resend が使えないときの非常手段）。

### 戻し方

- **上限だけ外す:** `CONTACT_DAILY_MAIL_CAP` を `"100"` などにして deploy。カウンタはそのまま動き、
  Resend の 429 は引き続き `daily_limit`（直接メールの案内）になる。
- **コードを前の版に戻す:** Durable Object のマイグレーション（`v1`）を含む版から、それより前の版へは
  `wrangler rollback` で戻せない場合がある。その場合は次の手順で撤去する。
  1. `src/index.js` から `counter.js` の利用（import・export・枠の確保と返却）を外し、`src/counter.js` を削除する。
  2. `wrangler.toml` から `[[durable_objects.bindings]]` を消し、`[vars]` の `CONTACT_DAILY_MAIL_CAP` も消す。
  3. `[[migrations]]` の `v1` は残したまま、`tag = "v2"`・`deleted_classes = ["ContactMailCounter"]` を追記して deploy。
     消えるのは日付と件数の記録だけ。
- `contact/index.html` の `daily_limit` の表示は、Worker を戻しても残して差し支えない（そのコードが返らなければ表示されない）。

## 動作確認

```sh
# 認証設定
for r in "MX eivrad.com" "TXT eivrad.com" "TXT _dmarc.eivrad.com" \
         "TXT resend._domainkey.send.eivrad.com"; do
  echo "--- $r"; dig +short $r @1.1.1.1; done
```

フォームから自分宛に1件送り、届いた通知の「メッセージのソースを表示」で
`Authentication-Results:` を確認する。**`dkim=pass` かつ `dmarc=pass` が合格条件。**

日次上限の動き（上限到達・Resend 失敗時の枠の返却・429・カウンタ故障時の fail open・UTC 0時の切り替わり）は
`worker/test/contact.test.mjs` で確認する。本番に送って試さないこと（Resend の枠を使う）。
