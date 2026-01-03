# BGP Packet Analyzer - Requirements & Design Document

## 1. Project Overview

### 1.1 Product Name
BGP Packet Analyzer

### 1.2 Concept
A lightweight, web-based pcap analyzer specialized for BGP session troubleshooting. Quickly inspect and analyze BGP messages in the browser without launching Wireshark.

### 1.3 Target Users
- IXP operators
- ISP NOC engineers
- Network engineers working with BGP
- Networking students

### 1.4 Hosting
GitHub Pages (fully static site)

---

## 2. Functional Requirements

### 2.1 MVP Features (Phase 1)

#### 2.1.1 Pcap File Loading
- Drag & drop or file picker to upload pcap
- Supported format: libpcap (.pcap)
- Client-side parsing (no server upload)
- File size limit: ~10MB

#### 2.1.2 BGP Message Extraction
- Auto-filter packets on TCP port 179
- Identify BGP message types:
  - OPEN (Type 1)
  - UPDATE (Type 2) - display only, detailed parsing in Phase 2
  - NOTIFICATION (Type 3)
  - KEEPALIVE (Type 4) - display only

#### 2.1.3 OPEN Message Analysis
| Field | Display |
|-------|---------|
| Version | BGP version (typically 4) |
| My Autonomous System | ASN (2-byte/4-byte support) |
| Hold Time | Seconds |
| BGP Identifier | Router ID (IPv4 format) |
| Optional Parameters | Expanded Capabilities view |

**Supported Capabilities**
- Multiprotocol Extensions (Code 1) - AFI/SAFI display
- Route Refresh (Code 2)
- 4-byte AS Number (Code 65)
- Graceful Restart (Code 64)
- ADD-PATH (Code 69)
- Extended Next Hop Encoding (Code 5)

#### 2.1.4 NOTIFICATION Message Analysis
| Field | Display |
|-------|---------|
| Error Code | Code value + name |
| Error Subcode | Subcode value + name |
| Data | Hex dump of relevant bytes |
| Hint | Common causes & troubleshooting tips |

**Supported Error Codes**
| Code | Name | Example Subcodes |
|------|------|------------------|
| 1 | Message Header Error | Bad Message Length, Bad Message Type |
| 2 | OPEN Message Error | Unsupported Version, Bad Peer AS, Bad BGP Identifier, Unsupported Capability |
| 3 | UPDATE Message Error | Malformed Attribute List, Invalid NEXT_HOP, etc. |
| 4 | Hold Timer Expired | - |
| 5 | FSM Error | - |
| 6 | Cease | Admin Shutdown, Peer De-configured, etc. |

#### 2.1.5 Packet List View
- Timestamp
- Source/Destination IP
- BGP message type
- Summary info (e.g., "OPEN AS65001 Hold=90")

#### 2.1.6 Detail View
- Click packet to show detail panel
- Hierarchical field display
- Hex dump of relevant bytes

### 2.2 Future Features (Phase 2+)

- pcapng format support
- UPDATE message detailed parsing (AS_PATH, NLRI, Withdrawn, etc.)
- Side-by-side OPEN comparison (Capability diff)
- Timeline visualization
- Filter functionality
- URL fragment state sharing

---

## 3. Non-Functional Requirements

### 3.1 Performance
- Parse 1000-packet pcap within 3 seconds
- Maintain 60fps UI

### 3.2 Browser Support
- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)

### 3.3 Security
- All processing client-side only
- No external data transmission
- Content Security Policy configured

### 3.4 Accessibility
- Keyboard navigation support
- Basic screen reader support

---

## 4. Technical Design

### 4.1 Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | React 18 |
| Language | TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS |
| State Management | React hooks (useState/useReducer) |
| Testing | Vitest + React Testing Library |
| Deployment | GitHub Actions → GitHub Pages |

### 4.2 Directory Structure

