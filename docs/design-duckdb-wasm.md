# BGPShark DuckDB WASM 設計書

## 概要

現在のIn-memory React stateベースのアーキテクチャから、DuckDB WASMを使用したSQLベースのクエリエンジンに移行する設計。

## 現状の課題

1. **スケーラビリティ**: 大規模pcapファイル（10万パケット以上）でパフォーマンス低下
2. **フィルタリング効率**: 線形スキャン、インデックスなし
3. **複雑なクエリ**: カスタムパーサーの拡張コストが高い
4. **集計機能**: AS PATHの統計やトラフィック分析が困難

## DuckDB WASMとは

- ブラウザ内で動作する組み込みOLAPデータベース
- SQLによる高速な分析クエリ
- 列指向ストレージで集計処理に最適
- WebAssemblyで動作、サーバー不要

## 提案アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (React App)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  PCAP Parser │───▶│  BGP Parser  │───▶│  DuckDB Loader   │  │
│  │  (既存)       │    │  (既存)       │    │  (新規)           │  │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘  │
│                                                    │             │
│                                                    ▼             │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    DuckDB WASM Instance                      │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌───────────────────────┐  │ │
│  │  │   packets   │ │  messages   │ │   path_attributes     │  │ │
│  │  │   (Table)   │ │   (Table)   │ │   (Table)             │  │ │
│  │  └─────────────┘ └─────────────┘ └───────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                │                                 │
│                                ▼                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Query Service (新規)                    │   │
│  │   - SQL変換 (フィルタ式 → SQL)                            │   │
│  │   - 結果マッピング (SQL結果 → BgpPacket[])                │   │
│  │   - 集計クエリ (統計、サマリー)                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                │                                 │
│                                ▼                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   React Components                        │   │
│  │   - useDuckDB() hook                                      │   │
│  │   - PacketList, PacketDetail, NeighborSummary            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## データベーススキーマ

### 1. packets テーブル (メインテーブル)

```sql
CREATE TABLE packets (
  frame_index     INTEGER PRIMARY KEY,  -- PCAPフレーム番号
  timestamp       TIMESTAMP,            -- パケットタイムスタンプ
  src_ip          VARCHAR,              -- 送信元IP
  dst_ip          VARCHAR,              -- 宛先IP
  src_port        INTEGER,              -- 送信元ポート
  dst_port        INTEGER,              -- 宛先ポート
  raw_data        BLOB,                 -- 生データ (HexDump用)
  parse_warnings  VARCHAR[]             -- パース警告
);
```

### 2. messages テーブル (BGPメッセージ)

```sql
CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,  -- 自動生成ID
  frame_index     INTEGER,              -- パケットへの外部キー
  message_index   INTEGER,              -- パケット内でのインデックス
  type            VARCHAR,              -- OPEN, UPDATE, NOTIFICATION, KEEPALIVE, ROUTE_REFRESH
  length          INTEGER,              -- メッセージ長

  -- OPEN message fields
  version         INTEGER,
  my_as           INTEGER,              -- AS番号 (4バイト対応)
  hold_time       INTEGER,
  router_id       VARCHAR,

  -- NOTIFICATION fields
  error_code      INTEGER,
  error_subcode   INTEGER,

  -- ROUTE_REFRESH fields
  afi             INTEGER,
  safi            INTEGER,

  FOREIGN KEY (frame_index) REFERENCES packets(frame_index)
);

-- インデックス
CREATE INDEX idx_messages_frame ON messages(frame_index);
CREATE INDEX idx_messages_type ON messages(type);
CREATE INDEX idx_messages_router_id ON messages(router_id);
CREATE INDEX idx_messages_my_as ON messages(my_as);
```

### 3. capabilities テーブル (OPENメッセージのケーパビリティ)

```sql
CREATE TABLE capabilities (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER,              -- messagesへの外部キー
  code            INTEGER,              -- Capability Code
  name            VARCHAR,              -- e.g., MULTIPROTOCOL, FOUR_OCTET_AS
  value           BLOB,                 -- 生の値

  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_capabilities_message ON capabilities(message_id);
CREATE INDEX idx_capabilities_name ON capabilities(name);
```

### 4. path_attributes テーブル (UPDATE の Path Attributes)

