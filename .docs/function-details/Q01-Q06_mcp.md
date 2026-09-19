# 詳細設計: Q-01 〜 Q-06（MCP 連携）

対象機能: **Q-01 有効化とトークン発行 / Q-02 読み取りツール / Q-03 書き込みツール（論理情報） / Q-04 書き込みツール（ER図の構成） / Q-05 配置の自動レイアウト連携 / Q-06 書き込み前のバックアップ**
関連: H-07・H-08（自動レイアウト）、H-09（外部変更バナー）、H-12（競合検出）、I-01〜I-03（ページ管理）、P-06〜P-08（論理制約）、P-12・P-13（タグ・色）、K-11（適用前バックアップ）、K-15（無視リスト）
設計書: [1_architecture.md](../1_architecture.md) §5.1（データの所有者）/ §8.2（エンドポイント）/ §8.5（セキュリティ）/ §8.8（MCP 連携）

---

## 0. この設計が守るべき不変条件

この機能の存在意義は「**AI に ER図 と説明を書かせ、人が `git diff` でレビューする**」である。
逆に言えば、レビューで戻せない壊れ方をさせないことが交渉不可能な前提になる。

| # | 不変条件 | 破られたときに起きること |
|---|---|---|
| INV-1 | MCP は **machine-owned（物理情報）を書き換えない**。書けるのは `meta.*`・`diagrams/**`・`manifest.diagrams`・`dictionary.js`・`config.js` だけ | 次の逆生成が DB を正として上書きし、**AI が書いた内容が黙って消える**。利用者から見れば「書いたはずのものが無い」という最悪の不具合になる |
| INV-2 | MCP は **DB に接続せず、ネットワークへ送信せず、`data/**` の外を読まない** | プロンプトインジェクション（DB コメントや注記に仕込まれた指示文）が成立したときに、スキーマや接続情報を外へ持ち出す経路ができる |
| INV-3 | MCP の認証は**セッショントークンと別建て**であり、互いに通用しない | AI クライアントの設定が起動のたびに切れる（別建てでない場合）。あるいは、AI に渡したトークンで書き込み API 全体が叩ける |
| INV-4 | 書き込みは**既存サービス**（`DiagramService` / `TableService` / `DictionaryService` / `ConfigService`）を必ず経由する | 決定論的プリンタ・`index.js` / `manifest.js` の再生成・`ATOMIC_MOVE` が二重実装になり、GUI 経由と MCP 経由で出力が食い違う |
| INV-5 | **MCP からは `force` を使わせない**。`baseHash` 検証を必ず通す | 人が GUI で編集した内容や `git pull` の結果を、AI が黙って踏み潰す |
| INV-6 | 書き込みツールは**許可がオフのとき `tools/list` に出さず、直接呼んでも拒否する** | 一覧に出さないだけでは、モデルが名前を推測して呼べてしまう |
| INV-7 | 無効化中は `POST /__erd/mcp` 自体が **404** を返す | 「無効なのにエンドポイントは生きている」状態は、攻撃面としても運用の説明としても余計 |

---

## 1. 全体構成

```
MCP クライアント (Claude Code)
   │  POST /__erd/mcp   Authorization: Bearer <MCP トークン>
   ▼
Javalin（既存プロセス・既存ポート）
   ├── (ガード)        有効判定 / トークン / Origin / Host          … §2
   ├── McpEndpoint     JSON-RPC 2.0 の入出力（自前実装）            … §3
   └── McpTools        ツールの実体（トランスポート非依存）          … §4・§5
         ├── ProjectStore / IndexGenerator          （読み取り）
         ├── TableService / DictionaryService / ConfigService （書き込み）
         ├── DiagramService                          （書き込み）
         ├── AutoLayout（ELK）                       （座標計算）
         └── Backups                                 （書き込み前スナップショット）
```

**`McpTools` はトランスポートを知らない。** 将来 stdio を足す場合も、`McpEndpoint` を差し替えるだけで済む。

---

## 2. Q-01 認証と設定

### 2.1 設定ファイル `erd/.local/mcp.json`

**全ワークスペース共通。Git 管理外**（同梱の `.gitignore` が `.local/` を除外する。設計書 §3.3）。

