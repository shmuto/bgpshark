# BGPShark ユーザーマニュアル

BGPShark は、パケットキャプチャを解析して BGP セッションの状態を可視化するツールです。セッションが上がらない、フラップする、経路が届かない、意図しない上流へ抜けるといった障害調査に利用できます。

すべての処理はブラウザ内で完結します。キャプチャファイルが外部にアップロードされることはなく、オフライン環境でもそのまま動作します。

## キャプチャの読み込み {#loading-a-capture}

ウィンドウ内の任意の場所へファイルをドラッグ＆ドロップするか、開始画面のファイル選択から読み込みます。`.pcap`、`.pcapng`、`.cap` 形式（最大 50 MB）に対応しており、ファイル形式は自動で判別されます。

サイズの大きなキャプチャでは読み込みに数秒かかり、進行状況がプログレスバーに表示されます。所要時間の大部分は最終段階の **Loading into DuckDB** で、大規模な経路テーブル転送では数百万行のデータをインポートします。

手元にキャプチャがない場合は、**Load sample** でサンプルデータを試せるほか、**Build** 画面で検証用のキャプチャを作成できます。

読み込んだキャプチャはブラウザ内のストレージ（IndexedDB）に保存されるため、ページをリロードしても保持されます。別のファイルを読み込む場合は **New File** をクリックしてください。

### 解析結果に違和感があるとき {#if-the-capture-looks-wrong}

ヘッダー下に黄色い警告バナーが表示された場合、ファイルの一部（途中で切れたフレームや破損したブロックなど）を正常にパースできなかったことを示します。バナーをクリックすると詳細を確認でき、問題のない残りのパケットはそのまま解析されます。

解析結果を読む際は、以下の 3 点に注意してください。

