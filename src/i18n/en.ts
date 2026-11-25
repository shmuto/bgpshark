/**
 * English message catalog — the source of truth for the i18n schema.
 *
 * Every other locale implements `Messages` (derived structurally from this
 * object), so adding or changing a key or interpolation parameter here becomes
 * a compile-time error in every translation until it is updated.
 */

import { describeParseError, type ParseErrorDetail } from '../lib/filter/parser'

export const en = {
  app: {
    title: 'BGP Packet Analyzer',
    restoringCapture: 'Restoring capture…',
    dropToLoad: 'Drop pcap file to load',
  },

  nav: {
    captureAria: 'Capture',
    toolsAria: 'Tools',
    messages: 'Messages',
    sessions: 'Sessions',
    routes: 'Routes',
    sql: 'SQL',
    build: 'Build',
    help: 'Help',
    openAnother: 'Open another capture',
    captureMeta: (packets: number) => `${packets} BGP packet${packets === 1 ? '' : 's'}`,
    menu: 'More',
    buildHint: 'Make a capture',
    viewOnGithub: 'View on GitHub',
  },

  theme: {
    light: 'Light',
    dark: 'Dark',
    system: 'Auto',
    nextLight: 'Switch to light theme',
    nextDark: 'Switch to dark theme',
    nextSystem: 'Follow system theme',
  },

  language: {
    switchToJa: 'Switch to Japanese',
    switchToEn: 'Switch to English',
    badgeEn: 'EN',
    badgeJa: '日本語',
  },

  common: {
    backToList: 'Back to list',
    resizePanes: 'Resize panes',
    resizeHint: 'Drag to resize, double-click to reset',
    error: 'Error',
    tryAgain: 'Try Again',
    loading: 'Loading…',
    none: 'none',
    bytes: (n: number) => `${n} bytes`,
    seconds: (n: number) => `${n} seconds`,
  },

  errorBoundary: {
    title: 'Something went wrong',
    description: 'The app hit an unexpected error, possibly while parsing the loaded pcap file.',
    details: 'Error details',
    reload: 'Reload',
    clearAndReset: 'Clear stored file and reset',
  },

  warnings: {
    bannerCount: (count: number) =>
      `${count} warning${count > 1 ? 's' : ''} loading this capture`,
    more: (count: number) => `…and ${count} more`,
    duckdbFailed:
      'Packets could not be loaded into DuckDB, so the SQL console is unavailable for this capture. Every other screen, filtering included, works without it.',
    noIpPackets: 'No IP packets found in the pcap file.',
    unknownError: 'Unknown error occurred',
  },

  fileConstraints: {
    tooLarge: (maxLabel: string, actualMb: string) =>
      `File too large. Maximum size is ${maxLabel} (got ${actualMb}MB)`,
    invalidType: (extensions: string) =>
      `Invalid file type. Please upload a ${extensions} file.`,
  },

  progress: {
    ariaLabel: 'Loading capture',
    reading: 'Reading file',
    parsing: 'Parsing packets',
    decoding: 'Decoding BGP messages',
    database: 'Loading into DuckDB',
    databaseShort: 'DuckDB',
    preparing: ' — preparing tables',
    countedPackets: (done: number, total: number) =>
      ` — ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} packets`,
  },

  upload: {
    dropHere: 'Drop pcap file here',
    orClick: 'or click to select',
    supports: (maxSize: string) => `Supports .pcap and .pcapng files up to ${maxSize}`,
    loadingSample: 'Loading sample...',
    preparing: 'Preparing...',
    loadingSampleFile: 'Loading sample.pcapng...',
    trySample: 'Try with sample.pcapng',
    sampleDescription: 'Includes session resets and NOTIFICATION messages between two BGP peers',
    sampleError: 'Could not load the sample capture. Check your connection and try again.',
    noCapturePrefix: 'No capture to hand?',
    buildOne: 'Build one',
    noCaptureSuffix: 'from a described BGP session.',
    featuresHeading: 'Features',
    feature1: 'Analyze BGP OPEN, UPDATE, NOTIFICATION, KEEPALIVE messages',
    feature2: 'Troubleshoot BGP session issues with detailed error hints',
    feature3: 'Filter and search with SQL-powered queries',
    feature4: '100% client-side - your data never leaves your browser',
    ossPrefix: 'Built on open source fonts and libraries —',
    ossLink: 'licenses',
  },

  workspace: {
    railAria: 'Sessions and findings',
    openRail: 'Sessions and findings',
    sessionsHeading: 'Sessions',
    allSessions: 'All sessions',
    findingsHeading: 'Findings',
    /** Kinds of finding, and occurrences summed the way each finding's ×N is. */
    findingsCount: (groups: number, occurrences: number) =>
      `${groups} kind${groups === 1 ? '' : 's'} · ${occurrences} occurrence${occurrences === 1 ? '' : 's'}`,
    noFindings: 'No issues detected — every session looks healthy.',
    findingsPending: 'Analyzing routes for findings…',
    messageCount: (n: number) => `${n} msg${n === 1 ? '' : 's'}`,
    clearScope: 'Show all sessions',
    wholeCapture: 'Whole capture',
    dragToNarrow: 'Drag to narrow',
    clearRange: 'Show all',
    timeStripAria: 'Messages over time. Drag across it to narrow every view to that window.',
    severity: { critical: 'Critical', warning: 'Warning', info: 'Info' },
    groupInSession: 'In this session',
    groupSessions: (n: number) => (n === 0 ? 'Across the capture' : `${n} session${n === 1 ? '' : 's'}`),
    /** A group's heading; rules whose alert titles name a subject get a generic one. */
    groupTitle: (rule: string, firstTitle: string): string =>
      ({
        'no-reply': 'TCP connects but the peer sends no BGP',
        'silent-teardown': 'Session ended with no NOTIFICATION',
        'graceful-restart': 'Graceful restart',
        'route-flap': 'Route flapping',
        'route-aspath': 'AS_PATH changed',
        'route-macmove': 'MAC moved',
      })[rule] ?? firstTitle,
  },

  alerts: {
    notifTitle: (codeName: string, subcodeName: string) =>
      `NOTIFICATION: ${codeName} / ${subcodeName}`,
    notifCollisionDetail: (srcIp: string, dstIp: string) =>
      `${srcIp} → ${dstIp} — both ends connected at once; one connection closed (normal)`,
    routeFlappingTitle: (key: string) => `Route flapping: ${key}`,
    routeFlappingDetail: (announced: number, withdrawn: number) =>
      `${announced} announcement${announced === 1 ? '' : 's'}, ${withdrawn} withdrawal${withdrawn === 1 ? '' : 's'}`,
    morePrefixesFlappedTitle: (count: number) => `${count} more prefixes flapped`,
    morePrefixesFlappedDetail: (flaps: number) =>
      `${flaps} further flap${flaps === 1 ? '' : 's'} — sort the Routes screen by Flap to see them all`,
    asPathChangedTitle: (key: string) => `AS_PATH changed: ${key}`,
    asPathChangedDetail: (from: string, first: string, last: string) =>
      `from ${from}: ${first} → ${last}`,
    asPathFromPath: (source: string, pathId: number) => `${source} (path ${pathId})`,
    noAsPath: '(no AS_PATH)',
    macMovedTitle: (key: string) => `MAC moved: ${key}`,
    moreAsPathChangedTitle: (count: number) => `${count} more prefixes changed AS_PATH`,
    moreAsPathChangedDetail: 'Open the Routes screen to compare their paths',
    oneDirectionTitle: 'Only one direction of this session is in the capture',
    oneDirectionDetail: (ipA: string, ipB: string, from: string) =>
      `Every frame between ${ipA} and ${ipB} was sent by ${from}. Either the ` +
      `capture caught one direction only, or traffic from the other end is ` +
      `not arriving — a one-way link, a filter applied in one direction. ` +
      `Anything read off this session is half a conversation until you know which.`,
    noReplyTitle: (silent: string) => `TCP connects but ${silent} sends no BGP`,
    noReplyDetail: (accepted: number, speaker: string, silent: string) =>
      `${accepted} connection(s) accepted on port 179 and ${speaker} sent ` +
      `BGP, but ${silent} sent none — no OPEN, no NOTIFICATION. The port is ` +
      `open and the handshake succeeded, so the fault is after TCP came up: ` +
      `the peer's BGP not willing to talk to this address, or the payload not ` +
      `surviving a path that carries the handshake (a TCP middlebox, a PMTU ` +
      `black hole, control-plane policing).`,
    silentResetTitle: (ipA: string, ipB: string) =>
      `${ipA} ↔ ${ipB} was reset with no NOTIFICATION`,
    silentCloseTitle: (ipA: string, ipB: string) =>
      `${ipA} ↔ ${ipB} was closed with no NOTIFICATION`,
    silentResetDetail: (sender: string) =>
      `A connection carrying BGP ended when ${sender} sent an RST, and no ` +
      `NOTIFICATION was exchanged on it. A speaker shutting the session ` +
      `down would have sent a Cease first, so the reset came from ` +
      `somewhere else — a firewall or load balancer dropping the flow, a ` +
      `stack that had no socket for it, an ACL applied mid-session. The ` +
      `frame is in the capture under All Packets.`,
    silentCloseDetail: (sender: string) =>
      `A connection carrying BGP was closed with FIN by ${sender}, and no ` +
      `NOTIFICATION was exchanged on it. BGP does not end a session that ` +
      `way — a speaker going down sends a Cease — so something in the ` +
      `path decided the connection was finished, which is what an idle ` +
      `timeout on a firewall or NAT looks like. The frame is in the ` +
      `capture under All Packets.`,
    grTitle: (restarter: string, peer: string) =>
      `${restarter} restarted gracefully, peer ${peer}`,
    grConvergenceMeasured: (secs: string, restartTime: number, restarter: string) =>
      `Routes were back ${secs} after the session came up, against the ${restartTime}s ${restarter} asked for.`,
    grConvergenceUnknown: (restarter: string) =>
      `The capture holds no End-of-RIB from ${restarter} after it came back, so how long convergence took cannot be measured here — only that the session returned.`,
    grForwardingPreserved: (restarter: string) =>
      `${restarter} advertised that it kept forwarding state across the restart, so traffic should have continued while BGP caught up.`,
    grForwardingNotPreserved: (restarter: string) =>
      `${restarter} did not advertise preserved forwarding state, so its dataplane most likely dropped traffic for the whole of that window — which is the part a graceful restart is supposed to avoid.`,
    grOverran:
      ' Convergence ran past the Restart Time, so the peer will have given up holding the routes and withdrawn them before they came back.',
    grDetail: (convergence: string, forwarding: string, overran: string) =>
      `The session went down with nothing at the BGP layer announcing it and came back with both ends re-advertising Graceful Restart, which is a restart rather than a flap. ${convergence} ${forwarding}${overran}`,
    sessionFlapTitle: 'Session flapping detected',
    sessionFlapDetail: (ipA: string, ipB: string, opens: number, establishments: number) =>
      `${ipA} ↔ ${ipB} — ${opens} OPEN messages (~${establishments} establishments)`,
    withdrawBurstTitle: 'Burst of withdrawn prefixes',
    withdrawBurstDetail: (total: number, windowSeconds: number) =>
      `${total} prefixes withdrawn within ${windowSeconds}s`,
    transportNo179Title: 'No BGP messages and no TCP port 179 traffic',
    transportNo179DetailTcp: (tcpCount: number) =>
      `${tcpCount} TCP packets on other ports — non-standard-port sessions are decoded only when BGP message markers are visible in the flow`,
    transportNo179DetailNone: 'The capture contains no TCP traffic',
    transportRefusedTitle: 'TCP connections to port 179 are being refused',
    transportRefusedDetail: (synCount: number) =>
      `${synCount} SYNs answered by RST — the session never reaches BGP. Check ACLs/filters, MD5 (TCP-AO) configuration, or whether BGP is running on the peer`,
    transportUnansweredTitle: 'TCP SYNs to port 179 go unanswered',
    transportUnansweredDetail: (synCount: number) =>
      `${synCount} SYNs with no SYN-ACK — traffic filtered in transit or the peer is unreachable`,
    transportNoBgpPayloadTitle: 'TCP port 179 traffic carries no decodable BGP',
    transportNoBgpPayloadDetail: (count: number) =>
      `${count} packets on port 179 but no BGP messages could be decoded`,
  },

  messages: {
    filterAria: 'Filter',
    /** A filter the parser rejected, with the list left unfiltered. */
    parseError: (detail: ParseErrorDetail) => describeParseError(detail),
    parseErrorUnapplied: 'The filter is not applied until this is fixed.',
    filterPlaceholder:
      'Filter — type = UPDATE, ip = 192.0.2.1, 198.51.100.0/24, AS65001   ( / to focus)',
    clearFilterAria: 'Clear filter',
    showLabel: 'Show:',
    bgpOnly: 'BGP Only',
    allPackets: 'All Packets',
    noBgpBanner: (count: number) =>
      `⚠ No BGP messages in this capture, but it contains ${count} other packets (TCP handshakes, resets, …).`,
    noBgpInViewBanner: (count: number) =>
      `⚠ No BGP messages in this session or time window, but it contains ${count} other packets (TCP handshakes, resets, …).`,
    showAllPackets: 'Show all packets',
    showingPackets: (shown: number, total: number) =>
      `Showing ${shown} of ${total} packets`,
    bgpSubcount: (count: number) => ` (${count} BGP)`,
    nonBgpMatchTooltip:
      'Non-BGP frames (SYN, ACK, FIN, RST) are matched on src_ip, dst_ip, src_port, dst_port and frame; BGP-only conditions never match them.',
    nonBgpMatchCount: (bgpCount: number, genericCount: number) =>
      ` (${bgpCount} BGP + ${genericCount} non-BGP matched by address/port)`,
    filtering: 'filtering...',
    exportTitle: 'Save the packets listed here as a pcap file',
    exportButton: (count: number) => `⬇ Export ${count} packets as pcap`,
    resizeList: 'Resize the packet list',
    packetNumber: (frameIndex: number) => `Packet #${frameIndex}`,
    packetDetail: 'Packet Detail',
    selectPacket: 'Select a packet to view details',
    networkLayer: 'Network Layer',
    sourceIp: 'Source IP:',
    destinationIp: 'Destination IP:',
    transportLayer: 'Transport Layer',
    protocol: 'Protocol:',
    sourcePort: 'Source Port:',
    destinationPort: 'Destination Port:',
    payloadLength: 'Payload Length:',
    tcpFlags: 'TCP Flags:',
    frameInfo: 'Frame Info',
    captured: 'Captured:',
    original: 'Original:',
    timestampUtc: 'Timestamp (UTC):',
    addFilterButton: '+ Filter',
    addFilterTitle: 'Build a condition from menus and add it to the filter',
    addFilterFormAria: 'Add a filter condition',
    addFilterFieldAria: 'Field',
    addFilterOperatorAria: 'Operator',
    addFilterValueAria: 'Value',
    addFilterPickOrType: 'Pick or type a value…',
    addFilterType: 'Type a value…',
    addFilterSubmit: 'Add (and)',
    columnsButton: 'Columns',
    columnsTitle: 'Configure columns',
    visibleColumns: 'Visible Columns',
    resetColumns: 'Reset to default',
    columns: {
      index: '#',
      time: 'Relative',
      timeTitle: 'Seconds since the first frame of the capture — fixed, whatever the filter',
      delta: 'Delta',
      absTime: 'Absolute (UTC)',
      src: 'Source',
      srcPort: 'Src Port',
      dst: 'Destination',
      dstPort: 'Dst Port',
      protocol: 'Proto',
      type: 'Type',
      info: 'Info',
      length: 'Len',
      asPath: 'AS Path',
      nlriCount: 'NLRI',
      withdrawnCount: 'WR',
    },
    updateAnnouncedCount: (n: number) => `${n} announced`,
    updateWithdrawnCount: (n: number) => `${n} withdrawn`,
    updateEmpty: 'empty',
  },

  packetDetail: {
    packetInfo: 'Packet Info',
    timeUtc: 'Time (UTC)',
    sinceCaptureStart: 'Since capture start',
    deltaPrevious: 'Δ previous on session',
    deltaPreviousTitle:
      'Time since the previous BGP packet between these two addresses, in either direction',
    firstOnSession: '- (first on this session)',
    source: 'Source',
    destination: 'Destination',
    messages: 'Messages',
    parseWarnings: 'Parse Warnings',
    rawData: (bytes: number) => `Raw Data (${bytes} bytes)`,
    messageTitle: (type: string) => `BGP ${type} Message`,
    messageTitleIndexed: (type: string, index: number, total: number) =>
      `BGP ${type} Message (${index}/${total})`,
    addToFilterTitle: (condition: string) => `Add to filter: and ${condition}`,
    addToFilterAria: (condition: string) => `Add to filter: ${condition}`,
    filterOnTitle: (condition: string) => `Filter on: ${condition}`,
    filterOnAria: (condition: string) => `Filter on: ${condition}`,
    open: {
      version: 'Version',
      myAs: 'My AS',
      twoByteAs: (fourByte: number, twoByte: number) => `${fourByte} (2-byte: ${twoByte})`,
      holdTime: 'Hold Time',
      bgpIdentifier: 'BGP Identifier',
      capabilities: (count: number) => `Capabilities (${count})`,
      asNumber: 'AS Number',
      restartTime: 'Restart Time',
      restartFlags: 'Restart Flags',
      addressFamilies: 'Address Families:',
      nextHopEncodings: 'Next Hop Encodings:',
      usesNextHop: (nlriAfi: string, nlriSafi: string, nhAfi: string) =>
        `${nlriAfi}/${nlriSafi} uses ${nhAfi} next-hop`,
      supported: 'Supported',
    },
    update: {
      endOfRibNote: (family: string) =>
        `${family} — initial routing table advertisement is complete (RFC 4724)`,
      announced: (count: number) => `Announced (${count})`,
      withdrawn: (count: number) => `Withdrawn (${count})`,
      evpnAnnounced: (count: number) => `EVPN Routes (${count} announced)`,
      evpnWithdrawn: (count: number) => `EVPN Routes (${count} withdrawn)`,
      pathAttributes: 'Path Attributes',
      showAll: (count: number) => `Show all ${count}`,
      showFewer: 'Show fewer',
      pathIdTitle: (id: number) => `ADD-PATH Path Identifier ${id} (RFC 7911)`,
      pathIdLabel: (id: number) => `path ${id}`,
      optTitle: 'Optional',
      transTitle: 'Transitive',
      present: 'Present',
      aggregatorVia: (asn: number, address: string) => `AS${asn} via ${address}`,
      nonTransitiveTitle: 'Non-transitive: does not leave this AS',
      nonTransitiveTag: ' (non-transitive)',
      nextHopLabel: 'Next Hop ',
      unparsed: 'Unparsed',
      empty: 'Empty',
      evpnColType: 'Type',
      evpnColIp: 'IP / Originating Router',
      evpnColEthTag: 'Eth Tag',
      evpnPartialTitle: 'The route body could not be fully read',
      evpnPartial: '⚠ partial',
      evpnSecondLabelTitle: 'Second label, an L3 VNI alongside the L2 one',
    },
    keepalive: {
      headerOnly: 'KEEPALIVE — header only (19 bytes).',
      sincePreviousTitle: "Each end's hold timer is reset by messages from the other end",
      sincePrevious: (sender: string, receiver: string) =>
        `Since ${sender}'s previous message to ${receiver}`,
      firstInCapture: '- (first from this end in the capture)',
      negotiatedHoldTime: 'Negotiated hold time',
      noOpensInCapture: '- (OPENs not in the capture)',
      holdTimeUsed: 'Hold time used',
    },
    notification: {
      errorCode: 'Error Code',
      errorSubcode: 'Error Subcode',
      troubleshootingHint: 'Troubleshooting Hint',
      errorData: (bytes: number) => `Error Data (${bytes} bytes)`,
      silenceHeading: 'Silence before the teardown',
      silenceReached:
        'The peer was quiet for the whole hold time, so the session timed out as specified. What to chase is why its packets stopped arriving — one-way reachability, a filter in one direction, an overloaded control plane — rather than BGP itself.',
      silenceShort:
        'That is shorter than the hold time, so the timer fired before the silence could have run it out. Either this capture is missing packets that did arrive, or the hold time in force was not the one these OPENs agreed.',
      silenceUnknownHold:
        'The hold time is unknown because the capture does not hold an OPEN from both ends — compare the silence against the configured value yourself.',
      silenceNoneBefore: (peer: string) =>
        `Nothing from ${peer} appears in this capture before the teardown, so the silence cannot be measured — and a capture with nothing from one end is worth checking before drawing conclusions from it.`,
      silenceLine: (
        duration: string,
        msgType: string,
        peer: string,
        time: string,
        holdTime?: number
      ) => ({
        duration,
        afterDuration: ` since the last ${msgType} from `,
        peer,
        atTime: ' at ',
        time,
        againstHold: holdTime !== undefined ? ', against a negotiated hold time of ' : null,
        holdTimeStr: holdTime !== undefined ? `${holdTime}s` : null,
        suffix: '.',
      }),
      offendingAttribute: 'Offending attribute',
      attrType: (code: number) => `type ${code}`,
      flagOptional: 'Optional',
      flagWellKnown: 'Well-known',
      flagTransitive: 'Transitive',
      flagPartial: 'Partial',
      flagExtendedLength: 'Extended length',
      highestVersion: 'Highest version the peer supports',
      asInData: 'AS number in the data field',
      asInDataHint: "Compare this against your neighbor statement and the peer's router bgp line.",
      unsupportedCapabilities: (count: number) =>
        `Unsupported ${count === 1 ? 'capability' : 'capabilities'}`,
      capCode: (code: number) => `code ${code}`,
      rejectedLength: 'Rejected message length',
      validLengthHint: 'Valid BGP messages are 19–4096 bytes.',
      unrecognisedType: 'Unrecognised message type',
      shutdownCommunication: 'Shutdown communication',
    },
    routeRefresh: {
      heading: 'What the refresh changed',
      nothingChanged: (unchanged: number) =>
        ` and nothing changed: ${unchanged} route${unchanged === 1 ? '' : 's'} came back exactly as before.`,
      someChanged: (unchanged: number) =>
        `. ${unchanged} route${unchanged === 1 ? '' : 's'} came back unchanged.`,
      reAdvertisedVerb: 're-advertised',
      added: 'Added',
      removed: 'No longer advertised',
      changed: 'Attributes changed',
      beforeIncomplete:
        'The capture does not hold this session starting, so the “before” side is only what it happened to catch. A route listed as no longer advertised may be one that was announced before the capture began — or one that was never there.',
      afterIncomplete:
        'No End-of-RIB closed the re-advertisement in this capture, so the answer may be incomplete: anything not re-sent before the capture ended is listed as no longer advertised whether or not it was on its way.',
      detailAnnounced: 'announced',
      detailAnnouncedWithComm: (communities: string) =>
        `announced with community ${communities}`,
      detailNotReAdvertised: 'was not re-advertised',
      detailCommAdded: (comm: string) => `community ${comm} added`,
      detailCommRemoved: (comm: string) => `community ${comm} removed`,
      detailCommChanged: (before: string, after: string) => `community ${before} → ${after}`,
      detailAttrChanged: (name: string, before: string, after: string) =>
        `${name} ${before} → ${after}`,
      detailNone: '(none)',
    },
  },

  sessions: {
    title: 'Sessions',
    pickHint: 'Pick a session to compare its OPENs and read its events',
    colSession: 'Session',
    colAs: 'AS',
    colState: 'State',
    colFindings: 'Findings',
    stateAtEndTitle: 'State when the capture ended',
    healthy: 'OK',
    none: 'No sessions in this capture',
    ibgp: 'iBGP',
    ebgp: 'eBGP',
    unknownKind: 'no OPEN',
    statHold: 'Hold time (agreed)',
    statMessages: 'Messages',
    statPrefixes: (from: string) => `Prefixes from ${from}`,
    prefixActivityTitle:
      'NLRI entries sent in UPDATEs, in this direction only; a prefix re-announced with new attributes counts again',
    openRoutes: 'Routes →',
    openMessages: 'Messages →',
    capabilityDiff: 'OPEN comparison',
    events: (count: number) => `Events (${count})`,
    eventsScopeAria: 'Which messages to list',
    scopeEvents: 'OPEN / NOTIFICATION',
    scopeAll: (count: number) => `All (${count})`,
    timeSincePrevTitle: 'Time since the previous message shown',
  },

  capabilityDiff: {
    noOpenEither: 'No OPEN message captured for either side of this session',
    oneSidedWarning: (missingLabel: string) =>
      `No OPEN captured from ${missingLabel} — this is a one-sided comparison.`,
    sessionFields: 'Session Fields',
    mismatches: (count: number) => `Capability Mismatches${count > 0 ? ` (${count})` : ''}`,
    noMismatches: '✓ No capability mismatches detected',
    matchingCapabilities: (count: number) => `Matching Capabilities (${count})`,
    addPathResult: 'ADD-PATH Result',
    colAddressFamily: 'Address Family',
    colDirection: 'Direction',
    colPathIdentifiers: 'Path Identifiers',
    addPathSent: 'Sent',
    addPathNotSent: 'Not sent',
    addPathNeither: (from: string, to: string) =>
      `${from} does not send them and ${to} does not accept them`,
    addPathNoSend: (from: string) => `${from} did not advertise send for this family`,
    addPathNoReceive: (to: string) => `${to} did not advertise receive for this family`,
    legendAdvertised: 'advertised',
    legendNotAdvertised: 'not advertised',
    legendMismatch: 'mismatch',
    colField: 'Field',
    colStatus: 'Status',
    colCapability: 'Capability',
    fieldBgpVersion: 'BGP Version',
    fieldMyAs: 'My AS',
    fieldHoldTime: 'Hold Time',
    fieldBgpIdentifier: 'BGP Identifier',
    notCaptured: 'not captured',
    statusMatch: '✓ Match',
    statusMismatch: '⚠ Mismatch',
    statusAsInconsistent: '⚠ AS field inconsistent',
    statusSameAs: 'Same AS on both sides',
    statusDiffersEbgp: 'Differs — normal for eBGP',
    statusHoldDiffers: 'Differs — not an error, the lower value is negotiated',
    statusIdCollision: '⚠ Collision — same Router ID on both sides',
    statusIdUnique: '✓ Unique',
    asMismatchNote: (myAs: number, expected: number) =>
      `2-byte My AS field is ${myAs}, expected ${expected} given the 4-byte AS capability`,
    twoByteField: (fourByte: number, twoByte: number) =>
      `${fourByte} (2-byte field: ${twoByte})`,
    statusBoth: '✓ Both',
    statusOnly: (label: string) => `⚠ Only ${label}`,
    supported: 'Supported',
    capSupport: 'Support',
    capBytePayload: (len: number) => `${len} byte payload`,
    capGrDetail: (restartTime: number, flagsHex: string) =>
      `restart time ${restartTime}s, flags 0x${flagsHex}`,
    capGrAfLabel: (afi: string, safi: string) => `${afi} / ${safi} forwarding state`,
    capGrFlags: (flagsHex: string) => `flags 0x${flagsHex}`,
    capEnhLabel: (nlriAfi: string, nlriSafi: string, nhAfi: string) =>
      `${nlriAfi}/${nlriSafi} via ${nhAfi} next-hop`,
  },

  routes: {
    searchAria: 'Prefix search',
    searchPlaceholder: 'Filter by prefix (10.0.0.0/8), IP, AS65001 or MAC',
    clearSearchAria: 'Clear search',
    matchLabel: 'Match',
    matchExact: 'Exact',
    matchExactHint: 'Only the prefix and mask length typed',
    matchSubnets: 'Subnets',
    matchSubnetsHint: 'Routes announced inside the block typed',
    matchSupernets: 'Supernets',
    matchSupernetsHint: 'Less specific routes that cover the block typed',
    asnSearchNote: (asn: string) => `Prefixes with AS${asn} in their AS_PATH`,
    prefixStatistics: 'Prefix Statistics',
    showAllPeersTitle: 'Show routes from every peer',
    fromPeers: (peers: string) => `from ${peers} ✕`,
    prefixesCount: (count: number) => `${count} prefixes`,
    sorting: 'sorting...',
    colPrefix: 'Prefix',
    colAnnounced: 'Announced',
    colWithdrawn: 'Withdrawn',
    colLastSeen: 'Last Seen (UTC)',
    colFlap: 'Flap',
    colFlapTitle:
      'Times the route went away: withdrawals of a route the same peer had announced (or announced before the capture began). Re-announcing is not a flap, nor is a repeated withdrawal.',
    noPrefixesFound: 'No prefixes found',
    resizePrefixList: 'Resize the prefix list',
    routeHistory: (prefix: string | null) =>
      `Route History${prefix ? `: ${prefix}` : ''}`,
    oldestFirstTitle: 'Oldest first — click for newest first',
    newestFirstTitle: 'Newest first — click for oldest first',
    colTimeUtc: 'Time (UTC)',
    colDeltaTitle: 'Time since the previous event in time',
    colAction: 'Action',
    colPathId: 'Path ID',
    colPathIdTitle:
      "ADD-PATH Path Identifier (RFC 7911) — which of the peer's paths to this prefix this event is about",
    colRdTitle: 'Route Distinguisher — which leaf advertised this route',
    colFrom: 'From',
    colFromTitle: 'The peer this event arrived from',
    colNextHop: 'Next Hop',
    colMedTitle:
      'MULTI_EXIT_DISC — lower wins, and only between paths from the same neighbouring AS',
    colLocalPrefTitle: 'LOCAL_PREF — higher wins, and outranks AS_PATH length',
    colOrigin: 'Origin',
    colOriginTitle: 'ORIGIN — IGP beats EGP beats INCOMPLETE',
    colCommunities: 'Communities',
    actionAnnounce: 'Announce',
    actionWithdraw: 'Withdraw',
    selectPrefix: 'Select a prefix to view history',
    asPathAnalysis: 'AS_PATH Analysis',
    singlePath: 'single path',
    distinctPaths: (count: number) => `${count} distinct paths`,
    prependedTitle: (repeat: number) => `prepended ${repeat} times`,
    pathSeen: (isAlternate: boolean, count: number) =>
      `${isAlternate ? 'alternate, ' : ''}seen ${count} time${count > 1 ? 's' : ''}`,
  },

  sql: {
    title: 'SQL Console',
    duckdbNotInitialized: '⚠ DuckDB could not be started, so SQL is unavailable. Every other screen works without it; reopen this screen to try again.',
    duckdbLoading: 'Loading this capture into DuckDB. SQL becomes available when it finishes.',
    duckdbUnavailable:
      '⚠ This capture could not be loaded into DuckDB, so SQL is unavailable. Filtering on the other screens still works in-memory.',
    queryHeading: 'Query',
    shortcutHint: 'Ctrl+Enter to execute',
    editorAria: 'SQL query',
    run: 'Run',
    running: 'Running...',
    clear: 'Clear',
    executionTime: (ms: string) => `Execution: ${ms}ms`,
    resultsHeading: (count?: number) =>
      count !== undefined ? `Results (${count} rows)` : 'Results',
    exportCsv: 'Export CSV ↓',
    errorPrefix: 'Error:',
    noResults: 'Query returned no results',
    runPrompt: 'Run a query to see results',
    showingFirst100: (total: number) => `Showing first 100 of ${total} rows`,
    templatesHeading: 'Query Templates',
    historyHeading: 'Query History',
    schemaHeading: 'Schema',
    schemaHint: 'click a name to insert it',
    expandTableAria: (name: string) => `Expand ${name}`,
    collapseTableAria: (name: string) => `Collapse ${name}`,
    insertTitle: (name: string) => `Insert ${name}`,
    openFrameTitle: (frame: string) => `Open frame ${frame} in Messages`,
    openRouteTitle: (prefix: string) => `Open the route history of ${prefix}`,
    queryFailed: 'Query execution failed',
    templates: {
      neighborSummary: 'Neighbor Summary',
      asPathStats: 'AS_PATH Stats',
      prefixFlapping: 'Prefix Flapping',
      evpnMacMoves: 'EVPN MAC Moves',
      evpnRouteTargets: 'EVPN Route Targets',
      errorAnalysis: 'Error Analysis',
      messageTypes: 'Message Types',
    },
  },

  builder: {
    title: 'Build a capture',
    subtitle:
      'Describe a BGP session and get a pcap of it. Start from a scenario below, then change the addresses, AS numbers and routes to match the one you are working on.',
    scenarioLabel: 'Scenario',
    previewHeading: 'Preview',
    previewStats: (frames: number, size: string, bgpMessages: number) =>
      `${frames} frames · ${size} · ${bgpMessages} BGP messages`,
    downloadPcap: 'Download .pcap',
    openInAnalyzer: 'Open in analyzer',
    readBackWarning: 'The built file did not read back cleanly',
    colTime: 'Time',
    colSource: 'Source',
    colDestination: 'Destination',
    colLen: 'Len',
    colInfo: 'Info',
    sectionPeers: 'Peers',
    sectionCapture: 'Capture',
    sectionSequence: 'Sequence',
    peerConnects: 'connects',
    peerListens: 'listens on 179',
    peerBadge: (side: string) => `Peer ${side}`,
    fieldIp: 'IP address',
    fieldAs: 'AS number',
    fieldRouterId: 'Router ID',
    fieldHoldTime: 'Hold time (s)',
    fieldTcpPort: 'TCP port',
    fieldTcpPortHint: "Set both peers' ports to separate two sessions between one pair of addresses",
    fieldLinkType: 'Link type',
    fieldVlanIds: 'VLAN IDs',
    fieldVlanIdsHint: 'Outermost first. Two of them make a QinQ capture.',
    fieldMtu: 'MTU',
    fieldMtuHint: 'Lower it to split BGP messages across TCP segments',
    fieldDefaultGap: 'Default gap (ms)',
    noStepsYet: 'No steps yet. Add a TCP handshake to start a session.',
    addLabel: 'Add:',
    sentByAria: 'Sent by',
    fromA: (ip: string) => `from A (${ip})`,
    fromB: (ip: string) => `from B (${ip})`,
    delayFor: 'for',
    stepAfter: 'after',
    moveUp: 'Move up',
    moveDown: 'Move down',
    removeStep: 'Remove step',
    removeMessage: 'Remove message',
    sendHint: 'Sent as one write — messages that fit share a TCP segment.',
    fieldPrefixes: 'Prefixes',
    fieldNextHop: 'Next hop',
    fieldAsPath: 'AS path',
    fieldAsPathHint: 'Left to right, nearest AS first',
    fieldOrigin: 'Origin',
    fieldMed: 'MED',
    fieldCommunities: 'Communities',
    fieldCommunitiesHint: '65000:100, NO_EXPORT, …',
    endOfRibNote:
      'An empty UPDATE — the marker that the initial advertisement is complete (RFC 4724).',
    fieldErrorCode: 'Error code',
    fieldSubcode: 'Subcode',
    rawNote: 'Built as specified. This message has no form here, so it is kept as it was.',
    steps: {
      handshake: 'TCP handshake',
      open: 'OPEN',
      keepalive: 'KEEPALIVE',
      send: 'Send messages',
      close: 'TCP close (FIN)',
      reset: 'TCP reset (RST)',
      delay: 'Wait',
    },
    messages: {
      announce: 'Announce routes',
      withdraw: 'Withdraw routes',
      'end-of-rib': 'End-of-RIB',
      notification: 'NOTIFICATION',
      'route-refresh': 'ROUTE-REFRESH',
      raw: 'Other',
    },
    presets: {
      established: {
        name: 'Established session',
        description:
          'Handshake, OPEN exchange, route advertisement and End-of-RIB. A healthy baseline.',
      },
      'hold-timer': {
        name: 'Hold timer expired',
        description:
          'The session comes up, one side goes quiet, the other tears it down with NOTIFICATION 4/0.',
      },
      'bad-peer-as': {
        name: 'AS mismatch',
        description:
          'The OPEN is rejected with NOTIFICATION 2/2 because remote-as does not match.',
      },
      'connection-refused': {
        name: 'TCP rejected — no BGP at all',
        description:
          'SYN answered with RST, three times over. What an MD5 mismatch or an ACL looks like.',
      },
      ipv6: {
        name: 'IPv6 transport',
        description:
          'A session over IPv6 carrying IPv6 routes in MP_REACH_NLRI and MP_UNREACH_NLRI.',
      },
      flap: {
        name: 'Flapping route',
        description:
          'One prefix announced and withdrawn five times over, for the route analysis screen.',
      },
      'four-byte-as': {
        name: '4-byte AS numbers',
        description:
          'AS_TRANS in the OPEN with the real ASN in the capability, and a 4-byte AS_PATH.',
      },
      segmented: {
        name: 'UPDATE split across segments',
        description:
          'A 400-prefix advertisement at a 576-byte MTU, so messages span TCP segments.',
      },
    } as Record<string, { name: string; description: string }>,
  },

  manual: {
    contentsAria: 'Manual contents',
    contentsHeading: 'Contents',
    footerPrefix: 'BGPShark ships fonts and libraries written by other people.',
    footerLink: 'Their licenses',
    footerSuffix: '.',
  },

  filterSuggestions: {
    andDesc: 'AND condition',
    orDesc: 'OR condition',
    opEq: 'Equals',
    opNeq: 'Not equals',
    opLt: 'Less than',
    opLte: 'Less than or equal',
    opGt: 'Greater than',
    opGte: 'Greater than or equal',
    opContains: 'Contains',
    fields: {
      type: 'Message type',
      src_ip: 'Source IP (packets.src_ip)',
      dst_ip: 'Destination IP (packets.dst_ip)',
      src_port:
        'TCP source port — one side of a session; both: src_port = 179 or dst_port = 179',
      dst_port: 'TCP destination port — pairs with src_port to separate colliding sessions',
      frame: 'Frame number (the # column) — ranges with < <= > >=, e.g. frame >= 100',
      router_id: 'Router ID (messages.router_id)',
      src_as: 'Source AS (from OPEN message)',
      asn: 'AS in AS_PATH (as_path.asn)',
      origin: 'Origin (path_attributes.origin_value)',
      med: 'MULTI_EXIT_DISC — ranges with < <= > >=, e.g. med > 100. Absent on an UPDATE that carries none',
      local_pref:
        'LOCAL_PREF — ranges with < <= > >=, e.g. local_pref >= 200. iBGP only; eBGP UPDATEs carry none',
      next_hop: 'Next Hop (path_attributes.next_hop)',
      prefix: 'Prefix announced or withdrawn — the whole history of a route',
      nlri: 'Announced prefix only (nlri.prefix)',
      withdrawn: 'Withdrawn prefix only (withdrawn.prefix)',
      community: 'Community (communities.formatted)',
      rt: 'Route Target, e.g. rt = 65001:100 — what decides which VRF a route lands in',
      ext_community:
        'Extended community as displayed, e.g. ext_community contains "MAC Mobility"',
      mac: 'MAC in an EVPN route — follows one host, announced or withdrawn',
      vni: 'VNI carried by an EVPN route — narrows a capture to one bridge domain',
      rd: 'Route Distinguisher of an EVPN route, e.g. rd = 10.0.0.1:100',
      evpn_type: 'EVPN route type: 1 A-D, 2 MAC/IP, 3 IMET, 4 Ethernet Segment, 5 IP Prefix',
      capability: 'Capability (capabilities.name)',
    } as Record<string, string>,
  },
}

/**
 * Structural message catalog shape: every string literal widens to `string` so
 * other locales provide translated strings while preserving every key and
 * function signature.
 */
type WidenStrings<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => WidenStrings<R>
    : T extends object
      ? { [K in keyof T]: WidenStrings<T[K]> }
      : T

export type Messages = WidenStrings<typeof en>
