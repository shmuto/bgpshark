# TODO

## 対応済み

2026-08-04 の Playwright 実機テストで洗い出した 8 件はすべて修正済み。

| # | 内容 | 主な変更 |
|---|------|----------|
| 1 | SQLコンソールがエラーを「0 行」と表示 | `SqlQueryResult` を判別可能ユニオン化し、`SqlConsolePage` が失敗を分岐して表示・履歴に積まない |
| 2 | 経路検索がプレースホルダの例で 0 件 | `src/lib/net/prefix.ts` を追加して数値比較で包含判定。Include subnets / Search ボタン / AS番号検索を実装 |
| 3 | 経路分析でプレフィックス長が欠落 | 集計キーと表示を `prefix/length` に統一。4 箇所の重複していた集計処理を `record()` に集約 |
| 4 | ディープリンクとリロードが Messages に飛ぶ | `RequireCapture` が復元完了まで待ち、遷移先を `location.state` で引き継ぐ。`?selected=` も保持 |
| 5 | オートコンプリートの Enter がクエリを壊す | 候補は明示的に選択されたときだけ Enter で確定。補完にならない候補は語を置換せず挿入 |
| 6 | 入力途中でエラー表示 | `useFilter` が 600ms 入力が止まってからエラーを出す |
| 7 | 狭い画面でレイアウト破綻 | 各画面のペインを `lg` 未満で縦積みに。ヘッダのナビは横スクロール |
| 8 | 使われていないコード | `WarningBanner` をヘッダ直下に接続（パーサ警告が初めて UI に出る）。`MainContent.tsx` と `Header.tsx` を削除し、`DisplayPacket` を `PacketList` へ移動 |

### プレフィックス照合の統一

上記 2・3 の修正で経路分析画面だけが数値比較になり、フィルタ式と食い違っていた件を解消。
`prefix_bits` / `src_ip_bits` / `dst_ip_bits`（`lib/net/prefix.ts` のビット列キー）を
DuckDB のスキーマに追加し、包含判定を `LIKE 'bits%'` で表現。
インメモリ側も同じ `lib/net/prefix.ts` を使うようにして、3 実装を 1 つに統合した。

- `prefix = 10.0.0.0/8` は「その中にある経路」を選ぶ（従来は文字列完全一致で無意味だった）
- `prefix = 10.0.12.7` は「そのアドレスを含む経路」を選ぶ
- `src_ip = 192.168.0.0/23` がビット単位で正しくなった
  （従来はオクテット単位に切り捨てていたため /12 が /8 相当にマッチしていた）
- IPv6 も同じ経路で動く

### 経路分析の仕様未達項目

`docs/ui-design.md` 4.5 節との差分を解消。

- **Last Seen** カラムを追加（計算済みで未表示だった `PrefixStats.lastSeen`）
- 全カラムのヘッダークリックでソート。Prefix は数値順なので
  10.0.9.0/24 が 10.0.12.0/24 より前に来る（文字列順だと逆になる）
- **AS_PATH Analysis** パネルを追加。選択した Prefix が観測された AS_PATH を
  出現回数の多い順に並べ、複数ある場合は 2 件目以降を alternate として示す
  （マルチホームか経路リークかの判断材料になる）

### 狭い画面のマスター/ディテール

`lg` 未満では一覧と詳細を上下に積んでいたが、480px では両方とも高さ半分で読めなかった。
`useIsCompact()`（`src/hooks/useMediaQuery.ts`）で判定し、
スマホアプリのように「一覧 → 選択で詳細に切り替え、Back で一覧」に変更。
Messages / Neighbors / Routes の 3 画面に適用。
ブレークポイントをまたいでリサイズしても、選択状態に応じた画面が出る。

### バンドルサイズ

561kB（gzip 152kB）の単一チャンクで Vite の警告が出ていた。

| チャンク | サイズ | 読み込みタイミング |
|---|---|---|
| `index` | 81kB (gzip 25kB) | 初回 |
| `react` | 179kB (gzip 59kB) | 初回、デプロイしてもキャッシュが効く |
| `duckdb-browser` | 200kB (gzip 47kB) | DuckDB 初期化時（動的 import） |
| 各ページ | 8〜46kB | 画面遷移時（`React.lazy`） |

初回に必要な JS は 561kB → 260kB（gzip 152kB → 84kB）。警告も解消。

### ペインのドラッグリサイズ

`useResizablePanes` は削除済みの 3 ペイン構成（旧 `MainContent`）専用の API だったので削除し、
現在の 2 ペイン構成に合う `useSplitPane` + `PaneDivider` として実装し直した。

