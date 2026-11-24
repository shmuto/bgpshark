# BGPShark — アーキテクチャ

[English](architecture.md) | 日本語

> BGPShark の全体の組み立てを図でまとめた文書です。どこで何が動くか、読み込んだキャプチャがどう画面に届くか、どのモジュールが何を決めるかを示します。
> 要件、アラートルール、性能の数値は [`design.md`](design.md) にあります。この文書では繰り返さず、リンクで参照します。
> 図は [Mermaid](https://mermaid.js.org/) で書いており、GitHub 上でそのまま表示されます。ここに描いた処理の流れを変えたときは、英語版と日本語版の両方の図を更新してください。

## 目次

1. [どの文書を読めばよいか](#1-どの文書を読めばよいか)
2. [システムの全体像](#2-システムの全体像)
3. [モジュールの階層](#3-モジュールの階層)
4. [キャプチャの読み込み](#4-キャプチャの読み込み)
5. [デコード: フレームから BGP メッセージまで](#5-デコード-フレームから-bgp-メッセージまで)
6. [読み込みとデータベースの状態](#6-読み込みとデータベースの状態)
7. [ワークスペース: セッション・時間範囲・フィルタ](#7-ワークスペース-セッション時間範囲フィルタ)
8. [2 つの実行方式によるフィルタ](#8-2-つの実行方式によるフィルタ)
9. [DuckDB のテーブル](#9-duckdb-のテーブル)
10. [Findings の算出](#10-findings-の算出)
11. [画面とルーティング](#11-画面とルーティング)
12. [Capture Builder](#12-capture-builder)
13. [ビルド・テスト・デプロイ](#13-ビルドテストデプロイ)
14. [守るべき不変条件の一覧](#14-守るべき不変条件の一覧)

---

## 1. どの文書を読めばよいか

| 知りたいこと | 文書 |
|--------------|------|
| 全体の構成と、各モジュールの役割 | **この文書** |
| 機能やアラートルールの正確な仕様、性能目標 | [`design.md`](design.md) |
| DuckDB WASM を採用した理由、フレーム番号だけを返す理由 | [`design-duckdb-wasm.md`](design-duckdb-wasm.md) |
| 現時点でどの BGP 障害を診断できるか | [`troubleshooting-scenarios.md`](troubleshooting-scenarios.md) |
| アプリの使い方 | アプリ内マニュアル（[`src/pages/manual/manual.ja.md`](../src/pages/manual/manual.ja.md)） |
| キャプチャやスクリーンショットの生成方法 | [`testlab/README.md`](../testlab/README.md) |
| 開発者と AI エージェント向けのルール | [`CLAUDE.md`](../CLAUDE.md) |

---

## 2. システムの全体像

BGPShark は静的なシングルページアプリです。サーバーはファイルを配るだけです。キャプチャの読み取り、デコード、検索はすべて利用者のブラウザのタブ内で行います。

```mermaid
flowchart LR
    user(["ネットワーク技術者"])
    pages["GitHub Pages<br/>/bgpshark/<br/>静的ファイルのみ"]

    subgraph browser["ブラウザのタブ（本番 CSP: connect-src 'self'）"]
        direction TB
        app["BGPShark SPA<br/>React + TypeScript"]
        worker["DuckDB WASM<br/>Web Worker"]
        idb[("IndexedDB<br/>直近のキャプチャ")]
        ls[("localStorage<br/>テーマ・言語・<br/>ペイン幅・列設定")]
        app <-- "Arrow IPC で投入、<br/>フレーム番号を受け取る" --> worker
        app <--> idb
        app <--> ls
    end

    third["他のオリジン<br/>（CDN、DuckDB 拡張の配布元、解析サービス）"]

    user -- ".pcap / .pcapng をドロップ" --> app
    pages -- "HTML・JS・WASM・フォント・<br/>マニュアル画像" --> app
    app -. "CSP で遮断" .-x third
```

- **何もアップロードしません。** キャプチャはディスクからタブのメモリへ読み込みます。再読み込みで復元できるよう、IndexedDB にも保存します。
- **すべて自前で配信します。** DuckDB の `.wasm` とワーカー、フォント、マニュアル画像は `dist/assets/` に含めます。外部へのリクエストが 1 件でもあると `tests/e2e/offline.e2e.ts` が失敗します。
- **DuckDB はなくても動きます。** ワーカーが起動しなくても、SQL Console 以外の画面はすべて使えます（[§6](#6-読み込みとデータベースの状態) を参照）。

---

## 3. モジュールの階層

矢印は「使う側 → 使われる側」を表します。純粋な処理は `src/lib/` にあり、React に依存しません。そのため `bun test` で直接テストできます。

```mermaid
flowchart TB
    subgraph ui["UI — src/pages, src/components"]
        direction LR
        pagesNode["pages/<br/>Messages · Sessions · Routes<br/>SQL · Builder · Manual · Upload"]
        comps["components/<br/>workspace · message · neighbor<br/>common · builder · layout"]
    end

    subgraph state["状態管理 — src/context, src/hooks"]
        direction LR
        appctx["AppContext<br/>(useBgpAnalyzer)"]
        wsctx["WorkspaceContext<br/>scope · range · findings"]
        usefilter["useFilter"]
        i18n["i18n<br/>en · ja"]
    end

    subgraph domain["ドメインロジック — 純粋な TypeScript"]
        direction LR
        pcap["lib/pcap<br/>pcap · pcapng · writer"]
        bgp["lib/bgp<br/>メッセージのデコード · セッション<br/>プレフィックス統計 · ヒント"]
        filter["lib/filter<br/>字句解析 · 構文解析 · 評価"]
        rules["components/dashboard<br/>アラートルール · findings"]
        build["lib/build<br/>エンコーダー · フレーム生成 · プリセット"]
        net["lib/net<br/>プレフィックス · CIDR"]
    end

    subgraph infra["基盤"]
        direction LR
        db["lib/db<br/>DuckDB の起動 · スキーマ<br/>Arrow ローダー · フィルタの SQL 変換"]
        storage["lib/storage<br/>IndexedDB"]
        sliced["lib/sliced<br/>時間分割で実行する generator"]
    end

    ui --> state
    ui --> domain
    appctx --> pcap & bgp & db & storage
    wsctx --> rules & bgp
    usefilter --> filter & db
    rules --> bgp & sliced
    bgp --> pcap & net
    filter --> net
    db --> filter & net
    build --> pcap & bgp & net
    pcap --> sliced
```

| 階層 | 担当すること | してはいけないこと |
|------|--------------|--------------------|
| UI | レイアウト、操作、URL のクエリによる画面状態（`?filter=`、`?frame=` など） | バイト列の解析や findings の計算を自分で行うこと |
| 状態管理 | 読み込んだキャプチャ、読み込みの進み具合、ワークスペースの選択セッションと時間範囲 | 導出に必要な範囲を超えて、デコード結果を複製して持つこと |
| ドメインロジック | デコード、フィルタの意味、アラートルール、キャプチャの生成 | React を読み込むこと |
| 基盤 | DuckDB、IndexedDB、時間分割の実行 | データの意味を決めること（DuckDB はフレーム番号を選ぶだけ） |

アラートルールが `src/components/dashboard/` にあるのは、以前ダッシュボード画面がルールを持っていた名残です。画面はなくなり、findings は各ビューの横に表示されるようになりました。ルール自体は今も `BgpPacket[]` を受け取るだけの関数です。

---

## 4. キャプチャの読み込み

パケット一覧をできるだけ早く表示できる順序にしています。読み取り、解析、デコードは一覧の表示前に行います。IndexedDB への保存と DuckDB への投入は、表示後に裏で行います。

```mermaid
sequenceDiagram
    autonumber
    actor U as 利用者
    participant A as useBgpAnalyzer<br/>(AppContext)
    participant P as lib/pcap
    participant B as lib/bgp
    participant UI as ワークスペース画面
    participant S as IndexedDB
    participant L as lib/db ローダー
    participant D as DuckDB ワーカー

    U->>A: ファイルをドロップ (loadFile)
    A->>A: file.arrayBuffer()
    A->>P: parsePcapWork / parsePcapngWork<br/>runInSlices で約 12 ms ずつ実行
    P-->>A: RawPacket[]（BGP のフロー）<br/>+ GenericPacket[]（全 IP/TCP フレーム）
    A->>B: parseBgpFromPacketsAsync（分割実行）
    B-->>A: BgpPacket[] + 警告
    A->>UI: status = ready → パケット一覧を表示
    Note over UI: Findings は 20,000 パケット以下なら即時に計算、<br/>それを超えると裏で分割して計算

    par 完了を待たない
        A-)S: savePcapFile(Blob)
    and 裏で投入
        A-)L: loadPackets(packets)
        loop ROWS_PER_FLUSH 行ごと
            L->>L: Arrow の列バッファへ平坦化
            L->>D: insertArrowFromIPCStream → INSERT … SELECT
        end
        L--)A: 完了 → dbStatus = loaded
        A->>UI: フィルタと SQL Console が DuckDB を使い始める
    end
```

**再読み込み時**は、IndexedDB から読み戻したバッファ（`loadPcapFile`）で手順 2 から同じ処理を行います。結果が出るまで status は `initializing` です。この間 `RequireCapture` は別画面へ移動させずに待つので、ブックマークや直接リンクも再読み込み後にそのまま開けます。

**後から始まった読み込みが優先されます。** 読み込みのたびに新しい世代番号を割り当てます。古い読み込みは、新しい読み込みが始まったことに気づくと処理をやめます。DuckDB への投入も、自分の世代が表示中のときだけ進み具合を反映します。

主なファイル: `src/hooks/useBgpAnalyzer.ts`、`src/lib/sliced.ts`、`src/lib/db/loader.ts`、`src/lib/db/arrow-columns.ts`、`src/lib/storage.ts`。大きなキャプチャでの実測値は [`design.md` §3.1](design.md#31-performance) にあります。

---

## 5. デコード: フレームから BGP メッセージまで

解析器は 2 種類ありますが、出力の形は同じです。**All Packets** 表示のため、TCP フレームはすべて残します。BGP のフローに属するフレームだけが BGP のデコードへ進みます。

```mermaid
flowchart TB
    file[".pcap / .pcapng のバイト列"] --> magic{"マジックナンバー"}
    magic -- "pcap" --> pcapP["pcap/parser.ts"]
    magic -- "pcapng" --> ngP["pcap/pcapng-parser.ts"]
    pcapP & ngP --> link["リンク層<br/>Ethernet II (1) · Linux SLL (113)<br/>802.1Q / QinQ タグを除去"]
    link --> ip["IPv4 · IPv6 (ipv6.ts)"]
    ip --> tcp["TCP ヘッダー"]
    tcp --> generic[["GenericPacket[]<br/>全フレーム — All Packets 表示、<br/>TCP 層のアラート、pcap 書き出し"]]
    tcp --> detect{"BGP のフローか<br/>ポート 179、または<br/>16 バイトのマーカー (bgp-detect.ts)"}
    detect -- "はい" --> raw[["RawPacket[]<br/>TCP ペイロード + アドレス"]]

    raw --> reasm["方向ごとのフローバッファ<br/>前回の残りを先頭に連結<br/>4096 バイト超で破棄し警告"]
    reasm --> hdr["BGP ヘッダー<br/>マーカー · 長さ · 種別"]
    hdr --> body{"種別"}
    body --> open["OPEN<br/>open.ts"]
    body --> upd["UPDATE<br/>update.ts · evpn.ts"]
    body --> notif["NOTIFICATION<br/>notification.ts"]
    body --> ka["KEEPALIVE"]
    body --> rr["ROUTE-REFRESH"]

    open -- "observeOpen" --> tracker["BgpSessionTracker<br/>方向ごとに 4 バイト AS と<br/>ADD-PATH の有無を記録"]
    tracker -- "decodingFor(from, to)" --> upd
    shared["SharedDecodedValues<br/>繰り返し現れる属性ブロックや<br/>プレフィックスを 1 つだけ保持"] -.-> upd

    open & upd & notif & ka & rr --> out[["BgpPacket[]<br/>frameIndex · timestamp · messages[]"]]
```

- **メッセージはそれを完成させたフレームに属します。** 複数のセグメントにまたがるメッセージは、最後のバイトを含むフレームに割り当てます。これにより `frameIndex` は単調に増え、実際のフレームと 1 対 1 に対応します。
- **セッション途中から始まるキャプチャにも対応します。** OPEN が記録されていない場合、`UpdateDecoding` は `null` になります。このとき `update.ts` は NLRI の構造から 4 バイト AS と ADD-PATH の有無を推定します（[`design.md` §2.1.7](design.md#217-update-message-analysis-srclibbgpupdatets)）。
- **共有された値は書き換えてはいけません。** 同じデコード結果を多くのメッセージが参照しています。デコード済みのメッセージは変更しないでください（`src/lib/bgp/shared-decode.ts`）。

---

## 6. 読み込みとデータベースの状態

`useBgpAnalyzer` には独立した 2 つの状態があります。`status` は分析画面を開けるかどうかを決めます。`dbStatus` はフィルタと SQL Console が DuckDB を使うかどうかを決めます。

```mermaid
stateDiagram-v2
    direction LR
    [*] --> initializing: ページ読み込み
    initializing --> loading: IndexedDB に保存あり
    initializing --> idle: 保存なし
    idle --> loading: ファイルをドロップ
    loading --> ready: 解析とデコード完了
    loading --> error: 不正なファイル / IP パケットなし
    ready --> loading: 別のファイルをドロップ
    error --> loading: 別のファイルをドロップ
    ready --> idle: New File（リセット）
```

```mermaid
stateDiagram-v2
    direction LR
    [*] --> db_idle
    db_idle --> db_loading: BGP の行があるキャプチャを表示
    db_loading --> loaded: 投入完了
    db_loading --> failed: 投入中に例外
    db_loading --> unavailable: DuckDB が起動しなかった
    db_idle --> unavailable: 表示時点で DuckDB の起動に失敗済み

    loaded: loaded — SQL でフィルタ、SQL Console 利用可
    failed: failed — メモリ上でフィルタ、警告を表示
    unavailable: unavailable — メモリ上でフィルタ、SQL Console に理由を表示
    db_idle: idle
    db_loading: loading
```

`dbStatus` は React の state として持ちます。描画のたびに `isDataLoaded()` を読むのではありません。そのため、裏での投入が終わった時点でフィルタと SQL Console が再描画されます。

---

## 7. ワークスペース: セッション・時間範囲・フィルタ

キャプチャを開くと、Messages、Sessions、Routes、SQL は 1 つのワークスペースのタブになります（`src/components/workspace/WorkspaceLayout.tsx`）。`WorkspaceContext` が決まった順序でパケットを絞り込み、各タブはその結果を読みます。

```mermaid
flowchart LR
    all[["packets<br/>(AppContext)"]] --> scope{"セッションを選択？<br/>scope = peeringKey"}
    scope -- "はい" --> sp["sessionPackets"]
    scope -- "いいえ" --> sp
    sp --> strip["TimeStrip<br/>キャプチャ全体の<br/>流量を描画"]
    sp --> range{"時間範囲を<br/>ドラッグ？"}
    range --> scoped[["scopedPackets"]]
    scoped --> routes["Routes タブ<br/>prefixStatsFor"]
    scoped --> filt["useFilter<br/>（クエリ入力欄）"]
    filt --> list["Messages タブ<br/>一覧 → 詳細 · 16 進表示 · 書き出し"]

    all --> alerts["alertsFor<br/>（キャプチャ全体、キャッシュあり）"]
    alerts --> sa["scopedAlertsFor<br/>（セッション自身の分 +<br/>経路系を再計算）"]
    sa --> groups["groupFindings<br/>→ Findings 一覧"]
    alerts --> sessions["セッション一覧<br/>セッションごとの最悪の重大度"]
```

| 絞り込み | 対象 | 対象**外** |
|----------|------|------------|
| セッションの選択（scope） | Messages、Routes、Findings、Sessions の詳細 | SQL Console |
| 時間範囲 | Messages、Routes | Findings、OPEN の比較、SQL Console |
| フィルタ式 | Messages | それ以外すべて |

選択セッションと時間範囲はワークスペースのレイアウトが保持します。そのためタブを切り替えても残り、キャプチャを閉じると一緒に消えます。Finding を開いても選択セッションは変わりません。Finding のリンク自体にフィルタが含まれているためです。

---

## 8. 2 つの実行方式によるフィルタ

フィルタ式は**一度だけ**構文木に変換し、状況に合う方式で実行します。どちらの方式でも同じ結果になることが、この設計の中心となる約束です（[`CLAUDE.md`](../CLAUDE.md) を参照）。

```mermaid
flowchart TB
    q["クエリ文字列<br/>例: type = UPDATE and asn = 65001"] --> parse["lib/filter/parser.ts<br/>字句解析 → 構文解析 → 構文木<br/>ip / peer / 値だけの入力を書き換え"]
    parse --> err{"構文エラー？"}
    err -- "あり" --> red["一覧は絞り込まない<br/>入力が 600 ms 止まると赤い行で表示"]
    err -- "なし" --> mem{"DuckDB 投入済み かつ<br/>20,000 パケット超？"}

    mem -- "いいえ" --> sync["メモリ上で評価<br/>matchPacket（キー入力ごと）"]
    sync --> shown[["すぐに表示"]]
    mem -- "はい" --> keep["前回の結果を残し<br/>Filtering… を表示"]

    err -- "なし" --> sqlq{"DuckDB 投入済み？"}
    sqlq -- "はい" --> deb["200 ms 待つ"] --> tosql["lib/db/filter-to-sql.ts<br/>構文木 → WHERE 句"]
    tosql --> duck["SELECT frame_index FROM packets<br/>WHERE … ORDER BY frame_index"]
    duck --> resolve["フレーム番号を<br/>解析済みの BgpPacket[] に対応づけ"]
    resolve --> shown2[["メモリ上の結果を置き換え"]]
    duck -- "クエリ失敗" --> fallback["matchPacket に切り替え"]
```

- **DuckDB は選ぶだけで、パケットを組み立て直しません。** 境界を越えるのは `frame_index` だけです。そのため、入れ子の項目が画面に届く途中で欠けることはありません（[`design-duckdb-wasm.md`](design-duckdb-wasm.md)）。
- **CIDR の照合**は、SQL 側ではビット列の列（`prefix_bits`、`src_ip_bits`）と `LIKE 'bits%'` で行います。メモリ側では `lib/net/prefix.ts` を使います。
- **既知の違い:** メモリ側の `prefix != X` は UPDATE だけに一致します。SQL 側は OPEN や KEEPALIVE も返します（`tests/e2e/prefix-matching.e2e.ts` で固定）。

---

## 9. DuckDB のテーブル

テーブルは `BgpPacket[]` を検索しやすく平坦にした写しで、`src/lib/db/schema.ts` で定義しています。どの行も `frame_index` を通じて元のフレームにたどれます。主キーはありますが、副次インデックスはありません。フレームの生バイトも保存しません。

```mermaid
erDiagram
    packets ||--o{ messages : "frame_index"
    messages ||--o{ capabilities : "message_id (OPEN)"
    messages ||--o{ path_attributes : "message_id (UPDATE)"
    messages ||--o{ as_path : "message_id (UPDATE)"
    messages ||--o{ nlri : "message_id (UPDATE)"
    messages ||--o{ withdrawn : "message_id (UPDATE)"
    messages ||--o{ communities : "message_id"
    messages ||--o{ extended_communities : "message_id"
    messages ||--o{ large_communities : "message_id"

    packets {
        INTEGER frame_index PK
        TIMESTAMP timestamp
        VARCHAR src_ip
        VARCHAR dst_ip
        VARCHAR src_ip_bits
        INTEGER src_port
        VARCHAR_LIST parse_warnings
    }
    messages {
        INTEGER id PK
        INTEGER frame_index
        VARCHAR type
        BIGINT my_as
        INTEGER hold_time
        INTEGER error_code
        INTEGER error_subcode
    }
    capabilities {
        INTEGER id PK
        INTEGER message_id
        INTEGER code
        VARCHAR name
        INTEGER cap_afi
        INTEGER cap_safi
    }
    path_attributes {
        INTEGER id PK
        INTEGER message_id
        INTEGER type_code
        VARCHAR next_hop
        BIGINT med_value
        BIGINT local_pref
    }
    as_path {
        INTEGER id PK
        INTEGER message_id
        VARCHAR segment_type
        INTEGER as_index
        BIGINT asn
    }
    nlri {
        INTEGER id PK
        INTEGER message_id
        VARCHAR prefix
        VARCHAR prefix_bits
        INTEGER evpn_route_type
        VARCHAR evpn_mac
    }
    withdrawn {
        INTEGER id PK
        INTEGER message_id
        VARCHAR prefix
        VARCHAR prefix_bits
    }
    communities {
        INTEGER id PK
        INTEGER message_id
        VARCHAR formatted
    }
    extended_communities {
        INTEGER id PK
        INTEGER message_id
        VARCHAR kind
        VARCHAR formatted
    }
    large_communities {
        INTEGER id PK
        INTEGER message_id
        VARCHAR formatted
    }
```

図には主な列だけを載せています。全列は SQL Console の横のスキーマ一覧で確認できます。この一覧も同じ DDL から作っています。符号なし 32 ビットの項目（ASN、MED、LOCAL_PREF）は `BIGINT` にしています。DuckDB の `INTEGER` は符号付きだからです。

**行の投入方法**（`src/lib/db/loader.ts`）: ローダーはまず全テーブルを作り直します。次にパケットを一定量ずつ Arrow の列バッファへ直接書き込みます。それを Arrow IPC のストリームに手作業で組み立て、作業用テーブルへ投入します。最後に列名を指定した `INSERT … SELECT` で本テーブルへ写します。投入は順番待ちにしており、2 つが重なることはありません。Arrow の高水準ビルダーと DuckDB の JSON 読み込み機能は使いません。本番 CSP が `new Function` と拡張機能のダウンロードを禁止しているためです。

---

## 10. Findings の算出

アラートルールは**問題 1 件ごとに 1 つ**のアラートを出します。Findings 一覧では、それを**問題の種類ごとに 1 行**へまとめます。各ルールの発火条件と、誤検知を防ぐための除外条件は [`design.md` §2.1.14](design.md#2114-alert-rules-srccomponentsdashboardalertsts) で定めています。

```mermaid
flowchart TB
    in[["BgpPacket[] + GenericPacket[]"]] --> any{"BGP メッセージが<br/>あるか"}
    any -- "なし" --> transport["computeTransportAlerts<br/>RST で拒否 / 応答なしの SYN"]
    any -- "あり" --> work["alertsWork"]
    work --> conns["connectionsByPeering<br/>SYN（SYN-ACK 以外）ごとに<br/>TCP フレームを接続へ分割"]

    conns --> setup["セッション確立系のルール<br/>片方向のみ · 接続後に BGP なし"]
    conns --> silent["Silent teardown<br/>NOTIFICATION なしの RST / FIN"]
    conns --> gr["Graceful restart"]
    gr -. "抑止" .-> silent
    gr -. "抑止" .-> flap
    work --> notif["NOTIFICATION<br/>送信元 → 宛先、コード、サブコード別"]
    work --> flap["Session flapping<br/>同じペアで OPEN が 4 回以上"]
    work --> route["キャプチャ全体のルール<br/>withdrawn burst · route flapping<br/>AS_PATH changed · MAC moved<br/>（経路系は prefixStatsFor を使用）"]

    transport & setup & silent & gr & notif & flap & route --> sort["sortAlerts<br/>重大度 → 件数 → 新しさ"]
    sort --> cache[("WeakMap キャッシュ<br/>パケット配列 × 言語ごと")]
    cache --> scope["scopeAlerts<br/>選択セッション自身の分は残し、<br/>キャプチャ全体のルールは<br/>そのセッションのパケットで再計算"]
    scope --> group["groupFindings<br/>groupKey ごとにまとめる"]
    group --> ui["Findings 一覧 · セッションの重大度"]
```

- **処理は 1 つ、実行の速さは 2 通りです。** 各ルールは generator として書いています（`src/lib/sliced.ts`）。20,000 パケット以下では `runToEnd` で一度に計算します。それを超えると `runInSlices` で約 12 ms ずつ計算し、その間も一覧を操作できます。どちらも同じコードを通るので、テストで確かめた内容が大きなキャプチャでもそのまま表示されます。
- **Graceful Restart は他のルールと連動します。** GR は他の接続系ルールと同じ `connectionsByPeering` を使います。そのため、接続の区切り方で食い違うことなく *Session flapping* と *Silent teardown* を抑止できます。
- **テスト用の題材があります。** ルールを変えたときは、`testlab/scenarios.ts` の 14 シナリオで確認してください（[`troubleshooting-scenarios.md`](troubleshooting-scenarios.md)）。

---

## 11. 画面とルーティング

`BrowserRouter` の basename は `/bgpshark` です。アップロード画面以外は `React.lazy` で必要になったときに読み込みます。

```mermaid
flowchart LR
    root["App<br/>I18nProvider → BrowserRouter → AppProvider"] --> header["AppHeader · WarningBanner<br/>画面全体のドロップ領域"]
    root --> routes{"Routes"}

    routes --> upload["/<br/>FileUploadPage"]
    routes --> builder["/builder<br/>BuilderPage"]
    routes --> manual["/manual<br/>ManualPage"]
    routes --> guard["RequireCapture<br/>復元を待ち、なければ /<br/>（移動先を覚えておく）"]

    guard --> ws["WorkspaceLayout<br/>WorkspaceProvider<br/>SessionRail · TimeStrip · タブ"]
    ws --> msgs["/messages"]
    ws --> sess["/sessions"]
    ws --> rts["/routes"]
    ws --> sql["/sql"]

    routes -. "転送" .-> old1["/dashboard → /messages"]
    routes -. "転送" .-> old2["/neighbors → /sessions<br/>（指定されたセッションを選択）"]
```

Builder とマニュアルは、意図的に `RequireCapture` の外に置いています。どちらも何も読み込んでいない段階でこそ役に立つためです。共有する価値のある画面状態は URL に持たせています（`?filter=`、`?selected=`、`?frame=`、`?all=1`、経路の検索と並び順）。リンクを開けば同じ画面を再現できます。

---

## 12. Capture Builder

Builder はブラウザ内で正しい形式のキャプチャを生成します。e2e テストの入力やシナリオ集も同じライブラリで作っています。そのため、テストが中身の見えないバイナリの pcap に頼ることはありません。

```mermaid
flowchart LR
    presets["presets.ts<br/>8 種類のプリセット"] --> scen
    editor["ScenarioEditor<br/>ピア · 経路 · 手順"] --> scen["Scenario<br/>ピア + 手順"]
    lab["testlab/scenarios.ts<br/>14 種類の障害キャプチャ"] --> scen
    e2e["tests/e2e の補助関数"] --> scen

    scen --> buildS["buildScenario<br/>scenario.ts"]
    buildS --> enc["encodeMessage<br/>bgp-encode.ts<br/>AS 幅と ADD-PATH を<br/>OPEN のケイパビリティから決定"]
    enc --> frame["buildTcpFrame<br/>frame.ts<br/>MTU に従って分割、<br/>IPv4/TCP チェックサム計算"]
    frame --> write["writePcap<br/>pcap/writer.ts"]
    write --> bytes[[".pcap のバイト列"]]

    bytes --> preview["プレビュー<br/>parsePcap → parseBgpFromPackets"]
    bytes --> dl["ダウンロード"]
    bytes --> open["解析画面で開く<br/>(loadFile)"]
```

往復テスト（`tests/lib/build/round-trip.test.ts`）では、Builder で作ったものを解析器で読み戻して確かめます。これにより、生成側と解析側のずれに気づかないまま進むことを防いでいます。

---

## 13. ビルド・テスト・デプロイ

```mermaid
flowchart TB
    pr["プルリクエスト<br/>ci.yml"] --> checks
    push["main への push<br/>deploy.yml"] --> checks
    tag["v* タグの push<br/>release.yml"] --> checks

    subgraph checks["checks.yml（両ワークフローで共通）"]
        direction LR
        subgraph job1["ジョブ: check"]
            direction TB
            lint["bun run lint"] --> unit["bun test"] --> build["bun run build<br/>tsc -b (src · tests · testlab)<br/>+ vite build"]
        end
        subgraph job2["ジョブ: e2e × 3 分割"]
            direction TB
            pbuild["E2E_PREVIEW=1<br/>ビルド + vite preview"] --> pw["Playwright · Chromium<br/>本番ビルド、本番と同じ CSP"]
        end
    end

    checks -- "main のみ、両ジョブ成功時" --> deploy["actions/deploy-pages<br/>check ジョブの dist/ を公開"]
    deploy --> gp["GitHub Pages<br/>/bgpshark/"]
    checks -- "タグのみ、両ジョブ成功、<br/>タグ = package.json の版" --> rel["GitHub Release<br/>ノート: CHANGELOG.md の該当節<br/>+ マージ済み PR の一覧"]
```

**リリース手順。** [`CHANGELOG.md`](../CHANGELOG.md) に新しい版の節を追加し、`package.json` に同じ版を設定します。main にマージしたら、そのコミットに `v<版>` のタグを push します。リリースは何もデプロイしません。サイトはすでに main の内容で公開されています。

`vite build` では `vite.config.ts` にある 4 つの独自プラグインが動きます。

| プラグイン | ビルド時のみ | 役割 |
|------------|:------------:|------|
| `markdownPlugin` | いいえ | マニュアルの `.md` を、見出し ID と画像サイズ付きの HTML に変換します。Markdown の解析器は配信物に含めません |
| `cspPlugin` | はい | `index.html` の先頭に Content Security Policy の `<meta>` を挿入します |
| `openGraphPlugin` | いいえ | リンクプレビュー用のタグを絶対 URL（`SITE_URL`）で追加します |
| `spaFallbackPlugin` | はい | `index.html` を `404.html` にコピーし、GitHub Pages でも直接リンクを開けるようにします |

CI の e2e テストは**本番ビルド**に対して実行します。開発サーバーには CSP がないためです。CSP の下でだけ壊れる変更（外部への通信や `new Function` など）は、デプロイ後ではなくこの段階で見つかります。

---

## 14. 守るべき不変条件の一覧

| 不変条件 | 担保しているもの | 影響する変更 |
|----------|------------------|--------------|
| 外部オリジンへの通信なし、`eval` / `new Function` なし | 本番 CSP、`tests/e2e/offline.e2e.ts` | 依存ライブラリ、DuckDB の機能、アセットの読み込み |
| DuckDB はフレーム番号を選ぶだけで、パケットを組み立て直さない | `lib/db/queries.ts` が公開する関数 | SQL を使う新機能 |
| フィルタの意味が 2 つの方式で一致する | `tests/lib/filter`、`tests/e2e/*filter*`、`prefix-matching.e2e.ts` | フィルタの項目や演算子の変更 |
| デコード済みのメッセージは読み取り専用 | 取り決め（`shared-decode.ts`） | `BgpPacket` に触れるすべてのコード |
| Findings は DuckDB なしで動く | ルールは `BgpPacket[]` だけを受け取る | 新しいアラートルールや集計 |
| アラートルールが仕様の表と一致する | `design.md` §2.1.14 と `testlab/scenarios.ts` | ルールの追加・変更 |
| 英語版と日本語版のマニュアルで見出しの ID が一致する | `tests/e2e/manual.e2e.ts` | マニュアルの編集 |