```
bgp-analyzer/
├── public/
│   └── sample.pcap              # Sample file
├── src/
│   ├── components/
│   │   ├── App.tsx
│   │   ├── FileDropzone.tsx     # File upload
│   │   ├── PacketList.tsx       # Packet list
│   │   ├── PacketDetail.tsx     # Detail view
│   │   ├── OpenMessage.tsx      # OPEN analysis view
│   │   ├── NotificationMessage.tsx  # NOTIFICATION analysis view
│   │   └── HexDump.tsx          # Byte display
│   ├── lib/
│   │   ├── pcap/
│   │   │   ├── parser.ts        # Pcap file parser
│   │   │   ├── types.ts         # Pcap type definitions
│   │   │   └── reader.ts        # Binary reading utilities
│   │   └── bgp/
│   │       ├── parser.ts        # BGP message parser
│   │       ├── types.ts         # BGP type definitions
│   │       ├── open.ts          # OPEN message parsing
│   │       ├── notification.ts  # NOTIFICATION message parsing
│   │       ├── capabilities.ts  # Capability parsing
│   │       └── errors.ts        # Error Code/Subcode definitions
│   ├── hooks/
│   │   ├── usePcapParser.ts
│   │   └── usePacketSelection.ts
│   ├── utils/
│   │   └── format.ts            # Display formatting functions
│   ├── main.tsx
│   └── index.css
├── tests/
│   ├── pcap/
│   └── bgp/
├── .github/
│   └── workflows/
│       └── deploy.yml           # GitHub Pages deployment
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

### 4.3 Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  User                                                           │
└─────────────────────────────────────────────────────────────────┘
        │ Drop pcap file
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  FileDropzone                                                   │
│  - Get binary via File API                                      │
│  - Read as ArrayBuffer                                          │
└─────────────────────────────────────────────────────────────────┘
        │ ArrayBuffer
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  pcap/parser.ts                                                 │
│  - Parse Global Header                                          │
│  - Sequentially parse Packet Header + Data                      │
│  - Strip Ethernet → IP → TCP                                    │
│  - Filter TCP port 179                                          │
└─────────────────────────────────────────────────────────────────┘
        │ RawPacket[]
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  bgp/parser.ts                                                  │
│  - Validate BGP Marker                                          │
│  - Determine Message Type                                       │
│  - Dispatch to type-specific parsers                            │
└─────────────────────────────────────────────────────────────────┘
        │ BgpMessage[]
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  React State                                                    │
│  - packets: BgpPacket[]                                         │
│  - selectedIndex: number | null                                 │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────┬─────────────────────────────────────────┐
│  PacketList           │  PacketDetail                           │
│  - List display       │  - OpenMessage / NotificationMessage    │
│  - Click to select    │  - HexDump                              │
└───────────────────────┴─────────────────────────────────────────┘
```

### 4.4 Key Type Definitions

```typescript
// pcap/types.ts
interface PcapGlobalHeader {
  magicNumber: number;
  versionMajor: number;
  versionMinor: number;
  snapLen: number;
  network: number; // Link-layer type
}

interface PcapPacket {
  timestamp: Date;
  capturedLength: number;
  originalLength: number;
  data: Uint8Array;
}

// bgp/types.ts
type BgpMessageType = 'OPEN' | 'UPDATE' | 'NOTIFICATION' | 'KEEPALIVE';

interface BgpPacket {
  timestamp: Date;
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  message: BgpMessage;
  rawData: Uint8Array;
}

interface BgpOpenMessage {
  type: 'OPEN';
  version: number;
  myAs: number;
  holdTime: number;
  bgpIdentifier: string;
  capabilities: BgpCapability[];
}

interface BgpNotificationMessage {
  type: 'NOTIFICATION';
  errorCode: number;
  errorSubcode: number;
  errorName: string;
  errorSubcodeName: string;
  data: Uint8Array;
  hint: string; // Troubleshooting hint
}

interface BgpCapability {
  code: number;
  name: string;
  length: number;
  value: Uint8Array;
  parsed?: CapabilityDetail; // Parsed data
}
```

### 4.5 Pcap Format Specification