- ドラッグで幅を変更、ダブルクリックで既定値に戻す
- 矢印キーでも動く（`role="separator"` + `tabIndex`）
- 幅は localStorage に画面ごとに保存（Messages と Routes は別々）
- 1 ペインしか出ない compact 表示では非表示

### Prefix 検索に照合方向を持たせた

`10.30.0.0/24` で検索すると「0 prefixes」になり、それを収容している
`10.30.0.0/16` が出てこなかった。Include subnets のチェックが下向き
（入力ブロックの内側）だけを見ていたため、入力より粗い経路には決して当たらない。

包含には向きがあり、下向きと上向きは別の問いなので、チェックボックスをやめて
Exact / Subnets / Supernets の 3 択（ラジオ）にした。

- Subnets が既定。`10.30.0.0/11` が配下の /16 を拾う従来の動作はそのまま
- Supernets で `10.30.0.0/24` → `10.30.0.0/16` が引ける
- マスクなしの IP も /32 として同じ方向設定に従うので、`10.0.13.1` と
  `10.0.13.1/32` の結果が食い違わない（従来はマスクの有無で暗黙に向きが変わっていた）
- 選択は `?match=` として URL に載る

### 経路分析の状態を URL に載せた

Neighbors の `?router=` に倣い、Routes も検索語・選択 Prefix・ソート列・
ソート方向・Include subnets を URL に持つようにした。
リンクを共有してもリロードしても、見ていたものがそのまま復元される。

---

## 対応済み(2026-08-05)

2026-08-04 の BGP エンジニア観点レビュー(下記)で洗い出した 11 項目を修正した。

| # | Issue | 内容 | 主な変更 |
|---|-------|------|----------|
| 1 | #12 | DuckDB ロード失敗で全フィルタ/SQL が静かに 0 件 | `isDataLoaded()` を新設し、非同期フィルタと SQL コンソールのゲートに。失敗は WarningBanner に表示、インメモリ評価へ確実にフォールバック |
| 2 | #13 | wasm 取得ハングでアプリ全体が使用不能 | `initDatabase()` に 15 秒のデッドライン。タイムアウト後に遅れて完了した接続は採用しない(worker terminate) |
| 3 | #14 | IPv6 トランスポート非対応 | 両パーサで EtherType 0x86DD を解析(拡張ヘッダの歩行、RFC 5952 表記、VLAN/QinQ/SLL 対応)。`lib/pcap/ipv6.ts` |
| 4 | #15 | BGP 0 件でも「healthy」表示 | BGP が 0 件のときは TCP 層を診断(SYN→RST=拒否、SYN 無応答=フィルタ、等)。Messages は All Packets への誘導を表示 |
| 5 | #16 | 非標準ポートを読めない | BGP マーカー(0xff×16+妥当な length/type)によるフロー単位の自動検出。`lib/pcap/bgp-detect.ts`、フローごとに警告 |
| 6 | #17 | タイムスタンプが画面ごとに不統一 | `lib/format-time.ts` の ms 付き UTC 表記に全画面統一。一覧の絶対時刻・ポートは既存のオプション列(列設定)で表示可能 |
| 7 | #18 | Flap がイベント総数 | (経路, 広告元)ごとの状態機械で up→down 遷移のみカウント。`lib/bgp/prefix-stats.ts` に分離してユニットテスト |
| 8 | #19 | 破損ブロック以降を全部破棄 | pcapng はブロック境界で resync し壊れたブロックだけスキップ(50 中 48 救済)。pcap は打ち切り位置と損失量を警告に明記 |
| 9 | #20 | 60k パケットで Routes が 35 秒フリーズ | 集計を capture 単位の memo に分離+`useVirtualRows` で行を仮想化。35.3 秒 → 0.6 秒 |
| 10 | #21 | End-of-RIB 無表示 | `endOfRibMarker()`(RFC 4724)で検出し詳細ビューにバッジ表示。一覧の Info も `WR=n PA=n` から announced/withdrawn 件数表記に |
| 11 | #22 | ポート/フレームで絞れない | フィルタに `src_port` / `dst_port` / `frame` と数値限定の `< <= > >=` を追加。インメモリ/SQL 両評価器で同一意味、両方をテスト |

#23(小粒まとめ)のうち: ROUTE_REFRESH 表記・Message Summary の意味注記・10MB→50MB・
タイプ別件数バッジ(クリックでフィルタ)を実装。SQL 結果の CSV エクスポートは既存実装が
あった(レビュー時の見落とし)。テーマ切替も適切な `aria-label` 付きボタンで修正不要だった。