```sql
CREATE TABLE path_attributes (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER,              -- messagesへの外部キー
  type_code       INTEGER,              -- Attribute Type Code
  type_name       VARCHAR,              -- e.g., ORIGIN, AS_PATH, NEXT_HOP
  flags           INTEGER,              -- Optional, Transitive, Partial, Extended Length

  -- 型別の値 (1つのみ使用)
  value_string    VARCHAR,              -- ORIGIN, NEXT_HOP等
  value_integer   INTEGER,              -- MED, LOCAL_PREF等
  value_blob      BLOB,                 -- その他

  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_path_attrs_message ON path_attributes(message_id);
CREATE INDEX idx_path_attrs_type ON path_attributes(type_name);
```

### 5. as_path テーブル (AS_PATH展開)

```sql
CREATE TABLE as_path (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER,
  segment_type    VARCHAR,              -- AS_SEQUENCE, AS_SET
  segment_index   INTEGER,              -- セグメント順序
  as_index        INTEGER,              -- セグメント内順序
  asn             INTEGER,              -- AS番号

  FOREIGN KEY (message_id) REFERENCES messages(id)
);

-- AS番号検索用インデックス
CREATE INDEX idx_as_path_message ON as_path(message_id);
CREATE INDEX idx_as_path_asn ON as_path(asn);
```

### 6. nlri テーブル (Announced Prefixes)

```sql
CREATE TABLE nlri (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER,
  prefix          VARCHAR,              -- e.g., "10.0.0.0/8"
  prefix_length   INTEGER,              -- 8
  afi             INTEGER,              -- 1=IPv4, 2=IPv6
  safi            INTEGER,              -- 1=unicast, 2=multicast

  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_nlri_message ON nlri(message_id);
CREATE INDEX idx_nlri_prefix ON nlri(prefix);
```

### 7. withdrawn テーブル (Withdrawn Routes)

```sql
CREATE TABLE withdrawn (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER,
  prefix          VARCHAR,
  prefix_length   INTEGER,
  afi             INTEGER,
  safi            INTEGER,

  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_withdrawn_message ON withdrawn(message_id);
CREATE INDEX idx_withdrawn_prefix ON withdrawn(prefix);
```

### 8. communities テーブル (通常コミュニティ)

```sql
CREATE TABLE communities (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER,
  asn             INTEGER,              -- 上位16ビット
  value           INTEGER,              -- 下位16ビット
  formatted       VARCHAR,              -- "65000:100"

  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_communities_message ON communities(message_id);
CREATE INDEX idx_communities_formatted ON communities(formatted);
```

### 9. large_communities テーブル (Large Communities)

```sql
CREATE TABLE large_communities (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER,
  global_admin    INTEGER,              -- Global Administrator
  local_data1     INTEGER,              -- Local Data Part 1
  local_data2     INTEGER,              -- Local Data Part 2
  formatted       VARCHAR,              -- "65000:100:200"

  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_large_communities_message ON large_communities(message_id);
```

## ファイル構成

```
src/
├── lib/
│   ├── db/                          # 新規ディレクトリ
│   │   ├── index.ts                 # エクスポート
│   │   ├── database.ts              # DuckDB初期化・管理
│   │   ├── schema.ts                # テーブル作成SQL
│   │   ├── loader.ts                # BgpPacket[] → INSERT
│   │   ├── queries.ts               # 定義済みクエリ
│   │   └── filter-to-sql.ts         # フィルタ式 → SQL変換
│   ├── bgp/                         # 既存 (変更なし)
│   ├── pcap/                        # 既存 (変更なし)
│   └── filter/
│       └── parser.ts                # 既存 (SQL変換用に拡張)
├── hooks/
│   ├── useDuckDB.ts                 # 新規: DuckDB状態管理
│   ├── useBgpAnalyzer.ts            # 変更: DuckDB統合
│   └── useFilter.ts                 # 変更: SQLクエリに移行
└── components/                       # 最小限の変更
```

## 主要コンポーネント設計

### 1. database.ts - DuckDB管理

