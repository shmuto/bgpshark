# BGPShark Test Lab

Tools and lab setup for generating BGP packet captures and manual screenshots.

## Quick synthetic fault captures

To generate 14 targeted BGP fault captures immediately without Docker or SR Linux images, use `scenarios.ts` (built on `src/lib/build` and documented in [`docs/troubleshooting-scenarios.md`](../docs/troubleshooting-scenarios.md)):

```bash
bun run testlab/scenarios.ts          # generate all 14 captures into testlab/scenarios/
bun run testlab/scenarios.ts s3 s11   # generate specific scenarios only
```

## One-off captures

When you need a capture for a single check — confirming a fix by hand, reproducing a report — describe it in a file and let `testlab/pcap.ts` do the rest, rather than writing a script that imports the builder and writes bytes itself:

```bash
bun run pcap --new /tmp/case.ts       # write a starter capture file
bun run pcap /tmp/case.ts --dump      # build it into testlab/out/case.pcap and list each frame
bun run pcap flap -o /tmp/flap.pcap   # a preset, written wherever you like
bun run pcap real.pcapng --dump       # an existing capture, listed as the app reads it
bun run pcap --list                   # the preset ids
```

`--dump` reads the written file back through the app's own pcap and BGP parsers, so what it lists is what BGPShark will show — a capture that does not decode as intended shows up here, before you open it in the browser. Parser warnings are printed too; they do not fail the command, because a deliberately malformed capture is a legitimate thing to build.

A capture file's default export may be any of:

| Export | Result |
|--------|--------|
| a `Scenario` | that session |
| a `PacketList` (`{ packets: [...] }`) | exactly those packets — see below |
| a `BuiltCapture` (from any builder, `readCapture`, or an edit) | that capture |
| an array of any of the above | all of them merged in time order |
| a `Uint8Array` | written as is — for a file damaged with `patchRecord` |
| a function, optionally async | whatever it returns; it is passed the builder module plus `Afi`, `Safi` and `load(path)`, so a file outside the repository needs no imports |

A `.json` file holding a `Scenario` (or an array of them) also works, and a `.pcap` / `.pcapng` / `.cap` on the command line is read in as it is. Several sources on one command line are merged into one file; the command warns when two of them reuse the same TCP connection, since every preset uses the same two routers.

The pieces most captures share are in `src/lib/build`: `ROUTER_A` / `ROUTER_B`, `establish()` for the handshake-OPEN-KEEPALIVE opening, `announce()` / `withdraw()` / `END_OF_RIB`, `mergeCaptures()` for several sessions in one file, and `keepSide()` for a capture with one direction missing.

### Beyond a clean BGP session

Three things the session builder cannot say on its own:

- **Bytes the encoder has no spec for.** A message `{ type: 'RAW', bytes }` goes on the TCP stream verbatim, with no header added and no checks: EVPN or any other NLRI the encoder does not know, an unknown message type, a bad marker or length, half a message, or data that is not BGP at all. `bgpMessage(type, body)` adds the 19-byte header for you, and `hex('ff ff 00 13')` turns text into bytes.
- **Traffic that is not a session.** `buildPackets({ packets })` builds exactly the packets listed — `protocol: 'tcp' | 'udp' | 'icmp'` or any IP protocol number — with real checksums and no connection state, so a TCP packet carries just the flags and sequence number it is given. Use it for the ICMP, BFD or stray RST around a session, or a connection on another port.
- **Damage and existing captures.** `readCapture(bytes)` (or `load(path)` in a function export) reads any pcap or pcapng, keeping non-IP frames the app skips. Then, each returning a new capture: `dropFrames`, `filterFrames`, `shiftTime` (all frames, or from one on), `startAt`, `overwriteBytes`, `editFrame`, `snapFrames` (what `tcpdump -s` does). Frames are numbered from 1, as in the app. `patchRecord(file, [1, 2], { capturedLength: (n) => n + 40 })` makes record headers lie about their length or time. It works on a finished file's bytes — a classic pcap or a pcapng, which fail differently: a lying pcap record reads as the end of the file, a lying pcapng block costs only that packet — so it comes last.

```ts
// A real capture with a frame lost, a minute's silence, and a ping alongside.
export default ({ load, dropFrames, shiftTime, buildPackets }) => [
  shiftTime(dropFrames(load('real.pcapng'), [12]), 60_000, { from: 20 }),
  buildPackets({
    startTime: new Date('2026-01-01T00:00:00Z'),
    packets: [
      { protocol: 'icmp', src: '10.0.0.1', dst: '10.0.0.2' },
      { protocol: 'icmp', type: 0, src: '10.0.0.2', dst: '10.0.0.1' },
    ],
  }),
]
```