```json
{
  "enabled": true,
  "write": false,
  "token": "…64桁…",
  "issuedAt": "2026-09-04T09:00:00Z",
  "lastAccess": { "at": "2026-09-04T09:31:22Z", "tool": "erd_list_tables", "write": false }
}
```

- **`erd/config.js` に置いてはならない**（Git 管理対象であり、トークンがコミットされる）。
- トークンはセッショントークンと同じ強度（`SecureRandom` 16 バイト以上の hex）とする。
- `lastAccess` は毎リクエスト更新するが、**書き込みのたびにファイルを書くと差分ノイズになる**ため、
  メモリ上で保持し、変化があれば数秒デバウンスして書く（Git 管理外なので競合の心配はない）。

### 2.2 ガード（`McpEndpoint` 内）

**既存の `authorized()` とは別の関数にする**（INV-3）。判定順と応答は次のとおり。

| 条件 | 応答 |
|---|---|
| `enabled` が false | **404**（エンドポイントが存在しないかのように振る舞う。INV-7） |
| `Host` のホスト名が `127.0.0.1` / `localhost` / `[::1]` でない | 403 |
| `Origin` があり、サーバー自身のオリジンと完全一致しない | 403 |
| `Authorization: Bearer <token>` が `mcp.json` の `token` と一致しない | 403 |
| （**セッショントークンの提示**） | 403（通用させない。INV-3） |

- `Host` はホスト名だけを見て**ポートは見ない**。理由は設計書 §8.5（dev の vite プロキシが `changeOrigin: false`）。
- トークン比較は**固定時間比較**とする（ローカル専用だが、比較コストの差で漏れる情報を作らない）。
- 403 の本文にトークンや設定内容を含めない。

### 2.3 設定 API（GUI 用。セッショントークンで認証する）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/__erd/mcp/settings` | `enabled` / `write` / トークンの**有無と発行日時**（値は返さない）/ `lastAccess` / **現在の実ポート** |
| PUT | `/__erd/mcp/settings` | `{ enabled?, write?, token?: "issue" \| "delete" }`。`issue` は新規発行（既存があれば即失効） |

- **トークンの生値を返すのは発行の応答だけ**とする。以後 GET では伏字（`erf_…abcd` のような末尾数文字）だけを返す。
  再表示できないことを画面に明記し、失くしたら再発行させる。

---

## 3. トランスポートと JSON-RPC

### 3.0 2 世代を同時に喋る（dual-era）

MCP の仕様は改訂 **`2026-07-28`** で **`initialize` のハンドシェイクを廃止**し、
リクエストごとにメタ情報を載せるステートレス方式（仕様の言う **modern**）になった。
`2025-11-25` 以前（**legacy**）とは開始手順も版の運び方も違う。

**両方を実装する。** 仕様の互換性マトリクスでは「legacy クライアント × modern のみのサーバー」は
**失敗する**とされており、片方だけでは手元のクライアントか将来のクライアントのどちらかで動かない。
仕様自身が dual-era を認めている。

**世代の判定はリクエストの形で行う**（仕様どおり）:

| 条件 | 世代 |
|---|---|
| `params._meta` に `io.modelcontextprotocol/protocolVersion` がある | **modern** |
| `initialize` が来た | **legacy** |
| どちらでもない（`_meta` なしの `tools/list` 等） | legacy として扱う |

### 3.1 実装するメソッド

| メソッド | legacy | modern | 応答 |
|---|---|---|---|
| `initialize` | ✓ | — | `protocolVersion`（提示版をサポートしていればそのまま返す）、`serverInfo`、`capabilities: { tools: {} }`、`instructions` |
| `notifications/initialized` | ✓ | — | 通知（id なし）はすべて **202 Accepted** で本文なし |
| `server/discover` | — | ✓ | `supportedVersions`・`capabilities`・`_meta['io.modelcontextprotocol/serverInfo']`・`instructions`。**modern ではサーバーに実装義務がある** |
| `tools/list` | ✓ | ✓ | ツール定義の配列。**書き込み許可がオフなら読み取りツールのみ**（INV-6） |
| `tools/call` | ✓ | ✓ | §4・§5 のディスパッチ |
| `ping` | ✓ | ✓ | 空応答 |

