#!/bin/bash
# Capture BGP traffic between srl1 and srl2

OUTPUT="${1:-bgp-capture.pcap}"
DURATION="${2:-60}"

echo "Capturing BGP traffic for ${DURATION} seconds..."
echo "Output: ${OUTPUT}"

# Capture from srl1's e1-1 interface
sudo ip netns exec clab-bgpshark-test-srl1 \
    tcpdump -i e1-1 -nn port 179 -w "${OUTPUT}" &
TCPDUMP_PID=$!

sleep "${DURATION}"

sudo kill "${TCPDUMP_PID}" 2>/dev/null
wait "${TCPDUMP_PID}" 2>/dev/null

echo "Capture complete: ${OUTPUT}"
echo "Packets captured:"
tcpdump -r "${OUTPUT}" -nn | head -20
