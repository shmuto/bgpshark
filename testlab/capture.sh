#!/usr/bin/env bash
# Capture BGP traffic from srl1's 3 BGP interfaces and merge into one pcap

set -e

OUTPUT="${1:-bgp-capture.pcap}"
TMPDIR=$(mktemp -d)
trap 'rm -rf "${TMPDIR}"' EXIT

echo "Capturing BGP traffic from srl1..."
echo "  - e1-1 (iBGP to srl2)"
echo "  - e1-2 (eBGP to srl3)"
echo "  - e1-3 (eBGP to srl4)"
echo ""
echo "Output: ${OUTPUT}"
echo "Press Enter to stop capturing."
echo ""

# Capture from srl1's 3 interfaces in parallel
sudo ip netns exec clab-bgpshark-test-srl1 \
    tcpdump -i e1-1 -nn port 179 -w "${TMPDIR}/e1-1.pcap" 2>/dev/null &
PID1=$!

sudo ip netns exec clab-bgpshark-test-srl1 \
    tcpdump -i e1-2 -nn port 179 -w "${TMPDIR}/e1-2.pcap" 2>/dev/null &
PID2=$!

sudo ip netns exec clab-bgpshark-test-srl1 \
    tcpdump -i e1-3 -nn port 179 -w "${TMPDIR}/e1-3.pcap" 2>/dev/null &
PID3=$!

# Wait for user input
read -r

# Stop all captures
sudo kill "${PID1}" "${PID2}" "${PID3}" 2>/dev/null || true
wait "${PID1}" "${PID2}" "${PID3}" 2>/dev/null || true

echo ""
echo "Merging pcap files..."

# Merge pcap files (mergecap sorts by timestamp automatically)
if command -v mergecap &> /dev/null; then
    mergecap -w "${OUTPUT}" "${TMPDIR}"/e1-*.pcap
else
    echo "Warning: mergecap not found, using tcpslice instead..."
    if command -v tcpslice &> /dev/null; then
        tcpslice -w "${OUTPUT}" "${TMPDIR}"/e1-*.pcap
    else
        echo "Error: Neither mergecap nor tcpslice found."
        echo "Install wireshark-common: sudo apt install wireshark-common"
        echo "Individual captures saved in ${TMPDIR}"
        trap - EXIT
        exit 1
    fi
fi

echo "Capture complete: ${OUTPUT}"
echo ""
echo "Packets captured:"
tcpdump -r "${OUTPUT}" -nn 2>/dev/null | head -20
echo ""
echo "Total packets: $(tcpdump -r "${OUTPUT}" -nn 2>/dev/null | wc -l)"