- modern の結果には **`resultType: "complete"`** を付ける。
- `GET` / `DELETE` は **405**（旧リビジョンの SSE ストリームとセッション終了。実装しない）。
- **セッションを持たない**（`Mcp-Session-Id` を発行しない）。
- 応答は常に `application/json`（通知を送らないため SSE 応答ストリームを開かない。仕様上許容される）。
- 対応版は 1 箇所の定数に置き、テストで固定する。

### 3.2 modern のヘッダ検証

modern では、本文の一部が HTTP ヘッダにも載る。**ヘッダと本文が食い違うリクエストは拒否する**
（経路上の中継が本文と違う値で判断する余地を作らないため、仕様が要求している）。

| ヘッダ | 対応する本文 | 欠落・不一致のとき |
|---|---|---|
| `MCP-Protocol-Version` | `params._meta['io.modelcontextprotocol/protocolVersion']` | **400 + `-32020`**（`HeaderMismatch`） |
| `Mcp-Method` | `method` | 同上 |
| `Mcp-Name` | `params.name`（`tools/call`） | 同上 |

- `Mcp-Name` は非 ASCII を **`=?base64?…?=`** の形で運ぶことがあるため、比較前にデコードする。
- 未対応の版は **400 + `-32022`**（`UnsupportedProtocolVersionError`）で、`data.supported` に対応版を列挙する。
- 未知のメソッドは **404 + `-32601`**（HTTP+SSE の旧サーバーが返す 404 と区別できるよう、本文に JSON-RPC エラーを載せる）。

### 3.3 エラーの出し分け

**「プロトコルの誤り」と「ツール実行の失敗」を混同しない。**

| 種別 | 表現 | 例 |
|---|---|---|
| プロトコルの誤り | **JSON-RPC error**（`-32700` / `-32600` / `-32601` / `-32602` / `-32603`） | JSON が壊れている、未知のメソッド、`name` が無い |
| ツール実行の失敗 | **`result` に `isError: true`** とテキスト | ページ ID が不正、参照先テーブルが無い、`STALE`、書き込み許可がオフ |

ツール実行の失敗を JSON-RPC error にしないのは、**モデルが自力で直せるようにする**ためである。
`isError` の結果はモデルのコンテキストに戻り、再試行の材料になる。したがって**文言は「何が悪くて、どうすれば通るか」**を書く。

```
Page ID "受注 v2" is invalid. Use letters, numbers, dots, underscores, and hyphens only.
Existing page IDs: core, billing, inventory.
```

---

## 4. ツール定義

**説明文はすべて英語**（LLM 向けであり X-01 / X-02 の翻訳対象ではない）。
`workspace` は全ツール共通の任意引数で、**省略時はワークスペースが1つならそれを使い、
複数なら「どれか」を明示させる `isError`** を返す（黙って先頭を選ばない）。

### 4.1 Q-02 読み取り（8 種・常時公開）

| ツール | 引数 | 実装 |
|---|---|---|
| `erd_list_workspaces` | — | `WorkspaceStore.list` + 各 `manifest` の `schemaVersion` とテーブル数 |
| `erd_list_tables` | `query?` `tag?` `diagram?` `limit?`(既定200) `offset?` | `IndexGenerator` が作る索引相当（id / 物理名 / 論理名 / カラム数 / タグ / 色 / 所属ページ） |
| `erd_get_table` | `tableId` | `ProjectStore` でテーブル1件 + **カラム辞書を解決した論理名**（`displayName` と、由来を示す `displayNameSource: "column" \| "dictionary"` を併記） |
| `erd_list_relations` | `tableId?` | `index.js` の `relations`（カーディナリティは解決済みの値をそのまま） |
| `erd_search` | `query` `target?`(`table`/`column`/`note`) `limit?` | F-04 と同じ対象。`note` は `meta.notes` を含む |
| `erd_list_diagrams` | — | `manifest.diagrams` + 各ページのノード数 |
| `erd_get_diagram` | `diagramId` | `diagrams/<id>.js` のノード・エッジ |
| `erd_get_dictionary` | — | `dictionary.js` |