- **片方向のみのキャプチャはアラートで検知されますが、原因の切り分けが必要です。** Dashboard は片方向しか観測できないセッションを critical アラートとして報告しますが、ミラーポートや `tcpdump` フィルタの設定ミスなのか、片方向リンクや ACL による実際の通信障害なのかは区別できません。見分け方は [キャプチャが不完全な可能性を確認する](#the-capture-may-be-lying-to-you) を参照してください。
- **TCP レベルのフレームは既定では非表示です。** パケット一覧は初期状態では BGP メッセージのみを表示します。TCP の RST（`[R]`）や FIN（`[F]`）を確認するには **All Packets** に切り替えてください。All Packets でもフィルタは有効です。BGP を含まないフレームには `src_ip`・`dst_ip`・`src_port`・`dst_port`・`frame` の条件だけが評価されるため、`src_ip = 10.0.13.1` ならそのピアの BGP と併せて TCP ハンドシェイクや切断も表示され、`type = UPDATE` のような BGP 専用の条件では該当する BGP フレームだけが残ります。
- **セッション途中から取得したキャプチャには OPEN が含まれません。** 4 バイト AS の利用有無や ADD-PATH の Path Identifier の有無は OPEN でネゴシエートされ、UPDATE 単体には明示されません。OPEN が欠けている場合、BGPShark はメッセージ構造からエンコーディングを推定し、警告バナーにその旨を表示します。可能であればセッション確立前から再取得してください。

## 各画面の使い方 {#the-screens}

画面ごとに得意な調査内容が異なります。迷った場合はまず **Dashboard** を開くか、[症状から調べる](#investigating-by-symptom) から該当するケースを選んでください。

| 画面 | 主な用途 |
|------|----------|
| **Dashboard** | キャプチャ内の異常や障害の概要を把握する |
| **Messages** | 送受信されたメッセージの詳細と生バイトを確認する |
| **Neighbors** | ピア同士が OPEN で合意した内容（ケイパビリティ）を比較する |
| **Routes** | 特定プレフィックスの広告・取り消し履歴や属性を確認する |
| **SQL** | 複数プレフィックスやセッションをまたぐ自由な集計・検索を行う |
| **Build** | 任意の BGP シナリオから検証用の `.pcap` ファイルを生成する |

### Dashboard {#dashboard}

キャプチャを読み込むと最初にこの画面が開きます。メッセージ件数、タイムライン、ネイバー一覧表、および **Alerts** パネルを表示します。アラートは重要度順に並び、パケット単位ではなく問題単位で集約されます（たとえば拒否された OPEN の 40 回リトライは、回数 40 の 1 行として表示されます）。上位 5 件のみ表示され、**Show N more alerts** で残りを展開できます。

NOTIFICATION、セッションフラップ、Withdraw バースト、経路フラップ、同一ピアからの AS_PATH 変化、EVPN の MAC ムーブ、Graceful Restart、NOTIFICATION なしの TCP 切断、片方向セッション、TCP 接続後に BGP 応答がないケースを自動で検出します。各アラートの **View →** をクリックすると、適切なフィルタが適用された状態で該当パケットへ移動します。

*Cease / Connection Collision Resolution* は critical ではなく warning として表示されます。両端が同時に接続した際に一方の接続を閉じる BGP の通常動作（RFC 4271 §6.8）であり、障害ではないためです。また、*異なる*ピアからの AS_PATH の違い（iBGP ピアの空のパスと eBGP ピアの `65001` など）は正常なので通知しません。比較は **Routes** で行ってください。

> 「No issues detected」はセッション層に異常がないことを意味します。経路リークや意図しないベストパス選択など、ポリシー上の問題はセッションが健全なため検出されません。

### Messages {#messages}

パケット一覧、階層化された詳細ビュー、16 進ダンプを表示します。行をクリックすると、ケイパビリティやパス属性までデコードされた内容と生バイトを確認できます。

**Info** 列には各メッセージの要約が表示されます（OPEN なら `AS65001 Hold=90`、UPDATE なら広告・取り消し件数、NOTIFICATION ならエラー名）。NLRI も Withdraw も含まない空の UPDATE は **End-of-RIB** と表示されます。

ステータスバー右端の **Columns** ボタンでタイムスタンプやポート番号の列を切り替えられ、**Export** ボタンで現在フィルタ表示中のパケットだけを新しい `.pcap` として保存できます（チケット添付用に関連パケットだけを切り出す用途に便利です）。

UPDATE のパス属性は展開された状態で表示され、折りたたんだ場合はその状態が `↑`/`↓` でのパケット移動後も維持されます。KEEPALIVE では、送信元の直前メッセージからの経過時間と、それがネゴシエート済み Hold Time の何 % にあたるかを表示します。**Messages** から別タブへ移動してヘッダから戻ると、フィルタ・**All Packets** モード・選択中のフレームが復元されます。

### Neighbors {#neighbors}

Router ID ごとにセッションを一覧表示します。**Sent** 列はそのルータが送信したメッセージ数で、詳細ペインの **Message Summary** は送受信の合計です。ルータを選ぶと、セッション・メッセージ・広告プレフィックスが表示されます（プレフィックスをクリックすると経路履歴が開きます）。さらにセッションをクリックすると、ペインがそのセッション専用の表示に切り替わり、パンくず（**← Router overview** で戻る）、双方の OPEN メッセージを並べて比較する **Capability Diff**、プレフィックスの増減、前のメッセージからの経過時間付きのメッセージ一覧が表示されます。

ケイパビリティはアドレスファミリ（AFI/SAFI）単位で比較され、不一致の項目が先頭に表示されます。Hold Time の違いは仕様上問題ない（小さい値が採用される）ため情報表示にとどめ、BGP Identifier の重複はエラーとして強調します。

### Routes {#routes}

キャプチャ内の全プレフィックスについて、広告回数、取り消し（Withdraw）回数、最終観測時刻、**Flap** 回数を一覧表示します。**Flap** 列でソートすると不安定な経路をすぐに見つけられ、プレフィックスをクリックすると全履歴と AS_PATH を確認できます。検索は入力に合わせて即時反映されます。履歴の行をクリックすると、そのプレフィックスで絞り込んだ **Messages** が該当 UPDATE を選択した状態で開きます。

検索ボックスでは 3 つの照合モードを切り替えられます。

- **Exact** — 入力したプレフィックスと完全一致するもののみ表示します。
- **Subnets** — 入力した CIDR に含まれるより細かい経路を検索します（例：`10.0.0.0/8` で `10.0.12.0/24` がヒット）。
- **Supernets** — 入力した IP アドレスや CIDR を包含する集約経路を検索します（例：`10.0.12.7` で `10.0.0.0/8` がヒット）。

### SQL {#sql}

キャプチャを DuckDB のテーブルとして SQL で直接クエリできます。標準画面では対応できない横断的な比較や集計に利用してください。テーブル定義はサイドバーに、代表的なクエリ例は **Query Templates** に用意されています。

クエリを書く際のポイントは以下の 3 点です。

- `nlri.prefix` にはプレフィックス長が含まれないため、`prefix || '/' || prefix_length` で結合して表示してください。
- `nlri`、`as_path`、`path_attributes` はいずれも `message_id` で結合するため、3 つをそのまま JOIN すると行が直積で膨らみます。相関サブクエリを使用してください。
- テーブルは検索用に平坦化したデータです。全フィールドの詳細を確認したい場合は `frame_index` から **Messages** 画面を参照してください。

同じプレフィックスに対する複数経路の属性を比較するクエリ例：

```sql
select n.prefix || '/' || n.prefix_length as route, p.src_ip,
       (select string_agg(a.asn, ' ' order by a.as_index)
          from as_path a where a.message_id = m.id) as as_path,
       (select max(med_value)  from path_attributes where message_id = m.id) as med,
       (select max(local_pref) from path_attributes where message_id = m.id) as local_pref
from nlri n
  join messages m on m.id = n.message_id
  join packets p using (frame_index)
order by route
```

### Build {#build}

ラボ環境を用意せずに、セッション構成を記述するだけで有効な `.pcap` ファイルを生成できます。事前にキャプチャを読み込む必要はありません。

8 種類のプリセット（正常確立、Hold Timer 満了、AS 不一致、TCP 接続拒否、IPv6 トランスポート、経路フラップ、4 バイト AS、TCP セグメント分割された UPDATE）から選び、ピア情報・経路・メッセージ手順を編集して、プレビュー確認やダウンロードを行えます。

UPDATE のエンコーディング（4 バイト AS 幅や ADD-PATH Path Identifier）は OPEN のケイパビリティ設定から自動で決定され、TCP セグメント分割は MTU 設定に従います（MTU を下げるとセグメントをまたぐ BGP メッセージを生成できます）。チェックサムも正しく計算されるため、出力した `.pcap` は Wireshark など他のツールでもそのまま開けます。

## 症状から調べる {#investigating-by-symptom}

実際の障害症状から、確認すべき画面と判断のポイントを逆引きできます。

### 最初に確認すること {#start-here}

どの症状であっても、まず次の 3 ステップから確認してください。

1. **Dashboard** を開き、カウンタと **Alerts** パネルを確認します。
2. キャプチャに双方向のパケットが含まれているか確認します（[キャプチャが不完全な可能性を確認する](#the-capture-may-be-lying-to-you)）。
3. 重要度の高いアラートの **View →** をクリックし、フィルタ済みの状態で起点パケットを確認します。

![フラップしているセッションの Dashboard。カウンタ、2 件のアラート、ネイバー一覧表、タイムラインを表示](manual/dashboard.png)

「No issues detected — every session looks healthy」と表示されていても、それはセッション層が健全であることを示すだけです。経路リークやベストパス選択の異常は別途確認する必要があります。

### 「セッションが確立しない」 {#the-session-will-not-come-up}

ネイバーが Idle または Connect のままで BGP メッセージがやり取りされない場合、TCP ポート 179 への SYN に対する応答を確認します。

**Dashboard** を開くと、BGP メッセージが一切含まれないキャプチャでは TCP 層からアラートが生成されます。

![critical アラート「TCP connections to port 179 are being refused — 3 SYNs answered by RST」](manual/s1-tcp-refused.png)

- **SYN に RST が返る** — ACL やファイアウォールによる拒否、TCP-MD5 / TCP-AO の不一致、あるいは対向ルータで BGP が待ち受けていない状態です。
- **SYN に応答がない** — BGP より下位のルーティング障害やパケット破棄（フィルタリング）が起きています。
- **SYN-ACK のあと BGP が来ない** — Dashboard に *「TCP connects but 10.0.0.2 sends no BGP」* と表示されます。TCP ハンドシェイクが成立しているため、ポートは開いており、ACL による SYN 破棄や TCP-MD5 不一致は除外できます。対向のネイバー設定漏れ、TCP ミドルボックス、PMTU ブラックホール、コントロールプレーンポリシングなどを確認してください。

リトライ回数や間隔を確認するには、**Messages** を **All Packets** モードに切り替えます（BGP Only では何も表示されません）。

### 「Established だが特定のアドレスファミリの経路が来ない」 {#it-is-established-but-a-whole-address-family-never-arrives}

セッションは確立し IPv4 経路は正常なのに、IPv6・EVPN・VPNv4 などの経路がまったく届かない場合はケイパビリティの不一致を確認します。

**Neighbors → ルータを選択 → セッションを選択** の順に進むと **Capability Diff** が表示されます（ルータ行ではなくセッション行を選択する必要があります）。

![Capability Diff。セッション基本項目は一致し、IPv6/Unicast Multiprotocol Extensions を含む 4 つのケイパビリティが片側のみ広告されている](manual/s2-capability-diff.png)

**Status** 列を確認してください。

- **⚠ Only *x*** — 片側しか広告していないケイパビリティ／アドレスファミリです。双方で有効にしない限り、そのアドレスファミリの経路は交換されません。
- **Differs — normal for eBGP**（My AS）や Hold Time の差異は正常です。
- **BGP Identifier の重複** はエラーとして表示されます。

### 「数分おきにセッションがフラップする」 {#it-flaps-every-few-minutes}

Dashboard は繰り返された切断を回数付きの NOTIFICATION アラート 1 行と、セッションフラップ警告にまとめて表示します。

![アラート「NOTIFICATION: Hold Timer Expired / Unspecific ×3」と「Session flapping detected — 6 OPEN messages (~3 establishments)」](manual/s3-holdtimer-alerts.png)

`Hold Timer Expired` は対向からのメッセージが一定時間届かなかったことを意味します。**Messages** で該当の NOTIFICATION をクリックし、**Silence before the teardown** を確認してください。

![NOTIFICATION の詳細。ネゴシエートされた Hold Time 90 秒に対し、10.0.0.1 からの最終 KEEPALIVE から 90.4 秒経過している](manual/s3-holdtimer-gap.png)

- **無応答時間 ≧ ネゴシエートされた Hold Time**（例：90 秒に対して 90.4 秒）：セッション自体は稼働していたものの、片方向で KEEPALIVE が届かなくなっています。BGP 設定ではなくルータ間の通信経路を調査してください。
- **無応答時間が Hold Time より大幅に短い**：タイマーの早期発火として警告表示されます。キャプチャのパケット取りこぼしか、記録された OPEN と異なる Hold Time が有効になっていた可能性があります。

無応答時間は単純な直前パケット（自ルータの KEEPALIVE の場合がある）ではなく、**対向ピアの最終メッセージ** から計測され、その切断直前の OPEN でネゴシエートされた小さい方の Hold Time と比較されます。OPEN がキャプチャに含まれない場合は、無応答時間のみが表示されます。

### 「理由が記録されないままセッションが切断された」 {#it-dropped-and-nothing-says-why}

NOTIFICATION が出力されないままセッションが切断・再確立している場合、TCP 層での切断が起きています。

**Dashboard** では、NOTIFICATION なしの切断が種別ごとに critical アラートとして表示されます。

- *「…was reset with no NOTIFICATION」*（TCP RST — ファイアウォールやソケットリセットなど能動的な切断）
- *「…was closed with no NOTIFICATION」*（TCP FIN — セッションアイドルタイムアウトなど正常クローズによる切断）

各アラートの **View →** をクリックすると、**Messages** が自動で **All Packets** モードに切り替わり、該当フレームが選択されます。

![Alerts パネルに「was reset with no NOTIFICATION」と「was closed with no NOTIFICATION」の 2 件の critical アラート、その下に「Session flapping detected」を表示](manual/s11-teardown-alerts.png)

これらのアラートは *「Session flapping detected」* と併用して確認します（フラップ警告は再確立の回数、切断アラートはどのように切れたかを示します）。なお、一度も確立しなかったセッションは *「TCP connects but the peer sends no BGP」* 側で扱われるため、ここには表示されません。

手動で確認する場合は **Messages** を **All Packets** に切り替えます（BGP Only 表示でフレーム番号が飛んでいる箇所が手がかりになります）。

![All Packets モードでフレーム 11 を選択。10.0.0.2 からの [AR] フレームと、詳細ペインの「TCP Flags: ACK, RST」を表示](manual/s11-tcp-reset.png)

`[AR]` は ACK+RST、`[F]` は FIN を表します。TCP フラグ専用のフィルタフィールドはないため、**All Packets** モードで直接確認してください。

### 「経路を広告した直後にセッションが落ちる」 {#the-session-drops-the-moment-routes-are-advertised}

セッション確立後、最初の UPDATE を送った直後に切断される場合は、**Messages** で該当の NOTIFICATION をクリックします。

![NOTIFICATION の詳細。エラーコード 3 UPDATE Message Error、サブコード 2 Unrecognized Well-known Attribute、トラブルシューティングヒント、Well-known・Transitive とデコードされた UNKNOWN(199) および生バイトを表示](manual/s6-notification.png)

エラーコード **3**（`UPDATE Message Error`）とサブコード（`Unrecognized Well-known Attribute`、`Invalid NEXT_HOP`、`Malformed AS_PATH` など）、および **Troubleshooting Hint** から原因を特定できます。

BGPShark は NOTIFICATION の data フィールドをデコードして生バイトの上に表示します。

- **エラーコード 3**：問題のパス属性の型とフラグをデコードします（たとえば未知の属性に誤って **Well-known** フラグが付いている場合など）。直前の UPDATE と見比べてください（未対応属性は `UNKNOWN(199) · Transitive · Unparsed` のように表示されます）。
- **その他のエラーコード**：`Bad Peer AS` の不一致 AS 番号、`Unsupported Capability` で拒否されたケイパビリティ、Cease に添付された RFC 9003 のシャットダウンメッセージ（メンテナンス予定やチケット番号が書かれていることがあります）もデコードされます。

### 「特定のプレフィックスが届かない」 {#a-prefix-is-missing}

**Routes** 画面で、目的に合わせた照合モードを使って検索します。

- **Exact** — 指定したプレフィックスそのものを探します。
- **Subnets** — 指定した CIDR より細かい経路が広告されていないか確認します（例：`10.0.0.0/8` で `10.0.12.0/24` を検索）。
- **Supernets** — 特定ホスト IP をカバーする集約経路を探します（例：`10.0.12.7`）。

該当する経路が一切見つからない場合、そのセッション上では一度も広告されていないため、対向の広告ポリシーを確認してください。アドレスファミリごと欠落している場合は **Neighbors** の **Capability Diff** を確認します。

複数の TCP セグメントに分割された UPDATE はパース前に自動再構成されるため、MTU が小さく分割された大規模 UPDATE でも正確なプレフィックス数が集計されます。

### 「ピアが複数経路を持っているのに 1 本しか届かない」 {#only-one-path-arrives-though-the-peer-has-several}

ルートリフレクタやピアは、**ADD-PATH**（RFC 7911）が適切にネゴシエートされない限り、各プレフィックスにつきベストパス 1 本しか広告しません。

**Neighbors → ルータを選択 → セッションを選択** を開き、Capability Diff の下にある **ADD-PATH Result** を確認してください。ADD-PATH は方向性を持つ（送信側が *send*、受信側が *receive* を広告して初めて成立する）ため、双方が *send* のみ設定している場合、上のケイパビリティ表では一致に見えても実際には Path Identifier が送信されません。**ADD-PATH Result** では方向・アドレスファミリごとの実際のネゴシエーション結果と不足している設定を確認できます。

ADD-PATH が有効な場合、パケット詳細のプレフィックスには `10.1.0.0/24 path 2` のように Path ID が表示され、経路履歴にも **Path ID** 列が追加されます。これにより「プレフィックス全体が消えた」のか「複数パスのうち 1 本だけが Withdraw された」のかを明確に区別できます。

### 「トラフィックが意図しない上流から出ていく」 {#traffic-leaves-by-the-wrong-upstream}

**Routes** で該当プレフィックスを選択すると、ピアごとの広告履歴がベストパス選択に関わる属性（AS_PATH、Next Hop、MED、LOCAL_PREF、コミュニティ）とともに並びます。

![172.20.0.0/16 の経路履歴。短い AS_PATH は MED 300・LOCAL_PREF なし、長い AS_PATH は MED 10・LOCAL_PREF 200 を持つ](manual/s4-bestpath.png)

上の例では、長い AS_PATH の経路が `LOCAL_PREF 200` を持つため優先されます（LOCAL_PREF は AS_PATH 長より先に評価され、短い経路の `MED 300` は比較対象になりません）。

- ハイフン（`-`）はその UPDATE に属性が含まれていなかったことを示し、値 `0` とは区別されます。
- 各属性列は選択した経路にその属性が存在する場合のみ表示され、`ORIGIN` は広告間で値が異なる場合のみ表示されます。

多数のプレフィックスを横断して確認したい場合は、**Messages** で `med` や `local_pref` の範囲フィルタが使えます。

```
med > 100
local_pref = 200
prefix = 172.20.0.0/16 and local_pref >= 200
```

MED や LOCAL_PREF を持たない UPDATE はこれらの条件にマッチしません。なお、キャプチャから確認できるのはワイヤ上の広告内容までであり、ルータが実際に RIB へ採用した経路はルータ側で確認してください。

### 「CPU 負荷が高く RIB が収束しない」 {#cpu-is-high-and-the-rib-will-not-settle}

経路チャーンが発生すると、**Dashboard** の **Alerts** パネルにプレフィックスごとのフラップ、AS_PATH の変化、Withdraw バーストがまとめて表示されます。

![経路フラップ、AS_PATH 変化、および「Burst of withdrawn prefixes — 60 prefixes withdrawn within 10s」を表示するアラートパネル](manual/s10-churn-alerts.png)

続いて **Routes** を開き、**Flap** 列を 2 回クリックして降順ソートし、最上位のプレフィックスを選択します。

![Flap 数でソートされた Routes 画面。announce と withdraw を交互に繰り返す履歴と、2 つのパスを示す AS_PATH Analysis パネル](manual/s10-churn-routes.png)

**From** 列と **AS_PATH Analysis** パネルから発生箇所を切り分けられます。

- 1 つのピアから announce と withdraw が規則的に繰り返されている場合、そのピアとのリンクや配下インターフェースが不安定です。
- 同じピアからの広告で複数の AS_PATH が交互に切り替わっている場合、さらに上流のネットワークでフラップが発生しています。

### 「ピアが本来広告すべきでない経路を広告している」 {#a-peer-is-announcing-routes-it-has-no-business-announcing}

経路リークは正常な BGP セッション上で起きるため、Dashboard には *「No issues detected」* と表示されます。

**Routes** の検索ボックスに `AS15169` のように AS 番号を入力すると、AS_PATH のどこかにその AS を含む全プレフィックスを絞り込めます。プレフィックスを選択して完全な AS_PATH を確認してください。

![AS15169 を含むプレフィックスで絞り込んだ Routes 画面。8.8.8.0/24 の AS_PATH が AS65100 → AS65001 → AS15169 になっている](manual/s5-route-leak.png)

たとえば顧客 `AS65100` とのセッション上で `AS65100 AS65001 AS15169` が観測される場合、他トランジットから学習した経路が顧客経由で再広告されています。**Messages** でも `asn = 15169` で同様に絞り込めます。

### 「ファブリック内のホストが断続的に通信不能になる」 {#a-host-in-the-fabric-drops-out-in-bursts}

EVPN の MAC ムーブは、一方のリーフからの Withdraw と別リーフからの広告の組として現れます。**Messages** で対象 MAC アドレスをフィルタしてください。

```
mac = 00:0c:29:aa:bb:cc
```

![特定 MAC で絞り込んだパケット一覧。10.0.0.2 の広告・Withdraw と 10.0.0.1 の広告が並び、Withdraw された経路の RD と VNI がデコードされている](manual/s13-mac-move.png)

`mac`、`vni`、`rd`、`evpn_type` は広告と取り消しの両方にマッチし、詳細ビューで RD・MAC・VNI・ESI がデコードされます。複数の VTEP が短時間に同じ MAC を交互に広告している場合、デュアルホーム設定ミスやブリッジループによる MAC ムーブループが疑われます。

**Routes** 画面でも MAC ごとの履歴を追跡でき、Dashboard ではムーブそのものが *「MAC moved」*（移動元と移動先の VTEP を表示）として、*「Route flapping」* と併せて通知されます。MAC Mobility 拡張コミュニティも詳細ビューでデコードされます（シーケンス番号の自動比較は行いません）。

### 「リロードやソフトクリア後の挙動を確認したい」 {#after-a-reload-or-after-a-soft-clear}

リロードやソフトクリアは大量の BGP パケットを発生させるため、障害と見分けにくくなりがちです。

**Graceful Restart** が行われた場合、**Dashboard** には *「Session flapping detected」* ではなく *「10.0.0.1 restarted gracefully」* と表示されます。アラートには要求された **Restart Time**、**forwarding state（転送状態）の保持有無**、再確立から **End-of-RIB** までの実測収束時間がまとめられます。

![Alerts パネルの warning アラート「10.0.0.1 restarted gracefully, peer 10.0.0.2」。要求された 120s に対し 3.8s で収束し、転送状態を保持したことを表示](manual/s8-graceful-restart.png)

Restart Time 以内に収束し転送状態も保持されていれば warning 表示にとどまりますが、Restart Time を超過した場合や転送状態が保持されなかった場合は **critical** に昇格します。一方、Graceful Restart を使わないクラッシュループは *「Session flapping detected」* と切断アラートとして表示されます。

詳細を確認したい場合は **Capability Diff** で Graceful Restart の各フラグを確認でき、**Messages** では空の UPDATE が `End-of-RIB` とラベル表示されます。

**ソフトクリア（ROUTE-REFRESH）** は ROUTE-REFRESH メッセージと後続の再広告として記録されます。**Messages** で ROUTE-REFRESH を選択すると **What the refresh changed** パネルが開き、再広告によって **追加された経路**、**広告されなくなった経路**、**属性が変化した経路** の差分が表示されます（変化のない経路は件数のみ表示）。一覧の各経路をクリックすると該当の UPDATE を開けます。

![ROUTE-REFRESH の詳細と「What the refresh changed」パネル。10.0.0.1 が IPv4 Unicast を再広告し、1 経路は変化なし、10.1.1.0/24 がコミュニティ 65001:999 付きで追加されたことを表示](manual/s9-refresh-diff.png)

ソフトクリア後、ピアは現在の経路テーブル全体を再送し、消えた経路について明示的な Withdraw は送りません。そのため、ソフトクリアで失われた経路は Withdraw ではなく **no longer advertised** の一覧で確認します。

キャプチャ範囲に関する次の 2 点は、該当する場合にパネル内へ注記されます。

- セッション途中から取得したキャプチャでは、refresh 前の状態として観測できた経路のみが比較対象になります。
- キャプチャ終了までに End-of-RIB が届いていない場合、未再送の経路も「広告されなくなった」として一覧に含まれます。

複数の ROUTE-REFRESH が含まれるキャプチャでは、それぞれのメッセージを選択することで個別の区間を比較できます。

### キャプチャが不完全な可能性を確認する {#the-capture-may-be-lying-to-you}

片方向のパケットしか含まれないキャプチャでは、Dashboard に *「Only one direction of this session is in the capture」* と警告され、ネイバー一覧表に `⚠ Never up` と表示されます。ただし、SPAN やキャプチャフィルタの不備と実際の片方向通信障害は BGP 層では見分けがつかないため、まずどちらかを切り分けてください。

**Messages** を **All Packets** に切り替え、**Source** 列と TCP フラグを確認します。

![5 フレームすべてが 10.0.0.1 発で、SYN と ACK はあるが SYN-ACK が欠けているパケット一覧](manual/s12-one-direction.png)

`[S]`（SYN）の次に `[SA]`（SYN-ACK）なしで `[A]`（ACK）が記録されている場合、ホスト自体は対向からの応答を受信しています（そうでなければ ACK を返しません）。したがって、これはネットワーク障害ではなくキャプチャ側で復路を取りこぼしています。

大きなキャプチャでは、**SQL** で送信方向ごとの件数を確認すると素早く判別できます。

```sql
select src_ip, dst_ip, count(*) as frames
from packets group by all order by frames desc
```

双方向が正常に記録されていれば、1 セッションにつき同規模の 2 行が出力されます。1 行のみの場合は片方向の BGP パケットしか含まれていません（`packets` テーブルは BGP パケットのみを格納するため、TCP ハンドシェイクの確認には上の **All Packets** を使用してください）。

## フィルタ {#filters}

フィルタバーには同じ構文を扱う 2 つのモードがあります。**Simple** ではドロップダウンから条件を組み立てられ、**Advanced** では補完付きで直接フィルタ式を入力できます。

```
type = NOTIFICATION and src_ip = 10.0.0.1
asn = 65001
prefix = 10.0.0.0/8 and not (type = KEEPALIVE)
capability contains "Route Refresh"
```

複数の条件は `and`、`or`、`not` と括弧で組み合わせられます。演算子は `=`、`!=`、`contains`、`not contains` に加え、数値フィールドでは `<`、`<=`、`>`、`>=` が利用できます。

### フィールド一覧 {#fields}

| フィールド | 照合対象 |
|------------|----------|
| `type` | `OPEN`、`UPDATE`、`NOTIFICATION`、`KEEPALIVE`、`ROUTE_REFRESH` |
| `src_ip` / `dst_ip` | 送信元 / 宛先 IP アドレス（CIDR 指定で範囲内の全アドレスに一致） |
| `src_port` / `dst_port` | TCP ポート番号（同一 IP ペア間の複数セッションを切り分ける用途） |
| `frame` | フレーム番号（例：`frame >= 100 and frame < 200`） |
| `router_id` | OPEN メッセージの BGP Identifier |
| `src_as` | OPEN メッセージで広告された AS 番号 |
| `asn` | AS_PATH のどこかに含まれる AS 番号 |
| `origin` | `IGP`、`EGP`、`INCOMPLETE` |
| `next_hop` | NEXT_HOP または MP_REACH のネクストホップ |
| `med` | MULTI_EXIT_DISC（範囲比較可。MED を持たない UPDATE には不一致） |
| `local_pref` | LOCAL_PREF（範囲比較可。iBGP のみ。属性がない UPDATE には不一致） |
| `prefix` | 広告または取り消し（Withdraw）されたプレフィックス |
| `withdrawn` | 取り消し（Withdraw）されたプレフィックスのみ |
| `community` | Standard / Large Community |
| `rt` | Route Target（例：`rt = 65001:100`） |
| `ext_community` | 表示形式による Extended Community 全般 |
| `mac` / `vni` / `rd` / `evpn_type` | EVPN 経路の各属性 |
| `capability` | OPEN メッセージのケイパビリティ名 |

以下のエイリアスも利用できます：`src`、`dst`、`as`、`aspath`、`nexthop`、`nlri`、`router-id`、`my_as`、`large-community`、`route-target`、`ext-community`、`evpn-type`。

### プレフィックスと IP アドレスの照合ルール {#how-prefixes-match}

IP アドレスとプレフィックスは文字列ではなく数値としてビット単位で比較されます。たとえば `src_ip = 192.168.0.0/23` は `192.168.0.0` 〜 `192.168.1.255` に正確に一致します。

`prefix` と `withdrawn` では、入力形式によって照合方向が変わります。

- `prefix = 10.0.0.0/8` — 指定 CIDR の **内側** にある経路（`10.0.12.0/24` が一致）
- `prefix = 10.0.12.7` — 指定ホストアドレスを **包含する** 経路
- `prefix contains "10.0.1"` — 部分文字列一致

**Routes** 画面の検索も同じロジックで動作します。

### フィルタが効いていないように見えるとき {#when-a-filter-does-not-seem-to-work}

フィルタ式に構文エラーや未知のフィールド名があると、**Showing N of M packets** カウンタの横に赤いエラーメッセージが表示され、一覧は絞り込まれずに全件表示されたままになります。赤いメッセージが出ている状態で「Showing 5 of 5」と表示されていても、全件一致ではなくフィルタ未適用を意味します。上の表でフィールド名を確認してください。

## BGPShark では判断できないこと {#what-bgpshark-will-not-tell-you}

アラートが出ていないことをそのまま「問題なし」と誤認しないよう、以下の限界を念頭に置いてください。

- **キャプチャ不備と片方向障害の区別**：片方向しか記録されていないことは検知しますが、キャプチャ側の問題かネットワーク障害かは TCP ハンドシェイクから判断する必要があります（[確認手順](#the-capture-may-be-lying-to-you)）。
- **ルーティングポリシーの妥当性**：期待される AS_PATH や広告ポリシーの情報は持たないため、経路リークは正当な広告と区別されません。
- **ルータ内部の RIB 決定**：キャプチャに記録されるのはワイヤ上を流れたパケットのみです。最終的にどの経路が選択・インストールされたかはルータ上で確認してください。