```typescript
// src/lib/db/database.ts
import * as duckdb from '@duckdb/duckdb-wasm'

let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null

export async function initDatabase(): Promise<void> {
  // DuckDB WASMの初期化
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES)

  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })
  )
  const worker = new Worker(worker_url)
  const logger = new duckdb.ConsoleLogger()

  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  conn = await db.connect()

  // スキーマ作成
  await createSchema(conn)
}

export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!conn) {
    await initDatabase()
  }
  return conn!
}

export async function resetDatabase(): Promise<void> {
  if (conn) {
    await conn.query('DROP TABLE IF EXISTS large_communities')
    await conn.query('DROP TABLE IF EXISTS communities')
    await conn.query('DROP TABLE IF EXISTS withdrawn')
    await conn.query('DROP TABLE IF EXISTS nlri')
    await conn.query('DROP TABLE IF EXISTS as_path')
    await conn.query('DROP TABLE IF EXISTS path_attributes')
    await conn.query('DROP TABLE IF EXISTS capabilities')
    await conn.query('DROP TABLE IF EXISTS messages')
    await conn.query('DROP TABLE IF EXISTS packets')
    await createSchema(conn)
  }
}
```

### 2. loader.ts - データロード

```typescript
// src/lib/db/loader.ts
import type { BgpPacket } from '../bgp/types'
import { getConnection } from './database'

export async function loadPackets(packets: BgpPacket[]): Promise<void> {
  const conn = await getConnection()

  // バッチINSERT用のPrepared Statement
  const insertPacket = await conn.prepare(`
    INSERT INTO packets (frame_index, timestamp, src_ip, dst_ip, src_port, dst_port, raw_data, parse_warnings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMessage = await conn.prepare(`
    INSERT INTO messages (frame_index, message_index, type, length, version, my_as, hold_time, router_id, error_code, error_subcode, afi, safi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `)

  // トランザクションでバッチ処理
  await conn.query('BEGIN TRANSACTION')

  try {
    for (const packet of packets) {
      // パケット挿入
      await insertPacket.run(
        packet.frameIndex,
        packet.timestamp.toISOString(),
        packet.srcIp,
        packet.dstIp,
        packet.srcPort,
        packet.dstPort,
        packet.rawData,
        packet.parseWarnings
      )

      // メッセージ挿入
      for (let i = 0; i < packet.messages.length; i++) {
        const msg = packet.messages[i]
        const result = await insertMessage.run(
          packet.frameIndex,
          i,
          msg.type,
          msg.length,
          msg.type === 'OPEN' ? msg.version : null,
          msg.type === 'OPEN' ? msg.myAs : null,
          // ... 他のフィールド
        )

        const messageId = result.getChild('id').get(0)

        // 関連テーブルへの挿入
        if (msg.type === 'UPDATE') {
          await insertUpdateData(conn, messageId, msg)
        } else if (msg.type === 'OPEN') {
          await insertCapabilities(conn, messageId, msg)
        }
      }
    }

    await conn.query('COMMIT')
  } catch (error) {
    await conn.query('ROLLBACK')
    throw error
  }
}
```

### 3. filter-to-sql.ts - フィルタ→SQL変換

```typescript
// src/lib/db/filter-to-sql.ts
import type { Expression } from '../filter/parser'

export function filterToSql(expr: Expression): string {
  switch (expr.type) {
    case 'comparison':
      return comparisonToSql(expr)
    case 'and':
      return `(${filterToSql(expr.left)} AND ${filterToSql(expr.right)})`
    case 'or':
      return `(${filterToSql(expr.left)} OR ${filterToSql(expr.right)})`
    case 'not':
      return `NOT (${filterToSql(expr.operand)})`
    default:
      throw new Error(`Unknown expression type: ${(expr as any).type}`)
  }
}