- **キャッシュしない。** GUI からの保存直後に古い値を返さないため、毎回ディスクから読む
  （`ProjectStore.read` + `IndexGenerator.generate`）。索引ファイルを直接読まないのは、
  `index.js` が派生物であり、パーサを別途持つと生成規則の二重管理になるためである。
- 一覧系は打ち切ったとき `"showing 200 of 431 tables"` を必ず添える（モデルが全件と誤認しないように）。

### 4.2 Q-03 書き込み（論理情報）

| ツール | 引数 | 経由するサービス |
|---|---|---|
| `erd_set_table_meta` | `tableId`, `displayName?`, `notes?`, `tags?`, `color?`, `columns?: [{name, displayName?, notes?, tags?, color?}]` | `TableService.put`（**§4.4 のマージ層経由**） |
| `erd_set_logical_constraints` | `tableId`, `logicalForeignKeys?`, `logicalUniques?`, `relations?` | 同上 |
| `erd_set_dictionary_entry` | `column`, `displayName?`, `tags?`, `color?` | `DictionaryService.put` |
| `erd_set_ignore_tables` | `patterns: []` | `ConfigService.put` |

- **省略した項目は変更しない**（`null` を明示したときだけ削除する）。全文置換にすると、
  モデルが1項目だけ直すつもりで他を消す事故が必ず起きる。
- タグ・色は既存の正規化（`MetaRules.normalizeTags` / `normalizeColor`）をそのまま通す。
  未知の色トークンは **422 相当の `isError`** とし、使える値を列挙する（P-13）。
- 論理制約の検証は **P-08 と同一の規則**（参照先テーブル / カラムの存在、カラム数の一致）。
  検証の実装を MCP 用に二重化しない。

### 4.3 Q-04 書き込み（ER図の構成）

| ツール | 引数 | 経由するサービス |
|---|---|---|
| `erd_create_diagram` | `id`, `title`, `order?` | `DiagramService.create` |
| `erd_update_diagram` | `diagramId`, `title?`, `order?` | `DiagramService.patch` |
| `erd_delete_diagram` | `diagramId` | `DiagramService.delete` |
| **`erd_place_tables`** | `diagramId`, `add?: []`, `remove?: []`, `layout?: "auto"(既定) \| "keep"` | `AutoLayout` → `DiagramService.patch` |
| `erd_auto_layout` | `diagramId` | 同上（ページ全体を再配置） |
| `erd_set_node_positions` | `diagramId`, `nodes: { "<tableId>": [x, y] }` | `DiagramService.patch` |

`erd_set_node_positions` の説明文には **"Prefer `erd_place_tables`; only use this to fine-tune"** と明記する。

### 4.4 マージ層（machine-owned を守る）

`TableService.put` は**テーブル1件の完全な定義を受け取り全文置換する**（O-03 詳細設計 §4.3）。
MCP のツールは部分更新なので、間に薄いマージ層を1枚置く。

1. 現在のテーブルをディスクから読む（同時に `baseHash` を得る）
2. **`meta` 配下のみ**にパッチを当てる。machine-owned のフィールドは読んだ値をそのまま使う
3. 引数に machine-owned のキーが混ざっていたら**黙って捨てず `isError`** にする
   （「無視した」と伝えないと、モデルは書けたつもりで先へ進む）
4. `TableService.put` に完全な定義 + `baseHash` を渡す

**3 が INV-1 の実効的な担保である。** テストで固定する（§8）。

---

## 5. Q-05 配置の自動レイアウト連携

**AI に座標を書かせない。** LLM は「どのテーブルを同じページに置くか」という意味的判断は得意だが、
重なりのない座標を出すのは苦手で、1テーブル1呼び出しにするとツール呼び出しを浪費する。

`erd_place_tables(diagramId, add, remove, layout)` の処理:

1. `diagrams/<id>.js` と `index.js` を読む
2. `remove` のノードを外す
3. `add` のテーブルが**存在するか**を検証（無ければ `isError` に不明な ID を列挙）
4. `layout: "auto"` なら、**そのページの最終的なノード集合**と、その間のリレーション（`index.js` の `relations` を
   ページ内に閉じたものへ絞る）を `AutoLayout.layout` に渡して座標を得る
