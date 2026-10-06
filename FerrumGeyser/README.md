# FerrumCertificates — GeyserのNetherNet HTTPS連携

FerrumProxyのManager APIから証明書と秘密鍵を取得し、Geyserの `config.yml` にHTTPS用のパスを自動設定するGeyser拡張です。既存のCertbot等が更新したファイルをManagerが毎回読み直すため、Geyser側への手動コピーは不要です。

証明書の**発行・更新はCertbot等の発行元**で行います。この拡張は更新済みの証明書を配布・反映します。別サーバーで発行している場合は、更新後のファイルがFerrumProxy側にも届く仕組み（共有マウント、更新後の同期など）が必要です。一度だけコピーしたファイルは自動更新されません。

## 導入手順

1. この変更を含むFerrumProxy本体とFerrumGUIをビルド・更新し、対象インスタンスを起動します。GUIのインスタンス設定 → **Manager API** → **API・Geyser証明書連携**を開きます。
2. 「配布する証明書」で接続ドメインと、**FerrumProxyが動くサーバー上**の `fullchain.pem` / `privkey.pem` のパスを指定し、**「証明書を検証して登録」**を押します。ドメインを変更すると `/etc/letsencrypt/live/example.com/` 形式の標準パスを自動入力します。手動指定した別のパスは保持します。これはパスの補完であり、実際のファイルの存在・ドメイン・鍵の一致は登録時に検証します。既存の登録は一覧から選択して編集できます。FerrumProxyの実行ユーザーにファイル・親ディレクトリの読み取り権限が必要です。秘密鍵を全ユーザーに公開する権限にはしないでください。
3. 「Geyser拡張の認証」で、登録済み証明書を選択してトークンを発行します。発行時に一度だけ表示されます。管理者用Manager Tokenを拡張に渡す必要はありません。「拡張設定をコピー」には、選択した証明書のIDとドメインが入ります。証明書登録・トークン発行は各ボタンで即時保存され、画面下のインスタンス設定の「保存」とは別の操作です。
4. GitHub Releasesの固定タグ **FerrumGeyser** から `FerrumGeyser.jar` を取得するか、下の手順でビルドし、Geyserの `extensions/` に配置して一度起動します。設定フォルダー `extensions/FerrumCertificates/` が作成されます。Paperの場合は通常 `plugins/Geyser-Spigot/extensions/` です。
5. 発行したトークンを `extensions/FerrumCertificates/manager-token.txt` に保存し、同フォルダーの `config.yml` を下の例のように設定して、Geyserを再起動します。GUIの「拡張設定をコピー」も使えます。

```yaml
enabled: true
# GUIのURL＋対象インスタンスのManagerパス。インスタンスIDはGUIで確認します。
manager-url: 'https://manager.example.com/api/instances/INSTANCE_ID/manager'
token-file: manager-token.txt
certificate-id: geyser
domain: example.com
poll-seconds: 300
auto-reload: true
allow-insecure-http: false
```

Managerへの接続はHTTPS、localhostのHTTP、またはTailscaleの100.64.0.0/10内のIPv4 HTTPに対応します。Manager本体は `127.0.0.1` のみで待ち受けるため、別マシンのGeyserからはGUIのManager転送URLを使います。公開HTTPのURLをコピーした場合はHTTPSまたはTailscale経由のURLへ変更してください。

UbuntuではトークンファイルをGeyserの実行ユーザー所有にして、権限を制限します。

```sh
chmod 600 extensions/FerrumCertificates/manager-token.txt
```

配布設定の `enabled` は `false` です。`example.com`、ManagerのURL、証明書IDを実際の環境に合わせて設定してから有効にします。

