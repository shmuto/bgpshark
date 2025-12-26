# BGPShark Test Lab

ContainerLab environment for testing BGP packet captures.

## Topology

```
+--------+     e1-1      +--------+
|  srl1  |---------------| srl2   |
| AS65001|  10.0.0.0/30  | AS65002|
+--------+               +--------+
```

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
# Connect to srl1
ssh admin@clab-bgpshark-test-srl1

# Check BGP neighbors
show network-instance default protocols bgp neighbor
```

### Capture BGP traffic

```bash
# Capture on the link between srl1 and srl2
sudo ip netns exec clab-bgpshark-test-srl1 tcpdump -i e1-1 port 179 -w bgp-capture.pcap

# Or capture from host bridge
sudo tcpdump -i br-$(docker network ls -qf name=clab) port 179 -w bgp-capture.pcap
```

### Generate BGP events

```bash
# Flap the BGP session on srl1
ssh admin@clab-bgpshark-test-srl1 "sr_cli 'tools network-instance default protocols bgp neighbor 10.0.0.2 reset-peer'"

# Administratively shutdown BGP on srl2
ssh admin@clab-bgpshark-test-srl2 "sr_cli 'enter candidate; set network-instance default protocols bgp neighbor 10.0.0.1 admin-state disable; commit now'"
```

### Stop the lab

```bash
sudo containerlab destroy -t topology.clab.yml
```

## Credentials

- Username: `admin`
- Password: `NokiaSrl1!`
