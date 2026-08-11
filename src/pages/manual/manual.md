# BGPShark user manual

BGPShark reads a packet capture and tells you what the BGP sessions in it were
doing. It is meant for the moment when a session is down, a route is missing, or
a peer is complaining, and you have a `.pcap` and a question.

Everything happens in your browser. The capture is never uploaded, the app makes
no requests to anyone, and it keeps working with the network unplugged.

## Loading a capture

Drop a file anywhere in the window, or use the picker on the start screen.
`.pcap` and `.pcapng` are both accepted and told apart automatically; there is no
need to say which one you have. The limit is 50 MB.

If you have nothing to hand, **Load sample** gives you a working capture to
explore, and the **Build** screen can write one to your description.

Your capture stays loaded across reloads — it is kept in your browser's storage,
not on a server. **New File** clears it.

### If the capture looks wrong

A yellow banner under the header means the parser had trouble with part of the
file. Click it to see what. This is usually a truncated capture or a corrupted
block, and the rest of the file is still analysed — a warning is not a failure.

Two things worth knowing before you trust what you see:

- **A capture with only one direction is flagged, but you decide which cause.**
  The Dashboard says so as a critical alert. It cannot tell you *why*: either a
  mirror or `tcpdump` filter caught one leg, or the peer's packets genuinely are
  not arriving — a one-way link, an ACL applied in one direction. The second is
  an outage rather than a capture problem, so check before you re-capture.
- **TCP-level frames are hidden by default.** The packet list shows BGP only
  until you switch it to **All Packets**. A session killed by a firewall shows
  up as a `[R]` frame there and nowhere else.

## The screens

Each screen answers a different question. If you do not know where to start,
start at the Dashboard.

| Screen | The question it answers |
|--------|-------------------------|
| **Dashboard** | What is wrong with this capture? |
| **Messages** | What exactly was sent, byte by byte? |
| **Neighbors** | What did these two routers agree on? |
| **Routes** | What happened to this prefix? |
| **SQL** | Anything the other screens do not ask |
| **Build** | I need a capture that shows *this* |

### Dashboard

Message counts, a timeline, the neighbour table, and — the part to read first —
the **Alerts** panel. Alerts are sorted worst-first and are one row per
*problem*, not per packet: a peer that retried a rejected OPEN forty times is one
row that says forty, not forty rows.

Alerts cover NOTIFICATIONs, sessions that flapped, bursts of withdrawn prefixes,
routes that flapped, routes whose AS_PATH changed, and two cases where the
problem is something *missing*: a session with only one direction in the capture,
and a TCP connection that was accepted and then answered with no BGP at all.
**View →** takes you to the packet where the story starts, with a filter already
applied.

"No issues detected" means every session in the capture came up and stayed up. It
does not mean nothing is wrong — a route leak, for instance, is invisible to it,
because nothing about the sessions carrying it is unhealthy.

### Messages

The packet list, a detail view, and a hex dump. Click a packet to expand it;
every field the parser understood is there, down to the individual capability or
path attribute, with the raw bytes underneath.

The **Info** column summarises each message — `AS65001 Hold=90` for an OPEN, the
announced and withdrawn counts for an UPDATE, the error name for a NOTIFICATION.
An UPDATE with nothing in it is marked **End-of-RIB** rather than left looking
empty.

Use the **Columns** button to add timestamp and port columns, and **Export** to
save whatever the filter currently shows as a new pcap — useful for attaching the
relevant twenty packets to a ticket instead of the whole capture.

### Neighbors

Sessions grouped by Router ID. Click a router, then click one of its sessions,
and you get the **Capability Diff**: the two OPEN messages side by side.

This is the fastest answer to "the session is up but the routes are not coming".
Capabilities are compared per address family, so "both support Multiprotocol"
cannot hide one side offering IPv4 and the other IPv6. Mismatches are listed
before matches, since that is what you came for.

Hold Time differing between the two sides is normal — only the lower of the two
is used — so it is marked informational rather than as a fault. The same Router
ID on both sides is flagged as an error, because it is one.

### Routes

Every prefix in the capture, with how often it was announced, how often
withdrawn, when it was last seen, and a **flap** count. Sort by flap to find the
unstable ones. Click a prefix for its full history and the AS_PATHs it was seen
with.

The search box matches three ways, which is the part people trip on:

- **Exact** — this prefix and nothing else
- **Subnets** — everything *inside* what you typed, so `10.0.0.0/8` finds
  `10.0.12.0/24`
- **Supernets** — everything that *covers* what you typed, so `10.0.12.7` finds
  the `10.0.0.0/8` that carries it

### SQL

The capture as a set of tables you can query. Use it when the built-in screens do
not ask your question — comparing path attributes across peers is the usual
reason, since the Routes screen shows AS_PATH and next hop but not MED or
LOCAL_PREF.

The schema is in the sidebar and the **Query Templates** are worth reading once
even if you write your own.

Three things that will save you time:

- `nlri.prefix` holds no mask. Use `prefix || '/' || prefix_length`.
- `nlri`, `as_path` and `path_attributes` all join on `message_id`, so joining
  all three at once multiplies the rows. Use correlated subqueries instead.
- Results are frame-accurate but the tables are a flattened projection, not the
  whole parsed message. For full detail, follow `frame_index` back to Messages.

Comparing two paths for the same prefix:

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

Describe a session and BGPShark writes the pcap. It needs no capture loaded,
which is the situation you are in when you are looking for one.

Start from one of the presets — a clean establishment, a hold timer expiry, an AS
mismatch, a refused TCP connection, IPv6 transport, a flapping route, 4-byte AS
numbers, or UPDATEs split across TCP segments — then change the addresses, AS
numbers and prefixes to match the case in front of you.