Timestamps are kept to the millisecond, because built frames hold a `Date`: a capture read in and written back keeps its frame order but loses any sub-millisecond part.

```ts
// Two upstreams, the second seen only in one direction.
export default ({ ROUTER_A, ROUTER_B, buildScenario, establish, keepSide }) => [
  { a: ROUTER_A, b: ROUTER_B, steps: establish() },
  keepSide(
    buildScenario({
      a: { ...ROUTER_A, ip: '10.0.1.1' },
      b: { ...ROUTER_B, ip: '10.0.1.2' },
      startTime: new Date('2026-01-01T00:00:05Z'),
      steps: establish(),
    }),
    'a'
  ),
]
```

Output in `testlab/out/` is gitignored. If a capture turns out to be worth keeping, move its description into `testlab/scenarios.ts` or a test helper rather than committing the pcap.

## Large captures: measuring memory and long tasks

`MAX_FILE_SIZE` (`src/lib/file-constraints.ts`) is set by what a capture near it costs the tab, and that depends far more on the capture's shape than its size. Two scripts measure it, against synthetic captures of four shapes:

```bash
bun run testlab/large-captures.ts                 # U, R and T at 300 MB into testlab/out/large/
bun run testlab/large-captures.ts U R T E --mb 250
bunx vite build && bunx vite preview &            # the production build, with the real CSP
bun run testlab/measure-large.ts                  # every capture in testlab/out/large/
bun run testlab/measure-large.ts T-300mb.pcap --json /tmp/t.json
```

| Shape | What it is | What it stresses |
|-------|------------|------------------|
| **U** | Every UPDATE its own /32, AS_PATH and MED; a withdrawal every 50 | Nothing repeats, so the most packets and decoded objects per byte |
| **R** | 200 distinct /24s per UPDATE from 50,000 per session, 50 AS paths, communities | Tens of millions of announcements: route statistics, the `nlri` table |
| **T** | A table transfer: 50 /24s per UPDATE, each session cycling through 300,000 | Over a million routes: per-route state, the Routes screen |
| **E** | EVPN MAC/IP routes and ADD-PATH IPv4 (optional) | MP_REACH routes, which are never shared, and per-event Path Identifiers |

Each is four sessions (`10.k.0.1` ↔ `10.k.0.2`, k = 0..3) opening with the handshake, both OPENs and both KEEPALIVEs, then one UPDATE per segment 0.01 ms apart, with a KEEPALIVE each way every 2,000 UPDATEs. The UPDATE count is worked out from a sample so the file lands just under the size asked for.

`measure-large.ts` opens each capture in a fresh headless Chromium (`CHROMIUM_PATH`, or the preinstalled one) and walks it through the screens: the packet list, the findings, the filter box's suggestions for `prefix = `, the filter `prefix = 20.0.0.0/8`, the Routes screen until its list is sorted, and the SQL console until DuckDB holds the capture and has answered a query on `duckdb_memory()`. For each stage it records the wall time; the JS heap at its largest (sampled every 100 ms over the DevTools protocol) and once garbage is collected (`gc()` twice, then `performance.memory.usedJSHeapSize`); the longest task (`PerformanceObserver`, `longtask`); the renderer process's resident memory, which also counts typed arrays, the file itself and DuckDB's WebAssembly memory; and whether the tab crashed. It ends with a Markdown table.

A capture above the current limit is refused by the drop zone, so measuring one means raising `MAX_FILE_SIZE` in a local build only. Do not commit that.

For where the time and memory go, `measure-pipeline.ts` runs the same in-memory stages — parse, decode, route statistics, findings, suggestions, one filter — in Node, where a CPU profile or heap snapshot is easier to take:

```bash
bun build testlab/measure-pipeline.ts --target=node --outfile=/tmp/pipeline.mjs
node --expose-gc /tmp/pipeline.mjs testlab/out/large/U-300mb.pcap
node --expose-gc --cpu-prof --cpu-prof-dir=/tmp/prof /tmp/pipeline.mjs <capture>
node --expose-gc /tmp/pipeline.mjs <capture> --snapshot /tmp/u.heapsnapshot
node --max-old-space-size=8000 /tmp/pipeline.mjs --summarize /tmp/u.heapsnapshot
```

Node does not compress pointers, so its heap is about twice Chromium's for the same objects; compare stages with each other, not with the browser's figures. For a CPU profile in the browser, build with `vite build --minify false` so function names survive.

## Manual screenshots

