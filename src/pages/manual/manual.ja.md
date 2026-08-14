# BGPShark ユーザーマニュアル

BGPShark はパケットキャプチャを読み、その中の BGP セッションが何をしていたかを
教えます。セッションが落ちた、経路が来ない、ピアから苦情が来た — そういう場面で、
手元に `.pcap` と疑問がある、というときのための道具です。

すべてブラウザの中で完結します。キャプチャがアップロードされることはなく、アプリは
どこにもリクエストを送らず、ネットワークを抜いた状態でも動きます。

## キャプチャを読み込む {#loading-a-capture}

ウィンドウのどこにでもファイルをドロップするか、開始画面のピッカーを使ってください。
`.pcap` と `.pcapng` はどちらも受け付け、自動で判別します。どちらなのかを申告する
必要はありません。上限は 50 MB です。

手元に何もなければ **Load sample** で試せるキャプチャが手に入ります。**Build** 画面
なら、記述したとおりのキャプチャを書き出せます。

読み込んだキャプチャはリロードしても残ります — サーバーではなくブラウザのストレージに
保持されるためです。**New File** で消えます。

### キャプチャがおかしく見えるとき {#if-the-capture-looks-wrong}

ヘッダー下の黄色いバナーは、パーサーがファイルの一部を扱いかねたという意味です。
クリックすると内容が出ます。たいていは切り詰められたキャプチャか壊れたブロックで、
残りの部分は解析されています — 警告は失敗ではありません。

見えているものを信用する前に、知っておく価値のあることが2つあります。

