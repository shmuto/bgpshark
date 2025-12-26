/**
 * BGP Error Codes and Subcodes (RFC 4271, RFC 4486, RFC 8538)
 */

interface ErrorSubcode {
  name: string
  hint: string
}

interface ErrorCode {
  name: string
  subcodes: Record<number, ErrorSubcode>
}

export const BGP_ERROR_CODES: Record<number, ErrorCode> = {
  1: {
    name: 'Message Header Error',
    subcodes: {
      0: {
        name: 'Unspecific',
        hint: 'Generic message header error.',
      },
      1: {
        name: 'Connection Not Synchronized',
        hint: 'BGP marker validation failed. The 16-byte marker should be all 0xFF. Check for packet corruption or middlebox interference.',
      },
      2: {
        name: 'Bad Message Length',
        hint: 'Message length is outside valid range (19-4096 bytes). Check for MTU issues or packet corruption.',
      },
      3: {
        name: 'Bad Message Type',
        hint: 'Unknown BGP message type received. The peer may be using a newer BGP extension.',
      },
    },
  },
  2: {
    name: 'OPEN Message Error',
    subcodes: {
      0: {
        name: 'Unspecific',
        hint: 'Generic OPEN message error.',
      },
      1: {
        name: 'Unsupported Version Number',
        hint: 'Peer does not support BGP version 4. Modern BGP implementations should all use version 4.',
      },
      2: {
        name: 'Bad Peer AS',
        hint: 'The remote-as configured in your neighbor statement does not match the AS sent by the peer. Verify: (1) Your "neighbor X.X.X.X remote-as" value, (2) Peer\'s "router bgp" ASN.',
      },
      3: {
        name: 'Bad BGP Identifier',
        hint: 'Router ID is invalid (0.0.0.0 or 255.255.255.255) or conflicts. Check router-id configuration.',
      },
      4: {
        name: 'Unsupported Optional Parameter',
        hint: 'Peer sent an unrecognized optional parameter type.',
      },
      5: {
        name: 'Authentication Failure',
        hint: 'MD5 authentication failed. Check that both peers have the same MD5 password configured.',
      },
      6: {
        name: 'Unacceptable Hold Time',
        hint: 'Hold time is non-zero but less than 3 seconds. BGP requires hold time to be either 0 or >= 3 seconds.',
      },
      7: {
        name: 'Unsupported Capability',
        hint: 'Peer does not support a required capability. Check the Data field for the unsupported capability code. Consider removing the capability requirement or updating the peer.',
      },
      8: {
        name: 'BGP Role Mismatch',
        hint: 'BGP role (RFC 9234) mismatch. Check that both peers have compatible role configurations.',
      },
    },
  },
  3: {
    name: 'UPDATE Message Error',
    subcodes: {
      0: {
        name: 'Unspecific',
        hint: 'Generic UPDATE message error.',
      },
      1: {
        name: 'Malformed Attribute List',
        hint: 'Path attributes are malformed. Check for software bugs or packet corruption.',
      },
      2: {
        name: 'Unrecognized Well-known Attribute',
        hint: 'A well-known attribute is not recognized. Peer may be using a newer BGP extension.',
      },
      3: {
        name: 'Missing Well-known Attribute',
        hint: 'A mandatory attribute is missing (ORIGIN, AS_PATH, NEXT_HOP for EBGP).',
      },
      4: {
        name: 'Attribute Flags Error',
        hint: 'Attribute flags are inconsistent with the attribute type.',
      },
      5: {
        name: 'Attribute Length Error',
        hint: 'Attribute length is incorrect.',
      },
      6: {
        name: 'Invalid ORIGIN Attribute',
        hint: 'ORIGIN attribute has an invalid value (must be IGP, EGP, or INCOMPLETE).',
      },
      7: {
        name: 'Deprecated (AS Routing Loop)',
        hint: 'This error code is deprecated.',
      },
      8: {
        name: 'Invalid NEXT_HOP Attribute',
        hint: 'NEXT_HOP is not a valid IP address or is not reachable.',
      },
      9: {
        name: 'Optional Attribute Error',
        hint: 'An optional transitive attribute has an error.',
      },
      10: {
        name: 'Invalid Network Field',
        hint: 'NLRI prefix is invalid (e.g., prefix length > 32 for IPv4).',
      },
      11: {
        name: 'Malformed AS_PATH',
        hint: 'AS_PATH attribute is malformed. Check for 2-byte/4-byte AS number compatibility issues.',
      },
    },
  },
  4: {
    name: 'Hold Timer Expired',
    subcodes: {
      0: {
        name: 'Unspecific',
        hint: 'No KEEPALIVE or UPDATE received within the negotiated hold time. Check: (1) Network connectivity, (2) CPU load on routers, (3) BGP process health, (4) Consider increasing hold time.',
      },
    },
  },
  5: {
    name: 'Finite State Machine Error',
    subcodes: {
      0: {
        name: 'Unspecified Error',
        hint: 'Unexpected event in BGP state machine. Often caused by receiving a message in the wrong state.',
      },
      1: {
        name: 'Receive Unexpected Message in OpenSent State',
        hint: 'Received unexpected message while waiting for OPEN response.',
      },
      2: {
        name: 'Receive Unexpected Message in OpenConfirm State',
        hint: 'Received unexpected message while waiting for KEEPALIVE.',
      },
      3: {
        name: 'Receive Unexpected Message in Established State',
        hint: 'Received unexpected message in established session.',
      },
    },
  },
  6: {
    name: 'Cease',
    subcodes: {
      0: {
        name: 'Unspecific',
        hint: 'Session was closed for unspecified reason.',
      },
      1: {
        name: 'Maximum Number of Prefixes Reached',
        hint: 'Peer exceeded the maximum prefix limit. Increase the limit or filter routes.',
      },
      2: {
        name: 'Administrative Shutdown',
        hint: 'Session was administratively shut down by operator. This is intentional.',
      },
      3: {
        name: 'Peer De-configured',
        hint: 'The peer was removed from configuration.',
      },
      4: {
        name: 'Administrative Reset',
        hint: 'Session was reset by operator (e.g., "clear bgp neighbor").',
      },
      5: {
        name: 'Connection Rejected',
        hint: 'Connection was rejected. Check: (1) ACLs, (2) BGP neighbor configuration, (3) TTL security.',
      },
      6: {
        name: 'Other Configuration Change',
        hint: 'Session was reset due to configuration change.',
      },
      7: {
        name: 'Connection Collision Resolution',
        hint: 'This connection was closed in favor of another connection between the same peers.',
      },
      8: {
        name: 'Out of Resources',
        hint: 'Router ran out of resources (memory, CPU). Check system health.',
      },
      9: {
        name: 'Hard Reset',
        hint: 'Session was hard reset (RFC 8538). Graceful restart is not available.',
      },
      10: {
        name: 'BFD Down',
        hint: 'BFD (Bidirectional Forwarding Detection) detected a failure.',
      },
    },
  },
  7: {
    name: 'ROUTE-REFRESH Message Error',
    subcodes: {
      0: {
        name: 'Reserved',
        hint: 'Reserved subcode.',
      },
      1: {
        name: 'Invalid Message Length',
        hint: 'ROUTE-REFRESH message has invalid length.',
      },
    },
  },
}

/**
 * Get error information for given code and subcode
 */
export function getErrorInfo(
  errorCode: number,
  errorSubcode: number
): {
  codeName: string
  subcodeName: string
  hint: string
} {
  const code = BGP_ERROR_CODES[errorCode]
  if (!code) {
    return {
      codeName: `Unknown (${errorCode})`,
      subcodeName: `Unknown (${errorSubcode})`,
      hint: 'Unknown error code. This may be a proprietary extension.',
    }
  }

  const subcode = code.subcodes[errorSubcode]
  if (!subcode) {
    return {
      codeName: code.name,
      subcodeName: `Unknown (${errorSubcode})`,
      hint: 'Unknown error subcode. Check vendor documentation.',
    }
  }

  return {
    codeName: code.name,
    subcodeName: subcode.name,
    hint: subcode.hint,
  }
}