拡張が読み込まれていても `enabled: false` なら証明書連携は動きません。拡張設定の変更後はGeyserを再起動してください。Paperではサーバーを再起動します。起動ログに有効・無効の状態と読み込んだ設定ファイルのパスを表示します。`manager-url` のパスに誤って `//api` と入力した場合は自動補正し、警告を表示します（`http://` / `https://` は維持します）。失敗ログの `stage` はトークン読み取り、Manager通信、証明書検証、設定書き込み、リロードのどこで失敗したかを示します。Managerが200以外を返した場合はHTTPステータスも表示します。トークン・PEM・APIのエラー本文はログに出しません。

## GeyserとFerrumProxyのネットワーク設定

ユーザー提供の設定のように、Geyserは `bedrock.transport: nethernet` と `bedrock.signaling.mode: builtin` で動かします。拡張が変更するのは次のHTTPS設定だけで、Floodgate、HAPROXY、MOTDなどの設定・コメントは保持します。最初の変更前の設定を `config.yml.ferrum-backup` に保存します。

```yaml
bedrock:
  port: 19132
  webrtc-port: 0
  transport: nethernet
  signaling:
    mode: builtin
    builtin:
      https:
        certificate: '/.../extensions/FerrumCertificates/tls/REVISION/fullchain.pem'
        private-key: '/.../extensions/FerrumCertificates/tls/REVISION/privkey.pem'
        password: ''
```

この構成はGeyserでTLSを処理します。FerrumProxyは19132のTCPとUDPをGeyserへ転送してください。FerrumProxy側のTLS終端を同時に有効にする必要はありません。

HTTPSのSDPはFerrumProxyで書き換えられないため、GUIの証明書登録に `advertiseHost` と `advertisePort` を設定すると、拡張がGeyserの `geyserAdvertiseAddresses` システムプロパティに公開UDP IPを設定します。このGeyserプレビューではプロパティによる広告に別の公開ポートを指定できないため、**公開UDPポートとGeyser側のBedrockポートは同じ値**にしてください。今回の例は両方19132です。ポートが異なる登録は設定を書き換える前に拡張が拒否します。`both` や別の `webrtc-port`、ポート変換が必要な構成はこの自動広告機能の対象外です。

GeyserがHAPROXYを要求する設定の場合、Proxy側でもHAPROXY転送を有効にし、Geyserの許可リストに**Geyserから見えるProxyの送信元IP**を設定します。証明書のドメインはクライアントが使う接続名と一致させます。例の `example.com` にはその名前をSANに含む証明書が必要です。`play.example.com` に接続する場合は、その名前または `*.example.com` を含む証明書を使います。

## 更新時の動作

通常5分ごとにManagerから取得し、X.509の期限・DNS名・SHA-256・秘密鍵との一致を検証します。RSA/ECの非暗号化PEM（PKCS8、RSA PKCS1、EC SEC1）に対応します。ファイルを世代別ディレクトリへ書き込んでから設定を置換し、反映が必要な時だけGeyser内部の `GeyserImpl.reloadGeyser()` を直接呼びます。これは `geyser reload` コマンドが呼ぶ処理です。取得・検証に失敗した場合は既存の設定を保持します。同じ証明書で毎回リロードすることはありません。トークンファイルも毎回読むため、トークンの差し替えは拡張の再起動なしで反映されます。

`auto-reload: true` なら初回の設定変更と証明書更新を自動反映します。Geyserのプロセスは再起動せず、ネイティブのリロード処理で設定を読み直し、イベント、Bedrock接続、HTTPSリスナーを更新します。接続中のBedrockプレイヤーは切断されます。`auto-reload: false` の場合は設定を更新して通知し、運用者が `geyser reload` を実行します。

リロードはGeyser内部のスケジューラーで実行します。初回もGeyserが設定を読み込んだ後に拡張が動くため、初期化完了後に一度リロードします。NetherNetの停止は非同期なので、`GeyserPreReloadEvent` で既存リスナーの停止完了を待ち、ポートの再確保に失敗する競合を避けます。待機はTCP接続確認・UDPバインド確認によって行い、この処理にリフレクションは使用しません。