5. `DiagramService.patch` に `nodes` の差分として渡す（1 回の書き込み）

- **`layout: "keep"`** は既存ノードの座標を保ち、新規分だけを空き領域に置く。既存の配置を尊重したいときに使う。
- ノードの寸法は GUI と同じ既定値を使う（ELK に渡す `w` / `h`）。**ビューア側の実測値には依存しない**
  （MCP はブラウザを持たないため）。多少ずれても、人が GUI で `fitView` すれば済む。
- **粗い粒度にする。** `add` / `remove` が配列を受けるのは、数十テーブルのページ生成で書き込みが
  数十回に分かれるのを防ぐため。バナーは二重に開かない仕様（設計書 §8.7）だが、Git の中間状態は増える。

### 5.1 想定フロー（本命ユースケース）

```
1. erd_list_tables / erd_list_relations       全体像を把握する
2. （AI がソースコードを読む）                  業務ドメインの切り方を推測する
3. erd_create_diagram                          ページを切る
4. erd_place_tables                            テーブルを置く（座標は ELK）
5. erd_set_logical_constraints                 コード上の参照関係を論理外部制約に（破線エッジが出る）
6. erd_set_table_meta                          論理名・注記を埋める
7. 人が GUI で確認し、git diff でレビューして commit
```

---

## 6. Q-06 書き込みの安全網

| 層 | 実装 |
|---|---|
| バックアップ | `Backups.create(privateDir, dataDir)`（K-11 と同一実装）。**MCP からの書き込み前**に `data/**` をスナップショット |
| バックアップの頻度 | 毎回取ると3世代がすぐ埋まるため、**サーバー起動後の最初の MCP 書き込み**と、**前回の MCP バックアップから一定時間（既定10分）経過**したときだけ取る。ワークスペースごとに判定する |
| 競合検出 | `baseHash` を必ず通す（INV-5）。`STALE` なら**1回だけ**読み直して再試行し、それでも失敗したら `isError` で「他の誰か（GUI / `git pull` / 別の AI セッション）が変更した」と伝える |
| 通知 | 書き込みは GUI と同一プロセス・同一サービスを通るため `Revisions` が採番し、開いているタブに**外部変更バナー**（H-09）が出る。専用の通知経路は作らない |
| 回復 | `git checkout` が第一手段。バックアップは Git を使っていない利用者と、コミット前に大量に書かれた場合の保険 |

---

## 7. Q-01 画面（設定 → AI 連携（MCP））

| 要素 | 内容 |
|---|---|
| 状態 | 有効 / 無効のトグル。既定は**無効** |
| トークン | [発行] / [再発行]（旧トークンは即失効）/ [削除]。**生値は発行直後しか表示しない**（以後は末尾数文字のみ）。[コピー] を置く |
| 書き込みの許可 | 既定オフ。**トグルは1段**。オンにするとき、書き換わり得るものを列挙する（論理名・注記・タグ・色・論理制約・ER図ページと配置・カラム辞書・無視リスト）と、**「先にコミットしておくことを推奨します」** |
| 設定スニペット | **実ポートとトークンを埋め込んだ JSON** を表示して [コピー]。A-11 が等価な CLI コマンドを常に見せているのと同じ思想。**トークンを実物で埋められるのは発行直後だけ**なので、それ以外は `<発行したトークン>` のプレースホルダを出す（伏字を貼らせない）。ここを「いつでも実物が見られる」ようにすると、画面を開くだけでトークンが漏れる経路になる |
| 最終アクセス | 直近のツール呼び出しの時刻・ツール名・書き込みの有無 |
| 注意書き | 「サーバーを停止すると AI から見えなくなる」「ポートが変わったら貼り直す」 |

**トグルを2段（論理情報 / ER図の構成）に割らない。** 回復コストは非対称だが（人が書いた注記は Git から
戻すしかなく、ER図の配置は自動レイアウトで作り直せる）、本命の用途が両方を使うため実運用では両方オンになる。
設定が増えると「AI からツールが見えない」原因が2通りに増える。後から割るのは既存設定を壊さずにできる。