### フィルタ結果の pcap 切り出し(#23 の残り)

Messages 画面のステータスバーから、いま一覧に出ているパケットをそのまま pcap に
書き出せるようにした。BGP Only / All Packets のどちらでも、フィルタ結果でも動く。

- `lib/pcap/writer.ts` — 純粋関数の pcap ライタ。出力は常にクラシック pcap
  (リトルエンディアン)。元が pcapng でも、どのツールでも読める形式に寄せる
- リンクタイプは元キャプチャから引き継ぐ(Ethernet/SLL を取り違えるとデコードが壊れる)
- フレーム実バイトは `GenericPacket.frameBytes` として保持。`BinaryReader.readBytes()` が
  コピーではなくビューを返すので、保持コストはビューオブジェクトだけ
- タイムスタンプはミリ秒精度。パース時点で `Date` に落ちているため、
  ナノ秒 pcapng のサブミリ秒は失われる(順序と間隔は保たれる)
- テストは書き出し → `parsePcap` で読み戻すラウンドトリップで検証

実機確認: サンプルを `type = NOTIFICATION` で 9 件に絞ってエクスポート → 生成された
`sample-filtered.pcap` を再読込して同じ 9 件が復元。`file(1)` も
`pcap capture file, microsecond ts (little-endian) - version 2.4 (Ethernet, ...)` と認識。

## pcap ビルダー (2026-08-05)

キャプチャを「読む」だけだったアプリに、「書く」側を追加した。BGP セッションを
記述すると、その通りの pcap が出てくる。Build 画面はキャプチャ未ロードでも開ける
（ファイルを探しに来た人がいる状態がまさにそれなので）。

### 構成

| ファイル | 役割 |
|---|---|
| `lib/build/bytes.ts` | ビッグエンディアン専用のバイトライタ、アドレス/プレフィックス符号化、インターネットチェックサム |
| `lib/build/bgp-encode.ts` | OPEN / UPDATE / NOTIFICATION / KEEPALIVE / ROUTE_REFRESH のエンコーダ。`lib/bgp/*` の鏡 |
| `lib/build/frame.ts` | TCP / IPv4 / IPv6 / Ethernet / Linux SLL の組み立て。VLAN・QinQ 対応 |
| `lib/build/scenario.ts` | 記述されたセッション → フレーム列。TCP の seq/ack を一貫して進める |
| `lib/build/presets.ts` | 実運用で当たる 8 シナリオ |
| `pages/BuilderPage.tsx` | 画面。プレビューは組み立てたファイルを実パーサで読み戻したもの |

### シナリオから導出するもの（入力させないもの）

どちらも「選択」ではなく「帰結」なので、フォームに出さず計算している。

- **UPDATE の符号化方式** — AS 番号幅（RFC 6793）と ADD-PATH の Path Identifier
  （RFC 7911）は OPEN で交換される。両ピアの capability から `BgpSessionTracker`
  と同じ規則で導出する。OPEN と UPDATE が食い違うキャプチャは、どのセッションにも
  作れない
- **TCP セグメント境界** — 1 ステップで送るメッセージはバイト列に詰めて MSS で切る。
  MTU を下げることが「メッセージがセグメントをまたぐキャプチャ」の作り方になる

### 検証

- **往復テスト** (`tests/lib/build/round-trip.test.ts`, 30 件) — 組み立てた pcap を
  `parsePcap` + `parseBgpFromPackets` で読み戻し、記述した通りのセッションに
  なっているかを見る。バイト列を手書きの期待値と比べるとエンコーダを二度書くだけに
  なるので、そうはしていない。エンコーダとデコーダが静かに乖離することも防げる
- **チェックサム検証** (`tests/lib/build/checksums.test.ts`, 27 件) — 1 の補数和は
  「チェックサムを含めて足すと 0」になる性質があるので、受信側スタックがやる検算を
  そのまま回す。このアプリのパーサは IP/TCP チェックサムを見ないため、ここを
  省くと「BGPShark でだけ読めるファイル」になっていても気づけない
- **e2e** (`tests/e2e/builder.e2e.ts`, 8 件) — キャプチャ未ロードでルートが
  ガードに飲まれないこと、組み立てたファイルが analyzer にロードできること

実機確認: 生成した 8 プリセットを `file(1)` が
`pcap capture file, microsecond ts (little-endian) - version 2.4 (Ethernet, ...)`
と認識。flap プリセットを Open in analyzer → Routes で `10.9.9.0/24` が出る。

