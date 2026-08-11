/**
 * DuckDB Schema for BGPShark
 */

export const SCHEMA_SQL = `
-- Main packets table
CREATE TABLE IF NOT EXISTS packets (
  frame_index     INTEGER PRIMARY KEY,
  timestamp       TIMESTAMP,
  src_ip          VARCHAR,
  dst_ip          VARCHAR,
  -- Address bits as text (see lib/net/prefix.ts). Carried alongside the
  -- printable form so a CIDR search can be answered by asking whether the
  -- address bits start with the query's bits, which is a question SQL can ask
  -- about IPv6 too.
  src_ip_bits     VARCHAR,
  dst_ip_bits     VARCHAR,
  src_port        INTEGER,
  dst_port        INTEGER,
  raw_data_base64 VARCHAR,
  parse_warnings  VARCHAR[]
);

-- BGP messages table
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  frame_index     INTEGER NOT NULL,
  message_index   INTEGER NOT NULL,
  type            VARCHAR NOT NULL,

  -- OPEN message fields
  version         INTEGER,
  my_as           INTEGER,
  hold_time       INTEGER,
  router_id       VARCHAR,

  -- NOTIFICATION fields
  error_code      INTEGER,
  error_subcode   INTEGER,
  error_code_name VARCHAR,
  error_subcode_name VARCHAR,

  -- ROUTE_REFRESH fields
  afi             INTEGER,
  safi            INTEGER,
  afi_name        VARCHAR,
  safi_name       VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_messages_frame ON messages(frame_index);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_router_id ON messages(router_id);
CREATE INDEX IF NOT EXISTS idx_messages_my_as ON messages(my_as);

-- Capabilities table (for OPEN messages)
CREATE TABLE IF NOT EXISTS capabilities (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  code            INTEGER,
  name            VARCHAR,

  -- Parsed capability details
  cap_type        VARCHAR,
  cap_afi         INTEGER,
  cap_afi_name    VARCHAR,
  cap_safi        INTEGER,
  cap_safi_name   VARCHAR,
  cap_as_number   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_capabilities_message ON capabilities(message_id);
CREATE INDEX IF NOT EXISTS idx_capabilities_name ON capabilities(name);

-- Path attributes table (for UPDATE messages)
CREATE TABLE IF NOT EXISTS path_attributes (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  type_code       INTEGER,
  type_name       VARCHAR,
  flags_optional  BOOLEAN,
  flags_transitive BOOLEAN,
  flags_partial   BOOLEAN,
  flags_extended  BOOLEAN,

  -- Parsed values
  origin_value    VARCHAR,
  next_hop        VARCHAR,
  med_value       INTEGER,
  local_pref      INTEGER,
  aggregator_as   INTEGER,
  aggregator_addr VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_path_attrs_message ON path_attributes(message_id);
CREATE INDEX IF NOT EXISTS idx_path_attrs_type ON path_attributes(type_name);

-- AS_PATH expanded table
CREATE TABLE IF NOT EXISTS as_path (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  segment_type    VARCHAR,
  segment_index   INTEGER,
  as_index        INTEGER,
  asn             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_as_path_message ON as_path(message_id);
CREATE INDEX IF NOT EXISTS idx_as_path_asn ON as_path(asn);

-- NLRI table (announced prefixes)
CREATE TABLE IF NOT EXISTS nlri (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  prefix          VARCHAR,
  prefix_length   INTEGER,
  -- Network bits as text (see lib/net/prefix.ts). One prefix is inside another
  -- exactly when its key starts with the other's, so subnet searches are a
  -- LIKE 'bits%' this index can serve. NULL for families with no printable
  -- address form.
  prefix_bits     VARCHAR,
  afi             INTEGER DEFAULT 1,
  safi            INTEGER DEFAULT 1,
  -- EVPN (AFI 25 / SAFI 70) carries no prefix, so the columns above say little
  -- about it. These hold what an EVPN route is actually identified by; they are
  -- NULL for every other family.
  evpn_route_type INTEGER,
  evpn_type_name  VARCHAR,
  evpn_rd         VARCHAR,
  evpn_mac        VARCHAR,
  evpn_ip         VARCHAR,
  evpn_vni        INTEGER,
  -- A MAC/IP route carries a second label when it also has an L3 VNI.
  evpn_vni2       INTEGER,
  evpn_esi        VARCHAR,
  evpn_eth_tag    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nlri_message ON nlri(message_id);
CREATE INDEX IF NOT EXISTS idx_nlri_prefix ON nlri(prefix);
CREATE INDEX IF NOT EXISTS idx_nlri_prefix_bits ON nlri(prefix_bits);
CREATE INDEX IF NOT EXISTS idx_nlri_evpn_mac ON nlri(evpn_mac);

-- Withdrawn routes table
CREATE TABLE IF NOT EXISTS withdrawn (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  prefix          VARCHAR,
  prefix_length   INTEGER,
  prefix_bits     VARCHAR,
  afi             INTEGER DEFAULT 1,
  safi            INTEGER DEFAULT 1,
  -- EVPN (AFI 25 / SAFI 70) carries no prefix, so the columns above say little
  -- about it. These hold what an EVPN route is actually identified by; they are
  -- NULL for every other family.
  evpn_route_type INTEGER,
  evpn_type_name  VARCHAR,
  evpn_rd         VARCHAR,
  evpn_mac        VARCHAR,
  evpn_ip         VARCHAR,
  evpn_vni        INTEGER,
  -- A MAC/IP route carries a second label when it also has an L3 VNI.
  evpn_vni2       INTEGER,
  evpn_esi        VARCHAR,
  evpn_eth_tag    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_withdrawn_message ON withdrawn(message_id);
CREATE INDEX IF NOT EXISTS idx_withdrawn_prefix ON withdrawn(prefix);
CREATE INDEX IF NOT EXISTS idx_withdrawn_prefix_bits ON withdrawn(prefix_bits);
CREATE INDEX IF NOT EXISTS idx_withdrawn_evpn_mac ON withdrawn(evpn_mac);

-- Communities table
CREATE TABLE IF NOT EXISTS communities (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  asn             INTEGER,
  value           INTEGER,
  formatted       VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_communities_message ON communities(message_id);
CREATE INDEX IF NOT EXISTS idx_communities_formatted ON communities(formatted);

-- Extended communities table (RFC 4360). \`kind\` and \`value\` are the decoded
-- halves — 'Route Target' and '65001:100' — and \`formatted\` is the two joined,
-- so a search can be as loose or as exact as the question being asked.
CREATE TABLE IF NOT EXISTS extended_communities (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  kind            VARCHAR,
  value           VARCHAR,
  formatted       VARCHAR,
  transitive      BOOLEAN,
  type_code       INTEGER,
  subtype         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ext_communities_message ON extended_communities(message_id);
CREATE INDEX IF NOT EXISTS idx_ext_communities_value ON extended_communities(value);
CREATE INDEX IF NOT EXISTS idx_ext_communities_formatted ON extended_communities(formatted);

-- Large communities table
CREATE TABLE IF NOT EXISTS large_communities (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  global_admin    INTEGER,
  local_data1     INTEGER,
  local_data2     INTEGER,
  formatted       VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_large_communities_message ON large_communities(message_id);
`

export const DROP_TABLES_SQL = `
DROP TABLE IF EXISTS large_communities;
DROP TABLE IF EXISTS extended_communities;
DROP TABLE IF EXISTS communities;
DROP TABLE IF EXISTS withdrawn;
DROP TABLE IF EXISTS nlri;
DROP TABLE IF EXISTS as_path;
DROP TABLE IF EXISTS path_attributes;
DROP TABLE IF EXISTS capabilities;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS packets;
`
