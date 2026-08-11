# Troubleshooting scenarios

Thirteen faults an operator actually arrives with, each one compiled into a
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

**✔ / ◑** The dashboard groups the repeats into one row, *"NOTIFICATION: Hold
Timer Expired / Unspecific ×3"*, alongside *"Session flapping detected — 6 OPEN
messages (~3 establishments)"*, and the NOTIFICATION detail carries a
troubleshooting hint. The interval is **◑**: it takes SQL.

```sql
select m.type, p.src_ip, p.timestamp,
       epoch(p.timestamp - lag(p.timestamp) over (order by p.timestamp)) as gap_s
from packets p join messages m using(frame_index)
order by p.frame_index
```

90.2s between A's last KEEPALIVE and B's NOTIFICATION, against a negotiated hold
time of 90 — which is what makes this one-way reachability rather than a BGP
fault.

### S4 — `s4-bestpath` · Traffic leaves by the wrong upstream

*Want from the capture:* every path for the prefix, side by side — AS_PATH
length, LOCAL_PREF, MED, ORIGIN, NEXT_HOP, communities.

**◑** SQL only. The Routes screen's per-prefix history carries AS_PATH and Next
Hop but not MED, LOCAL_PREF or communities (`lib/bgp/prefix-stats.ts`), and
neither `med` nor `local_pref` is a filter field.

```sql
select n.prefix || '/' || n.prefix_length as route, p.src_ip,
       (select string_agg(a.asn, ' ' order by a.as_index)
          from as_path a where a.message_id = m.id) as as_path,
       (select max(med_value)  from path_attributes where message_id = m.id) as med,
       (select max(local_pref) from path_attributes where message_id = m.id) as lpref,
       (select string_agg(formatted, ',') from communities where message_id = m.id) as comms
from nlri n join messages m on m.id = n.message_id join packets p using(frame_index)
```

Two traps worth knowing, both visible here. `nlri.prefix` holds no mask —
`172.20.0.0`, not `172.20.0.0/16` — so it wants `prefix || '/' || prefix_length`.
And `nlri`, `as_path` and `path_attributes` all join on `message_id`, so a plain
three-way JOIN fans out into the cross product; the correlated subqueries above
are the shape that works.

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

**✔ / ◑** The NOTIFICATION reads `3/2 UPDATE Message Error / Unrecognized
Well-known Attribute`, and the UPDATE before it shows `UNKNOWN(199) · Transitive
· Unparsed` with the full message hex. What is missing is the last step: a
NOTIFICATION's data field is rendered as an undifferentiated hex dump, though for
error code 3 it is by definition the attribute that caused the error and could be
decoded as one.

### S7 — `s7-segmented` · Only some advertised routes seem to arrive

*Want from the capture:* whether messages span TCP segments, and the prefix total
after reassembly.

**✔** 400 prefixes at a 576-byte MTU, all 400 recovered and counted on the Routes
screen.

### S8 — `s8-graceful-restart` · A reload, and did forwarding survive?

*Want from the capture:* the GR capability on both ends including restart time
and the forwarding-state flag, and how long the re-established session took to
reach End-of-RIB.

**◑** The capability is in the Capability Diff and End-of-RIB is labelled as such
in the packet list, but the dashboard reports only *"Session flapping detected"* —
a graceful restart and a crash-loop read identically. Assembling "GR was
negotiated, forwarding state was preserved, convergence took 3s" is manual.

### S9 — `s9-route-refresh` · A soft clear did not produce the expected routes

*Want from the capture:* the ROUTE-REFRESH AFI/SAFI, and how the re-advertisement
differs from what was there before.

**◑** Both halves are visible as messages; the diff between them is yours to make.

### S10 — `s10-churn` · High CPU and a RIB that will not settle

*Want from the capture:* withdrawals per unit time, and which prefixes are worst.

**✔** Per-prefix flap rows, a *"N more prefixes flapped"* summary pointing at the
Routes screen, a withdraw-burst alert, and AS_PATH-change rows — the fullest
automatic answer of any scenario here.

### S11 — `s11-tcp-reset` · It dropped, and no NOTIFICATION says why

*Want from the capture:* whether a RST or FIN ended it, at what time, and how
long until the reconnect.

**◑** The evidence is there — switch the packet list to **All Packets** and frame
11 is `[AR] 179 → 51000` — but nothing routes you to it. The dashboard reports
the flap and stays silent about the reset, because `computeTransportAlerts` only
runs when the capture holds no BGP at all (`DashboardPage.tsx:117`). There is
also no filter field for TCP flags.

### S12 — `s12-one-direction` · A capture that shows a session the router calls down

*Want from the capture:* first and foremost, that it is half a capture.

**✘** The dashboard reports *"No issues detected — every session looks healthy"*
and the neighbor table marks the pair `✓ OK`. Only frames from 10.0.0.1 are
present; the NOTIFICATION 6/2 that ended the session was sent by the other end
and is simply absent. A one-legged SPAN is common enough, and confident enough in
its wrongness, that this is the gap with the most cost attached.

### S13 — `s13-evpn-mac-move` · A host in the fabric unreachable in bursts

*Want from the capture:* MAC, VNI, RD, ESI, and which VTEP advertised or withdrew
each one.

**✔** Surfaced as *"Route flapping: [2] 00:0c:29:aa:bb:cc VNI 10100"* plus an
AS_PATH change from 65002 to 65001 — the two halves of a move. The `mac`, `vni`,
`rd` and `evpn_type` filter fields and the `nlri`/`withdrawn` EVPN columns all
carry it. Reading a move as a "flap" is a wording mismatch rather than a wrong
answer, and MAC Mobility sequence numbers are not compared.

## What the scenarios say about the tool

Session-layer faults — S1, S2, S3, S7, S10, S13 — are answered on screen, often
in one row of the alert panel. That is the tool working as designed.

Three gaps are worth naming, in the order the scenarios argue for them:

1. **A one-sided capture is reported as healthy** (S12). Detectable from the
   structure alone — traffic in one direction only, or SYNs with no SYN-ACK — and
   every conclusion drawn from such a file is unsafe until it is said out loud.
2. **A post-establishment RST or FIN is never surfaced** (S11). The data is
   already parsed into `GenericPacket.tcpFlags`; only the gate on
   `computeTransportAlerts` keeps it off the dashboard.
3. **Best-path attributes stop at AS_PATH and Next Hop** (S4). MED, LOCAL_PREF
   and communities reach DuckDB but not the route history or the filter
   language, which makes the most common "why this path" question SQL-only.

Smaller ones: NOTIFICATION data is not decoded per error code (S6); `hold_time`
exists as a column but not as a filter field; the SQL results grid renders
`timestamp` as raw epoch milliseconds; and a graceful restart is indistinguishable
from a flap (S8).