function comparisonToSql(expr: ComparisonExpression): string {
  const { field, operator, value } = expr

  switch (field) {
    case 'type':
      return `EXISTS (SELECT 1 FROM messages m WHERE m.frame_index = packets.frame_index AND m.type ${sqlOperator(operator)} '${value}')`

    case 'src':
      if (value.includes('/')) {
        // CIDR notation - prefix match
        return `src_ip << '${value}'::inet`
      }
      return `src_ip ${sqlOperator(operator)} '${value}'`

    case 'dst':
      if (value.includes('/')) {
        return `dst_ip << '${value}'::inet`
      }
      return `dst_ip ${sqlOperator(operator)} '${value}'`

    case 'aspath':
      if (operator === 'contains') {
        return `EXISTS (
          SELECT 1 FROM as_path ap
          JOIN messages m ON ap.message_id = m.id
          WHERE m.frame_index = packets.frame_index AND ap.asn = ${value}
        )`
      }
      return `EXISTS (
        SELECT 1 FROM as_path ap
        JOIN messages m ON ap.message_id = m.id
        WHERE m.frame_index = packets.frame_index AND ap.asn ${sqlOperator(operator)} ${value}
      )`

    case 'nlri':
      return `EXISTS (
        SELECT 1 FROM nlri n
        JOIN messages m ON n.message_id = m.id
        WHERE m.frame_index = packets.frame_index
        AND (n.prefix = '${value}' OR n.prefix << '${value}'::inet OR '${value}'::inet << n.prefix)
      )`

    case 'community':
      return `EXISTS (
        SELECT 1 FROM communities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = packets.frame_index AND c.formatted ${sqlOperator(operator)} '${value}'
      )`

    case 'router-id':
      return `EXISTS (
        SELECT 1 FROM messages m
        WHERE m.frame_index = packets.frame_index
        AND m.type = 'OPEN'
        AND m.router_id ${sqlOperator(operator)} '${value}'
      )`

    // ... 他のフィールド

    default:
      throw new Error(`Unknown field: ${field}`)
  }
}

function sqlOperator(op: string): string {
  switch (op) {
    case '=': return '='
    case '!=': return '!='
    case 'contains': return 'LIKE'
    case 'not contains': return 'NOT LIKE'
    default: return '='
  }
}
```

### 4. queries.ts - 定義済みクエリ

```typescript
// src/lib/db/queries.ts
import { getConnection } from './database'
import type { BgpPacket } from '../bgp/types'

// フィルタ付きパケット取得
export async function getPackets(whereClause?: string): Promise<BgpPacket[]> {
  const conn = await getConnection()

  const sql = `
    SELECT
      p.frame_index,
      p.timestamp,
      p.src_ip,
      p.dst_ip,
      p.src_port,
      p.dst_port,
      p.raw_data,
      p.parse_warnings
    FROM packets p
    ${whereClause ? `WHERE ${whereClause}` : ''}
    ORDER BY p.frame_index
  `

  const result = await conn.query(sql)
  return resultToPackets(result)
}

// ネイバーサマリー取得
export async function getNeighborSummary(): Promise<NeighborSummary[]> {
  const conn = await getConnection()

  const result = await conn.query(`
    SELECT
      src_ip,
      dst_ip,
      COUNT(*) as packet_count,
      COUNT(CASE WHEN m.type = 'OPEN' THEN 1 END) as open_count,
      COUNT(CASE WHEN m.type = 'UPDATE' THEN 1 END) as update_count,
      COUNT(CASE WHEN m.type = 'KEEPALIVE' THEN 1 END) as keepalive_count,
      COUNT(CASE WHEN m.type = 'NOTIFICATION' THEN 1 END) as notification_count,
      MIN(p.timestamp) as first_seen,
      MAX(p.timestamp) as last_seen
    FROM packets p
    LEFT JOIN messages m ON p.frame_index = m.frame_index
    GROUP BY src_ip, dst_ip
    ORDER BY src_ip, dst_ip
  `)

  return resultToNeighborSummary(result)
}

// AS_PATH統計
export async function getAsPathStats(): Promise<AsPathStats[]> {
  const conn = await getConnection()

  const result = await conn.query(`
    SELECT
      asn,
      COUNT(*) as occurrence_count,
      COUNT(DISTINCT m.frame_index) as packet_count
    FROM as_path ap
    JOIN messages m ON ap.message_id = m.id
    GROUP BY asn
    ORDER BY occurrence_count DESC
    LIMIT 100
  `)

  return resultToAsPathStats(result)
}

