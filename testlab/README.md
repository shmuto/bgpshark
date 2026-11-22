# BGPShark Test Lab

Tools and lab setup for generating BGP packet captures and manual screenshots.

## Quick synthetic fault captures

To generate 14 targeted BGP fault captures immediately without Docker or SR Linux images, use `scenarios.ts` (built on `src/lib/build` and documented in [`docs/troubleshooting-scenarios.md`](../docs/troubleshooting-scenarios.md)):

```bash
bun run testlab/scenarios.ts          # generate all 14 captures into testlab/scenarios/
bun run testlab/scenarios.ts s3 s11   # generate specific scenarios only
```

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
