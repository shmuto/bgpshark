/**
 * BGP Capability Codes (IANA)
 */
export const CapabilityCode = {
  MULTIPROTOCOL: 1,
  ROUTE_REFRESH: 2,
  OUTBOUND_ROUTE_FILTERING: 3,
  EXTENDED_NEXT_HOP: 5,
  EXTENDED_MESSAGE: 6,
  BGPSEC: 7,
  MULTIPLE_LABELS: 8,
  BGP_ROLE: 9,
  GRACEFUL_RESTART: 64,
  FOUR_OCTET_AS: 65,
  DYNAMIC_CAPABILITY: 67,
  MULTISESSION: 68,
  ADD_PATH: 69,
  ENHANCED_ROUTE_REFRESH: 70,
  LLGR: 71,
  FQDN: 73,
} as const

export const CapabilityCodeNames: Record<number, string> = {
  [CapabilityCode.MULTIPROTOCOL]: 'Multiprotocol Extensions',
  [CapabilityCode.ROUTE_REFRESH]: 'Route Refresh',
  [CapabilityCode.OUTBOUND_ROUTE_FILTERING]: 'Outbound Route Filtering',
  [CapabilityCode.EXTENDED_NEXT_HOP]: 'Extended Next Hop Encoding',
  [CapabilityCode.EXTENDED_MESSAGE]: 'BGP Extended Message',
  [CapabilityCode.BGPSEC]: 'BGPsec',
  [CapabilityCode.MULTIPLE_LABELS]: 'Multiple Labels',
  [CapabilityCode.BGP_ROLE]: 'BGP Role',
  [CapabilityCode.GRACEFUL_RESTART]: 'Graceful Restart',
  [CapabilityCode.FOUR_OCTET_AS]: '4-byte AS Number',
  [CapabilityCode.DYNAMIC_CAPABILITY]: 'Dynamic Capability',
  [CapabilityCode.MULTISESSION]: 'Multisession BGP',
  [CapabilityCode.ADD_PATH]: 'ADD-PATH',
  [CapabilityCode.ENHANCED_ROUTE_REFRESH]: 'Enhanced Route Refresh',
  [CapabilityCode.LLGR]: 'Long-Lived Graceful Restart',
  [CapabilityCode.FQDN]: 'FQDN Capability',
}

/**
 * Address Family Identifier (AFI) - IANA
 */
export const Afi = {
  IPV4: 1,
  IPV6: 2,
  L2VPN: 25,
} as const

export const AfiNames: Record<number, string> = {
  [Afi.IPV4]: 'IPv4',
  [Afi.IPV6]: 'IPv6',
  [Afi.L2VPN]: 'L2VPN',
}

/**
 * Subsequent Address Family Identifier (SAFI) - IANA
 */
export const Safi = {
  UNICAST: 1,
  MULTICAST: 2,
  MPLS_LABEL: 4,
  MCAST_VPN: 5,
  VPLS: 65,
  EVPN: 70,
  LS: 71,
  LS_VPN: 72,
  SR_TE_POLICY: 73,
  SD_WAN: 74,
  MPLS_VPN: 128,
  MCAST_MPLS_VPN: 129,
  FLOWSPEC: 133,
  FLOWSPEC_VPN: 134,
} as const

export const SafiNames: Record<number, string> = {
  [Safi.UNICAST]: 'Unicast',
  [Safi.MULTICAST]: 'Multicast',
  [Safi.MPLS_LABEL]: 'MPLS Label',
  [Safi.MCAST_VPN]: 'MCAST-VPN',
  [Safi.VPLS]: 'VPLS',
  [Safi.EVPN]: 'EVPN',
  [Safi.LS]: 'Link-State',
  [Safi.LS_VPN]: 'Link-State VPN',
  [Safi.SR_TE_POLICY]: 'SR TE Policy',
  [Safi.SD_WAN]: 'SD-WAN',
  [Safi.MPLS_VPN]: 'MPLS VPN',
  [Safi.MCAST_MPLS_VPN]: 'Multicast MPLS VPN',
  [Safi.FLOWSPEC]: 'FlowSpec',
  [Safi.FLOWSPEC_VPN]: 'FlowSpec VPN',
}

/**
 * Get AFI name or "Unknown (N)"
 */
export function getAfiName(afi: number): string {
  return AfiNames[afi] ?? `Unknown (${afi})`
}

/**
 * Get SAFI name or "Unknown (N)"
 */
export function getSafiName(safi: number): string {
  return SafiNames[safi] ?? `Unknown (${safi})`
}

/**
 * Get Capability name or "Unknown (N)"
 */
export function getCapabilityName(code: number): string {
  return CapabilityCodeNames[code] ?? `Unknown (${code})`
}
