import { BinaryReader } from '../pcap/reader'
import type { BgpNotificationMessage } from './types'
import { getErrorInfo } from './errors'
import { decodeNotificationData } from './notification-data'

/**
 * Parse BGP NOTIFICATION message
 */
export function parseNotificationMessage(reader: BinaryReader): BgpNotificationMessage {
  const errorCode = reader.readUint8()
  const errorSubcode = reader.readUint8()

  // Remaining bytes are error data
  const dataLength = reader.remaining()
  const data = dataLength > 0 ? reader.readBytes(dataLength) : new Uint8Array(0)

  const errorInfo = getErrorInfo(errorCode, errorSubcode)

  return {
    type: 'NOTIFICATION',
    errorCode,
    errorSubcode,
    errorCodeName: errorInfo.codeName,
    errorSubcodeName: errorInfo.subcodeName,
    data,
    decodedData: decodeNotificationData(errorCode, errorSubcode, data),
    hint: errorInfo.hint,
  }
}