**リフレクションはStandaloneのコンソール対策1箇所に限定しています。** 検証対象のStandaloneは `onGeyserEnable()` のたびにブロックするコンソール入力ループを開始します。そのため `StandaloneConsoleGuard` で `geyserLogger` フィールドを起動時に一度だけ、元の入力ループを初回だけ開始するロガーへ置き換えます。元のコンソールとコマンド入力は維持します。設定・証明書・NetherNetのprivateフィールドにはアクセスしません。Standalone以外ではこの対策を使わず、内部リロードAPIを直接利用します。

JSONはフィールドを明示的に読み取り、YAMLは `SafeConstructor` でマッピングとして読み込みます。CIは上記の固定フィールドへのアクセス以外のリフレクションを禁止します。依存ライブラリやGeyser本体の内部実装はこの検査範囲に含みません。

以前の `reload-command` / `reload-timeout-seconds` は不要です。古い設定に残っていても外部コマンドは実行しません。内部APIへの依存があるため、Geyserの更新時は対応するプレビュー版で再ビルド・統合検証してください。

Certbotの既存の自動更新は発行元サーバーで確認します。

```sh
systemctl list-timers --all | grep -i certbot
sudo certbot renew --dry-run
```

Certbotが `live/` のリンク先を更新すると、Manager APIは新しい世代を読み、拡張の次回取得で反映します。Manager APIを呼ぶこと自体は証明書を発行しません。

## Manager API

全操作はBearer認証です。GUIからは `/api/instances/INSTANCE_ID/manager` を各パスの前に付けます。ログイン済みGUI画面からはセッションも利用できます。外部から渡された拡張用BearerトークンをGUIが管理者トークンへ置き換えることはありません。

| メソッド・パス | 用途 | 必要権限 |
| --- | --- | --- |
| GET `/api/v1/catalog` | 操作一覧（GUIのAPI実行画面で利用） | 管理者 |
| GET `/api/v1/health` | 生存確認 | 管理者 / `health:read` |
| GET `/api/v1/performance` | 稼働情報 | 管理者 / `performance:read` |
| GET / POST `/api/v1/tokens` | 既存の共有リレー用トークン一覧・発行 | 管理者 |
| DELETE `/api/v1/tokens/{id}` | 共有リレー用トークン削除 | 管理者 |
| GET / POST `/api/v1/credentials` | API認証の一覧・発行 | 管理者 |
| DELETE `/api/v1/credentials/{id}` | API認証の失効 | 管理者 |
| GET / POST `/api/v1/certificates` | 証明書登録の一覧・登録または更新 | 管理者 |
| GET `/api/v1/certificates/{id}` | 検証済み証明書と秘密鍵の取得 | 管理者 / `certificates:read:{id}` |
| DELETE `/api/v1/certificates/{id}` | 登録削除と、その証明書への既存権限の削除 | 管理者 |

証明書登録リクエスト例：

```json
{
  "id": "geyser",
  "domain": "example.com",
  "certificatePath": "/etc/letsencrypt/live/example.com/fullchain.pem",
  "privateKeyPath": "/etc/letsencrypt/live/example.com/privkey.pem",
  "advertiseHost": "198.51.100.1",
  "advertisePort": 19132
}
```

`advertiseHost` / `advertisePort` はセットで指定するか、両方省略します。相対パスはFerrumProxyの設定ファイルがあるディレクトリを基準に解決します。Certbotの `live/` のパスを保存し、登録時の `archive/` 世代に固定しません。

拡張用認証の発行リクエスト例：

```json
{
  "name": "Geyser",
  "scopes": ["certificates:read:geyser"],
  "expiresIn": null
}
```

`expiresIn` は秒数です。`null` は失効まで有効。レスポンスの `token` は一度だけ返します。保存先はProxy設定に付随する `CONFIG_PATH.manager.json` で、トークンのハッシュ、権限、有効期限、証明書の元パスだけを保存します。PEMはこのJSONに保存しません。Unix上では権限600です。

