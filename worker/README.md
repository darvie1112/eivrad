# eivrad-contact — お問い合わせフォーム受付 Worker

`https://eivrad.com/contact/` のフォームから POST を受け、Turnstile で検証したうえで
Resend 経由で `contact@eivrad.com` へ通知する Cloudflare Worker。

配信サイト本体は GitHub Pages（このリポジトリのルート）だが、eivrad.com は
Cloudflare のプロキシ配下にあるため、`/api/contact` だけを Worker が横取りしている。

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
| Turnstile | サイト名 `eivrad.com` | Site Key は `contact/index.html` に直書き（公開情報） |
| Resend | ドメイン `send.eivrad.com` | 送信元。ルートドメインとは分離している |
| DNS | `_dmarc.eivrad.com` | `p=quarantine` + `rua`。rua が唯一の可視化手段 |

**シークレットの値をこのリポジトリに書かないこと。**

## デプロイ

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

## 設計上の約束（変更する前に読むこと）

- **通知メールの From は必ず `form@send.eivrad.com`。** 問い合わせ者は `Reply-To` に入れる。
  From に問い合わせ者のアドレスを入れると、au（`p=reject`）や docomo（`sp=reject`）から
  届いた問い合わせの通知を自分で消すことになる。
- **自動返信は送らない。** ボットが第三者のアドレスを入力した場合にバックスキャッタ源となり、
  Google の送信者要件「スパム率 0.3% 未満」を直撃する。受付は送信完了画面で伝える。
- **シークレットが欠けたら fail closed。** 検証を素通りさせるより 503 で落とす。
- **Resend Free は日次 100 通で 429 停止し、従量課金では逃げられない。** JST 午前9時（UTC 0時）まで復旧しない。
  Turnstile・time-trap・レート制限はいずれも「あった方がいい」ではなく必須。

## 動作確認

```sh
# 認証設定
for r in "MX eivrad.com" "TXT eivrad.com" "TXT _dmarc.eivrad.com" \
         "TXT resend._domainkey.send.eivrad.com"; do
  echo "--- $r"; dig +short $r @1.1.1.1; done
```

フォームから自分宛に1件送り、届いた通知の「メッセージのソースを表示」で
`Authentication-Results:` を確認する。**`dkim=pass` かつ `dmarc=pass` が合格条件。**
