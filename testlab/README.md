# BGPShark Test Lab

ContainerLab environment for testing BGP packet captures.

For captures you want *now*, without Docker or four SR Linux images, see
`scenarios.ts` in this directory: fourteen reproductions of specific faults,
compiled through `src/lib/build` and described in
[../docs/troubleshooting-scenarios.md](../docs/troubleshooting-scenarios.md).

```bash
bun run testlab/scenarios.ts          # all of them, into testlab/scenarios/
bun run testlab/scenarios.ts s3 s11   # just these
```

The lab below is still what produces traffic no description would think to
include — real timers, real convergence, real vendor quirks.

## Topology

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

## IP Addressing

| Router | Loopback | AS | Interfaces |
|--------|----------|-----|------------|
| srl1 | 1.1.1.1/32 | 65001 | e1-1: 10.0.12.1/24, e1-2: 10.0.13.1/24, e1-3: 10.0.14.1/24 |
| srl2 | 2.2.2.2/32 | 65001 | e1-1: 10.0.12.2/24, e1-2: 10.0.23.2/24, e1-3: 10.0.24.2/24 |
| srl3 | 3.3.3.3/32 | 65002 | e1-1: 10.0.34.3/24, e1-2: 10.0.13.3/24, e1-3: 10.0.23.3/24 |
| srl4 | 4.4.4.4/32 | 65002 | e1-1: 10.0.34.4/24, e1-2: 10.0.14.4/24, e1-3: 10.0.24.4/24 |

## Requirements

- [ContainerLab](https://containerlab.dev/install/)
- Docker

## Usage

### Start the lab

```bash
cd testlab
sudo containerlab deploy -t topology.clab.yml
```

### Check BGP status

```bash
# Connect to any router
ssh admin@clab-bgpshark-test-srl1

# Check BGP neighbors
show network-instance default protocols bgp neighbor
```

### Capture BGP traffic

```bash
# Capture from srl1's 3 interfaces and merge
./capture.sh

# Or capture manually on a specific interface
sudo ip netns exec clab-bgpshark-test-srl1 tcpdump -i e1-2 port 179 -w bgp-capture.pcap
```

### Generate BGP events

```bash
# Flap the eBGP session between srl1 and srl3
ssh admin@clab-bgpshark-test-srl1 "sr_cli 'tools network-instance default protocols bgp neighbor 10.0.13.3 reset-peer'"

# Administratively shutdown iBGP on srl1
ssh admin@clab-bgpshark-test-srl1 "sr_cli 'enter candidate; set network-instance default protocols bgp neighbor 10.0.12.2 admin-state disable; commit now'"

# Re-enable iBGP
ssh admin@clab-bgpshark-test-srl1 "sr_cli 'enter candidate; set network-instance default protocols bgp neighbor 10.0.12.2 admin-state enable; commit now'"
```

### Stop the lab

```bash
sudo containerlab destroy -t topology.clab.yml
```

## Credentials

- Username: `admin`
- Password: `NokiaSrl1!`