Two things follow from the scenario rather than being asked for, because a
capture that got them wrong is one no real session could produce: how UPDATEs are
encoded, which follows from the capabilities in the OPENs, and where TCP segment
boundaries fall, which follows from the MTU. Lowering the MTU is therefore how
you build a capture whose messages span segments.

The output is a real capture — checksums are computed properly — so it can be fed
to other tools, not just back into this one.

## Filters

The filter bar has two modes. **Simple** builds rules from dropdowns; **Advanced**
takes an expression. Both produce the same thing.

```
type = NOTIFICATION and src_ip = 10.0.0.1
asn = 65001
prefix = 10.0.0.0/8 and not (type = KEEPALIVE)
capability contains "Route Refresh"
```

Combine conditions with `and`, `or`, `not` and parentheses. The operators are
`=`, `!=`, `contains` and `not contains`; numeric fields also take `<`, `<=`,
`>`, `>=`.

### Fields

| Field | Matches |
|-------|---------|
| `type` | `OPEN`, `UPDATE`, `NOTIFICATION`, `KEEPALIVE`, `ROUTE_REFRESH` |
| `src_ip` / `dst_ip` | Source / destination address; a CIDR matches anything inside it |
| `src_port` / `dst_port` | Separates two sessions between the same pair of addresses |
| `frame` | Frame number, for a range like `frame >= 100 and frame < 200` |
| `router_id` | BGP Identifier from an OPEN |
| `src_as` | AS number advertised in an OPEN |
| `asn` | AS number appearing anywhere in AS_PATH |
| `origin` | `IGP`, `EGP`, `INCOMPLETE` |
| `next_hop` | NEXT_HOP, or the MP_REACH next hop |
| `prefix` | Announced or withdrawn prefix |
| `withdrawn` | Withdrawn prefix only |
| `community` | Standard or large community |
| `rt` | Route Target, e.g. `rt = 65001:100` |
| `ext_community` | Any extended community as displayed |
| `mac` / `vni` / `rd` / `evpn_type` | EVPN routes, which carry no prefix |
| `capability` | Capability name from an OPEN |

Aliases exist for most of these: `src`, `dst`, `as`, `aspath`, `nexthop`,
`nlri`, `router-id`, `my_as`, `large-community`, `route-target`,
`ext-community`, `evpn-type`.

### How prefixes match

Addresses and prefixes are compared as numbers, to the bit — not as text. So
`src_ip = 192.168.0.0/23` covers 192.168.0.0 through 192.168.1.255 and nothing
else.

For `prefix` and `withdrawn`, what you type decides the direction:

- `prefix = 10.0.0.0/8` — routes **inside** that block, so `10.0.12.0/24` matches
- `prefix = 10.0.12.7` — routes that **cover** that address
- `prefix contains "10.0.1"` — plain substring search, for when you are still
  typing

The Routes screen answers the same way, so a prefix you found there will work in
a filter using the same text.

### When a filter does not seem to work

An invalid expression shows a red message next to the **Showing N of M packets**
counter, and leaves the list unfiltered. "Showing 5 of 5" next to a red message
means the filter was not applied — not that everything matched. The most common
cause is a field name that does not exist: `med` and `local_pref`, for instance,
are available in SQL but are not filter fields.

## Common questions

**The session will not come up.** Look at the Dashboard first. If there is no BGP
in the capture at all, the alert will tell you what the TCP layer shows — SYNs
answered by RST means something is refusing the connection (an ACL, an MD5
mismatch, or BGP not running), and SYNs with no answer at all means the traffic
is not getting there.

If TCP *does* come up and nothing comes back, the Dashboard says so: *"TCP
connects but 10.0.0.2 sends no BGP"*. That is worth reading for what it rules
out. Something accepted the connection on port 179, so the port is open, no ACL
is dropping the SYN, and MD5 agrees — a one-sided MD5 fails the handshake rather
than surviving it. The fault is after TCP came up: the peer's BGP not willing to
talk to your address, or the payload not surviving a path that carries the
handshake fine — a TCP middlebox, a PMTU black hole, control-plane policing.

**The session is up but a route is missing.** Search for the prefix on the Routes
screen. If it is not there, it was never announced on this session. If it is,
check the Capability Diff — routes for an address family that only one side
advertised have nowhere to go.

**The session keeps dropping.** The Dashboard groups the NOTIFICATIONs and counts
the re-establishments. `Hold Timer Expired` means one side stopped hearing from
the other; compare the timestamp of the NOTIFICATION with the last KEEPALIVE from
the other side, and if the gap matches the negotiated hold time, the problem is
one-way reachability rather than BGP. If there is no NOTIFICATION at all, switch
the packet list to **All Packets** and look for a TCP reset.

**Traffic is leaving by the wrong path.** The Routes screen shows AS_PATH and
next hop per announcement. For the rest of the decision — LOCAL_PREF, MED,
communities — use the SQL console; the query above puts every path for a prefix
side by side.

**A MAC keeps moving in my EVPN fabric.** Filter on `mac = ...`. A move is a
withdrawal from one leaf and an advertisement from another, and the filter shows
both halves. The Routes screen lists the MAC as a route with its own history.

## What BGPShark will not tell you

Worth knowing, so you do not read absence as evidence:

- **Which of two causes made a session one-sided.** It tells you one direction
  is missing; whether that is your capture or the network is yours to work out.
- **Why a session dropped without a NOTIFICATION.** The TCP reset is visible
  under **All Packets**, but nothing points you there.
- **What your router decided.** BGPShark reads what crossed the wire. Which path
  was selected, what policy did to it, and what ended up in the RIB are on the
  router, not in the capture.
