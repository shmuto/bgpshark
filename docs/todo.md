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

検証: `bun test` 81 件パス、`bun run build` / `bun run lint` クリーン、Playwright 29 チェック中 28 パス（残り 1 はテスト側のアサーション誤り）。
2.76MB / 23,800 パケットでの読み込み 1.6 秒、経路検索は即時、リロードで元の画面に復帰することも確認済み。

---

## 未対応

### 1. フィルタ式の `prefix` が文字列一致のまま

経路分析画面は `src/lib/net/prefix.ts` で数値比較するようになったが、
メッセージエクスプローラーのフィルタ式 `prefix = 10.0.0.0/8` は別実装で、
`src/lib/db/filter-to-sql.ts:437` の `prefixSql()` が `LIKE` による文字列一致をしている。
同じ式が画面によって違う結果になる。

**方針**
DuckDB 側は `prefix` と `prefix_length` の数値列を持っているので、
包含判定を SQL で書けるはず。インメモリ側（`src/lib/filter/parser.ts:633`）も
`src/lib/net/prefix.ts` を使うよう寄せて、3 つある実装を 1 つにする。

### 2. 経路分析が仕様に届いていない項目

`docs/ui-design.md` 4.5 節にあって未実装のもの。

- Prefix統計テーブルの **Last Seen** カラム（`PrefixStats.lastSeen` は計算済みで未表示）
- カラムヘッダークリックでのソート
- **AS_PATH Analysis** パネル（選択 Prefix の AS_PATH バリエーション図示）

### 3. 狭い画面のマスター/ディテール

`lg` 未満では一覧と詳細を上下に積んでいるだけなので、
480px では一覧も詳細も高さ半分ずつになる。
本来はスマホのように「一覧 → 選択で詳細に切り替え、戻るで一覧」が望ましい。
デスクトップ専用と割り切るなら README に明記する。

### 4. バンドルサイズ

`bun run build` が 561kB（gzip 152kB）で Vite の警告が出ている。
DuckDB WASM とアプリ本体を分けるなどの code splitting は未着手。