The screenshots embedded in the in-app user manual (`public/manual/*.png`) are generated from the scenarios above by driving the live app in Chromium:

```bash
bun run screenshots                   # regenerate all screenshots into public/manual/
bun run screenshots s2 s11            # regenerate specific shots only
```

The script starts a dev server if one is not running and honors `CHROMIUM_PATH` in the same way as `bun run test:e2e`. Re-run and commit updated PNGs after changing any screen referenced by the manual.

## ContainerLab topology

For realistic vendor traffic (real timers, convergence, and SR Linux behavior), deploy the 4-node ContainerLab topology below.

### Topology

```
         AS 65001                                  AS 65002
   +--------------------------------+        +--------------------------------+
   |  +--------+        +--------+  |        |  +--------+        +--------+  |
   |  |  srl1  |--iBGP--|  srl2  |  |        |  |  srl3  |--iBGP--|  srl4  |  |
   |  | R-ID:  |        | R-ID:  |  |        |  | R-ID:  |        | R-ID:  |  |
   |  | 1.1.1.1|        | 2.2.2.2|  |        |  | 3.3.3.3|        | 4.4.4.4|  |
   |  +---+----+        +----+---+  |        |  +---+----+        +----+---+  |
   |      |  10.0.12.0/24   |       |        |      |  10.0.34.0/24   |       |
   |      +-----------------+       |        |      +-----------------+       |
   +--------------+-----------------+        +--------------+-----------------+
                  |                                         |
                  +------------ eBGP full mesh -------------+
              every srl1/srl2 x srl3/srl4 pair, one link each

Links:
  - srl1 <-> srl2: 10.0.12.0/24 (iBGP) - .1 and .2
  - srl3 <-> srl4: 10.0.34.0/24 (iBGP) - .3 and .4
  - srl1 <-> srl3: 10.0.13.0/24 (eBGP) - .1 and .3
  - srl1 <-> srl4: 10.0.14.0/24 (eBGP) - .1 and .4
  - srl2 <-> srl3: 10.0.23.0/24 (eBGP) - .2 and .3
  - srl2 <-> srl4: 10.0.24.0/24 (eBGP) - .2 and .4
```

### IP Addressing

| Router | Loopback | AS | Interfaces |
|--------|----------|-----|------------|
| `srl1` | `1.1.1.1/32` | 65001 | `e1-1`: `10.0.12.1/24`, `e1-2`: `10.0.13.1/24`, `e1-3`: `10.0.14.1/24` |
| `srl2` | `2.2.2.2/32` | 65001 | `e1-1`: `10.0.12.2/24`, `e1-2`: `10.0.23.2/24`, `e1-3`: `10.0.24.2/24` |
| `srl3` | `3.3.3.3/32` | 65002 | `e1-1`: `10.0.34.3/24`, `e1-2`: `10.0.13.3/24`, `e1-3`: `10.0.23.3/24` |
| `srl4` | `4.4.4.4/32` | 65002 | `e1-1`: `10.0.34.4/24`, `e1-2`: `10.0.14.4/24`, `e1-3`: `10.0.24.4/24` |

### Requirements

- [ContainerLab](https://containerlab.dev/install/)
- Docker
- `mergecap` (from `wireshark-common`) or `tcpslice` for `capture.sh`

### Usage

**Deploy the lab:**

```bash
cd testlab
sudo containerlab deploy -t topology.clab.yml
```

**Check BGP status (credentials: `admin` / `NokiaSrl1!`):**

```bash
ssh admin@clab-bgpshark-test-srl1
show network-instance default protocols bgp neighbor
```

**Capture BGP traffic:**

```bash
# Capture all 3 interfaces on srl1 and merge by timestamp
./capture.sh

# Or capture a single interface manually
sudo ip netns exec clab-bgpshark-test-srl1 tcpdump -i e1-2 port 179 -w bgp-capture.pcap
```

**Trigger BGP events:**

```bash
# Flap eBGP session between srl1 and srl3
ssh admin@clab-bgpshark-test-srl1 "sr_cli 'tools network-instance default protocols bgp neighbor 10.0.13.3 reset-peer'"

# Administratively shut down iBGP on srl1
ssh admin@clab-bgpshark-test-srl1 "sr_cli 'enter candidate; set network-instance default protocols bgp neighbor 10.0.12.2 admin-state disable; commit now'"

# Re-enable iBGP
ssh admin@clab-bgpshark-test-srl1 "sr_cli 'enter candidate; set network-instance default protocols bgp neighbor 10.0.12.2 admin-state enable; commit now'"
```

**Destroy the lab:**

```bash
sudo containerlab destroy -t topology.clab.yml
```