- **片方向しかないキャプチャは検知されますが、原因の判断はあなたの仕事です。**
  ダッシュボードが critical のアラートとして出します。ただし *なぜ* かは言えません。
  ミラーや `tcpdump` のフィルタが片側しか捕まえなかったのか、それともピアのパケットが
  本当に届いていないのか — 片方向リンク、片方向にだけ適用された ACL。後者は
  キャプチャの問題ではなく障害なので、取り直す前に確かめてください。
  [キャプチャがあなたに嘘をついているかもしれない](#the-capture-may-be-lying-to-you)
  に、1分で見分ける方法が2つあります。
- **TCP レベルのフレームは既定で隠れています。** パケット一覧は **All Packets** に
  切り替えるまで BGP しか表示しません。ファイアウォールに殺されたセッションは、そこに
  `[R]` フレームとして現れ、他のどこにも現れません。

## 画面 {#the-screens}

画面ごとに答える問いが違います。どこから始めればよいか分からなければ、ダッシュボードから。
あるいは[症状から調べる](#investigating-by-symptom)へ飛んでください。実際の苦情を
十数件とりあげ、それぞれを答えまで歩きます。

| 画面 | 答える問い |
|--------|-------------------------|
| **Dashboard** | このキャプチャの何がおかしいのか |
| **Messages** | 実際に何が送られたのか、バイト単位で |
| **Neighbors** | この2台のルータは何で合意したのか |
| **Routes** | この prefix に何が起きたのか |
| **SQL** | 他の画面が訊かないこと全般 |
| **Build** | *これ* を示すキャプチャが必要だ |

### Dashboard {#dashboard}

メッセージ数、タイムライン、ネイバー表、そして最初に読むべき **Alerts** パネル。
アラートは重大なものが先に並び、パケット単位ではなく *問題* 単位で1行です。拒否された
OPEN を40回リトライしたピアは「40」と書かれた1行であって、40行ではありません。

アラートが扱うのは、NOTIFICATION、フラップしたセッション、withdraw のバースト、
フラップした経路、AS_PATH が変わった経路、そして問題が *欠けていること* である2つの
ケース — キャプチャに片方向しかないセッションと、TCP は接続できたのに BGP が一切
返ってこない接続です。**View →** で、話の始まる位置のパケットへ、フィルタが適用された
状態で飛べます。

"No issues detected" は、キャプチャ内のすべてのセッションが確立し、そのまま維持された、
という意味です。何も問題がないという意味ではありません — 例えば経路リークはこれには
見えません。それを運んでいるセッション自体は何も不健全ではないからです。

### Messages {#messages}

パケット一覧、詳細ビュー、16進ダンプ。パケットをクリックすると展開され、パーサーが
理解したフィールドが個々の capability や path attribute まで並び、その下に生バイトが
付きます。

**Info** 列は各メッセージを要約します — OPEN なら `AS65001 Hold=90`、UPDATE なら
announce と withdraw の数、NOTIFICATION ならエラー名。中身のない UPDATE は空に
見えるまま放置せず **End-of-RIB** と表示します。

**Columns** ボタンでタイムスタンプやポートの列を足せます。**Export** は、いまフィルタが
表示しているものを新しい pcap として保存します — チケットにキャプチャ全体ではなく
関係する20パケットだけを添付したいときに便利です。

### Neighbors {#neighbors}

Router ID でグループ化されたセッション。ルータをクリックし、そのセッションの1つを
クリックすると **Capability Diff** — 2つの OPEN メッセージが並びます。

「セッションは上がっているのに経路が来ない」への最短の答えがこれです。capability は
アドレスファミリごとに比較されるので、「両方 Multiprotocol 対応」が片側 IPv4・片側
IPv6 という食い違いを隠すことはありません。不一致が一致より先に並びます。見に来たのは
そちらだからです。

両側で Hold Time が違うのは正常なので — 小さい方だけが使われます — 障害ではなく
情報として表示されます。両側が同じ Router ID なのはエラーとして出します。実際にエラー
だからです。

### Routes {#routes}

キャプチャ内のすべての prefix と、announce された回数、withdraw された回数、最後に
見えた時刻、そして **flap** カウント。flap でソートすると不安定なものが見つかります。
prefix をクリックすると、その全履歴と、一緒に観測された AS_PATH が出ます。

検索ボックスは3通りにマッチします。ここが引っかかりやすい点です。

- **Exact** — その prefix だけ
- **Subnets** — 入力した範囲の *内側* すべて。`10.0.0.0/8` は `10.0.12.0/24` を見つけます
- **Supernets** — 入力を *含む* ものすべて。`10.0.12.7` は、それを運んでいる
  `10.0.0.0/8` を見つけます

### SQL {#sql}

キャプチャを、クエリできるテーブルの集合として扱います。組み込みの画面が訊かない問い —
多数の prefix をまたぐ比較や、集計が要るもの — のときに使ってください。

スキーマはサイドバーにあり、**Query Templates** は自分で書く場合でも一度読む価値が
あります。

時間を節約できることが3つ。

- `nlri.prefix` にマスクは入っていません。`prefix || '/' || prefix_length` を使ってください。
- `nlri`、`as_path`、`path_attributes` はいずれも `message_id` で join するので、
  3つを一度に join すると行が掛け算になります。相関サブクエリを使ってください。
- 結果はフレーム単位で正確ですが、テーブルはパース済みメッセージ全体ではなく平坦化した
  射影です。完全な詳細が要るときは `frame_index` を辿って Messages に戻ってください。

同じ prefix の2つの経路を比較する:

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

セッションを記述すると BGPShark が pcap を書きます。キャプチャを読み込んでいる必要は
ありません — キャプチャを探している状況では、まさにそれが無いのですから。

プリセットから始めてください — 正常な確立、hold timer の満了、AS 不一致、TCP 接続の
拒否、IPv6 トランスポート、フラップする経路、4バイト AS 番号、TCP セグメントをまたぐ
UPDATE — そのうえでアドレス、AS 番号、prefix を目の前のケースに合わせて変えます。

2つだけ、指定するのではなくシナリオから決まるものがあります。それを取り違えたキャプチャは
実在のセッションには作れないからです: UPDATE のエンコード方法（OPEN の capability から
決まります）と、TCP セグメント境界の位置（MTU から決まります）。したがって、メッセージが
セグメントをまたぐキャプチャを作りたければ MTU を下げます。

出力は本物のキャプチャです — チェックサムも正しく計算されます — ので、このアプリに戻す
だけでなく他のツールにも食わせられます。

## 症状から調べる {#investigating-by-symptom}

ここまでは画面の説明でした。ここからは *ケース* の説明です — 届く形での苦情、それに
答えるクリック経路、そして辿り着いた先で何を見ているべきかの絵。

以下のスクリーンショットはすべて BGPShark 自身が作ったキャプチャなので、どの手順も
再現できます: **Build** 画面がこの種のキャプチャを書きますし、元になったシナリオは
リポジトリの `testlab/scenarios.ts` にあります。ここの絵があなたの画面と違うなら、
違うのはバージョンではなくキャプチャです。

### まずここから {#start-here}

苦情が何であれ、最初の30秒は同じです。

1. **Dashboard。** カウンタを読み、次に **Alerts** パネルを読みます。アラートは重大な
   ものが先で、問題ごとに1行にまとめられています。
2. 何かを信用する前に **キャプチャが完全かを確認** してください — この節の最後の
   [キャプチャがあなたに嘘をついているかもしれない](#the-capture-may-be-lying-to-you)
   を参照。
3. アラートの **View →** を辿ります。話の始まるパケットに、フィルタが適用された状態で
   着地します。

![フラップしているセッションのキャプチャのダッシュボード。カウンタ、2件のアラート、ネイバー表、タイムライン](manual/dashboard.png)

"No issues detected — every session looks healthy" は、キャプチャ内のすべての
セッションが確立し維持されたという意味です。何も問題がないという意味では **ありません**。
経路リークもベストパスの意外も、どちらもこのメッセージを出します。それを運んでいる
セッション自体は何も不健全ではないからです。

### 「セッションが上がらない」 {#the-session-will-not-come-up}

ネイバーが Idle か Connect のままで、BGP が一切やりとりされない。キャプチャから知りたい
のは、ポート 179 への SYN に何が返っているか — SYN-ACK か、RST か、何も無いか。

**Dashboard** へ行ってください。キャプチャに BGP が一切含まれないとき、アラートは
代わりに TCP 層から計算されます。

![critical アラート "TCP connections to port 179 are being refused — 3 SYNs answered by RST"](manual/s1-tcp-refused.png)

- **SYN に RST が返る** — 何かが接続を拒否しています。ACL やファイアウォール、
  TCP-MD5/TCP-AO の不一致、あるいは単にピアで BGP が動いていない。
- **SYN に何も返らない** — パケットが届いていないか、返信が返ってきていません。BGP より
  下のルーティングかフィルタの問題です。
- **SYN-ACK の後、何も無い** — TCP は上がり、OPEN が続かなかった。ダッシュボードが
  そのまま言います: *"TCP connects but 10.0.0.2 sends no BGP"*。ここはハンドシェイクの
  成功が **何を否定したか** として読んでください — ポートは開いており、ACL は SYN を
  落としておらず、MD5 も一致しています。片側だけの MD5 はハンドシェイクを生き延びるのでは
  なく失敗させるからです。残るのは、ピアの BGP があなたのアドレスと話す気がないか、
  ハンドシェイクは通す経路がペイロードを通さないか: 接続を終端する TCP ミドルボックス、
  小さいセグメントは通し大きいものを落とす PMTU ブラックホール、control-plane policing。

パケット一覧を **All Packets** に切り替えるとリトライ回数と間隔が読めます。BGP Only の
ままでは何も見えません。ファイルの中に BGP が無いからです。

### 「Established なのに、あるアドレスファミリだけ来ない」 {#it-is-established-but-a-whole-address-family-never-arrives}

セッションは上がっていて、IPv4 の経路は問題なく、IPv6 の経路が1つも現れない — あるいは
EVPN が、あるいは VPNv4 が。これは capability の問題で、答えは1画面先にあります。

**Neighbors → ルータをクリック → そのセッションの1つをクリック。** Capability Diff は
*セッション* を選んで初めて出ます。ルータの行には出ません。

![Capability Diff。セッション項目は一致し、片側だけが広告している capability が4つ。IPv6/Unicast の Multiprotocol Extensions を含む](manual/s2-capability-diff.png)

capability はアドレスファミリごとに比較されるので、「両方 Multiprotocol 対応」が片側
IPv4・片側 IPv6 を隠すことはありません。不一致が一致より先に並びます。見に来たのは
そちらだからです。**Status** 列を読んでください。

- **⚠ Only *x*** — 片側が広告し、もう片側がしなかった。そのファミリの経路には行き場が
  ありません。これが答えです。
- My AS の **Differs — normal for eBGP** と、Hold Time の相違はどちらも想定内です。
  小さい方の hold time だけが使われます。
- **両側が同じ BGP Identifier** はエラーとして出します。実際にエラーだからです。

### 「数分おきにフラップする」 {#it-flaps-every-few-minutes}

ダッシュボードが繰り返しをまとめます: NOTIFICATION 群で1行（回数付き）、再確立で1行。

![アラート "NOTIFICATION: Hold Timer Expired / Unspecific ×3" と "Session flapping detected — 6 OPEN messages (~3 establishments)"](manual/s3-holdtimer-alerts.png)

`Hold Timer Expired` は、片側がもう片側から何も聞こえなくなったという意味です。これは
BGP についてではなく到達性についての主張であり、それを決める数字は、切断の *前* に
ピアからの最後のメッセージがいつ届いたか、です。

**Messages → NOTIFICATION をクリック。** 詳細が **Silence before the teardown** として
測ってくれます。

![NOTIFICATION の詳細。10.0.0.1 からの最後の KEEPALIVE から 90.4 秒、ネゴシエートされた hold time 90 秒に対して](manual/s3-holdtimer-gap.png)

hold time をまるごと使い切った沈黙 — hold time 90 に対して 90.4 秒 — は、セッションが
他の点では健全なまま、KEEPALIVE が片方向で届かなくなったという意味です。ルータではなく
ルータ間の経路を見てください。hold time より大幅に *短い* 沈黙はそれとして表示されます。
キャプチャが実際に届いたパケットを取りこぼしているか、実際に有効だった hold time が
これらの OPEN で合意されたものではなかったか、どちらかです。

パネルが慎重に扱っていることが2つあります。手で測るなら、あなたも同じように扱うべきです。

- **ピアの** 最後のメッセージから数えます。一覧の1つ前のパケットからではありません。
  健全なセッションでは両端が喋っているので、1つ前のパケットはたいてい苦情を言っている
  側自身の KEEPALIVE です — 別の数字であり、タイマーが数えていたものではありません。
  この例ではその間違いをすると 90.2 秒になります。
- 比較対象の hold time は **2つの OPEN の小さい方** で、*この* 切断に先行する OPEN から
  取ります。フラップしているキャプチャでは、その後に上がり直したセッションが別の値を
  ネゴシエートしているかもしれません。

キャプチャがセッション途中から始まっていて OPEN が無い場合でも沈黙は測ります。パネルは
hold time は不明だと言い、比較はあなたに委ねます。

### 「落ちたのに、理由がどこにも書かれていない」 {#it-dropped-and-nothing-says-why}

キャプチャのどこにも NOTIFICATION が無く、1分後にセッションが戻ってくる。証拠は TCP 層に
あり、パケット一覧は既定でそれを隠します — なので **Dashboard** から始めてください。
そこが名指しして、連れて行ってくれます。

critical が2行、切断ごとに1つ: *"10.0.0.1 ↔ 10.0.0.2 was reset with no NOTIFICATION"*
と *"…was closed with no NOTIFICATION"*。どちらの `View →` も一覧を **All Packets** に
切り替え、話題にしているフレームを選択します。そこが要点です — リセットがあると言っておいて
自分で探しに行かせるのでは、答えの半分にしかなりません。

![Alerts パネル。critical が2行 — "10.0.0.1 ↔ 10.0.0.2 was reset with no NOTIFICATION" と "was closed with no NOTIFICATION" — その下に "Session flapping detected" の warning](manual/s11-teardown-alerts.png)

これらは *"Session flapping detected"* の warning を置き換えるのではなく、隣に並びます。
あちらはセッションが何度 *上がった* かを数え、こちらはどう *落ちた* かを言います。2行に
分かれているのも意図的です。RST は接続を能動的に拒否している何か — ファイアウォール、
ソケットを使い果たしたスタック。FIN はセッションが終わったと判断して行儀よく閉じている何かで、
アイドルタイムアウトはこう見えます。次に確認すべきものが違います。

手で辿るなら **Messages → All Packets**。切り替える前から兆候は見えています: BGP Only での
フレーム番号が飛んでいる — 10 の次が 15 — その欠けたフレームがセッションを終わらせたものです。

![All Packets モードのパケット一覧、フレーム 11 を選択。10.0.0.2 からの [AR] フレームと、"TCP Flags: ACK, RST" と表示された詳細ペイン](manual/s11-tcp-reset.png)

`[AR]` は ACK+RST — セッションがリセットされたということで、この例では最後の KEEPALIVE
から26秒後に対向側が送り、60秒後に新しい SYN が来ています。FIN を表す `[F]` は同じ話の
行儀のよい版です。何かが意図的に接続を閉じ、BGP は理由を言う機会を与えられなかった。

1つだけまだ欠けています: TCP フラグ用のフィルタフィールドが無いので、一覧をリセットだけに
絞ることはできません。**All Packets** とあなたの目が、その部分を担当します。

一度も確立しなかったセッションはここには出ません。その接続も RST で終わってはいますが、
その場合は何も切断されていませんし、*"TCP connects but the peer sends no BGP"* が既に
有用なことを言っています。

### 「経路を広告した瞬間にセッションが落ちる」 {#the-session-drops-the-moment-routes-are-advertised}

確立は綺麗に済み、最初の UPDATE が出て、対向がセッションを落とす。NOTIFICATION が、
何に異議を唱えたかを名指しします。

**Messages → NOTIFICATION をクリック。**

![NOTIFICATION の詳細: エラーコード 3 UPDATE Message Error、サブコード 2 Unrecognized Well-known Attribute、トラブルシューティングのヒント、data フィールドが UNKNOWN(199) として Well-known・Transitive 付きでデコードされ、その下に生バイト](manual/s6-notification.png)

エラーコード **3** はピアが拒否した UPDATE で、サブコードが理由を言います —
`Unrecognized Well-known Attribute`、`Invalid NEXT_HOP`、`Malformed AS_PATH`。
どのコードにも下に Troubleshooting Hint が付きます。

次にその直前の UPDATE を読んでください。文句を言われているのはそれです。パーサーが識別
できなかった属性は `UNKNOWN(199) · Transitive · Unparsed` としてバイト付きで表示されます。
対向が実装していない機能を見分けるには、たいていそれで足ります。

NOTIFICATION 自身の data フィールドはバイトのまま放置せずデコードします。エラーコード 3 では
それが *まさに* 問題の属性そのもので、そのまま送り返されてきます — 型とフラグ付きで表示するのは、
フラグ自体が原因であることが多いからです。誰も認識できないのに **Well-known** と印の付いた
属性こそ、サブコード 2 が言っていることです。読みを確認できるよう、生バイトは下に残ります。

他のコードもそれぞれのフィールドをデコードします: `Bad Peer AS` で一致しなかった AS 番号、
`Unsupported Capability` の背後にある capability、そして — 知っておく価値があります —
管理上のシャットダウンやリセットにピアが添えられる文章 (RFC 9003)。これは BGP において
対向が *理由* を言葉で伝えられる唯一の場所で、たいていはメンテナンス時間帯かチケット番号です。

### 「prefix が来ていない」 {#a-prefix-is-missing}

**Routes** 画面で検索し、マッチモードに仕事をさせてください。

- **Exact** — その prefix だけ。
- **Subnets** — 入力の内側すべて。`10.0.0.0/8` は `10.0.12.0/24` を見つけます。ピアが
  より細かい経路を送っているかもしれないときに。
- **Supernets** — 入力を含むものすべて。`10.0.12.7` は、それを運んでいる集約経路を
  見つけます。あるホストに到達できず、それを覆っているはずの経路を知りたいときに。

そもそも prefix が無ければ、このセッションでは一度も広告されていないので、問いはピアの
ポリシーへ移ります。あるけれどファミリが違う — IPv4 しかネゴシエートしていないセッション上の
IPv6 prefix — なら、次は上記の Capability Diff です。

UPDATE が TCP セグメントに分割されているキャプチャでも、あなたが何かする必要はありません。
セグメントはパース前に再構成され、576バイト MTU での 400 prefix の UPDATE も、ここでは
400 prefix と数えられます。

### 「トラフィックが違う上流から出ていく」 {#traffic-leaves-by-the-wrong-upstream}

**Routes → その prefix。** 経路履歴が、その prefix のすべての広告をピアごとに1行ずつ、
判断の根拠になった属性とともに並べます: AS_PATH、Next Hop、MED、LOCAL_PREF、community。

![172.20.0.0/16 の経路履歴。2つの広告が並び、短い AS_PATH は MED 300 で LOCAL_PREF 無し、長い方は MED 10 と LOCAL_PREF 200](manual/s4-bestpath.png)

2行を横に読めば答えがそこにあります: **長い** AS_PATH が勝っています。LOCAL_PREF 200 を
持っており、LOCAL_PREF は経路長よりずっと先に比較されるからです。短い経路の MED 300 は
発言権を得ません — MED の比較はずっと後で、しかも同じ隣接 AS から来た経路同士でしか
行われません。

ダッシュは、その UPDATE にその属性が無かったという意味で、値が 0 なのとは違います。
`192.0.2.1` は LOCAL_PREF を一切送っていません。もし 0 を送っていたなら、それは意図的に
魅力を下げた経路であり、列には `0` と出ます。

列は、選択した経路がその属性を持つときだけ現れます。LOCAL_PREF がどこにも無いキャプチャで
ダッシュだけの列が出ることはありません。ORIGIN は逆向きの例外で、広告どうしで *異なる*
ときだけ現れます。ほぼすべてで IGP であり、同じ値が並ぶ列は他の列に必要な幅を食うからです。

多数の prefix にまたがって同じことを訊くなら、`med` と `local_pref` はフィルタフィールドに
なっており、範囲も取れます。

```
med > 100
local_pref = 200
prefix = 172.20.0.0/16 and local_pref >= 200
```

MED を持たない UPDATE は `med` の比較に一切マッチしません — ここでも「無い」は 0 では
ありません。そうでなければ `med < 100` が eBGP キャプチャのほとんどを拾ってしまいます。

キャプチャが決着をつけられることとつけられないことを忘れずに。キャプチャが持っているのは
ワイヤを流れたものであって、ルータがそれをどうしたかではありません。どの経路が採用されたかは
ルータ側にあります。

### 「CPU が高く、RIB が落ち着かない」 {#cpu-is-high-and-the-rib-will-not-settle}

ダッシュボードが最も完全に答えるのがこのケースです。churn はフラップした prefix ごとの行、
AS_PATH 変化ごとの行、そして withdraw バーストの行を生みます。

![経路フラップと AS_PATH 変化の行が並び、最後が "Burst of withdrawn prefixes — 60 prefixes withdrawn within 10s" のアラートパネル](manual/s10-churn-alerts.png)

次に **Routes** へ行き **Flap** でソートします — 列を1回クリックで昇順、2回で悪い順 —
最悪の prefix をクリックして履歴を見ます。

![flap 数でソートされた Routes 画面。ある prefix の announce と withdraw が交互に並ぶ履歴と、2つの異なる経路を示す AS_PATH Analysis パネル](manual/s10-churn-routes.png)

履歴が診断そのもので、**From** 列がその半分です。1つのピアから一定間隔で announce と
withdraw が繰り返されるなら、不安定なリンクか、その背後でフラップしているインターフェース
です。同じピアからの広告が2つの AS_PATH の間で交互になるなら — **AS_PATH Analysis**
パネルが種類を数えます — 不安定性はもっと上流にあります。隣接ルータがフラップしているのでは
なく、フラップしている何かについて教えてくれているのです。

### 「あるピアが、広告する筋合いのない経路を広告している」 {#a-peer-is-announcing-routes-it-has-no-business-announcing}

セッション層では何も問題がないので、ダッシュボードは "No issues detected" と言い、それは
本当です。リークは、探している人だけが見つけられます。

**Routes** の検索ボックスは prefix だけでなく AS 番号も取ります。`AS15169` と入力すると、
AS_PATH のどこかにその AS を含む prefix がすべて並びます。1つクリックしてください。

![AS15169 を経路に含む prefix に絞られた Routes 画面。8.8.8.0/24 が選択され、AS_PATH は AS65100 → AS65001 → AS15169](manual/s5-route-leak.png)

他人の AS を経由する経路を運んでいる顧客セッションが典型的な形です: 顧客 AS65100 との
セッション上に `AS65100 AS65001 AS15169` があるなら、彼らは別のトランジットから学んだ
ものを再広告しています。フィルタ `asn = 15169` でも同じようにパケット一覧を絞れます。

ここには「期待される経路の形」という概念が無いので、これを検知して知らせてくれるものは
ありません。このツールが与えるのは、キャプチャ内のすべての経路を素早く見る手段です。

### 「ファブリック内のホストが断続的に落ちる」 {#a-host-in-the-fabric-drops-out-in-bursts}

EVPN の MAC ムーブは、あるリーフからの withdraw と別のリーフからの advertise なので、
両方を一緒に見る必要があります。MAC でフィルタしてください。

```
mac = 00:0c:29:aa:bb:cc
```

![1つの MAC に絞られたパケット一覧: 10.0.0.2 からの announce、10.0.0.2 からの withdraw、10.0.0.1 からの announce。withdraw された経路は RD と VNI にデコードされている](manual/s13-mac-move.png)

`mac`、`vni`、`rd`、`evpn_type` はいずれも announce と withdraw の両方にマッチし、
パケット詳細は経路を RD、MAC、VNI、ESI にデコードします。2つの VTEP が同じ MAC を短時間で
繰り返し広告するならムーブループで、たいていは BGP の問題ではなくデュアルホームのホストか
ブリッジループです。

Routes は MAC を独自の履歴を持つ経路として並べ、ダッシュボードはムーブを
*"Route flapping: [2] 00:0c:29:aa:bb:cc VNI 10100"* として報告します。ムーブをフラップと
読むのは言葉の不一致であって、間違った答えではありません。MAC Mobility のシーケンス番号は
メッセージ詳細でデコードされますが、比較まではしません。

### 「リロード後、あるいは soft clear 後」 {#after-a-reload-or-after-a-soft-clear}

どちらも、実際より悪く見えるキャプチャを残します。

**Graceful restart** はそれとして名指しされます。ダッシュボードは
*"Session flapping detected"* ではなく *"10.0.0.1 restarted gracefully"* と報告し、
この問いに必要な3つを伴います: そのスピーカーが要求した **Restart Time**、
**forwarding state を保持した** と広告したかどうか、そして収束に実際どれだけかかったか —
セッションが戻ってから、経路が戻ったことを示す **End-of-RIB** までで測った値です。

![Alerts パネルの warning 1行 "10.0.0.1 restarted gracefully, peer 10.0.0.2"。要求した 120s に対して 3.8s で経路が戻り、forwarding state を保持したと説明している](manual/s8-graceful-restart.png)

最後の数字が読む価値のあるものです。それが再起動の実際のコストであり、Restart Time を
超えているならピアは既に経路を保持するのをやめて withdraw しています — なのでその行は
critical になります。forwarding state が保持され *なかった* 場合も critical になります。
その場合はデータプレーンがその間ずっとトラフィックを落としていたということで、graceful
restart が避けるためにある事態そのものだからです。

クラッシュループにはそれがありません。capability が無いので何も合意されておらず、
*"Session flapping detected"* と切断の行として出続けます。2つの画面の違いが答えです。

読みを確認したければ材料は残っています: フラグ付きの capability は **Capability Diff** に
あり、中身のない UPDATE はパケット一覧で空に見えるまま放置せず `End-of-RIB` と表示されます。

**Soft clear** は ROUTE-REFRESH とそれに続く再広告として現れます。refresh を選ぶと詳細
パネルが差分を取ってくれます: 再広告が **追加した** もの、**広告されなくなった** もの、
**属性が変わって** 戻ってきたもの。同じ内容で戻ってきた経路は列挙せず数えます。そこに
挙がった経路をクリックすると、それを運んだ UPDATE が開きます。

![ROUTE-REFRESH の詳細と "What the refresh changed" パネル: 10.0.0.1 が IPv4 Unicast を再広告し、1経路は変化なし、10.1.1.0/24 が community 65001:999 付きで追加された](manual/s9-refresh-diff.png)

「広告されなくなった」の一覧が、理解しておく価値のあるものです。refresh の後、ピアは表を
まるごと送り直すので、もう持っていない経路は答えから単に **抜けている** だけです — 何も
withdraw しません。経路を失った soft clear の後に withdraw を探しても何も見つからない、
というのがこの一覧の存在理由です。

推測せずに言ってくれることが2つあります。キャプチャがセッション確立後に始まっている場合、
「前」の側は捕まえられた分だけなので、消えたと表示されたものが記録開始前に広告されていた
可能性があります。再広告を End-of-RIB が閉じていない場合、キャプチャの終わりまでに再送
されなかったものは、届く途中だったかどうかに関わらず消えたと表示されます。

refresh が複数あるキャプチャでは、それぞれ別々に比較します — メッセージを選ぶことが、
区間を選ぶ方法です。

### キャプチャがあなたに嘘をついているかもしれない {#the-capture-may-be-lying-to-you}

SPAN の片側から取ったキャプチャや、片方向だけを捕まえた `tcpdump` フィルタのキャプチャには、
対向が言ったことが — セッションを終わらせた NOTIFICATION を含めて — 欠けています。
ダッシュボードは *"Only one direction of this session is in the capture"* を出し、ネイバー表は
そのペアを `⚠ Never up` と印すので、知らされはします。言えないのは、まったく性質の違う
2つの原因の **どちらか** です。片肺のミラーと片方向の到達性障害は同じファイルを生み、
キャプチャの問題なのはそのうち一方だけです。

以下の確認がその判断方法で、誰かに「あなたのルータは問題ない」と言う前にやる価値があります。

**Messages → All Packets** で Source 列を読んでください。

![5フレームすべてが 10.0.0.1 発で、SYN と ACK はあるが SYN-ACK が無いハンドシェイクを示すパケット一覧](manual/s12-one-direction.png)

兆候は2つ、どちらも上の図に見えています: すべてのフレームの送信元アドレスが同じであること、
そしてハンドシェイクに `[S]` と `[A]` はあるのに間の `[SA]` が無いこと。実在のセッションが
こう見えることはありません。

同じ問いを SQL で。大きなキャプチャではこちらが速いです。

```sql
select src_ip, dst_ip, count(*) as frames
from packets group by all order by frames desc
```

1つのセッションに1行なら片方向です。健全なセッションなら同程度の大きさの行が2つ出ます。
（このテーブルは BGP を運んだパケットだけを持つので、片方向に BGP が無いセッションはここには
見えません — それが上のパケット一覧の役目です。）

## フィルタ {#filters}

フィルタバーには2つのモードがあります。**Simple** はドロップダウンからルールを組み立て、
**Advanced** は式を取ります。どちらも同じものを生みます。

```
type = NOTIFICATION and src_ip = 10.0.0.1
asn = 65001
prefix = 10.0.0.0/8 and not (type = KEEPALIVE)
capability contains "Route Refresh"
```

条件は `and`、`or`、`not` と括弧で組み合わせます。演算子は `=`、`!=`、`contains`、
`not contains` で、数値フィールドは `<`、`<=`、`>`、`>=` も取ります。

### フィールド {#fields}

| フィールド | マッチするもの |
|-------|---------|
| `type` | `OPEN`、`UPDATE`、`NOTIFICATION`、`KEEPALIVE`、`ROUTE_REFRESH` |
| `src_ip` / `dst_ip` | 送信元 / 宛先アドレス。CIDR はその内側すべてにマッチ |
| `src_port` / `dst_port` | 同じアドレス対の2つのセッションを区別する |
| `frame` | フレーム番号。`frame >= 100 and frame < 200` のような範囲に |
| `router_id` | OPEN の BGP Identifier |
| `src_as` | OPEN で広告された AS 番号 |
| `asn` | AS_PATH のどこかに現れる AS 番号 |
| `origin` | `IGP`、`EGP`、`INCOMPLETE` |
| `next_hop` | NEXT_HOP、または MP_REACH の next hop |
| `med` | MULTI_EXIT_DISC。範囲可 — `med > 100`。MED を持たない UPDATE には一切マッチしない |
| `local_pref` | LOCAL_PREF。範囲可 — `local_pref >= 200`。iBGP のみ。eBGP の UPDATE は持たない |
| `prefix` | announce または withdraw された prefix |
| `withdrawn` | withdraw された prefix のみ |
| `community` | standard または large community |
| `rt` | Route Target。例 `rt = 65001:100` |
| `ext_community` | 表示どおりの任意の extended community |
| `mac` / `vni` / `rd` / `evpn_type` | EVPN 経路。prefix を持たない |
| `capability` | OPEN の capability 名 |

ほとんどに別名があります: `src`、`dst`、`as`、`aspath`、`nexthop`、`nlri`、
`router-id`、`my_as`、`large-community`、`route-target`、`ext-community`、
`evpn-type`。

### prefix のマッチのしかた {#how-prefixes-match}

アドレスと prefix は文字列ではなく数値として、ビット単位で比較されます。ですから
`src_ip = 192.168.0.0/23` は 192.168.0.0 から 192.168.1.255 までを覆い、それ以外は
覆いません。

`prefix` と `withdrawn` では、入力した内容が向きを決めます。

- `prefix = 10.0.0.0/8` — そのブロックの **内側** の経路。`10.0.12.0/24` がマッチします
- `prefix = 10.0.12.7` — そのアドレスを **覆う** 経路
- `prefix contains "10.0.1"` — 単なる部分文字列検索。まだ入力途中のときに

Routes 画面も同じ答え方をするので、そこで見つけた prefix はそのままフィルタでも使えます。

### フィルタが効いていないように見えるとき {#when-a-filter-does-not-seem-to-work}

不正な式は **Showing N of M packets** カウンタの隣に赤いメッセージを出し、一覧は絞られない
ままになります。赤いメッセージの隣の "Showing 5 of 5" は、すべてがマッチしたのではなく
フィルタが適用されなかったという意味です。最も多い原因は存在しないフィールド名です —
上の表と照らし合わせてください。

## BGPShark が教えてくれないこと {#what-bgpshark-will-not-tell-you}

「無いこと」を証拠として読まないために、知っておく価値のあること。

- **セッションが片方向になった2つの原因のどちら**か。片方向が欠けていることは教えますが、
  それがあなたのキャプチャなのかネットワークなのかは、あなたが判断することです。
  [見分け方](#the-capture-may-be-lying-to-you)。
- **その経路が運ばれてよいものかどうか。** 期待される AS_PATH という概念が無いので、
  リークは正当な広告とまったく同じに見えます。
- **あなたのルータが何を決めたか。** BGPShark が読むのはワイヤを流れたものです。どの経路が
  選ばれ、ポリシーが何をし、何が RIB に入ったかは、キャプチャではなくルータ側にあります。
