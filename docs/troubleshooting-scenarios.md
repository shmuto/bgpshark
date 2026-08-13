# Troubleshooting scenarios

Fourteen faults an operator actually arrives with, each one compiled into a
capture that shows that fault and nothing else. For every scenario: the
complaint, what you would want to learn from a capture of it, and what BGPShark
says about it today.

This exists for two reasons. It is a way to check the analysis screens against a
known answer — when a scenario says the hold timer expired 90 seconds after the
last KEEPALIVE, that is a fact the dashboard can be held to. And the last column
is an honest map of where the tool stops, written from actually driving it rather
than from reading the code.

The user-facing half of this document is the manual's **Investigating by
symptom** section (`src/pages/manual/manual.md`), which walks most of these
scenarios click by click and is illustrated from the same captures by
`bun run screenshots`. This file is the assessment; that one is the instruction.
When a verdict here changes, check whether a walkthrough there is now wrong.

## Building the captures

```bash
bun run testlab/scenarios.ts          # all of them, into testlab/scenarios/
bun run testlab/scenarios.ts s3 s11   # just these
```

The output directory is gitignored. `testlab/scenarios.ts` is the artifact worth
keeping: a pcap whose contents are only legible by opening it is not, and the
generator states each scenario's intent next to the bytes it produces.

