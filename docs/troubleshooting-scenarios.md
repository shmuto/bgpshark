# Troubleshooting Scenarios

Fourteen reproducible BGP fault captures compiled by [`testlab/scenarios.ts`](../testlab/scenarios.ts), paired with what an operator needs from each capture and how well BGPShark answers it today.

This document is the **coverage assessment** for developers and QA. For the user-facing walkthroughs illustrated from these same captures, see the in-app manual ([`src/pages/manual/manual.md`](../src/pages/manual/manual.md)). When a verdict changes here, update the manual and re-run `bun run screenshots` if needed.

## Building the captures

```bash
bun run testlab/scenarios.ts          # generate all 14 captures into testlab/scenarios/
bun run testlab/scenarios.ts s3 s11   # generate specific scenarios only
```

Output `.pcap` files are gitignored; `testlab/scenarios.ts` is the source of truth. These are fixed test reproductions rather than [Capture Builder](../README.md#capture-builder) presets (for example, S4 merges two sessions and S12 strips one direction from a complete capture).

## Where the capture was taken

Every scenario models a **single-router capture** (the most common real-world case when the remote peer belongs to another organization):

- **One router still sees both directions** (sent + received) on its own interface; 13 of 14 scenarios are bidirectional.
- **Multiple sessions in one capture are normal** (e.g. S4 compares two upstreams side by side).
- **Remote-side failures appear only as absence.** A single-router capture proves what left the local interface, not what the peer received (see S12 and S14).

## Coverage summary

Legend: **✔** answered on screen · **◑** answerable with manual search or SQL · **✘** not answerable or wrong.

| ID | Capture | Symptom | Status | Primary screen |
|----|---------|---------|--------|----------------|
| S1 | `s1-tcp-refused` | Neighbor stays Idle, no BGP exchanged | ✔ | Findings (transport alerts) |
| S2 | `s2-capability-mismatch` | Established, but IPv6 routes never arrive | ✔ | Sessions → OPEN comparison |
| S3 | `s3-holdtimer-flap` | Session flaps every few minutes | ✔ | Findings + Messages (NOTIFICATION) |
| S4 | `s4-bestpath` | Traffic leaves by the wrong upstream | ✔ | Routes (history attributes) |
| S5 | `s5-route-leak` | Customer announcing transit routes | ◑ | Routes (AS search) / Messages (`asn =`) |
| S6 | `s6-malformed-update` | Session drops on first UPDATE | ✔ | Messages (NOTIFICATION data decode) |
| S7 | `s7-segmented` | Large UPDATE split across TCP segments | ✔ | Routes (reassembled prefix count) |
| S8 | `s8-graceful-restart` | Router reload with Graceful Restart | ✔ | Findings (GR alert) + Capability Diff |
| S9 | `s9-route-refresh` | Soft clear changed or lost routes | ✔ | Messages (ROUTE-REFRESH diff) |
| S10 | `s10-churn` | High CPU and unstable RIB | ✔ | Findings + Routes (Flap sort) |
| S11 | `s11-silent-teardown` | Session dropped with no NOTIFICATION | ✔ | Findings + Messages (All Packets) |
| S12 | `s12-one-direction` | Only one direction present in capture | ✔ | Findings + Messages (All Packets) |
| S13 | `s13-evpn-mac-move` | Fabric host drops out in bursts | ✔ | Findings + Messages (`mac =`) + Routes |
| S14 | `s14-open-unanswered` | TCP connects, peer never sends BGP | ✔ | Findings + session list |

## Scenario details

### S1 — `s1-tcp-refused` · Neighbor stays Idle and no BGP is exchanged
- **Want:** What answers TCP SYNs to port 179 (SYN-ACK, RST, or silence) and retry cadence.
- **✔ Verdict:** With no BGP in the capture, the workspace runs `computeTransportAlerts` and leads with *"TCP connections to port 179 are being refused — 3 SYNs answered by RST"*, pointing to ACLs, TCP-MD5/AO, or a stopped BGP process.

### S2 — `s2-capability-mismatch` · Established, but no IPv6 routes arrive
- **Want:** Side-by-side OPEN comparison per AFI/SAFI and capability.
- **✔ Verdict:** The **Sessions** tab's **OPEN comparison** (with the session chosen) flags `IPv6/Unicast Multiprotocol Extensions ⚠ Only 1.1.1.1` (plus GR and ADD-PATH mismatches) ahead of matching entries.

### S3 — `s3-holdtimer-flap` · Session flaps every few minutes
- **Want:** NOTIFICATION code/subcode, flap count, and silence duration since the peer's last message against the negotiated hold time.
- **✔ Verdict:** Findings group repeats into *"NOTIFICATION: Hold Timer Expired / Unspecific ×3"* alongside *"Session flapping detected"*. Clicking the NOTIFICATION displays **Silence before the teardown** (`90.4s` since `10.0.0.1`'s last KEEPALIVE against negotiated `90s`), measured strictly from the peer's last message rather than the previous packet in the list.

### S4 — `s4-bestpath` · Traffic leaves by the wrong upstream
- **Want:** All announcements for a prefix side by side with AS_PATH, LOCAL_PREF, MED, ORIGIN, NEXT_HOP, and communities.
- **✔ Verdict:** **Routes → prefix** displays every announcement per peer with those columns (showing `-` for absent attributes, distinct from `0`, and hiding `ORIGIN` unless values disagree). `med` and `local_pref` also support range comparisons in the filter bar across both backends.

### S5 — `s5-route-leak` · Customer announcing more than it should
- **Want:** Full AS_PATH per prefix and all routes carrying an unexpected AS.
- **◑ Verdict:** Searchable via `AS15169` on **Routes** or `asn = 15169` in **Messages**, with AS_PATH Analysis showing the full path. Findings report *"No issues detected"* because session health is normal and BGPShark has no knowledge of expected routing policy.

### S6 — `s6-malformed-update` · Session drops when routes are advertised
- **Want:** Offending UPDATE attributes/flags and decoded NOTIFICATION data.
- **✔ Verdict:** NOTIFICATION displays `3/2 UPDATE Message Error / Unrecognized Well-known Attribute` and decodes the data field per RFC 4271 §6.3 (`UNKNOWN(199) · type 199 · 4 bytes · Well-known · Transitive`) above the raw hex bytes; the preceding UPDATE shows `UNKNOWN(199) · Transitive · Unparsed`.

### S7 — `s7-segmented` · Only some advertised routes seem to arrive
- **Want:** Accurate reassembly and prefix total when UPDATEs span TCP segments.
- **✔ Verdict:** 400 prefixes sent over a 576-byte MTU are reassembled and counted accurately on **Routes**.

### S8 — `s8-graceful-restart` · Reload with Graceful Restart
- **Want:** GR capabilities/flags, Restart Time, forwarding-state preservation, and convergence duration to End-of-RIB.
- **✔ Verdict:** Findings report *"10.0.0.1 restarted gracefully"* with Restart Time (`120s`), forwarding-state status, and measured convergence (`3.8s`), replacing both *"Session flapping detected"* and *"Silent teardown"* for the restart. Escalates to critical if forwarding state was not preserved or convergence exceeded Restart Time.

### S9 — `s9-route-refresh` · Soft clear changed or dropped routes
- **Want:** ROUTE-REFRESH AFI/SAFI and the diff between pre-refresh and post-refresh advertisements.
- **✔ Verdict:** Selecting the ROUTE-REFRESH shows **What the refresh changed** (added, no longer advertised, changed attributes, and unchanged count), including mid-session and missing End-of-RIB boundary notices.

### S10 — `s10-churn` · High CPU and an unstable RIB
- **Want:** Withdrawal bursts, worst-flapping prefixes, and AS_PATH oscillation.
- **✔ Verdict:** Findings surface per-prefix flaps, a summary overflow row, AS_PATH changes, and a withdraw-burst alert; **Routes** sorts by flap count and shows AS_PATH variants.

### S11 — `s11-silent-teardown` · Dropped with no NOTIFICATION
- **Want:** Whether RST or FIN ended the session, timestamps, and reconnect gap.
- **✔ Verdict:** Findings raise separate critical alerts for RST and FIN teardowns alongside *"Session flapping detected"*, and clicking the finding jumps directly to **All Packets** with the exact frame selected (`?all=1&frame=`). False-positive checks (`s3-holdtimer-flap`, `s14-open-unanswered`, `s8-graceful-restart`) stay quiet (`design.md` §2.1.14).
- **Remaining gap:** No filter field for TCP flags to manually filter **All Packets** down to resets/FINs.

### S12 — `s12-one-direction` · Only one direction captured
- **Want:** Immediate warning that the session is one-sided, without falsely assuming a capture defect vs. one-way outage.
- **✔ Verdict:** Findings raise *"Only one direction of this session is in the capture"* naming both possible causes, and the session list marks the pair **Critical**.

### S13 — `s13-evpn-mac-move` · Fabric host unreachable in bursts
- **Want:** MAC, VNI, RD, ESI, and which VTEP announced/withdrew each route.
- **✔ Verdict:** Surfaced as *"MAC moved"* (from the VTEP it left to the one it moved to) + route flapping in Findings, tracked in **Routes**, and filterable with `mac`, `vni`, `rd`, and `evpn_type`.
- **Minor notes:** MAC Mobility sequence numbers are decoded in details but not compared automatically.

### S14 — `s14-open-unanswered` · TCP connects and peer sends no BGP
- **Want:** Confirmation that TCP established and local OPEN was sent with no BGP reply.
- **✔ Verdict:** Findings report *"TCP connects but 10.0.0.2 sends no BGP ×3"* with guidance on what the completed handshake rules out (open port, no SYN ACL, matching MD5), and the session list marks the pair **Critical**. Does not overlap with S1 transport alerts.

## Remaining gaps

- **Policy-level anomalies (S5):** Detecting route leaks requires external policy intent that is not present in a packet capture.
- **Filter fields:** No filter fields yet for TCP flags (S11) or `hold_time`.
- **SQL Console formatting:** The results grid currently renders `timestamp` as raw epoch milliseconds.
