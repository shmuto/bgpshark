import type { Messages } from './en'
import type { ParseErrorDetail } from '../lib/filter/parser'

/** The text that caused a filter error, or how the query ended. */
function typed(text: string | null): string {
  return text === null ? '入力の終わり' : `「${text}」`
}

/**
 * Japanese message catalog.
 *
 * BGP protocol names (OPEN, UPDATE, NOTIFICATION, KEEPALIVE, ROUTE-REFRESH,
 * AS_PATH, NLRI, MED, LOCAL_PREF, AFI/SAFI, etc.) are kept in standard RFC
 * English so operators can match router output and RFCs directly, while UI
 * chrome, diagnostics, alerts, and guidance are written in natural Japanese.
 */
export const ja: Messages = {
  app: {
    title: 'BGP パケットアナライザー',
    restoringCapture: 'キャプチャを復元中…',
    dropToLoad: 'pcap ファイルをドロップして読み込む',
  },

  nav: {
    captureAria: 'キャプチャ解析',
    toolsAria: 'ツール',
    messages: 'メッセージ',
    sessions: 'セッション',
    routes: '経路',
    sql: 'SQL',
    build: '作成',
    help: 'ヘルプ',
    openAnother: '別のキャプチャを開く',
    captureMeta: (packets: number) => `BGP ${packets} パケット`,
    menu: 'その他',
    buildHint: 'キャプチャを作成',
    viewOnGithub: 'GitHub で見る',
  },

  theme: {
    light: 'ライト',
    dark: 'ダーク',
    system: '自動',
    nextLight: 'ライトテーマに切り替え',
    nextDark: 'ダークテーマに切り替え',
    nextSystem: 'OS のテーマ設定に従う',
  },

  language: {
    switchToJa: '日本語に切り替え',
    switchToEn: '英語に切り替え',
    badgeEn: 'EN',
    badgeJa: '日本語',
  },

  common: {
    backToList: '一覧へ戻る',
    resizePanes: 'ペインの幅を調整',
    resizeHint: 'ドラッグで幅を調整、ダブルクリックでリセット',
    error: 'エラー',
    tryAgain: 'もう一度試す',
    loading: '読み込み中…',
    none: 'なし',
    bytes: (n: number) => `${n} バイト`,
    seconds: (n: number) => `${n} 秒`,
  },

  errorBoundary: {
    title: 'エラーが発生しました',
    description:
      '予期しないエラーが発生しました。読み込んだ pcap ファイルのパース中に問題が起きた可能性があります。',
    details: 'エラー詳細',
    reload: '再読み込み',
    clearAndReset: '保存済みファイルを削除してリセット',
  },

  warnings: {
    bannerCount: (count: number) => `キャプチャの読み込み中に ${count} 件の警告がありました`,
    more: (count: number) => `…他 ${count} 件`,
    duckdbFailed:
      'パケットを DuckDB に読み込めませんでした。フィルタはメモリ上で動作しますが、このキャプチャでは SQL コンソールを利用できません。',
    noIpPackets: 'pcap ファイル内に IP パケットが見つかりませんでした。',
    unknownError: '不明なエラーが発生しました',
  },

  fileConstraints: {
    tooLarge: (maxLabel: string, actualMb: string) =>
      `ファイルサイズが大きすぎます。上限は ${maxLabel} です（選択ファイル: ${actualMb}MB）`,
    invalidType: (extensions: string) =>
      `対応していないファイル形式です。${extensions} ファイルを指定してください。`,
  },

  progress: {
    ariaLabel: 'キャプチャを読み込み中',
    reading: 'ファイルを読み込み中',
    parsing: 'パケットを解析中',
    decoding: 'BGP メッセージをデコード中',
    database: 'DuckDB へ読み込み中',
    databaseShort: 'DuckDB',
    preparing: ' — テーブルを準備中',
    countedPackets: (done: number, total: number) =>
      ` — ${done.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')} パケット`,
  },

  upload: {
    dropHere: 'pcap ファイルをここにドロップ',
    orClick: 'またはクリックして選択',
    supports: (maxSize: string) => `.pcap / .pcapng 形式に対応（最大 ${maxSize}）`,
    loadingSample: 'サンプルを読み込み中...',
    preparing: '準備中...',
    loadingSampleFile: 'sample.pcapng を読み込み中...',
    trySample: 'sample.pcapng で試す',
    sampleDescription: '2 台の BGP ピア間でのセッションリセットと NOTIFICATION を含むサンプル',
    sampleError:
      'サンプルキャプチャを読み込めませんでした。通信状態を確認してもう一度お試しください。',
    noCapturePrefix: '手元にキャプチャがありませんか？',
    buildOne: 'キャプチャを作成',
    noCaptureSuffix: 'して BGP セッションを再現できます。',
    featuresHeading: '主な機能',
    feature1: 'BGP OPEN・UPDATE・NOTIFICATION・KEEPALIVE メッセージの詳細解析',
    feature2: 'トラブルシューティングヒント付きの BGP セッション障害診断',
    feature3: 'SQL ベースの高速なフィルタリングと検索',
    feature4: '100% クライアントサイド動作 — キャプチャはブラウザ外に送信されません',
    ossPrefix: 'オープンソースのフォントとライブラリを利用しています —',
    ossLink: 'ライセンス',
  },

  workspace: {
    railAria: 'セッションと検出事項',
    openRail: 'セッションと検出事項',
    sessionsHeading: 'セッション',
    allSessions: 'すべてのセッション',
    findingsHeading: '検出事項',
    findingsCount: (groups: number, occurrences: number) => `${groups} 種類 · 計 ${occurrences} 回`,
    noFindings: '問題は検出されませんでした。すべてのセッションは正常です。',
    // "件" left open whether it counted packets or messages; the header counts packets.
    messageCount: (n: number) => `${n} メッセージ`,
    clearScope: 'すべてのセッションを表示',
    wholeCapture: '全期間',
    dragToNarrow: 'ドラッグで絞り込み',
    clearRange: '全期間に戻す',
    timeStripAria: '時間ごとのメッセージ数。ドラッグすると、全タブをその期間に絞り込みます。',
    severity: { critical: '重大', warning: '注意', info: '参考' },
    groupInSession: 'このセッション内',
    groupSessions: (n: number) => (n === 0 ? 'キャプチャ全体' : `${n} セッション`),
    groupTitle: (rule: string, firstTitle: string): string =>
      ({
        'no-reply': 'TCP は接続するが相手が BGP を送らない',
        'silent-teardown': 'NOTIFICATION なしでセッションが終了',
        'graceful-restart': 'グレースフルリスタート',
        'route-flap': '経路フラップ',
        'route-aspath': 'AS_PATH の変化',
        'route-macmove': 'MAC の移動',
      })[rule] ?? firstTitle,
  },

  alerts: {
    notifTitle: (codeName: string, subcodeName: string) =>
      `NOTIFICATION: ${codeName} / ${subcodeName}`,
    notifCollisionDetail: (srcIp: string, dstIp: string) =>
      `${srcIp} → ${dstIp} — 双方が同時に接続したため一方の接続を終了（正常動作）`,
    routeFlappingTitle: (key: string) => `経路フラップ: ${key}`,
    routeFlappingDetail: (announced: number, withdrawn: number) =>
      `広告 ${announced} 回、取り消し ${withdrawn} 回`,
    morePrefixesFlappedTitle: (count: number) => `他 ${count} プレフィックスでフラップ発生`,
    morePrefixesFlappedDetail: (flaps: number) =>
      `さらに ${flaps} 回のフラップあり — 経路画面で「フラップ」順に並べ替えると全件確認できます`,
    asPathChangedTitle: (key: string) => `AS_PATH が変化: ${key}`,
    asPathChangedDetail: (from: string, first: string, last: string) =>
      `${from} から: ${first} → ${last}`,
    asPathFromPath: (source: string, pathId: number) => `${source} (Path ID ${pathId})`,
    noAsPath: '(AS_PATH なし)',
    macMovedTitle: (key: string) => `MAC ムーブ検知: ${key}`,
    moreAsPathChangedTitle: (count: number) => `他 ${count} プレフィックスで AS_PATH が変化`,
    moreAsPathChangedDetail: '経路画面を開いてパスを比較してください',
    oneDirectionTitle: 'このセッションは片方向しかキャプチャされていません',
    oneDirectionDetail: (ipA: string, ipB: string, from: string) =>
      `${ipA} と ${ipB} の間のフレームはすべて ${from} からの送信のみです。キャプチャ設定で片方向しか取得できていないか、対向からのパケットが届いていない（片方向障害や片方向フィルタ）状態です。どちらなのか確認するまで、このセッションの解析結果は不完全な片側だけの情報になります。`,
    noReplyTitle: (silent: string) => `TCP 接続後に ${silent} から BGP 応答がありません`,
    noReplyDetail: (accepted: number, speaker: string, silent: string) =>
      `ポート 179 で ${accepted} 回の接続が受け入れられ ${speaker} は BGP を送信しましたが、${silent} からは OPEN も NOTIFICATION も返っていません。TCP ハンドシェイクは成功しているため、問題は TCP 確立後にあります（対向の BGP 設定不一致、またはハンドシェイクは通すがペイロードを通さない中間装置・PMTU ブラックホール・コントロールプレーンポリシング等）。`,
    silentResetTitle: (ipA: string, ipB: string) =>
      `${ipA} ↔ ${ipB} が NOTIFICATION なしで RST 切断されました`,
    silentCloseTitle: (ipA: string, ipB: string) =>
      `${ipA} ↔ ${ipB} が NOTIFICATION なしで FIN 切断されました`,
    silentResetDetail: (sender: string) =>
      `BGP を運んでいた接続が ${sender} からの RST で終了しましたが、NOTIFICATION は交換されていません。BGP スピーカー自身がセッションを落とす場合は先に Cease を送るため、ファイアウォールやロードバランサーによるフロー切断、ソケット不在、セッション途中での ACL 適用など BGP 層以外の要因が疑われます。該当フレームは「すべてのパケット」モードで確認できます。`,
    silentCloseDetail: (sender: string) =>
      `BGP を運んでいた接続が ${sender} からの FIN で終了しましたが、NOTIFICATION は交換されていません。BGP はこの方法でセッションを終了せず Cease を送るため、経路上の装置（ファイアウォールや NAT のアイドルタイムアウト等）が接続を閉じた可能性があります。該当フレームは「すべてのパケット」モードで確認できます。`,
    grTitle: (restarter: string, peer: string) =>
      `${restarter} が Graceful Restart を実施（ピア: ${peer}）`,
    grConvergenceMeasured: (secs: string, restartTime: number, restarter: string) =>
      `セッション再確立から ${secs} で経路が復旧しました（${restarter} の要求 Restart Time: ${restartTime}s）。`,
    grConvergenceUnknown: (restarter: string) =>
      `再確立後の ${restarter} からの End-of-RIB がキャプチャに含まれていないため、収束時間は計測できません（セッション復帰のみ確認）。`,
    grForwardingPreserved: (restarter: string) =>
      `${restarter} は再起動中も転送状態を維持した（Forwarding State Preserved）と広告しているため、BGP 再収束中も通信は継続できたはずです。`,
    grForwardingNotPreserved: (restarter: string) =>
      `${restarter} は転送状態維持（Forwarding State Preserved）を広告していないため、その間データプレーンで通信が欠損した可能性が高く、Graceful Restart の効果が得られていません。`,
    grOverran:
      ' 収束時間が Restart Time を超過したため、ピアが経路保持を打ち切って取り消した可能性があります。',
    grDetail: (convergence: string, forwarding: string, overran: string) =>
      `BGP 層の通知なしで切断された後、双方が Graceful Restart を再広告して復帰しました（通常のフラップではなく再起動です）。${convergence} ${forwarding}${overran}`,
    sessionFlapTitle: 'セッションフラップを検知しました',
    sessionFlapDetail: (ipA: string, ipB: string, opens: number, establishments: number) =>
      `${ipA} ↔ ${ipB} — OPEN ${opens} 回（約 ${establishments} 回の再確立）`,
    withdrawBurstTitle: 'プレフィックス取り消し（Withdraw）のバースト',
    withdrawBurstDetail: (total: number, windowSeconds: number) =>
      `${windowSeconds} 秒以内に ${total} プレフィックスが取り消されました`,
    transportNo179Title: 'BGP メッセージおよび TCP ポート 179 の通信がありません',
    transportNo179DetailTcp: (tcpCount: number) =>
      `他ポートの TCP パケットが ${tcpCount} 件あります — 非標準ポート上の BGP はフロー内に BGP マーカーが確認できる場合のみデコードされます`,
    transportNo179DetailNone: 'キャプチャに TCP トラフィックが含まれていません',
    transportRefusedTitle: 'TCP ポート 179 への接続が拒否されています',
    transportRefusedDetail: (synCount: number) =>
      `${synCount} 回の SYN に対して RST が返され、BGP 層に到達していません。ACL/フィルタ、MD5 (TCP-AO) 設定、対向で BGP が稼働しているかを確認してください`,
    transportUnansweredTitle: 'TCP ポート 179 への SYN に応答がありません',
    transportUnansweredDetail: (synCount: number) =>
      `${synCount} 回の SYN に対して SYN-ACK がありません — 経路上でフィルタされているか、対向に到達できません`,
    transportNoBgpPayloadTitle: 'TCP ポート 179 の通信にデコード可能な BGP が含まれません',
    transportNoBgpPayloadDetail: (count: number) =>
      `ポート 179 上に ${count} パケットありますが、BGP メッセージとしてデコードできませんでした`,
  },

  messages: {
    filterAria: 'フィルタ',
    parseError: (detail: ParseErrorDetail) => {
      switch (detail.code) {
        case 'unexpected-token':
          return `${typed(detail.got)} は解釈できません`
        case 'expected-field':
          return detail.got === null
            ? 'フィールド名が必要な位置でフィルタが終わっています'
            : `フィールド名が必要な位置に ${typed(detail.got)} があります`
        case 'expected-operator':
          return detail.got === null
            ? `「${detail.field}」の後に演算子（= など）が必要です`
            : `「${detail.field}」の後に演算子（= など）が必要です。${typed(detail.got)} があります`
        case 'expected-value':
          return `「${detail.field} ${detail.operator}」の後に値が必要です`
        case 'ordered-not-numeric':
          return `演算子「${detail.operator}」は数値のフィールド（${detail.numericFields.join(', ')}）にだけ使えます。「${detail.field}」には使えません`
        case 'expected-number':
          return `「${detail.field} ${detail.operator}」の後には数値が必要です`
      }
    },
    parseErrorUnapplied: '修正するまでフィルタは適用されません。',
    filterPlaceholder:
      'フィルタ — type = UPDATE, ip = 192.0.2.1, 198.51.100.0/24, AS65001   ( / でフォーカス)',
    clearFilterAria: 'フィルタをクリア',
    showLabel: '表示:',
    bgpOnly: 'BGP のみ',
    allPackets: 'すべてのパケット',
    noBgpBanner: (count: number) =>
      `⚠ このキャプチャには BGP メッセージがありませんが、その他のパケット（TCP ハンドシェイクや RST など）が ${count} 件含まれています。`,
    noBgpInViewBanner: (count: number) =>
      `⚠ このセッション・期間には BGP メッセージがありませんが、その他のパケット（TCP ハンドシェイクや RST など）が ${count} 件あります。`,
    showAllPackets: 'すべてのパケットを表示',
    showingPackets: (shown: number, total: number) => `${total} 件中 ${shown} 件のパケットを表示`,
    bgpSubcount: (count: number) => ` (BGP ${count} 件)`,
    nonBgpMatchTooltip:
      'BGP を含まないフレーム（SYN・ACK・FIN・RST 等）には src_ip・dst_ip・src_port・dst_port・frame 条件のみが評価され、BGP 専用条件には一致しません。',
    nonBgpMatchCount: (bgpCount: number, genericCount: number) =>
      ` (BGP ${bgpCount} 件 + アドレス/ポート一致の非 BGP ${genericCount} 件)`,
    filtering: 'フィルタ中...',
    exportTitle: '現在一覧に表示中のパケットだけを pcap ファイルとして保存します',
    exportButton: (count: number) => `⬇ ${count} 件を pcap 出力`,
    resizeList: 'パケット一覧の幅を調整',
    packetNumber: (frameIndex: number) => `パケット #${frameIndex}`,
    packetDetail: 'パケット詳細',
    selectPacket: 'パケットを選択すると詳細が表示されます',
    networkLayer: 'ネットワーク層',
    sourceIp: '送信元 IP:',
    destinationIp: '宛先 IP:',
    transportLayer: 'トランスポート層',
    protocol: 'プロトコル:',
    sourcePort: '送信元ポート:',
    destinationPort: '宛先ポート:',
    payloadLength: 'ペイロード長:',
    tcpFlags: 'TCP フラグ:',
    frameInfo: 'フレーム情報',
    captured: 'キャプチャ長:',
    original: '元の長さ:',
    timestampUtc: 'タイムスタンプ (UTC):',
    addFilterButton: '+ フィルタ',
    addFilterTitle: 'メニューから条件を組み立ててフィルタに追加します',
    addFilterFormAria: 'フィルタ条件を追加',
    addFilterFieldAria: 'フィールド',
    addFilterOperatorAria: '演算子',
    addFilterValueAria: '値',
    addFilterPickOrType: '値を選択または入力…',
    addFilterType: '値を入力…',
    addFilterSubmit: '追加 (and)',
    columnsButton: '列設定',
    columnsTitle: '表示する列を設定',
    visibleColumns: '表示する列',
    resetColumns: '既定に戻す',
    columns: {
      index: '#',
      time: '相対時刻',
      timeTitle: 'キャプチャ先頭フレームからの経過秒数（フィルタを変えても基準は固定）',
      delta: '差分',
      absTime: '時刻 (UTC)',
      src: '送信元',
      srcPort: '送信元ポート',
      dst: '宛先',
      dstPort: '宛先ポート',
      protocol: 'プロトコル',
      type: '種別',
      info: '情報',
      length: '長さ',
      asPath: 'AS_PATH',
      nlriCount: 'NLRI',
      withdrawnCount: 'WR',
    },
    updateAnnouncedCount: (n: number) => `広告 ${n}`,
    updateWithdrawnCount: (n: number) => `取り消し ${n}`,
    updateEmpty: '空',
  },

  packetDetail: {
    packetInfo: 'パケット情報',
    timeUtc: '時刻 (UTC)',
    sinceCaptureStart: 'キャプチャ開始からの経過',
    deltaPrevious: 'セッション内 前パケットとの差 (Δ)',
    deltaPreviousTitle: '同じ 2 アドレス間の直前 BGP パケットからの経過時間（双方向）',
    firstOnSession: '- (このセッションの最初)',
    source: '送信元',
    destination: '宛先',
    messages: 'メッセージ数',
    parseWarnings: 'パース警告',
    rawData: (bytes: number) => `生データ (${bytes} バイト)`,
    messageTitle: (type: string) => `BGP ${type} メッセージ`,
    messageTitleIndexed: (type: string, index: number, total: number) =>
      `BGP ${type} メッセージ (${index}/${total})`,
    addToFilterTitle: (condition: string) => `フィルタに追加: and ${condition}`,
    addToFilterAria: (condition: string) => `フィルタに追加: ${condition}`,
    filterOnTitle: (condition: string) => `この値でフィルタ: ${condition}`,
    filterOnAria: (condition: string) => `この値でフィルタ: ${condition}`,
    open: {
      version: 'バージョン',
      myAs: 'My AS',
      twoByteAs: (fourByte: number, twoByte: number) => `${fourByte} (2バイト欄: ${twoByte})`,
      holdTime: 'Hold Time',
      bgpIdentifier: 'BGP Identifier',
      capabilities: (count: number) => `ケイパビリティ (${count})`,
      asNumber: 'AS 番号',
      restartTime: 'Restart Time',
      restartFlags: 'Restart フラグ',
      addressFamilies: 'アドレスファミリ:',
      nextHopEncodings: 'Next Hop エンコーディング:',
      usesNextHop: (nlriAfi: string, nlriSafi: string, nhAfi: string) =>
        `${nlriAfi}/${nlriSafi} は ${nhAfi} の Next Hop を使用`,
      supported: '対応',
    },
    update: {
      endOfRibNote: (family: string) => `${family} — 初期経路テーブル広告の完了マーカー (RFC 4724)`,
      announced: (count: number) => `広告 (${count})`,
      withdrawn: (count: number) => `取り消し (${count})`,
      evpnAnnounced: (count: number) => `EVPN ルート（広告 ${count} 件）`,
      evpnWithdrawn: (count: number) => `EVPN ルート（取り消し ${count} 件）`,
      pathAttributes: 'パス属性',
      showAll: (count: number) => `全 ${count} 件を表示`,
      showFewer: '折りたたむ',
      pathIdTitle: (id: number) => `ADD-PATH Path Identifier ${id} (RFC 7911)`,
      pathIdLabel: (id: number) => `path ${id}`,
      optTitle: 'Optional（任意属性）',
      transTitle: 'Transitive（推移属性）',
      present: 'あり',
      aggregatorVia: (asn: number, address: string) => `AS${asn} (${address})`,
      nonTransitiveTitle: 'Non-transitive（非推移）: 自 AS の外には伝搬しません',
      nonTransitiveTag: ' (非推移)',
      nextHopLabel: 'Next Hop ',
      unparsed: '未デコード',
      empty: '空',
      evpnColType: '種別',
      evpnColIp: 'IP / 生成元ルータ',
      evpnColEthTag: 'Eth Tag',
      evpnPartialTitle: 'ルート本体を最後まで読み取れませんでした',
      evpnPartial: '⚠ 一部欠落',
      evpnSecondLabelTitle: '第 2 ラベル（L2 VNI と併送される L3 VNI）',
    },
    keepalive: {
      headerOnly: 'KEEPALIVE — ヘッダのみ（19 バイト）。',
      sincePreviousTitle: '各ルータの Hold Timer は対向からのメッセージ受信でリセットされます',
      sincePrevious: (sender: string, receiver: string) =>
        `${sender} → ${receiver} の直前メッセージからの経過`,
      firstInCapture: '- (キャプチャ内でこの送信元の最初)',
      negotiatedHoldTime: 'ネゴシエート済み Hold Time',
      noOpensInCapture: '- (キャプチャに OPEN なし)',
      holdTimeUsed: 'Hold Time 消費率',
    },
    notification: {
      errorCode: 'エラーコード',
      errorSubcode: 'エラーサブコード',
      troubleshootingHint: 'トラブルシューティングのヒント',
      errorData: (bytes: number) => `エラーデータ (${bytes} バイト)`,
      silenceHeading: '切断までの無応答時間',
      silenceReached:
        '対向が Hold Time 全期間にわたって無応答だったため、仕様どおりタイムアウトしました。BGP 自体ではなく、対向からのパケットが届かなくなった原因（片方向到達性、片方向フィルタ、コントロールプレーンの過負荷など）を調査してください。',
      silenceShort:
        'ネゴシエート済み Hold Time より短いため、無応答時間が満了する前にタイマーが発火しています。キャプチャにパケットの取りこぼしがあるか、実際に有効だった Hold Time がこの OPEN で合意された値と異なる可能性があります。',
      silenceUnknownHold:
        '双方の OPEN がキャプチャに含まれていないため Hold Time を特定できません。設定されている Hold Time とこの無応答時間を比較してください。',
      silenceNoneBefore: (peer: string) =>
        `切断前に ${peer} からのパケットがキャプチャ内に一切ないため無応答時間を計測できません。片方向しか取得できていないキャプチャではないか確認してください。`,
      silenceLine: (
        duration: string,
        msgType: string,
        peer: string,
        time: string,
        holdTime?: number
      ) => ({
        duration,
        afterDuration: `（直前の ${msgType} 送信元: `,
        peer,
        atTime: ' / ',
        time,
        againstHold: holdTime !== undefined ? '、ネゴシエート済み Hold Time: ' : null,
        holdTimeStr: holdTime !== undefined ? `${holdTime}s` : null,
        suffix: '）',
      }),
      offendingAttribute: 'エラーの原因となった属性',
      attrType: (code: number) => `type ${code}`,
      flagOptional: 'Optional',
      flagWellKnown: 'Well-known',
      flagTransitive: 'Transitive',
      flagPartial: 'Partial',
      flagExtendedLength: 'Extended length',
      highestVersion: '対向がサポートする最大バージョン',
      asInData: 'データフィールド内の AS 番号',
      asInDataHint: '自ルータの neighbor 設定と対向の router bgp 設定を見比べてください。',
      unsupportedCapabilities: () => '未対応のケイパビリティ',
      capCode: (code: number) => `code ${code}`,
      rejectedLength: '拒否されたメッセージ長',
      validLengthHint: '有効な BGP メッセージ長は 19〜4096 バイトです。',
      unrecognisedType: '未認識のメッセージ種別',
      shutdownCommunication: 'シャットダウンメッセージ (RFC 8203)',
    },
    routeRefresh: {
      heading: 'ROUTE-REFRESH 前後の経路差分',
      nothingChanged: (unchanged: number) =>
        ` を再広告しましたが変化はありませんでした（${unchanged} 経路が以前と同一）。`,
      someChanged: (unchanged: number) =>
        ` を再広告しました（${unchanged} 経路は変更なし）。`,
      reAdvertisedVerb: 'が',
      added: '新規追加',
      removed: '再広告されなかった経路',
      changed: '属性が変化した経路',
      beforeIncomplete:
        'このキャプチャにはセッション確立時点が含まれていないため、「変更前」は途中から観測できた経路のみです。再広告されなかった一覧に、キャプチャ開始前に広告されていた経路や元々存在しなかった経路が含まれる可能性があります。',
      afterIncomplete:
        '再広告を締めくくる End-of-RIB がキャプチャ内に見つからないため、結果が不完全な可能性があります。キャプチャ終了までに届かなかった経路も「再広告されなかった経路」に含まれます。',
      detailAnnounced: '広告',
      detailAnnouncedWithComm: (communities: string) => `広告（Community: ${communities}）`,
      detailNotReAdvertised: '再広告されず',
      detailCommAdded: (comm: string) => `Community ${comm} を追加`,
      detailCommRemoved: (comm: string) => `Community ${comm} を削除`,
      detailCommChanged: (before: string, after: string) => `Community ${before} → ${after}`,
      detailAttrChanged: (name: string, before: string, after: string) =>
        `${name} ${before} → ${after}`,
      detailNone: '(なし)',
    },
  },

  sessions: {
    title: 'セッション',
    pickHint: 'セッションを選ぶと OPEN の比較と出来事を表示します',
    colSession: 'セッション',
    colAs: 'AS',
    colState: '状態',
    colFindings: '検出事項',
    stateAtEndTitle: 'キャプチャ終了時点のセッション状態',
    healthy: '正常',
    none: 'このキャプチャにセッションはありません',
    ibgp: 'iBGP',
    ebgp: 'eBGP',
    unknownKind: 'OPEN なし',
    statHold: 'Hold Time（合意値）',
    statMessages: 'メッセージ',
    statPrefixes: (from: string) => `${from} からの経路`,
    prefixActivityTitle:
      'この方向の UPDATE で送られた NLRI の数です。属性を変えて再広告したプレフィックスは重ねて数えます',
    openRoutes: '経路 →',
    openMessages: 'メッセージ →',
    capabilityDiff: 'OPEN の比較',
    events: (count: number) => `出来事 (${count})`,
    eventsScopeAria: '表示するメッセージ',
    scopeEvents: 'OPEN / NOTIFICATION',
    scopeAll: (count: number) => `すべて (${count})`,
    timeSincePrevTitle: '表示中の直前メッセージからの経過時間',
  },

  capabilityDiff: {
    noOpenEither: 'このセッションでは双方とも OPEN メッセージがキャプチャされていません',
    oneSidedWarning: (missingLabel: string) =>
      `${missingLabel} からの OPEN がキャプチャされていないため、片側のみの比較です。`,
    sessionFields: 'セッション基本項目',
    mismatches: (count: number) =>
      `ケイパビリティの不一致${count > 0 ? ` (${count})` : ''}`,
    noMismatches: '✓ ケイパビリティの不一致は検出されませんでした',
    matchingCapabilities: (count: number) => `一致するケイパビリティ (${count})`,
    addPathResult: 'ADD-PATH ネゴシエーション結果',
    colAddressFamily: 'アドレスファミリ',
    colDirection: '方向',
    colPathIdentifiers: 'Path ID 送信',
    addPathSent: '有効',
    addPathNotSent: '無効',
    addPathNeither: (from: string, to: string) =>
      `${from} が送信対応しておらず、${to} も受信対応していません`,
    addPathNoSend: (from: string) => `${from} がこのファミリの送信 (send) を広告していません`,
    addPathNoReceive: (to: string) => `${to} がこのファミリの受信 (receive) を広告していません`,
    legendAdvertised: '広告あり',
    legendNotAdvertised: '広告なし',
    legendMismatch: '不一致',
    colField: '項目',
    colStatus: '状態',
    colCapability: 'ケイパビリティ',
    fieldBgpVersion: 'BGP バージョン',
    fieldMyAs: 'My AS',
    fieldHoldTime: 'Hold Time',
    fieldBgpIdentifier: 'BGP Identifier',
    notCaptured: '未取得',
    statusMatch: '✓ 一致',
    statusMismatch: '⚠ 不一致',
    statusAsInconsistent: '⚠ AS 欄に不整合',
    statusSameAs: '双方とも同じ AS (iBGP)',
    statusDiffersEbgp: '異なる AS（eBGP では正常）',
    statusHoldDiffers: '差異あり（エラーではなく小さい値が採用されます）',
    statusIdCollision: '⚠ 重複 — 双方の Router ID が同一です',
    statusIdUnique: '✓ 重複なし',
    asMismatchNote: (myAs: number, expected: number) =>
      `4 バイト AS ケイパビリティに対して 2 バイト My AS 欄が ${myAs} になっています（期待値: ${expected}）`,
    twoByteField: (fourByte: number, twoByte: number) =>
      `${fourByte} (2バイト欄: ${twoByte})`,
    statusBoth: '✓ 双方対応',
    statusOnly: (label: string) => `⚠ ${label} のみ`,
    supported: '対応',
    capSupport: '対応',
    capBytePayload: (len: number) => `${len} バイト`,
    capGrDetail: (restartTime: number, flagsHex: string) =>
      `Restart Time ${restartTime}s, flags 0x${flagsHex}`,
    capGrAfLabel: (afi: string, safi: string) => `${afi} / ${safi} 転送状態`,
    capGrFlags: (flagsHex: string) => `flags 0x${flagsHex}`,
    capEnhLabel: (nlriAfi: string, nlriSafi: string, nhAfi: string) =>
      `${nlriAfi}/${nlriSafi} (${nhAfi} Next Hop)`,
  },

  routes: {
    searchAria: 'プレフィックス検索',
    searchPlaceholder: 'プレフィックス (10.0.0.0/8)、IP、AS65001、MAC で検索',
    clearSearchAria: '検索をクリア',
    matchLabel: '照合',
    matchExact: '完全一致',
    matchExactHint: '入力したプレフィックスとプレフィックス長に完全一致する経路のみ',
    matchSubnets: 'サブネット',
    matchSubnetsHint: '入力した CIDR ブロックに含まれるより細かい経路を検索',
    matchSupernets: 'スーパーネット',
    matchSupernetsHint: '入力した IP や CIDR を包含する集約経路を検索',
    asnSearchNote: (asn: string) => `AS_PATH に AS${asn} を含むプレフィックス`,
    prefixStatistics: 'プレフィックス統計',
    showAllPeersTitle: 'すべてのピアからの経路を表示',
    fromPeers: (peers: string) => `送信元: ${peers} ✕`,
    prefixesCount: (count: number) => `${count} プレフィックス`,
    colPrefix: 'プレフィックス',
    colAnnounced: '広告',
    colWithdrawn: '取り消し',
    colLastSeen: '最終観測 (UTC)',
    colFlap: 'フラップ',
    colFlapTitle:
      '経路が消えた回数です。同じ相手が広告していた経路（キャプチャ開始前の広告を含む）の取り消しを 1 回と数えます。再広告や、取り消し済みの経路の重複した取り消しは数えません。',
    noPrefixesFound: '該当するプレフィックスが見つかりません',
    resizePrefixList: 'プレフィックス一覧の幅を調整',
    routeHistory: (prefix: string | null) =>
      `経路履歴${prefix ? `: ${prefix}` : ''}`,
    oldestFirstTitle: '古い順 — クリックで新しい順に切り替え',
    newestFirstTitle: '新しい順 — クリックで古い順に切り替え',
    colTimeUtc: '時刻 (UTC)',
    colDeltaTitle: '時系列上の直前イベントからの経過時間',
    colAction: '種別',
    colPathId: 'Path ID',
    colPathIdTitle:
      'ADD-PATH Path Identifier (RFC 7911) — 同一ピアからの複数パスのどれに関するイベントかを示します',
    colRdTitle: 'Route Distinguisher — このルートを広告したリーフを識別します',
    colFrom: '送信元',
    colFromTitle: 'このイベントの送信元ピア',
    colNextHop: 'Next Hop',
    colMedTitle: 'MULTI_EXIT_DISC — 小さい値が優先（同じ隣接 AS からの経路間のみで比較）',
    colLocalPrefTitle: 'LOCAL_PREF — 大きい値が優先（AS_PATH 長より優先）',
    colOrigin: 'Origin',
    colOriginTitle: 'ORIGIN — IGP > EGP > INCOMPLETE の順で優先',
    colCommunities: 'Communities',
    actionAnnounce: '広告',
    actionWithdraw: '取り消し',
    selectPrefix: 'プレフィックスを選択すると履歴が表示されます',
    asPathAnalysis: 'AS_PATH 分析',
    singlePath: '単一パス',
    distinctPaths: (count: number) => `${count} 通りのパス`,
    prependedTitle: (repeat: number) => `${repeat} 回プリペンド`,
    pathSeen: (isAlternate: boolean, count: number) =>
      `${isAlternate ? '別経路・' : ''}${count} 回観測`,
  },

  sql: {
    title: 'SQL コンソール',
    duckdbNotInitialized: '⚠ DuckDB が初期化されていません。先に pcap ファイルを読み込んでください。',
    duckdbLoading: 'このキャプチャを DuckDB に読み込んでいます。完了すると SQL を利用できます。',
    duckdbUnavailable:
      '⚠ このキャプチャを DuckDB に読み込めなかったため SQL は利用できません。他の画面のフィルタはメモリ上で動作します。',
    queryHeading: 'クエリ',
    shortcutHint: 'Ctrl+Enter で実行',
    editorAria: 'SQL クエリ',
    run: '実行',
    running: '実行中...',
    clear: 'クリア',
    executionTime: (ms: string) => `実行時間: ${ms}ms`,
    resultsHeading: (count?: number) =>
      count !== undefined ? `実行結果 (${count} 行)` : '実行結果',
    exportCsv: 'CSV 出力 ↓',
    errorPrefix: 'エラー:',
    noResults: '該当する結果はありませんでした',
    runPrompt: 'クエリを実行すると結果が表示されます',
    showingFirst100: (total: number) => `全 ${total} 行のうち先頭 100 行を表示`,
    templatesHeading: 'クエリテンプレート',
    historyHeading: 'クエリ履歴',
    schemaHeading: 'スキーマ',
    schemaHint: 'クリックで挿入',
    expandTableAria: (name: string) => `${name} を展開`,
    collapseTableAria: (name: string) => `${name} を折りたたむ`,
    insertTitle: (name: string) => `${name} を挿入`,
    openFrameTitle: (frame: string) => `メッセージ画面でフレーム ${frame} を開く`,
    openRouteTitle: (prefix: string) => `${prefix} の経路履歴を開く`,
    queryFailed: 'クエリの実行に失敗しました',
    templates: {
      neighborSummary: 'ネイバー集計',
      asPathStats: 'AS_PATH 統計',
      prefixFlapping: 'プレフィックスフラップ',
      evpnMacMoves: 'EVPN MAC ムーブ',
      evpnRouteTargets: 'EVPN Route Target 集計',
      errorAnalysis: 'エラー分析',
      messageTypes: 'メッセージ種別集計',
    },
  },

  builder: {
    title: 'キャプチャを作成',
    subtitle:
      'BGP セッションの構成を記述して .pcap ファイルを生成します。下のシナリオから選び、アドレス・AS 番号・経路を編集してください。',
    scenarioLabel: 'シナリオ',
    previewHeading: 'プレビュー',
    previewStats: (frames: number, size: string, bgpMessages: number) =>
      `${frames} フレーム · ${size} · BGP ${bgpMessages} メッセージ`,
    downloadPcap: '.pcap をダウンロード',
    openInAnalyzer: 'アナライザーで開く',
    readBackWarning: '生成したファイルの再パース時に警告・エラーがありました',
    colTime: '時刻',
    colSource: '送信元',
    colDestination: '宛先',
    colLen: '長さ',
    colInfo: '情報',
    sectionPeers: 'ピア設定',
    sectionCapture: 'キャプチャ設定',
    sectionSequence: 'シーケンス',
    peerConnects: '接続元 (Active)',
    peerListens: '待ち受け (Port 179)',
    peerBadge: (side: string) => `Peer ${side}`,
    fieldIp: 'IP アドレス',
    fieldAs: 'AS 番号',
    fieldRouterId: 'Router ID',
    fieldHoldTime: 'Hold Time (秒)',
    fieldTcpPort: 'TCP ポート',
    fieldTcpPortHint: '同一アドレスペア間で 2 つのセッションを分ける場合にポートを指定します',
    fieldLinkType: 'リンクタイプ',
    fieldVlanIds: 'VLAN ID',
    fieldVlanIdsHint: '外側から順に指定。2 つ指定すると QinQ になります。',
    fieldMtu: 'MTU',
    fieldMtuHint: '値を小さくすると BGP メッセージが複数 TCP セグメントに分割されます',
    fieldDefaultGap: '既定の間隔 (ms)',
    noStepsYet: 'ステップがありません。TCP ハンドシェイクを追加してセッションを開始してください。',
    addLabel: '追加:',
    sentByAria: '送信元',
    fromA: (ip: string) => `A から (${ip})`,
    fromB: (ip: string) => `B から (${ip})`,
    delayFor: '待機',
    stepAfter: '経過',
    moveUp: '上へ移動',
    moveDown: '下へ移動',
    removeStep: 'ステップを削除',
    removeMessage: 'メッセージを削除',
    sendHint: '1 回の送信として書き込みます — 収まるメッセージは同一 TCP セグメントにまとまります。',
    fieldPrefixes: 'プレフィックス',
    fieldNextHop: 'Next Hop',
    fieldAsPath: 'AS_PATH',
    fieldAsPathHint: '左から右へ、近い AS から順に指定',
    fieldOrigin: 'Origin',
    fieldMed: 'MED',
    fieldCommunities: 'Communities',
    fieldCommunitiesHint: '65000:100, NO_EXPORT, …',
    endOfRibNote: '空の UPDATE — 初期経路広告の完了を示すマーカーです (RFC 4724)。',
    fieldErrorCode: 'エラーコード',
    fieldSubcode: 'サブコード',
    rawNote: 'シナリオ定義どおりに生成されます。このメッセージ用の編集フォームはないためそのまま保持されます。',
    steps: {
      handshake: 'TCP ハンドシェイク',
      open: 'OPEN',
      keepalive: 'KEEPALIVE',
      send: 'メッセージ送信',
      close: 'TCP クローズ (FIN)',
      reset: 'TCP リセット (RST)',
      delay: '待機',
    },
    messages: {
      announce: '経路広告',
      withdraw: '経路取り消し',
      'end-of-rib': 'End-of-RIB',
      notification: 'NOTIFICATION',
      'route-refresh': 'ROUTE-REFRESH',
      raw: 'その他',
    },
    presets: {
      established: {
        name: '正常なセッション確立',
        description: 'ハンドシェイク、OPEN 交換、経路広告、End-of-RIB までの健全なベースライン。',
      },
      'hold-timer': {
        name: 'Hold Timer 満了',
        description: '確立後に片側が無応答となり、対向が NOTIFICATION 4/0 でセッションを切断します。',
      },
      'bad-peer-as': {
        name: 'AS 番号の不一致',
        description: 'remote-as 不一致により OPEN が NOTIFICATION 2/2 で拒否されます。',
      },
      'connection-refused': {
        name: 'TCP 接続拒否（BGP なし）',
        description: 'SYN に対して RST が 3 回返されます。MD5 不一致や ACL 拒否の典型例です。',
      },
      ipv6: {
        name: 'IPv6 トランスポート',
        description: 'IPv6 上のセッションで MP_REACH_NLRI / MP_UNREACH_NLRI により IPv6 経路を交換します。',
      },
      flap: {
        name: '経路フラップ',
        description: '1 つのプレフィックスが 5 回広告・取り消しを繰り返します。経路画面の確認用です。',
      },
      'four-byte-as': {
        name: '4 バイト AS 番号',
        description: 'OPEN の 2 バイト欄に AS_TRANS、ケイパビリティに実 ASN、4 バイト AS_PATH を使用します。',
      },
      segmented: {
        name: 'TCP セグメント分割された UPDATE',
        description: 'MTU 576 バイトで 400 プレフィックスを広告し、複数セグメントにまたがるメッセージを生成します。',
      },
    },
  },

  manual: {
    contentsAria: 'Manual contents',
    contentsHeading: '目次',
    footerPrefix: 'BGPShark にはオープンソースのフォントとライブラリが含まれています。',
    footerLink: 'ライセンス一覧',
    footerSuffix: '',
  },

  filterSuggestions: {
    andDesc: 'AND 条件',
    orDesc: 'OR 条件',
    opEq: '一致 (=)',
    opNeq: '不一致 (!=)',
    opLt: 'より小さい (<)',
    opLte: '以下 (<=)',
    opGt: 'より大きい (>)',
    opGte: '以上 (>=)',
    opContains: '部分一致 (contains)',
    fields: {
      type: 'メッセージ種別',
      src_ip: '送信元 IP (packets.src_ip)',
      dst_ip: '宛先 IP (packets.dst_ip)',
      src_port: 'TCP 送信元ポート — 片側のみ。双方向は src_port = 179 or dst_port = 179',
      dst_port: 'TCP 宛先ポート — src_port と組み合わせて同時セッションを分離',
      frame: 'フレーム番号（# 列）— < <= > >= で範囲指定可能（例: frame >= 100）',
      router_id: 'Router ID (messages.router_id)',
      src_as: '送信元 AS 番号（OPEN メッセージより）',
      asn: 'AS_PATH 内の AS 番号 (as_path.asn)',
      origin: 'ORIGIN 属性 (path_attributes.origin_value)',
      med: 'MULTI_EXIT_DISC — < <= > >= で範囲指定可能（例: med > 100）',
      local_pref: 'LOCAL_PREF — < <= > >= で範囲指定可能（例: local_pref >= 200）。iBGP のみ',
      next_hop: 'Next Hop (path_attributes.next_hop)',
      prefix: '広告または取り消しされたプレフィックス（経路の全履歴）',
      nlri: '広告プレフィックスのみ (nlri.prefix)',
      withdrawn: '取り消しプレフィックスのみ (withdrawn.prefix)',
      community: 'Community (communities.formatted)',
      rt: 'Route Target（例: rt = 65001:100）— 経路を取り込む VRF を決定',
      ext_community: '表示形式の Extended Community（例: ext_community contains "MAC Mobility"）',
      mac: 'EVPN ルート内の MAC アドレス（広告・取り消しを追跡）',
      vni: 'EVPN ルートが運ぶ VNI（特定のブリッジドメインで絞り込み）',
      rd: 'EVPN ルートの Route Distinguisher（例: rd = 10.0.0.1:100）',
      evpn_type: 'EVPN ルートタイプ: 1 A-D, 2 MAC/IP, 3 IMET, 4 Ethernet Segment, 5 IP Prefix',
      capability: 'ケイパビリティ (capabilities.name)',
    },
  },
}
