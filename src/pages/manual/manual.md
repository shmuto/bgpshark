# BGPShark user manual

BGPShark analyzes packet captures to show what happened inside your BGP sessions—whether a session failed to establish, flapped, dropped routes, or selected an unexpected path.

All processing runs locally in your browser. Captures are never uploaded, no external requests are made, and the app continues to work offline.

## Loading a capture

Drop a file anywhere in the window, or select one from the start screen. `.pcap`, `.pcapng`, and `.cap` files up to 300 MB are supported, and the format is detected automatically.

Large captures take several seconds to load, about ten near the 300 MB limit, while a progress bar tracks each stage. The packet list opens as soon as the capture is decoded. The capture is imported into DuckDB only when you open **SQL**, with a small **DuckDB** gauge in the header until it finishes; near the limit that can take up to two minutes. Every other screen, filtering included, works without it.

If you do not have a capture handy, click **Try with sample.pcapng** to explore a sample session, or open **Build** (in the **⋯** menu at the top right) to generate a synthetic capture.

The loaded capture is stored in your browser's local storage (IndexedDB) and restored automatically when you reload the page. Click the file name at the top left to clear it and load another capture.

### If the capture looks wrong

A yellow warning banner under the header indicates that part of the file could not be parsed cleanly (for example, a truncated capture or corrupted block). Click the banner to inspect the details; the rest of the capture is still analyzed.

Three caveats to keep in mind when reading results:

- **One-way captures raise a critical finding, but the cause is up to you to verify.** The findings cannot distinguish a broken mirror or one-sided `tcpdump` filter from a real one-way reachability outage (such as a unidirectional link or one-way ACL). See [The capture may be lying to you](#the-capture-may-be-lying-to-you) to tell them apart quickly.
- **TCP-level frames are hidden by default.** The packet list shows BGP messages only until you switch it to **All Packets**. TCP resets (`[R]`) and closes (`[F]`) only appear in **All Packets** mode. A filter stays applied there: frames without BGP are matched on `src_ip`, `dst_ip`, `src_port`, `dst_port` and `frame`, so `src_ip = 10.0.13.1` shows that peer's handshake and teardown alongside its BGP, while a BGP-only condition such as `type = UPDATE` leaves only the BGP frames it names.
- **Mid-session captures lack OPEN messages.** Encoding options such as 4-byte AS_PATH width and ADD-PATH Path Identifiers are negotiated in OPEN and are not self-describing inside UPDATE messages. When OPENs are missing, BGPShark infers these settings from the message structure and adds a note in the warning banner. Re-capture from before session establishment whenever possible.

## The screens

A loaded capture opens in one workspace. The left column lists the capture's **Sessions** and its **Findings**; the views are tabs on the right; a **time strip** runs across the top. If you are not sure where to start, read the findings, or jump to [Investigating by symptom](#investigating-by-symptom).

| Tab | What it answers |
|-----|-----------------|
| **Messages** | What exact packets and bytes were exchanged? |
| **Sessions** | What did a pair of peers negotiate in OPEN, and when did it go up or down? |
| **Routes** | What happened to a specific prefix? |
| **SQL** | Custom aggregations and cross-prefix queries |

**Build**, **Help** and the link to the source code are in the **⋯** menu at the top right, apart from the capture's views.

### The workspace

**Sessions** lists every pair of addresses that exchanged BGP (or tried to, on TCP port 179), with their AS numbers, message count and the worst finding against them. Choose a session to narrow **every tab** to it: the packet list, the routes, the time strip and the findings. Route findings (route flapping, AS_PATH changes, MAC moves, withdrawal bursts) are then counted over that session's messages alone, and say *In this session*. The chosen session is shown at the right of the tab row; click **×** there, or **All sessions**, to go back to the whole capture.

**Findings** are the problems the capture shows, folded one row per kind of problem rather than per packet: a hard reset on a router with three sessions is one *NOTIFICATION: Cease / Hard Reset ×3* row, not three. The worst kind comes first and starts expanded; click a row to list its instances, and click an instance to open the packet it is about in **Messages**, with a filter already applied. Opening a finding does not change the chosen session, so you can step through every instance of one problem.

Findings cover NOTIFICATIONs, session flapping, withdrawal bursts, route flapping, AS_PATH changes within one session, EVPN MAC moves, graceful restarts, silent TCP teardowns, one-way sessions, and TCP connections that receive no BGP reply. *Cease / Connection Collision Resolution* is listed last as **Info**: it is how BGP closes one of two connections when both ends dial at once (RFC 4271 §6.8), not a failure. Different AS_PATHs from *different* peers (an iBGP peer's empty path next to an eBGP peer's `65001`) are normal and raise nothing; compare them on **Routes**.

> "No issues detected" means every session in the capture stayed healthy at the session layer. It does not rule out policy problems such as route leaks or unexpected best-path selection.

The **time strip** shows how many messages were exchanged over the whole capture (for the chosen session, if there is one), with NOTIFICATIONs drawn as red rules. Drag across it to narrow **Messages** and **Routes** to that window; click it, or **Show all**, to go back. Findings, the OPEN comparison and SQL always cover the whole capture; opening a packet from one of them that lies outside the window clears the window, so the packet can be shown.

### Messages

Shows the packet list, a structured detail pane, and a foldable hex dump. Click any row to inspect decoded fields down to individual capabilities, path attributes, and raw bytes.

The **Info** column summarizes each message (for example, `AS65001 Hold=90` for OPEN, the announced prefixes and the struck-through withdrawn ones for UPDATE, with `+N` when there are more, or the error name for NOTIFICATION). Empty UPDATE messages are labeled **End-of-RIB**.

Use **Columns** (at the right end of the filter row) to toggle timestamp and port columns. The line under the list says how many packets are shown, and **Export** there saves them as a new `.pcap` file (handy for attaching only the relevant frames to a ticket). KEEPALIVE-only rows are drawn lighter so the rows that changed something stand out.

Each UPDATE is one card listing its announced and withdrawn prefixes (including those carried in MP_REACH/MP_UNREACH_NLRI) and its path attributes, each once. **Raw Data** is folded; opening it is remembered as you move between packets with `↑`/`↓`. A KEEPALIVE shows the gap since its sender's previous message and how much of the negotiated hold time that gap used. Leaving **Messages** for another tab and coming back through its tab restores the filter, **All Packets** mode, and the selected frame.

### Sessions

With no session chosen, this tab is a table of every session: its AS numbers and whether it is iBGP or eBGP, its state when the capture ended, its message counts and its worst finding. Click a row (or choose a session in the left column) to open it.

A chosen session shows, from the top: its state, the hold time both ends agreed on, its NOTIFICATION and message counts, and the prefixes each end announced and withdrew; the **OPEN comparison**, which compares the latest OPEN from each end side by side; and its **Events**, the OPENs and NOTIFICATIONs with the time since the previous one (**All** lists every message). Click an event to open it in **Messages**.

Capabilities are compared per address family (AFI/SAFI), with mismatches listed first. Different Hold Times are marked informational (the lower value is negotiated), while duplicate BGP Identifiers are flagged as errors.

### Routes

Lists every announced or withdrawn prefix with announce count, withdraw count, last-seen timestamp, and **Flap** count. **Flap** counts the times the route went away: each withdrawal of a route the same session had announced (or had announced before the capture began). Re-announcing is not a flap, and neither is withdrawing a route that is already withdrawn, so in the sample capture 1.1.1.1/32, announced 6 times and withdrawn twice, has 2 flaps. A session is a sender and a receiver, so on a route server or route reflector each neighbour's copy of the route is counted on its own: a member's withdrawal passed on to three others is three flaps, and different paths sent to different members under their own policies are not an AS_PATH change. When one peer sends the route to several neighbours, the route history adds a **To** column. The SQL console's *Prefix Flapping* template counts the same way. Sort by **Flap** to spot unstable routes, and click a prefix to view its full announcement history and AS_PATHs (on a wide screen the top prefix is opened for you). On a capture with more than 50,000 routes the list first appears in capture order, with *sorting...* beside the count until it is sorted. The search applies as you type; clicking a history row opens **Messages** filtered to that prefix with the UPDATE selected.

The search box supports three match modes:

- **Exact** — Matches only the exact prefix entered.
- **Subnets** — Matches more-specific routes inside the entered CIDR (e.g. `10.0.0.0/8` finds `10.0.12.0/24`).
- **Supernets** — Matches less-specific routes covering the entered IP or CIDR (e.g. `10.0.12.7` finds `10.0.0.0/8`).

### SQL

Exposes the capture as queryable DuckDB tables for custom analysis across many prefixes or sessions. The sidebar **Schema** lists every table and column with its type; click a name to insert it at the cursor. **Query Templates** has ready-made examples, and the editor can be made taller from its bottom-right corner.

In the results, a `frame_index` value opens that frame in **Messages** and a `prefix` value opens its route history on **Routes** (exactly, when the row also has `prefix_length`).

Three details to keep in mind when writing SQL:

- `nlri.prefix` does not include the mask length. Combine it with `prefix || '/' || prefix_length`.
- `nlri`, `as_path`, and `path_attributes` all join on `message_id`. Joining all three directly multiplies rows; use correlated subqueries instead.
- Tables are flattened projections of the parsed messages and hold no raw frame bytes. Follow `frame_index` back to **Messages** when you need the full decoded detail or the bytes themselves.

Example—compare paths for the same prefix:

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

### Build

Generates a valid `.pcap` file from a session description—useful when you need a reproduction capture without spinning up a lab. No loaded capture is required.

Pick one of the presets (established session, hold timer expiry, bad peer AS, refused TCP connection, IPv6 transport, flapping route, 4-byte AS, or segmented UPDATEs), customize peers, routes, and steps, then inspect or download the capture.

UPDATE encoding (AS width and ADD-PATH Path Identifiers) follows automatically from the configured OPEN capabilities, and TCP segment boundaries follow the configured MTU (lower the MTU to generate segmented BGP messages). Checksums are computed properly so the exported `.pcap` works in Wireshark and other tools.

## Investigating by symptom

Use this section to go directly from an operational symptom to the screen and evidence that explain it.

### Start here

Regardless of the symptom, start with the same three checks:

1. Read the **Findings** in the left column. The worst kind is at the top and already expanded.
2. Verify that the capture contains both directions (see [The capture may be lying to you](#the-capture-may-be-lying-to-you)).
3. Click an instance of the top finding to open the starting packet with its filter pre-applied.

![The workspace on a capture of a flapping session: the session list and findings on the left, the time strip with NOTIFICATIONs drawn in red, and the packet list](manual/workspace.png)

Remember that *"No issues detected — every session looks healthy"* only reflects session-layer health; policy issues such as route leaks and best-path surprises still show this message.

### “The session will not come up”

The neighbor stays in Idle or Connect and no BGP messages are exchanged. You need to see how port 179 responds to the TCP SYN.

Read the **Findings**. When a capture contains no BGP messages, findings are derived from the TCP layer:

![A critical finding reading "TCP connections to port 179 are being refused — 3 SYNs answered by RST"](manual/s1-tcp-refused.png)

- **SYNs answered by RST** — Something is actively refusing port 179 (ACL/firewall, TCP-MD5/TCP-AO mismatch, or BGP not listening on the peer).
- **SYNs with no reply** — Packets or replies are being dropped below BGP (routing or filtering).
- **SYN-ACK, then no BGP** — The findings report *"TCP connects but 10.0.0.2 sends no BGP"*. Because TCP connected, the port is open, SYN is not blocked, and TCP-MD5 matches. Check whether the peer has your neighbor configured, or whether a middlebox, PMTU black hole, or control-plane policing is dropping the OPEN payload.

Switch **Messages** to **All Packets** to inspect retry counts and timing (BGP Only will be empty).

### “It is Established, but a whole address family never arrives”

IPv4 routes work, but IPv6, EVPN, or VPNv4 routes never appear.

Choose the session in the left column and open the **Sessions** tab to see its **OPEN comparison**:

![The OPEN comparison: session fields matching, and four capabilities advertised by only one end, including IPv6/Unicast Multiprotocol Extensions](manual/s2-capability-diff.png)

Check the **Status** column:

- **⚠ Only *x*** — Only one side advertised that capability or AFI/SAFI. Routes for that family cannot be exchanged until both peers enable it.
- **Differs — normal for eBGP** (My AS) and differing Hold Times are normal.
- **Duplicate BGP Identifier** is flagged as an error.

### “It flaps every few minutes”

The findings fold repeated teardowns into a single NOTIFICATION row with a count, alongside a session-flapping warning:

![Findings reading "NOTIFICATION: Hold Timer Expired / Unspecific ×3" and "Session flapping detected — 6 OPEN messages (~3 establishments)"](manual/s3-holdtimer-alerts.png)

`Hold Timer Expired` indicates that one peer stopped receiving messages from the other. Open **Messages** and click the NOTIFICATION to check **Silence before the teardown**:

![The NOTIFICATION detail: 90.4 seconds since the last KEEPALIVE from 10.0.0.1, against a negotiated hold time of 90 seconds](manual/s3-holdtimer-gap.png)

- **Silence ≥ negotiated hold time** (e.g. 90.4s against 90s): KEEPALIVEs stopped arriving in one direction while the session was otherwise up. Investigate the network path rather than BGP configuration.
- **Silence much shorter than hold time**: Flagged as firing early—either the capture dropped packets or the active hold time differed from the captured OPENs.

The silence is measured from the **peer's** last message (not simply the previous packet in the list, which may be the local router's own KEEPALIVE) and compared against the lower Hold Time from the OPENs preceding that teardown. If OPENs are missing from the capture, the silence is still reported without a comparison.

### “It dropped, and nothing says why”

No NOTIFICATION appears in the capture, yet the session dropped and re-established. The teardown happened at the TCP layer.

Read the **Findings**. Silent teardowns appear as critical findings, one per teardown type:

- *"…was reset with no NOTIFICATION"* (TCP RST — active rejection such as a firewall or reset socket)
- *"…was closed with no NOTIFICATION"* (TCP FIN — polite close such as a session idle timeout)

Click either finding to switch **Messages** to **All Packets** and select the exact frame.

![The findings with two critical rows — one reading "10.0.0.1 ↔ 10.0.0.2 was reset with no NOTIFICATION", one "was closed with no NOTIFICATION" — above a "Session flapping detected" warning](manual/s11-teardown-alerts.png)

These findings appear alongside *"Session flapping detected"*: flapping counts how many times the session re-established, while the teardown rows show how it went down. Sessions that never established are excluded here (they are covered by *"TCP connects but the peer sends no BGP"*).

To inspect manually, switch **Messages** to **All Packets** (gaps in frame numbers in BGP Only mode also point to hidden TCP frames):

![The packet list in All Packets mode with frame 11 selected: an [AR] frame from 10.0.0.2, and a detail pane reading "TCP Flags: ACK, RST"](manual/s11-tcp-reset.png)

`[AR]` marks ACK+RST and `[F]` marks FIN. TCP flags do not have a filter field, so use **All Packets** to scan for them.

### “The session drops the moment routes are advertised”

The session establishes cleanly, then drops right after the first UPDATE. Open **Messages** and click the NOTIFICATION:

![A NOTIFICATION detail: error code 3 UPDATE Message Error, subcode 2 Unrecognized Well-known Attribute, a troubleshooting hint, the data field decoded as UNKNOWN(199) marked Well-known and Transitive, and the raw bytes below it](manual/s6-notification.png)

Error code **3** (`UPDATE Message Error`) and its subcode pinpoint why the peer rejected the UPDATE (such as `Unrecognized Well-known Attribute`, `Invalid NEXT_HOP`, or `Malformed AS_PATH`), along with a **Troubleshooting Hint**.

BGPShark decodes the NOTIFICATION data field above the raw bytes:

- **Error code 3**: Shows the offending attribute along with its type and flags (for example, an unknown attribute incorrectly marked **Well-known**). Compare it with the preceding UPDATE, where unrecognized attributes appear as `UNKNOWN(199) · Transitive · Unparsed`.
- **Other codes**: Decodes the mismatched AS on `Bad Peer AS`, refused capabilities on `Unsupported Capability`, and RFC 9003 administrative shutdown messages on Cease (often containing a maintenance window or ticket number).

### “A prefix is missing”

Open **Routes** and search using the appropriate match mode:

- **Exact** — Look for the exact prefix.
- **Subnets** — Check whether the peer is sending more-specific prefixes inside a summary block (e.g. `10.0.0.0/8` finds `10.0.12.0/24`).
- **Supernets** — Find which aggregate route covers a specific host IP (e.g. `10.0.12.7`).

If nothing matches, the prefix was never advertised on this session (check the peer's export policy). If the prefix is missing for an entire address family, check the **OPEN comparison** on the **Sessions** tab.

UPDATEs split across multiple TCP segments are reassembled automatically before parsing, so large segmented UPDATEs still report their full prefix counts.

### “Only one path arrives, though the peer has several”

By default, a peer or route reflector advertises only its best path unless **ADD-PATH** (RFC 7911) is negotiated in both directions.

Choose the session and open the **Sessions** tab, then check **ADD-PATH Result** below the capability table. Because ADD-PATH is directional—the sender must advertise *send* and the receiver must advertise *receive*—two peers both configured only for *send* can look matched in the capability table while exchanging no Path Identifiers at all. **ADD-PATH Result** shows the actual per-direction outcome and names whichever half is missing.

When ADD-PATH is active, prefix chips in packet details show `10.1.0.0/24 path 2`, and the route history displays a **Path ID** column so you can distinguish withdrawing one path from withdrawing the entire prefix.

### “Traffic leaves by the wrong upstream”

Open **Routes** and select the prefix. The route history compares every announcement per peer with the attributes used in best-path selection: AS_PATH, Next Hop, MED, LOCAL_PREF, and communities.

![The route history for 172.20.0.0/16 with two announcements side by side: the short AS_PATH carrying MED 300 and no LOCAL_PREF, the long one carrying MED 10 and LOCAL_PREF 200](manual/s4-bestpath.png)

In the example above, the longer AS_PATH wins because it carries `LOCAL_PREF 200` (evaluated before AS_PATH length), while `MED 300` on the shorter path is never compared.

- A dash (`-`) means the attribute was omitted from the UPDATE, not that its value was `0`.
- Optional attribute columns appear only when present on the selected route; `ORIGIN` appears only when announcements disagree on it.

To filter across many prefixes at once, use `med` and `local_pref` with range operators:

```
med > 100
local_pref = 200
prefix = 172.20.0.0/16 and local_pref >= 200
```

UPDATEs without MED or LOCAL_PREF do not match comparisons on those fields. Note that a capture shows what crossed the wire, not which path the router installed in its RIB.

### “CPU is high and the RIB will not settle”

Route churn appears directly in the **Findings**: route flapping and AS_PATH changes, each listing the prefixes involved, and withdrawal bursts:

![Findings for route flapping and AS_PATH changes, expanded to their prefixes,, ending in "Burst of withdrawn prefixes — 60 prefixes withdrawn within 10s"](manual/s10-churn-alerts.png)

Next, open **Routes**, sort by **Flap** (click twice for highest first), and select the top prefix:

![The Routes screen sorted by flap count, with one prefix's history of alternating announce and withdraw, and an AS_PATH Analysis panel showing two distinct paths](manual/s10-churn-routes.png)

Use the **From** column and **AS_PATH Analysis** to localize the instability:

- Repeating announce/withdraw cycles from one peer point to an unstable link or flapping interface behind that peer.
- Repeating announcements from one peer alternating between multiple AS_PATHs indicate instability further upstream.

### “A peer is announcing routes it has no business announcing”

Because a route leak occurs over a healthy BGP session, the findings report *"No issues detected"*.

On **Routes**, type an AS number such as `AS15169` in the search box to list every prefix containing that AS anywhere in its AS_PATH, then select a prefix to inspect the full path:

![The Routes screen filtered to prefixes with AS15169 in their path, with 8.8.8.0/24 selected and an AS_PATH of AS65100 → AS65001 → AS15169](manual/s5-route-leak.png)

For example, seeing `AS65100 AS65001 AS15169` on a session with customer `AS65100` shows the customer is re-announcing routes learned from another transit provider. You can also filter packets directly in **Messages** using `asn = 15169`.

### “A host in the fabric drops out in bursts”

An EVPN MAC move appears as a withdrawal from one leaf and an advertisement from another. Filter by MAC address in **Messages**:

```
mac = 00:0c:29:aa:bb:cc
```

![The packet list filtered to one MAC: an announcement from 10.0.0.2, a withdrawal from 10.0.0.2, an announcement from 10.0.0.1, with the withdrawn route decoded to its RD and VNI](manual/s13-mac-move.png)

`mac`, `vni`, `rd`, and `evpn_type` match both announcements and withdrawals, and the detail view decodes RD, MAC, VNI, and ESI. Repeated advertisements of the same MAC from two VTEPs point to a MAC move loop (typically a dual-homed host misconfiguration or bridge loop).

**Routes** tracks the MAC's full history, and the findings flag the move itself as *"MAC moved"* (naming the VTEP it left and the one it moved to) alongside *"Route flapping"*. MAC Mobility extended communities are decoded in packet details, though sequence numbers are not compared automatically.

### “After a reload, or after a soft clear”

Both events produce large bursts of BGP traffic that can resemble an outage.

**Graceful restart** is identified in the **Findings** as *"10.0.0.1 restarted gracefully"* instead of *"Session flapping detected"*. The finding summarizes the negotiated **Restart Time**, whether **forwarding state was preserved**, and the measured convergence time from re-establishment to **End-of-RIB**:

![The findings with a single warning row reading "10.0.0.1 restarted gracefully, peer 10.0.0.2", explaining that routes were back 3.8s after the session came up against the 120s it asked for, and that it kept forwarding state](manual/s8-graceful-restart.png)

The finding is a warning when the restart succeeded within its Restart Time with forwarding preserved, and escalates to **critical** if convergence exceeded Restart Time or forwarding state was not preserved. By contrast, a crash loop without Graceful Restart still appears as *"Session flapping detected"* plus a silent teardown finding.

You can also verify the Graceful Restart flags in the **OPEN comparison**, and empty UPDATEs are labeled `End-of-RIB` in **Messages**.

**Soft clear (ROUTE-REFRESH)** appears as a ROUTE-REFRESH message followed by re-advertised routes. Select the ROUTE-REFRESH message in **Messages** to see **What the refresh changed**: routes **added**, **no longer advertised**, and **changed attributes** (unchanged routes are counted only). Click any listed route to open its UPDATE.

![The ROUTE-REFRESH detail with a panel reading "What the refresh changed": 10.0.0.1 re-advertised IPv4 Unicast, one route unchanged, and 10.1.1.0/24 added with community 65001:999](manual/s9-refresh-diff.png)

After a soft clear, a peer re-sends its current table without sending explicit withdrawals for routes it no longer advertises; those missing routes appear under **no longer advertised**.

Keep two capture-boundary caveats in mind (both are noted in the panel when applicable):

- If the capture began mid-session, the "before" state only includes routes observed before the refresh.
- If no End-of-RIB closes the re-advertisement before the capture ends, routes not yet re-sent appear as no longer advertised.

When a capture contains multiple ROUTE-REFRESH messages, select each one individually to inspect its interval.

### The capture may be lying to you

If a capture contains only one direction of a session, the findings raise *"Only one direction of this session is in the capture"* and the session list marks the pair **Critical**. Because a one-sided SPAN/capture filter and a real one-way network outage look identical at the BGP layer, verify which one you have before drawing conclusions.

Open **Messages**, switch to **All Packets**, and inspect the **Source** column and TCP flags:

![The packet list showing five frames, every one of them from 10.0.0.1, and a handshake with a SYN and an ACK but no SYN-ACK](manual/s12-one-direction.png)

Seeing `[S]` followed by `[A]` with no `[SA]` in between proves the peer's replies reached the host (otherwise it would never send ACK), meaning the capture itself missed the return direction.

On large captures, you can run a quick direction check in **SQL**:

```sql
select src_ip, dst_ip, count(*) as frames
from packets group by all order by frames desc
```

A healthy bidirectional session produces two rows of comparable size; a single row means only one direction carried BGP. (Because `packets` holds BGP frames only, still check **All Packets** when debugging non-BGP TCP traffic.)

## Filters

The filter bar is a single query box with autocomplete. Press `/` or `Ctrl+K` (`⌘K`) to jump to it. On a large capture, the values it suggests (addresses, prefixes, AS numbers) are collected after you first focus the box and join the list a few seconds later; field names and operators are offered straight away. **+ Filter** builds one condition from menus and appends it with `and`. Choosing a session or a time window narrows the list as well, on top of the filter.

In the packet detail, values that can become a filter have a dotted underline. Hover an address, prefix, AS number, next hop or community and click **＋** to narrow the current filter by it, or **=** to filter on it alone.

```
type = NOTIFICATION and src_ip = 10.0.0.1
ip = 10.0.13.1
asn = 65001
prefix = 10.0.0.0/8 and not (type = KEEPALIVE)
capability contains "Route Refresh"
```

Combine conditions with `and`, `or`, `not`, and parentheses. Supported operators are `=` (or `==`), `!=`, `contains`, and `not contains`; numeric fields also accept `<`, `<=`, `>`, and `>=`. `!=` and `not contains` match every packet the positive form does not, so `prefix != 10.0.0.0/8` also lists OPENs and KEEPALIVEs; add `type = UPDATE` to keep to routes. On a large capture the list updates once you pause typing, with *filtering...* beside the count meanwhile.

A value typed on its own is read as the comparison it most likely means: an address (`10.0.13.1`) as `ip = 10.0.13.1`, a CIDR block (`10.0.0.0/8`) as `prefix = 10.0.0.0/8`, `AS65001` as `asn = 65001`, a MAC as `mac = …`, and a message type (`update`) as `type = UPDATE`.

### Fields

| Field | Matches |
|-------|---------|
| `type` | `OPEN`, `UPDATE`, `NOTIFICATION`, `KEEPALIVE`, `ROUTE_REFRESH` |
| `ip` / `peer` | Either address — `ip = X` is `src_ip = X or dst_ip = X`, and `ip != X` excludes X on both sides |
| `src_ip` / `dst_ip` | Source / destination IP; CIDR matches any address inside the block |
| `src_port` / `dst_port` | TCP port (separates multiple sessions between the same IP pair) |
| `frame` | Frame number (e.g. `frame >= 100 and frame < 200`) |
| `router_id` | BGP Identifier from OPEN |
| `src_as` | AS number advertised in OPEN |
| `asn` | AS number anywhere in AS_PATH |
| `origin` | `IGP`, `EGP`, `INCOMPLETE` |
| `next_hop` | NEXT_HOP or MP_REACH next hop |
| `med` | MULTI_EXIT_DISC (supports ranges; absent MED matches nothing) |
| `local_pref` | LOCAL_PREF (supports ranges; iBGP only, absent LOCAL_PREF matches nothing) |
| `prefix` | Announced or withdrawn prefix — the whole history of a route |
| `nlri` | Announced prefix only |
| `withdrawn` | Withdrawn prefix only |
| `community` | Standard or large community |
| `rt` | Route Target (e.g. `rt = 65001:100`) |
| `ext_community` | Extended community as displayed |
| `mac` / `vni` / `rd` / `evpn_type` | EVPN route attributes |
| `capability` | Capability name from OPEN |

Supported aliases: `src`, `dst`, `as`, `aspath`, `nexthop`, `router-id`, `my_as`, `large-community`, `route-target`, `ext-community`, `evpn-type`.

### How prefixes match

IP addresses and prefixes are compared numerically down to the bit, not as text. For example, `src_ip = 192.168.0.0/23` matches `192.168.0.0` through `192.168.1.255`.

For `prefix` and `withdrawn`, the input format determines the match direction:

- `prefix = 10.0.0.0/8` — Routes **inside** that CIDR (`10.0.12.0/24` matches)
- `prefix = 10.0.12.7` — Routes that **cover** that host address
- `prefix contains "10.0.1"` — Substring match

The **Routes** screen uses the same matching semantics.

### When a filter does not seem to work

If an expression is invalid, a red error message appears next to the **Showing N of M packets** counter and the list remains unfiltered. Seeing *"Showing 5 of 5"* next to a red message means the filter was not applied, not that every packet matched. Double-check field names against the table above.

## What BGPShark will not tell you

Keep these inherent limitations in mind so you do not mistake absence of a finding for proof that everything is fine:

- **Capture defect vs. one-way outage.** BGPShark flags one-way sessions, but confirming whether the capture missed return packets or the network dropped them requires checking the TCP handshake ([see above](#the-capture-may-be-lying-to-you)).
- **Routing policy correctness.** BGPShark has no knowledge of your intended export/import policies or expected AS_PATHs, so route leaks look identical to legitimate announcements.
- **Router RIB decisions.** A capture records only what crossed the wire—which path the router actually installed or how local policy modified it must be checked on the router itself.