証明書取得レスポンスは `id`, `domain`, `revision`, `expiresAt`, `certificateSha256`, `certificatePem`, `privateKeyPem`, `advertiseHost`, `advertisePort` を含み、`Cache-Control: private, no-store` を返します。ETag / If-None-Matchにも対応します。一覧にはPEMやトークンを含めません。GUIの汎用API実行画面ではレスポンスのトークン・PEMを非表示にします。

## ビルドと検証

Java 21以上とMavenが必要です。内部APIに直接依存するため、検証用の公式Geyser Standalone JARでコンパイルします。リポジトリのルートで固定バージョンを取得してから、`FerrumGeyser/` 内でビルドします。

```sh
python FerrumGeyser/scripts/fetch_geyser.py
cd FerrumGeyser
mvn verify
```

出力：`target/FerrumGeyser.jar`。GsonとSnakeYAMLはJARへ同梱し、パッケージ名を変更してGeyser本体との競合を避けています。

別のJARを使う場合は `mvn -Dgeyser.jar=/absolute/path/to/Geyser-Standalone.jar verify` のように絶対パスを指定します。

検証対象：Geyser `2.12.0-SNAPSHOT` / `bc81f9ed819e946a83121c9a8d26600407027cc4`（公式プレビューStandalone build 3057）。自動テストではYAMLコメント・Unicodeの保持、鍵の形式、期限切れ・ドメイン・鍵の不一致、トークン差し替え、更新時の設定変更、取得失敗時の設定保持、コンソールの二重起動防止を確認します。Rust側では認証の権限分離・失効・ETagと元ファイル更新の反映をHTTP経由で確認します。Standalone統合検証では、同じプロセス内の内部APIリロードによるHTTPS `/v1/join`、証明書更新、同じ証明書でリロードしないこと、手動 `geyser reload` とその後のコンソール応答を確認します。Spigot/PaperとiPhoneからのゲーム参加は別途実環境で確認が必要です。

実機Standaloneのローカル検証を再現するには、Proxyの `cargo build` と拡張の `mvn package` の後に、リポジトリのルートで次を実行します。Python 3の標準ライブラリを使用し、テスト用設定・公開テスト証明書を `.deps/` 内の新しいフォルダーに作ります。テストプロセスは終了時に停止します。本番サーバー設定には触れません。

```sh
python FerrumGeyser/scripts/check_no_reflection.py
python FerrumGeyser/scripts/fetch_geyser.py
python FerrumGeyser/scripts/verify_standalone.py --geyser-jar /absolute/path/to/Geyser-Standalone.jar
```

## GitHub Actionsによる自動リリース

`.github/workflows/ferrumgeyser-build.yml` は `main` / `master` への対象ファイルのpushと手動実行に対応します。Pull Requestではビルド・検証だけを行います。Java 21でテストとJAR作成を行い、SHA-256で固定した公式プレビュー版GeyserとローカルManagerを起動してHTTPS・証明書更新・内部APIリロードを検証します。Standaloneの固定フィールド以外へリフレクションを追加すると検証で失敗します。

検証成功後、固定タグ `FerrumGeyser` のリリースに `FerrumGeyser.jar`、`config.example.yml`、`README.md`、`SHA256SUMS`、コミット・日時を記録する `version.json` を公開します。ビルドジョブは読み取り権限、リリースジョブだけが `contents: write` を持ちます。手動実行も `main` / `master` で実行した場合だけ公開します。GitHubのActionsが有効で、リリース作成がリポジトリの設定で許可されていることが必要です。

テスト用Geyserを更新するときは `scripts/geyser-fixture.json` の公式プロジェクト・ビルド番号・コミット・SHA-256を同時に更新し、統合検証を実行します。

参考：[Geyser拡張の導入](https://geysermc.org/wiki/geyser/extensions/)、[公式拡張テンプレート](https://github.com/GeyserMC/GeyserExtensionTemplate)、[Certbotの自動更新](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)。