#### Global Header (24 bytes)
| Offset | Length | Field |
|--------|--------|-------|
| 0 | 4 | Magic Number (0xa1b2c3d4 or 0xd4c3b2a1) |
| 4 | 2 | Version Major |
| 6 | 2 | Version Minor |
| 8 | 4 | Reserved1 (thiszone) |
| 12 | 4 | Reserved2 (sigfigs) |
| 16 | 4 | SnapLen |
| 20 | 4 | Network (Link-Layer Type) |

#### Packet Header (16 bytes)
| Offset | Length | Field |
|--------|--------|-------|
| 0 | 4 | Timestamp (seconds) |
| 4 | 4 | Timestamp (microseconds) |
| 8 | 4 | Captured Length |
| 12 | 4 | Original Length |

### 4.6 BGP Message Structure

#### Common Header (19 bytes)
| Offset | Length | Field |
|--------|--------|-------|
| 0 | 16 | Marker (all 1s) |
| 16 | 2 | Length |
| 18 | 1 | Type |

#### OPEN Message
| Offset | Length | Field |
|--------|--------|-------|
| 0 | 1 | Version |
| 1 | 2 | My Autonomous System |
| 3 | 2 | Hold Time |
| 5 | 4 | BGP Identifier |
| 9 | 1 | Opt Param Length |
| 10 | variable | Optional Parameters |

---

## 5. UI Design

### 5.1 Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: BGP Packet Analyzer                          [GitHub]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                                                           │  │
│  │     Drop pcap file here or click to select               │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
├────────────────────────────┬────────────────────────────────────┤
│  Packet List               │  Packet Detail                     │
│  ─────────────────────────│  ────────────────────────────────  │
│  #  Time     Type    Info  │                                    │
│  1  00:00.00 OPEN    AS65001│  ▼ BGP OPEN Message               │
│  2  00:00.01 OPEN    AS65002│    Version: 4                     │
│  3  00:05.00 KEEPALIVE     │    My AS: 65001                    │
│ >4  00:10.00 NOTIFICATION  │    Hold Time: 90                   │
│                            │    BGP Identifier: 10.0.0.1        │
│                            │                                    │
│                            │  ▼ Capabilities                    │
│                            │    Multiprotocol: IPv4 Unicast     │
│                            │    4-byte AS: 65001                │
│                            │    Route Refresh: Supported        │
│                            │                                    │
│                            │  ▼ Hex Dump                        │
│                            │  0000: ff ff ff ff ff ff ff ff     │
│                            │  0008: ff ff ff ff ff ff ff ff     │
│                            │                                    │
└────────────────────────────┴────────────────────────────────────┘
```

### 5.2 NOTIFICATION Display Example

```
▼ BGP NOTIFICATION Message

  Error Code: 2 (OPEN Message Error)
  Error Subcode: 2 (Bad Peer AS)

  ┌─────────────────────────────────────────────────────────┐
  │ 💡 Common Cause                                         │
  │                                                         │
  │ The remote-as configured in your neighbor statement     │
  │ does not match the ASN sent by the peer.                │
  │                                                         │
  │ Check:                                                  │
  │ - Your "neighbor X.X.X.X remote-as" value               │
  │ - Peer's "router bgp" configuration                     │
  └─────────────────────────────────────────────────────────┘

  Data (hex):
  0000: 00 00 fd e9
```

---

## 6. Development Plan

### Phase 1: MVP (2-3 weeks)

| Week | Tasks |
|------|-------|
| Week 1 | Project setup, pcap parser implementation, tests |
| Week 2 | BGP parser (OPEN/NOTIFICATION), basic UI |
| Week 3 | UI polish, error handling, GitHub Pages deployment |

### Phase 2: Feature Expansion (Future)

- UPDATE message parsing
- Capability comparison feature
- pcapng support
- Dark mode

---

## 7. Constraints & Assumptions

- BGP messages spanning TCP segments: not supported initially
- IPv4 only (IPv6 in Phase 2)
- Ethernet II frames only (VLAN tags in Phase 2)
- BGP over TCP port 179 only

---

## 8. Success Criteria

- Parse pcap and display BGP messages within 3 seconds
- Correctly display all major fields for OPEN/NOTIFICATION
- Enable first-level BGP session troubleshooting without Wireshark installed