// プレフィックス統計
export async function getPrefixStats(): Promise<PrefixStats[]> {
  const conn = await getConnection()

  const result = await conn.query(`
    WITH all_prefixes AS (
      SELECT prefix, 'announced' as action FROM nlri
      UNION ALL
      SELECT prefix, 'withdrawn' as action FROM withdrawn
    )
    SELECT
      prefix,
      COUNT(CASE WHEN action = 'announced' THEN 1 END) as announce_count,
      COUNT(CASE WHEN action = 'withdrawn' THEN 1 END) as withdraw_count
    FROM all_prefixes
    GROUP BY prefix
    ORDER BY (announce_count + withdraw_count) DESC
    LIMIT 100
  `)

  return resultToPrefixStats(result)
}
```

### 5. useDuckDB.ts - Reactフック

```typescript
// src/hooks/useDuckDB.ts
import { useState, useCallback, useEffect } from 'react'
import { initDatabase, resetDatabase } from '../lib/db/database'
import { loadPackets } from '../lib/db/loader'
import { getPackets, getNeighborSummary } from '../lib/db/queries'
import { filterToSql } from '../lib/db/filter-to-sql'
import { parse } from '../lib/filter/parser'
import type { BgpPacket } from '../lib/bgp/types'

interface DuckDBState {
  status: 'initializing' | 'ready' | 'loading' | 'error'
  error: string | null
}

export function useDuckDB() {
  const [state, setState] = useState<DuckDBState>({
    status: 'initializing',
    error: null
  })

  // 初期化
  useEffect(() => {
    initDatabase()
      .then(() => setState({ status: 'ready', error: null }))
      .catch((err) => setState({ status: 'error', error: err.message }))
  }, [])

  // パケットロード
  const load = useCallback(async (packets: BgpPacket[]) => {
    setState((s) => ({ ...s, status: 'loading' }))
    try {
      await resetDatabase()
      await loadPackets(packets)
      setState({ status: 'ready', error: null })
    } catch (err) {
      setState({ status: 'error', error: (err as Error).message })
    }
  }, [])

  // フィルタリング
  const query = useCallback(async (filterExpr: string): Promise<BgpPacket[]> => {
    if (!filterExpr.trim()) {
      return getPackets()
    }

    const parsed = parse(filterExpr)
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.join(', '))
    }

    const whereClause = filterToSql(parsed.expression!)
    return getPackets(whereClause)
  }, [])

  return {
    ...state,
    load,
    query,
    getNeighborSummary,
  }
}
```

## 移行戦略

### Phase 1: 基盤構築 (1週目)
1. DuckDB WASMのセットアップ
2. スキーマ定義
3. データローダー実装
4. 基本クエリ実装

### Phase 2: フィルタ統合 (2週目)
1. フィルタ→SQL変換器
2. 既存フィルタ構文との互換性確保
3. useDuckDBフック実装

### Phase 3: UI統合 (3週目)
1. useBgpAnalyzerの変更
2. コンポーネントの更新
3. パフォーマンス最適化

### Phase 4: 拡張機能 (4週目)
1. 集計ビュー追加
2. エクスポート機能
3. 複数ファイル対応

## メリット

1. **パフォーマンス**: 列指向ストレージによる高速フィルタリング
2. **スケーラビリティ**: 大規模データセットに対応
3. **SQL**: 標準的なクエリ言語で拡張が容易
4. **集計**: GROUP BY, COUNT, JOINなど高度な分析
5. **インデックス**: 自動最適化されたクエリ実行

## デメリット・考慮点

1. **初期ロード時間**: WASMバイナリのダウンロード (約10MB)
2. **メモリ使用量**: DuckDB自体のオーバーヘッド
3. **複雑性**: SQLとJSの型変換が必要
4. **デバッグ**: SQL実行のトラブルシューティング

## 代替案

### IndexedDB + 手動インデックス
- より軽量だがクエリ機能が限定的

### sql.js (SQLite WASM)
- 行指向で分析クエリが遅い
- DuckDBより小さいが分析に不向き

### Web Workers + 現状維持
- フィルタリングをWorkerに移すだけ
- スケーラビリティ問題は解決しない

## 結論

BGPSharkの用途（BGPパケット分析）にはDuckDB WASMが最適。
- 複雑なAS_PATH検索
- プレフィックスの集計
- 時系列分析

すべてSQLで表現でき、カスタムパーサーより保守性が高い。
