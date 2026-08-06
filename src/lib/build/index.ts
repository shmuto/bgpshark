export {
  encodeMessage,
  AS_TRANS,
  BGP_MAX_MESSAGE_LENGTH,
  type BgpMessageSpec,
  type CapabilitySpec,
  type EncodeOptions,
  type KeepaliveSpec,
  type NotificationSpec,
  type OpenSpec,
  type PathAttributeSpec,
  type PrefixSpec,
  type RouteRefreshSpec,
  type UpdateSpec,
} from './bgp-encode'
export { buildTcpFrame, maxSegmentSize, type TcpFrameSpec } from './frame'
export {
  buildScenario,
  openFor,
  type BuiltCapture,
  type Scenario,
  type ScenarioPeer,
  type ScenarioStep,
  type Side,
} from './scenario'
export {
  PRESETS,
  presetById,
  announce,
  withdraw,
  END_OF_RIB,
  type PresetDefinition,
} from './presets'