These are deliberately not [capture builder](../README.md#capture-builder)
presets. A preset is a starting point you edit to match the session in front of
you, and the Build screen keeps a short curated list; these are fixed
reproductions meant to be read. Two of them are not expressible as a preset at
all — S4 merges two sessions into one capture, S12 deletes one direction from a
capture that was complete.

## Where the capture was taken

Every scenario here is shaped like a capture taken **on one router**, because
that is the only capture most people can get: the far end belongs to somebody
else, or to a team that will not run tcpdump on a Friday.

That constraint matters less than it sounds, and in one place more:

- **One router still sees both directions.** Capturing on your own interface
  records what you sent *and* what arrived from the peer. Thirteen of the
  fourteen captures below have both directions in them, which is what a normal
  single-router capture looks like — not a compromise.
- **More than one session is normal too.** S4 has two, because a router with two
  upstreams shows both in one file. Being able to compare them is the whole
  reason that scenario is answerable at all.
- **What you cannot see is whether your packets arrived.** The capture proves
  what left the interface, never what the peer received. So a fault at the far
  end shows up here only as *absence*. S12 and S14 are both that shape, and
  both are now reported — see the two rules in `computeSessionSetupAlerts`.

## The scenarios

Legend: **✔** answered on screen · **◑** answerable, but only by knowing where to
look or by writing SQL · **✘** not answerable, or answered wrongly.

### S1 — `s1-tcp-refused` · The neighbor stays Idle and no BGP is exchanged

*Want from the capture:* what answers the SYN to port 179 — SYN-ACK, RST, or
nothing — and how often it retries.

**✔** The dashboard leads with *"TCP connections to port 179 are being refused —
3 SYNs answered by RST"*, and names ACLs, MD5/TCP-AO and a stopped BGP process as
what to check. This is the case the transport-level alerts exist for.

### S2 — `s2-capability-mismatch` · Established, but no IPv6 routes arrive

*Want from the capture:* the two OPENs side by side — which AFI/SAFI, 4-byte AS,
ADD-PATH and Graceful Restart each end advertised.

**✔** Neighbors → a router → its session → **Capability Diff** lists
`IPv6/Unicast Multiprotocol Extensions ⚠ Only 1.1.1.1`, and the same for GR and
ADD-PATH. A direct answer to "why is this family missing". Note the navigation
depth: the diff only appears once a *session* is selected, not a router.

### S3 — `s3-holdtimer-flap` · The session flaps every few minutes

*Want from the capture:* the NOTIFICATION code and subcode, how many times it
re-established, and — the part that decides the diagnosis — how long after the
last KEEPALIVE the teardown came.

**✔** The dashboard groups the repeats into one row, *"NOTIFICATION: Hold Timer
Expired / Unspecific ×3"*, alongside *"Session flapping detected — 6 OPEN
messages (~3 establishments)"*. Selecting the NOTIFICATION shows the interval
under **Silence before the teardown**:

> **90.4s** since the last KEEPALIVE from 10.0.0.1 at 00:01:01.802, against a
> negotiated hold time of **90s**.

Which is what makes this one-way reachability rather than a BGP fault, and the
panel says so. The measurement is deliberately one-sided: the hold timer counts
silence *from the peer*, so it is the gap to 10.0.0.1's last message, not the gap
to the previous packet in the capture. Those differ by the offset between the two
ends' keepalive clocks — here the naive reading is 90.2s, from 10.0.0.2's own
KEEPALIVE, which the timer never looked at.

The same number in SQL, for a capture with more than one session in it. The
window has to skip the local end's own packets — a plain `lag(p.timestamp)`
walks across both directions and answers 90.2s:

```sql
select m.type, p.src_ip, p.timestamp,
       epoch(p.timestamp - max(case when p.src_ip = '10.0.0.1' then p.timestamp end)
             over (order by p.frame_index rows between unbounded preceding and 1 preceding))
         as since_peer_s
from packets p join messages m using(frame_index)
order by p.frame_index
```

### S4 — `s4-bestpath` · Traffic leaves by the wrong upstream

*Want from the capture:* every path for the prefix, side by side — AS_PATH
length, LOCAL_PREF, MED, ORIGIN, NEXT_HOP, communities.

**✔** Routes → the prefix. The route history lists every announcement with the
attributes the decision was made on, one row per peer: AS_PATH, Next Hop, MED,
LOCAL_PREF and communities. On this capture the two rows say it outright — the
longer AS_PATH wins, carrying LOCAL_PREF 200 against a shorter path with none,
and the loser's MED of 300 never gets a say because MED is compared much later
and only between paths from the same neighbouring AS.

A dash means the attribute was absent from that UPDATE, which is not a value of
zero: a route deliberately made unattractive with `local_pref 0` reads as `0`,
and one that simply carries no LOCAL_PREF reads as `-`. Columns appear only when
the selected route has them, and ORIGIN only when it *differs* between
announcements — it is IGP on almost everything, and a column of identical values
costs width the others need.

`med` and `local_pref` are also filter fields, with ranges (`med > 100`,
`local_pref >= 200`), in both the in-memory and the SQL backend. An UPDATE that
carried no MED matches no `med` comparison at all — treating absent as zero
would make `med < 100` select most of an eBGP capture.

SQL is still the better tool for the same question asked across every prefix at
once, and two traps are worth knowing there. `nlri.prefix` holds no mask —
`172.20.0.0`, not `172.20.0.0/16` — so it wants `prefix || '/' || prefix_length`.
And `nlri`, `as_path` and `path_attributes` all join on `message_id`, so a plain
three-way JOIN fans out into the cross product; correlated subqueries are the
shape that works:

```sql
select n.prefix || '/' || n.prefix_length as route, p.src_ip,
       (select string_agg(a.asn, ' ' order by a.as_index)
          from as_path a where a.message_id = m.id) as as_path,
       (select max(med_value)  from path_attributes where message_id = m.id) as med,
       (select max(local_pref) from path_attributes where message_id = m.id) as lpref,
       (select string_agg(formatted, ',') from communities where message_id = m.id) as comms
from nlri n join messages m on m.id = n.message_id join packets p using(frame_index)
```

### S5 — `s5-route-leak` · A customer announcing more than it should

*Want from the capture:* the full AS_PATH per prefix, the origin AS, and every
route carrying an AS that has no business being there.

**◑** `asn = 15169` narrows to the frame, and the Routes screen has an AS_PATH
Analysis panel and an "prefixes with ASxxx in their AS_PATH" search. But the
dashboard says **"No issues detected — every session looks healthy"**, which it
is: nothing is wrong at the session layer. There is no notion of an expected
path shape, so a leak is only found by someone already looking for one.

### S6 — `s6-malformed-update` · The session drops when routes are advertised

*Want from the capture:* the offending UPDATE's attributes and flags, and what
the NOTIFICATION's data field points at.

**✔** The NOTIFICATION reads `3/2 UPDATE Message Error / Unrecognized
Well-known Attribute`, the UPDATE before it shows `UNKNOWN(199) · Transitive ·
Unparsed`, and the NOTIFICATION's data field is decoded as what RFC 4271 §6.3
says it is — the offending attribute, handed straight back:

```
OFFENDING ATTRIBUTE
UNKNOWN(199)   type 199   4 bytes   Well-known   Transitive
```

`Well-known` is the optional bit being clear, which is the fault itself and the
word the subcode uses for it. The seven raw bytes stay underneath, because a
NOTIFICATION is the message people most want to check an interpretation
against.

### S7 — `s7-segmented` · Only some advertised routes seem to arrive

*Want from the capture:* whether messages span TCP segments, and the prefix total
after reassembly.

**✔** 400 prefixes at a 576-byte MTU, all 400 recovered and counted on the Routes
screen.

### S8 — `s8-graceful-restart` · A reload, and did forwarding survive?

*Want from the capture:* the GR capability on both ends including restart time
and the forwarding-state flag, and how long the re-established session took to
reach End-of-RIB.

**✔** The dashboard reports *"10.0.0.1 restarted gracefully"* and assembles the
three numbers the question needs: the Restart Time the speaker asked for, whether
it advertised preserved forwarding state, and the measured gap between the
session coming back and its End-of-RIB — 3.8s here, against the 120s it asked
for.

It replaces the *"Session flapping detected"* row rather than joining it. A
reload and a crash loop reading identically was the whole of S8, so leaving the
old headline in place would have left the confusion in place. The restart row
carries its own count, so a router restarting repeatedly still shows as
repeatedly. It also takes the *"was reset with no NOTIFICATION"* row with it,
since a restart is exactly the explanation that row exists to report the absence
of.

Warning rather than critical when the restart kept both of its promises, and
critical when it did not: forwarding state not preserved, or convergence running
past the Restart Time — after which the peer has stopped holding the routes and
withdrawn them, which is the outage the mechanism exists to prevent.

### S9 — `s9-route-refresh` · A soft clear did not produce the expected routes

*Want from the capture:* the ROUTE-REFRESH AFI/SAFI, and how the re-advertisement
differs from what was there before.

**✔** Select the ROUTE-REFRESH and the detail panel takes the difference: what
the re-advertisement added, what it did not bring back, and what came back with
different attributes. On this capture it reads *"10.1.1.0/24 — announced with
community 65001:999"*, with the route that returned identical counted rather
than listed.

The half that cannot be read from withdrawals is the important one. After a
refresh the peer re-sends its whole table, so a route it no longer has is simply
**absent** from the answer — nothing withdraws it. That is the "my soft clear
lost routes" complaint, and a rule watching for withdrawals would find nothing
wrong with the capture.

Selecting the message is also how a capture holding several refreshes chooses
the interval, since each compares its own. Where the capture cannot settle the
question it says so rather than guessing: no OPEN before the refresh means the
"before" side is only what was caught, and no End-of-RIB after it means anything
not yet re-sent is listed as gone whether or not it was on its way.

### S10 — `s10-churn` · High CPU and a RIB that will not settle

*Want from the capture:* withdrawals per unit time, and which prefixes are worst.

**✔** Per-prefix flap rows, a *"N more prefixes flapped"* summary pointing at the
Routes screen, a withdraw-burst alert, and AS_PATH-change rows — the fullest
automatic answer of any scenario here.

### S11 — `s11-silent-teardown` · It dropped, and no NOTIFICATION says why

*Want from the capture:* whether a RST or a FIN ended it, at what time, and how
long until the reconnect.

The capture holds both shapes, because they are the same fault with different
manners and an implementation that only looked for RST would call the second one
healthy: a bare RST five seconds after a KEEPALIVE, and later an ordinary FIN
close. A BGP speaker that meant to go away would have sent Cease first, so a FIN
on its own is the same missing explanation.

**✔** The dashboard reports both teardowns as critical rows — one for the RST,
one for the FIN — naming the peering and saying that nothing at the BGP layer
accounted for either. `View →` switches the packet list to **All Packets** and
selects the frame itself, which it has to: the list shows BGP only by default,
so a row naming an `[AR]` would otherwise land you where it cannot be seen.

The rows sit next to the existing *"Session flapping detected"* rather than
replacing it. They are symptom and cause: flapping counts how often the session
came up, these say how it went down and that nothing explained it.

`s3-holdtimer-flap` also contains RSTs — after its NOTIFICATIONs — and stays
quiet, as does `s14-open-unanswered`, whose resets end connections that never
became sessions and which already has a row of its own. `design.md` §2.1.14
carries the rule, including why it is scoped to a connection rather than a peer
and why connections are delimited by SYN rather than by the four-tuple.

Still missing: there is no filter field for TCP flags, so narrowing the packet
list to resets by hand is not possible.

### S12 — `s12-one-direction` · A capture that shows a session the router calls down

*Want from the capture:* first and foremost, that only one direction is in it.

Two different things produce this file and nothing distinguishes them. It may be
a broken mirror — a SPAN session or capture filter that caught one leg — or it
may be a fault, with the peer's packets genuinely not arriving because of a
unidirectional link, an ACL applied one way, or MD5 configured on one side. The
second is an outage, not a capture problem, which is why the right message names
both possibilities rather than telling the operator their capture is broken.

**✔** The dashboard leads with *"Only one direction of this session is in the
capture — every frame between 10.0.0.1 and 10.0.0.2 was sent by 10.0.0.1"*, and
names both readings rather than picking one. The neighbor table marks the pair
`⚠ Never up`.

The row deliberately does not say "your capture is incomplete", because half the
time that would be wrong: the peer's packets may not be arriving at all. What it
does say is that anything read off this session is half a conversation until you
know which.

### S13 — `s13-evpn-mac-move` · A host in the fabric unreachable in bursts

*Want from the capture:* MAC, VNI, RD, ESI, and which VTEP advertised or withdrew
each one.

**✔** Surfaced as *"Route flapping: [2] 00:0c:29:aa:bb:cc VNI 10100"* plus an
AS_PATH change from 65002 to 65001 — the two halves of a move. The `mac`, `vni`,
`rd` and `evpn_type` filter fields and the `nlri`/`withdrawn` EVPN columns all
carry it. Reading a move as a "flap" is a wording mismatch rather than a wrong
answer, and MAC Mobility sequence numbers are not compared.

### S14 — `s14-open-unanswered` · TCP connects and the peer never answers

*Want from the capture:* that the connection established, that our OPEN went
out, and that nothing came back — which is what narrows the search to the far
end.

This is the case a single-router capture is worst at explaining and an operator
hits most often when the far end is somebody else's. It is not S1: the SYN is
answered and TCP comes up. It is not S12: both directions are present, since the
peer's stack completes the handshake. The peer simply contributes no BGP —
identical from this end whether the neighbor statement is missing, the peer is
passive and waiting for something it will not get, or MD5 is set on one side so
the peer's stack discards the OPEN before BGP ever sees it.

**✔** The dashboard reports *"TCP connects but 10.0.0.2 sends no BGP ×3"*, and
the detail says what the successful handshake rules out: the port is open, no ACL
is dropping the SYN, and MD5 agrees — a one-sided MD5 fails the handshake rather
than surviving it. What is left is the peer's BGP unwilling to talk to this
address, or the payload not surviving a path that carries the handshake fine (a
TCP middlebox, a PMTU black hole, control-plane policing). The neighbor table
marks the pair `⚠ Never up`.

The rule requires a SYN-ACK, so S1 — where the SYN is refused — is left to the
transport alert that already explains it, rather than getting a second and worse
explanation of the same packets.

## What the scenarios say about the tool

Session-layer faults — S1, S2, S3, S7, S10, S13 — are answered on screen, often
in one row of the alert panel. That is the tool working as designed.

The gaps have a shape in common. **Everything the tool reports well is something
present in the capture; everything it misses is something absent from it.** An
alert fires on a NOTIFICATION that arrived, a withdrawal that happened, an OPEN
that disagreed. Nothing fires on a reply that never came, a direction that is not
there, or a session that never reached Established — and from a capture taken on
one router, absence is exactly how a fault at the far end appears.

Two of those gaps are now closed, both by rules that fire on an absence.
`computeSessionSetupAlerts` reports a session with one direction in it and a
connection that was accepted and never answered, both as critical rows, and the
neighbour table marks the pair `⚠ Never up` rather than `✓ OK`. Run against all
fourteen captures plus the sample and the ContainerLab capture, the two rules
fire on S12 and S14 and stay silent everywhere else.

`computeSilentTeardownAlerts` closes the second: a connection that carried BGP
both ways and then ended in RST or FIN with no NOTIFICATION on it. Across the
corpus it fires on S11, as two rows for the two shapes. S8 is the exception it
stands down for: a graceful restart is a teardown nobody announced, but the
restart rule accounts for it and says something more useful about it.

What remains is one scenario, and it is the one the capture cannot answer at
all: **S5 has no notion of an expected AS_PATH**, so a leak looks exactly like a
legitimate announcement. The missing thing there is not in the file but in what
the operator meant to accept, and no amount of reading the capture supplies it.

Smaller ones: `hold_time` exists as a column but not as a filter field, and the
SQL results grid renders `timestamp` as raw epoch milliseconds.