## 未対応

（なし）

### 2026-08-04 BGP エンジニア観点の実機レビュー(原文)

BGP セッション障害の切り分けを実際に行う想定で、Playwright + Chromium 141 上で
サンプルキャプチャ・自作キャプチャ（IPv6 トランスポート / 非標準ポート / SYN-RST のみ /
破損 pcapng / 60,000 パケット）を読み込ませて操作した。番号は概ね深刻度順。

#### 1. DuckDB へのデータロード失敗時、全フィルタと SQL が「0 件」になる（重大）

この環境では `loadPackets()` が DuckDB WASM の `memory access out of bounds` で失敗した。
その場合の挙動:

- `useBgpAnalyzer.ts:75-82` — 失敗を catch して「Continue without DuckDB」とするが、
  `dbReady` は `isInitialized()`（= true のまま）で設定される
- `useFilter.ts:57` — `isInitialized()` が true なので非同期パスが走り、
  **空のテーブル**への問い合わせが「成功」して 0 件を返す
- `useFilter.ts:96` — その 0 件が正しいインメモリ結果（`syncFilteredPackets`）を上書きする

結果、`type = UPDATE` も `src_ip = 1.1.1.1` も **一瞬正しく表示された後 200ms で 0 件になる**。
SQL コンソールも同様にエラーなしで「Query returned no results」。ユーザーには「この
キャプチャに該当パケットがない」ようにしか見えず、誤診に直結する。README の
「DuckDB が使えなければインメモリで動く」は初期化失敗時にしか成立していない。

対策案: ロード失敗時にモジュールレベルのフラグを立てて `isInitialized()`（または新設の
`isLoaded()`）を false に落とし、インメモリ評価へフォールバックした上で
WarningBanner に「SQL コンソールは利用できません」と出す。

#### 2. DuckDB WASM の取得が失敗/ハングすると、アップロード画面ごと永久に無効化（重大)

`.wasm` の fetch を遮断して検証: `database.ts:50` の `db.instantiate()` は worker 内の
fetch 失敗で **reject されずハング**し、`initDatabase()` が永遠に解決しないため
アプリが `initializing` から抜けず、「Try with sample.pcapng」ボタンとドロップゾーンが
無効のまま になる。プロキシや CSP で wasm がブロックされる環境では、パーサ自体は
無関係なのにアプリ全体が使えない。`initDatabase()` にタイムアウトを設け、超過時は
DuckDB なしで `idle` に進むべき。

#### 3. IPv6 トランスポートの BGP セッションを解析できない

`pcap/parser.ts:309`（pcapng 側も同様）が EtherType 0x0800 以外を捨てるため、
IPv6 TCP 上の BGP セッション（v6 ピアリングでは普通）のキャプチャは
**「No IP packets found in the pcap file.」** になる。IPv6 パケットは IP パケットなので
エラー文自体が誤り。MP_REACH の IPv6 NLRI を解析できるだけに、v6 トランスポート
非対応は実運用で最初に踏む壁になる。最低限、v6 パケットを検出して
「IPv6 トランスポートは未対応」と明示するべき（本対応が理想）。

#### 4. 「セッションが張れない」キャプチャで『healthy』と表示される

SYN → RST の応酬だけのキャプチャ（MD5 不一致・フィルタ・TCP レベル障害の典型）を
読み込むと、Messages は既定の BGP Only で「Showing 0 of 0 packets」の空画面、
Dashboard は **「No issues detected — every session looks healthy.」**。
トラブルシュートツールとして最悪の誤誘導になる。

- BGP メッセージが 0 件のときに healthy 表示を出さない
- 「All Packets には port 179 宛の TCP が N 件ある（SYN が RST で拒否されている）」の
  ような誘導を出す — データは既に `allPackets`（TCP フラグ付き）にある

#### 5. 非標準ポートの BGP を読む手段がない

`BGP_PORT = 179` 固定（`pcap/parser.ts:15`）。検証用に 1790 番で張ったセッションは
「Showing 0 of 0 packets」で終わり、説明もない。Wireshark の "Decode As" に相当する
「このポートも BGP として解釈」の指定（またはポート無視で BGP マーカー検出）が欲しい。

#### 6. タイムスタンプの表示が画面ごとにばらばらで、秒未満が読めない画面がある

