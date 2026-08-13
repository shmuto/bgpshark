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
  [The capture may be lying to you](#the-capture-may-be-lying-to-you) is two
  ways of telling them apart in under a minute.
- **TCP-level frames are hidden by default.** The packet list shows BGP only
  until you switch it to **All Packets**. A session killed by a firewall shows
  up as a `[R]` frame there and nowhere else.

## The screens

Each screen answers a different question. If you do not know where to start,
start at the Dashboard — or skip to
[Investigating by symptom](#investigating-by-symptom), which takes a dozen real
complaints and walks each one to its answer.

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
not ask your question — a comparison across many prefixes at once, or one that
wants an aggregate.

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

## Investigating by symptom

The rest of the manual describes the screens. This part describes the *cases* —
the complaint as it arrives, the click path that answers it, and a picture of
what you should be looking at when you get there.

Every screenshot below is a capture BGPShark built itself, so each walkthrough
is reproducible: the **Build** screen writes captures like these, and the
scenarios they come from are in `testlab/scenarios.ts` in the repository. If a
picture here does not match your screen, the difference is your capture, not
your version.

### Start here

Whatever the complaint, the first thirty seconds are the same.

1. **Dashboard.** Read the counters, then the **Alerts** panel. Alerts are
   sorted worst-first and grouped one row per problem.
2. **Check the capture is complete** before you trust any of it — see
   [The capture may be lying to you](#the-capture-may-be-lying-to-you) at the
   end of this section.
3. Follow the alert's **View →**, which lands you on the packet where the story
   starts with a filter already applied.

![The Dashboard on a capture of a flapping session: counters, two alerts, the neighbour table and the timeline](manual/dashboard.png)

"No issues detected — every session looks healthy" means every session in the
capture came up and stayed up. It does **not** mean nothing is wrong: a route
leak and a best-path surprise both produce that message, because nothing about
the sessions carrying them is unhealthy.

### “The session will not come up”

The neighbour sits in Idle or Connect and no BGP is ever exchanged. What you
want from the capture is what answers the SYN to port 179 — a SYN-ACK, an RST,
or nothing at all.

Go to the **Dashboard**. When a capture contains no BGP whatsoever, the alerts
are computed from the TCP layer instead:

![A critical alert reading "TCP connections to port 179 are being refused — 3 SYNs answered by RST"](manual/s1-tcp-refused.png)

- **SYNs answered by RST** — something is refusing the connection. An ACL or
  firewall, a TCP-MD5/TCP-AO mismatch, or BGP simply not running on the peer.
- **SYNs with no answer at all** — the packets are not arriving, or the replies
  are not coming back. This is a routing or filtering problem below BGP.
- **SYN-ACK, then nothing** — TCP came up and the OPEN never followed. The
  Dashboard says so directly: *"TCP connects but 10.0.0.2 sends no BGP"*. Read
  it for what the successful handshake **rules out** — the port is open, no ACL
  is dropping the SYN, and MD5 agrees, because a one-sided MD5 fails the
  handshake rather than surviving it. What is left is the peer's BGP unwilling
  to talk to your address, or the payload not surviving a path that carries the
  handshake fine: a TCP middlebox that terminates the connection, a PMTU black
  hole that passes small segments and drops full ones, control-plane policing.

Switch the packet list to **All Packets** to count the retries and read the
intervals; with the list on BGP Only there is nothing to see, because there is
no BGP in the file.

### “It is Established, but a whole address family never arrives”

The session is up, the IPv4 routes are fine, and no IPv6 route ever appears —
or no EVPN route, or no VPNv4 route. This is a capability question, and the
answer is one screen deep.

**Neighbors → click a router → click one of its sessions.** The Capability Diff
appears only once a *session* is selected; it is not on the router row.

![The Capability Diff: session fields matching, and four capabilities advertised by only one end, including IPv6/Unicast Multiprotocol Extensions](manual/s2-capability-diff.png)

Capabilities are compared per address family, so "both support Multiprotocol"
cannot hide one side offering IPv4 and the other IPv6. Mismatches are listed
before matches, since that is what you came for. Read the **Status** column:

- **⚠ Only *x*** — one side advertised it and the other did not. Routes for that
  family have nowhere to go, and this is your answer.
- **Differs — normal for eBGP** on My AS, and a Hold Time that differs, are both
  expected. Only the lower hold time is used.
- **The same BGP Identifier on both sides** is flagged as an error, because it
  is one.

### “It flaps every few minutes”

The Dashboard groups the repeats: one row for the NOTIFICATIONs with a count,
one for the re-establishments.

![Alerts reading "NOTIFICATION: Hold Timer Expired / Unspecific ×3" and "Session flapping detected — 6 OPEN messages (~3 establishments)"](manual/s3-holdtimer-alerts.png)

`Hold Timer Expired` means one side stopped hearing from the other. That is a
statement about reachability, not about BGP — and the number that decides it is
how long *before* the teardown the last message from the peer arrived.

**Messages → click the NOTIFICATION.** The detail measures it for you, under
**Silence before the teardown**.

![The NOTIFICATION detail: 90.4 seconds since the last KEEPALIVE from 10.0.0.1, against a negotiated hold time of 90 seconds](manual/s3-holdtimer-gap.png)

A silence that ran the whole hold time — 90.4 seconds against a hold time of
90 — means KEEPALIVEs stopped arriving one way while the session was otherwise
healthy. Look at the path between the routers, not at the routers. A silence
much *shorter* than the hold time is flagged as such: either the capture is
missing packets that did arrive, or the hold time actually in force was not the
one these OPENs agreed.

Two things the panel is careful about, and you should be too if you go
measuring this by hand:

- It counts from the **peer's** last message, not from the previous packet in
  the list. On a healthy session both ends are talking, so the previous packet
  is usually the complaining router's own KEEPALIVE — a different number, and
  not the one the timer was counting. Here that mistake reads 90.2 seconds.
- The hold time it compares against is the **lower of the two OPENs**, taken
  from the OPENs that preceded *this* teardown. On a flapping capture the
  session that came back may have negotiated something else.

If the capture starts mid-session and holds no OPENs, the silence is still
measured — the panel just says the hold time is unknown and leaves the
comparison to you.

### “It dropped, and nothing says why”

No NOTIFICATION anywhere in the capture, and the session came back a minute
later. The evidence is at the TCP layer, which the packet list hides by default
— so start at the **Dashboard**, which now names it and takes you there.

Two critical rows, one per teardown: *"10.0.0.1 ↔ 10.0.0.2 was reset with no
NOTIFICATION"* and *"…was closed with no NOTIFICATION"*. `View →` on either one
switches the list to **All Packets** and selects the frame it is talking about,
which is the point — a row naming a reset you then have to go and find would
only be half an answer.

![The Alerts panel with two critical rows — one reading "10.0.0.1 ↔ 10.0.0.2 was reset with no NOTIFICATION", one "was closed with no NOTIFICATION" — above a "Session flapping detected" warning](manual/s11-teardown-alerts.png)

They sit beside the *"Session flapping detected"* warning rather than replacing
it: that one counts how often the session came *up*, these say how it went
*down*. The split into two rows is deliberate too. An RST is something actively
rejecting the connection — a firewall, a stack with no socket left. A FIN is
something deciding the session was finished and closing it politely, which is
what an idle timeout looks like. The next thing to check differs.

**Messages → All Packets**, if you arrive by hand instead. The tell is visible
before you switch: the frame numbers in BGP Only jump — 10, then 15 — and the
missing frames are the ones that ended the session.

![The packet list in All Packets mode with frame 11 selected: an [AR] frame from 10.0.0.2, and a detail pane reading "TCP Flags: ACK, RST"](manual/s11-tcp-reset.png)

`[AR]` is ACK+RST — the session was reset, in this case by the far end 26
seconds after the last KEEPALIVE, with a fresh SYN 60 seconds later. `[F]` for a
FIN is the polite version of the same story: something closed the connection
deliberately, and BGP never got the chance to say why.

One thing is still missing: there is no filter field for TCP flags, so you
cannot narrow the list to resets — **All Packets** and your eyes do that part.

A session that never established is not reported here, even though its
connections also end in RST. Nothing was torn down in that case, and *"TCP
connects but the peer sends no BGP"* already says the useful thing about it.

### “The session drops the moment routes are advertised”

Establishment is clean, the first UPDATE goes out, and the far end tears the
session down. The NOTIFICATION names what it objected to.

**Messages → click the NOTIFICATION.**

![A NOTIFICATION detail: error code 3 UPDATE Message Error, subcode 2 Unrecognized Well-known Attribute, a troubleshooting hint, the data field decoded as UNKNOWN(199) marked Well-known and Transitive, and the raw bytes below it](manual/s6-notification.png)

Error code **3** is an UPDATE the peer refused, and the subcode says why —
`Unrecognized Well-known Attribute`, `Invalid NEXT_HOP`, `Malformed AS_PATH`.
Every code carries a Troubleshooting Hint under it.

Then read the UPDATE immediately before it, which is the one being complained
about. An attribute the parser could not identify is shown as
`UNKNOWN(199) · Transitive · Unparsed` with its bytes, which is usually enough to
recognise the feature the far end does not implement.

The NOTIFICATION's own data field is decoded rather than left as bytes. For
error code 3 it *is* the offending attribute, handed straight back — shown with
its type and its flags, because the flags are frequently the fault: an attribute
marked **Well-known** that nobody recognises is precisely what subcode 2 is
about. The raw bytes stay underneath so you can check the reading.

Other codes decode their own fields: the AS number that did not match a
`Bad Peer AS`, the capabilities behind an `Unsupported Capability`, and — worth
knowing about — the sentence a peer may attach to an administrative shutdown or
reset (RFC 9003). That last one is the only place in BGP where the far end can
tell you *why* in words, and it is usually a maintenance window or a ticket
number.

### “A prefix is missing”

Search for it on the **Routes** screen, and let the match mode do the work:

- **Exact** — this prefix and nothing else.
- **Subnets** — everything inside what you typed, so `10.0.0.0/8` finds
  `10.0.12.0/24`. Use this when the peer may be sending more specifics.
- **Supernets** — everything covering what you typed, so `10.0.12.7` finds the
  aggregate that carries it. Use this when a host is unreachable and you want
  the route that should have covered it.

If the prefix is not there at all, it was never announced on this session, and
the question moves to the peer's policy. If it is there but the family is wrong
— an IPv6 prefix on a session that only negotiated IPv4 — the Capability Diff
above is the next stop.

A capture whose UPDATEs are split across TCP segments needs nothing special
from you: the segments are reassembled before parsing, and a 400-prefix UPDATE
at a 576-byte MTU still counts 400 prefixes here.

### “Traffic leaves by the wrong upstream”

**Routes → the prefix.** The route history lists every announcement of it, one
row per peer, with the attributes the decision was made on: AS_PATH, Next Hop,
MED, LOCAL_PREF and communities.

![The route history for 172.20.0.0/16 with two announcements side by side: the short AS_PATH carrying MED 300 and no LOCAL_PREF, the long one carrying MED 10 and LOCAL_PREF 200](manual/s4-bestpath.png)

Read across the two rows and the answer is there: the **longer** AS_PATH wins,
because it carries LOCAL_PREF 200 and LOCAL_PREF is compared long before path
length. The short path's MED of 300 never gets a say — MED is compared much
later, and only between paths from the same neighbouring AS.

A dash means the attribute was not on that UPDATE, which is not the same as a
value of zero. `192.0.2.1` sent no LOCAL_PREF at all; had it sent 0, that would
be a route deliberately made unattractive, and the column would say `0`.

Columns appear only when the selected route carries them, so a capture with no
LOCAL_PREF anywhere does not get a column of dashes. ORIGIN is the exception in
the other direction: it appears only when it *differs* between announcements,
since it is IGP on almost everything and a column of identical values costs
width the others need.

To ask it across many prefixes at once, `med` and `local_pref` are filter
fields, and take ranges:

```
med > 100
local_pref = 200
prefix = 172.20.0.0/16 and local_pref >= 200
```

An UPDATE carrying no MED matches no `med` comparison at all — absent is not
zero here either, or `med < 100` would select most of an eBGP capture.

Remember what a capture can and cannot settle: it holds what crossed the wire,
not what the router did with it. Which path was installed is on the router.

### “CPU is high and the RIB will not settle”

This is the case the Dashboard answers most completely. Churn produces a row per
flapping prefix, a row per AS_PATH change, and a withdraw-burst row:

![An alert panel of route-flapping and AS_PATH-changed rows, ending in "Burst of withdrawn prefixes — 60 prefixes withdrawn within 10s"](manual/s10-churn-alerts.png)

Then go to **Routes** and sort by **Flap** — click the column once for ascending,
twice for worst-first — and click the worst prefix for its history.

![The Routes screen sorted by flap count, with one prefix's history of alternating announce and withdraw, and an AS_PATH Analysis panel showing two distinct paths](manual/s10-churn-routes.png)

The history is the diagnosis, and the **From** column is half of it. Announce and
withdraw at a regular interval from one peer is an unstable link, or an interface
flapping behind it. Announcements from the same peer that alternate between two
AS_PATHs — the **AS_PATH Analysis** panel counts the variants — put the
instability further upstream instead: your neighbour is not flapping, it is
telling you about something that is.

### “A peer is announcing routes it has no business announcing”

Nothing is wrong at the session layer, so the Dashboard says "No issues
detected" and means it. A leak is only found by someone looking for one.

The **Routes** search box takes an AS number as well as a prefix. Type `AS15169`
to list every prefix carrying that AS anywhere in its AS_PATH, then click one:

![The Routes screen filtered to prefixes with AS15169 in their path, with 8.8.8.0/24 selected and an AS_PATH of AS65100 → AS65001 → AS15169](manual/s5-route-leak.png)

A customer session carrying a path that transits somebody else's AS is the
classic shape: `AS65100 AS65001 AS15169` on a session with the customer AS65100
means they are re-announcing what they learned from another transit. The filter
`asn = 15169` narrows the packet list the same way.

There is no notion here of an expected path shape, so nothing will flag this for
you. What the tool gives you is every path in the capture, quickly.

### “A host in the fabric drops out in bursts”

An EVPN MAC move is a withdrawal from one leaf and an advertisement from
another, so the two halves have to be seen together. Filter on the MAC:

```
mac = 00:0c:29:aa:bb:cc
```

![The packet list filtered to one MAC: an announcement from 10.0.0.2, a withdrawal from 10.0.0.2, an announcement from 10.0.0.1, with the withdrawn route decoded to its RD and VNI](manual/s13-mac-move.png)

`mac`, `vni`, `rd` and `evpn_type` all match announcements and withdrawals
together, and the packet detail decodes the route to its RD, MAC, VNI and ESI.
Two VTEPs advertising the same MAC in quick succession, repeatedly, is a move
loop — usually a dual-homed host or a bridged loop rather than anything BGP is
doing wrong.

Routes lists the MAC as a route with its own history, and the Dashboard reports
a move as *"Route flapping: [2] 00:0c:29:aa:bb:cc VNI 10100"*. Reading a move as
a flap is a wording mismatch, not a wrong answer. MAC Mobility sequence numbers
are decoded in the message detail but are not compared for you.

### “After a reload, or after a soft clear”

Both leave a capture that looks like something worse than it is.

A **graceful restart** is named as one. The Dashboard reports
*"10.0.0.1 restarted gracefully"* instead of *"Session flapping detected"*, and
carries the three things the question needs: the **Restart Time** the speaker
asked for, whether it advertised that it **kept forwarding state**, and how long
convergence actually took — measured from the session coming back to the
**End-of-RIB** that says the routes are.

![The Alerts panel with a single warning row reading "10.0.0.1 restarted gracefully, peer 10.0.0.2", explaining that routes were back 3.8s after the session came up against the 120s it asked for, and that it kept forwarding state](manual/s8-graceful-restart.png)

That last number is the one worth reading. It is what the restart cost in
practice, and if it runs past the Restart Time the peer has already given up
holding the routes and withdrawn them — so the row turns critical. It turns
critical too when forwarding state was *not* preserved, because then the
dataplane dropped traffic for the whole window, which is the thing a graceful
restart exists to avoid.

A crash loop has none of that: no capability, so nothing was agreed, and it
still reads as *"Session flapping detected"* plus a teardown row. The difference
between the two screens is the answer.

The raw material is still there if you want to check the reading: the capability
with its flags is in the **Capability Diff**, and an UPDATE with nothing in it is
labelled `End-of-RIB` in the packet list rather than left looking empty.

A **soft clear** shows up as a ROUTE-REFRESH followed by the re-advertisement.
Both halves are visible as messages; comparing what came back against what was
there before is yours to do, most easily by noting the frame number of the
refresh and filtering the UPDATEs on either side of it (`frame < 240`,
`frame >= 240`).

### The capture may be lying to you

A capture taken from one side of a SPAN, or with a `tcpdump` filter that caught
one direction, is missing whatever the other end said — including the
NOTIFICATION that ended the session. The Dashboard now raises *"Only one
direction of this session is in the capture"* and the neighbour table marks the
pair `⚠ Never up`, so you are told; what it cannot tell you is **which** of two
very different causes it is. A one-legged mirror and a one-way reachability
fault produce the same file, and only one of them is a capture problem.

The checks below are how you decide, and they are worth doing before telling
anyone their router is fine.

**Messages → All Packets**, and read the Source column:

![The packet list showing five frames, every one of them from 10.0.0.1, and a handshake with a SYN and an ACK but no SYN-ACK](manual/s12-one-direction.png)

Two tells, both visible above: every frame has the same source address, and the
handshake has a `[S]` and an `[A]` but no `[SA]` between them. A real session
cannot look like this.

The same question in SQL, which is faster on a large capture:

```sql
select src_ip, dst_ip, count(*) as frames
from packets group by all order by frames desc
```

One row for a session means one direction. A healthy session gives you two rows
of comparable size. (This table holds BGP-bearing packets only, so a session
with no BGP in one direction is invisible to it — that is what the packet list
above is for.)

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
| `med` | MULTI_EXIT_DISC, with ranges — `med > 100`. Matches nothing on an UPDATE that carried no MED |
| `local_pref` | LOCAL_PREF, with ranges — `local_pref >= 200`. iBGP only; eBGP UPDATEs carry none |
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
cause is a field name that does not exist — check it against the table above.

## What BGPShark will not tell you

Worth knowing, so you do not read absence as evidence:

- **Which of two causes made a session one-sided.** It tells you one direction
  is missing; whether that is your capture or the network is yours to work out.
  [How to tell them apart](#the-capture-may-be-lying-to-you).
- **Whether a path is one it should be carrying.** There is no notion of an
  expected AS_PATH, so a leak looks exactly like a legitimate announcement.
- **What your router decided.** BGPShark reads what crossed the wire. Which path
  was selected, what policy did to it, and what ended up in the RIB are on the
  router, not in the capture.
