#!/usr/bin/env bash
# Capture BGP traffic between srl1 and srl2

OUTPUT="${1:-bgp-capture.pcap}"

echo "Capturing BGP traffic..."
echo "Output: ${OUTPUT}"
echo "Press Enter to stop capturing."
echo ""

# Capture from srl1's e1-1 interface
sudo ip netns exec clab-bgpshark-test-srl1 \
    tcpdump -i e1-1 -nn port 179 -w "${OUTPUT}" &
TCPDUMP_PID=$!

# Wait for user input
read -r

sudo kill "${TCPDUMP_PID}" 2>/dev/null
wait "${TCPDUMP_PID}" 2>/dev/null

echo ""
echo "Capture complete: ${OUTPUT}"
echo "Packets captured:"
tcpdump -r "${OUTPUT}" -nn | head -20