| 画面 | 表示 |
|---|---|
| パケット一覧 | 相対秒 `14.726` のみ（絶対時刻なし） |
| パケット詳細 | ISO UTC `2025-12-27T10:36:42.019Z` |
| Dashboard アラート / Neighbor 詳細 | `10:36:42`（秒単位・TZ 表記なし） |
| Routes | `10:36:52.50`（10ms 単位） |

サンプルの障害イベント 21 件はすべて同一秒内に収まっており、アラート一覧と
Neighbor の Session Messages では **前後関係が判別できない**。コリジョン解析のように
ミリ秒が本質的な場面で致命的。ミリ秒＋TZ を含む統一フォーマットと、一覧の
相対/絶対切り替えが必要。あわせてアラート・Session Messages にフレーム番号を
表示してクリックでジャンプできると裏取りが速い。

#### 7. Routes の「Flap」はフラップ数ではなくイベント総数

`RoutesPage.tsx` の `record()` が announce でも withdraw でも `stat.flap++` する。
セッションリセット後の再広告や複数ピアからの並行広告だけでも数字が積み上がり、
既定ソートが Flap 降順なので「一度も withdraw されていない経路」が上位に並ぶ。
実際、サンプルでは withdraw 0 回の `2.2.2.2/32` が Flap=6。運用者の期待する
「withdraw→announce の往復回数」（または RFC 2439 的なペナルティ）に改めるべき。

#### 8. 破損キャプチャで残り 98% が静かに捨てられる

EPB の captured length を壊した pcapng では「1 warning during parsing」バナーと
ともに **50 パケット中 1 パケットだけ**表示された（パーサは最初の不整合で break）。
バナーだけでは「ファイルの大半が読めていない」ことが伝わらない。壊れたブロックを
スキップして継続する（Wireshark と同じ挙動）か、少なくとも
「N パケット中 M パケットで解析を中断」と明示すべき。

#### 9. 60k パケットで Routes ページが 35 秒フリーズ

6.7MB / 60,000 UPDATE のキャプチャで、読み込み（2.8s）と一覧・詳細操作は快適
だが、Routes ページ遷移で **35 秒 UI ブロック**（スピナーなし)、Dashboard も 4.9 秒。
プレフィックス集計を Worker 化するか集計を DuckDB に寄せ、進行表示を出したい。
一覧テーブル自体も 60,000 行を仮想化なしで描画している。

#### 10. End-of-RIB が無表示

announce 0 / withdraw 0 の UPDATE（EoR）が「UPDATE (4/4) Announced - 0 / Withdrawn - 0」
とだけ表示される。グレースフルリスタート解析の目印なので「End-of-RIB」と
ラベル付けすべき（`grep End-of-RIB src/` は 0 件）。

#### 11. 細かい点

- **Neighbor 詳細の Message Summary が一覧の Msgs と食い違う**: 一覧はそのルータの
  送信メッセージ数（35）、詳細はセッション両方向の合計（68）。どちらの数字かの
  ラベルがなく混乱する。`ROUTEREFRESH` の表記も `ROUTE_REFRESH` に。
- **フィルタのフィールドにポート・時刻・フレーム番号がない**: 同一 IP ペア間の
  コリジョン解析（このサンプルがまさにそれ）で 2 本の TCP セッションを
  分離できない。`src_port` / `dst_port` / フレーム範囲が欲しい。
- **エクスポートがない**: SQL 結果の CSV、フィルタ結果の pcap 切り出しがあると
  エスカレーションに使える。
- **10MB 上限**: ルータでの数分のフルルート受信で容易に超える。パースは 60k
  パケット 2.8s と速いので、上限引き上げ（または警告つき受け入れ）の余地がある。
- **一覧が仮想描画のため Ctrl+F で探せない**: これ自体は仕様だが、UPDATE 27 件が
  すべて画面外にある初期表示では「UPDATE が存在しない」ように見える。タイプ別
  件数バッジ（クリックでフィルタ）が一覧上部にあると迷わない。

#### 良かった点（維持したい挙動）

- TCP セグメントをまたぐ再組み立てと 1 パケット複数メッセージの展開が正確
- NOTIFICATION のエラーコード解説とヒント、Cease/Hard Reset (RFC 8538) まで対応
- Route History → `?selected=` でパケットへ直接ジャンプでき、リロードでも復元される
- フィルタ式のオートコンプリートとエラーの遅延表示（入力中に赤くならない）
- 60k パケットでも読み込み 2.8 秒、一覧操作は軽快（仮想化が効いている）
- All Packets 表示の TCP フラグ表記（[S]/[AR]）は TCP レベルの切り分けに十分