**静的モードではこの画面を出さない**（サーバーが居ないため）。

---

## 8. テスト

**認証と境界を最優先で固定する。** ここは「うっかり通った」がそのまま事故になる場所である。

| # | 対象 | 内容 |
|---|---|---|
| T-1 | 認証 | トークンなし / 誤トークン / **セッショントークンの提示**は 403。無効化中は 404 |
| T-2 | `Host` | `Host: localhost:5173`（dev の vite プロキシ相当）と `127.0.0.1:<実ポート>` が**両方通り**、`evil.example.com` は 403。**全ルートに掛ける変更なので、落とすと dev 環境ごと死ぬ** |
| T-3 | `Origin` | 欠落は許可、別オリジンは 403 |
| T-3a | legacy | `initialize` が提示版をそのまま返し、`tools/call` が実データを返す |
| T-3b | modern | `server/discover` が対応版を返す。ヘッダと本文の不一致は 400 + `-32020`、未対応の版は 400 + `-32022`（`data.supported` 付き）、未知のメソッドは 404 + `-32601`、通知は 202 |
| T-4 | INV-1 | `erd_set_table_meta` に `columns[].type` などの machine-owned を混ぜたら `isError`。**書き込みは発生しない** |
| T-5 | INV-6 | 書き込み許可オフのとき、書き込みツールが `tools/list` に**出ず**、直接 `tools/call` しても拒否される |
| T-6 | INV-2 | `tools/list` に逆生成・接続設定・テーブル削除 / 作成 / リネーム・ワークスペース操作・データリセット・ZIP 書き出しが**存在しない** |
| T-7 | INV-5 | `baseHash` 不一致で1回再試行し、2回目も不一致ならファイルを**1バイトも書かない** |
| T-8 | シナリオ | 空ページを作り `erd_place_tables` で10テーブル置き、論理外部制約を1本足す → `index.js` にエッジが現れ、`manifest.js` にページが載り、出力が golden fixture と一致する |
| T-9 | エラー文言 | 不正なページ ID・存在しないテーブル ID のとき、**候補または正しい書式が本文に含まれる**（モデルが自力で直せること） |

| T-10 | 画面からの通し（e2e） | `npm run e2e:mcp`。配布物と同じ構成で起動し、**画面の操作だけ**で有効化 → トークン発行を行い、**表示されたスニペットのトークンでそのまま `POST /__erd/mcp` が通る**ことまで確かめる。画面・トークン・エンドポイントのどれがずれても画面上は正常に見えてしまい、利用者には「貼ったのに繋がらない」としか分からないため、ここを機械で押さえる |

手動確認は MCP Inspector（`npx @modelcontextprotocol/inspector`）で行う。開発時のみ Node を使うのは
viewer のビルドと同じで、配布物には影響しない。

---

## 9. 非スコープ

| 出さないもの | 理由 |
|---|---|
| 逆生成の実行（DB 接続・`introspect` / `apply`） | DB 認証情報を LLM 経由の操作対象にしない。差分の承認は人が GUI で行う（設計書 §4.2）。適用は複数ファイルのアトミック置換とバックアップを伴う（§8.6） |
| 接続設定の読み書き | パスワードを含む（INV-2） |
| 物理情報の変更 | INV-1 |
| テーブルの新規作成 / 削除 / リネーム | リネームは配置と参照への波及を伴い `RenameService` 経由が必須（O-03 詳細設計 §3）。作成は J-01 の領分 |
| ワークスペースの作成 / 削除 / 改名 | 削除は ID の打ち込み確認を要する破壊操作（A-10） |
| データリセット・閲覧用 ZIP の書き出し | 破壊的、あるいは成果物を外へ出す操作。人が明示的に行う |
| MCP の resources / prompts | クライアントの対応がまちまちで、必要なことは tools で表現できる |
| stdio トランスポート | ライフサイクルが Web サーバーと別になり、説明が難しい（設計書 §8.8 の比較表）。`McpTools` を分離してあるため、必要になれば後から足せる |
