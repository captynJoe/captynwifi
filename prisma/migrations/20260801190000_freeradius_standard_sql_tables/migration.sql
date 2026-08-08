-- Remaining standard FreeRADIUS PostgreSQL tables for accounting, groups, post-auth logs, and SQL clients.
CREATE TABLE IF NOT EXISTS radacct (
  RadAcctId bigserial PRIMARY KEY,
  AcctSessionId text NOT NULL,
  AcctUniqueId text NOT NULL UNIQUE,
  UserName text,
  Realm text,
  NASIPAddress inet NOT NULL,
  NASPortId text,
  NASPortType text,
  AcctStartTime timestamp with time zone,
  AcctUpdateTime timestamp with time zone,
  AcctStopTime timestamp with time zone,
  AcctInterval bigint,
  AcctSessionTime bigint,
  AcctAuthentic text,
  ConnectInfo_start text,
  ConnectInfo_stop text,
  AcctInputOctets bigint,
  AcctOutputOctets bigint,
  CalledStationId text,
  CallingStationId text,
  AcctTerminateCause text,
  ServiceType text,
  FramedProtocol text,
  FramedIPAddress inet,
  FramedIPv6Address inet,
  FramedIPv6Prefix inet,
  FramedInterfaceId text,
  DelegatedIPv6Prefix inet,
  Class text
);

CREATE INDEX IF NOT EXISTS radacct_active_session_idx ON radacct (AcctUniqueId) WHERE AcctStopTime IS NULL;
CREATE INDEX IF NOT EXISTS radacct_bulk_close ON radacct (NASIPAddress, AcctStartTime) WHERE AcctStopTime IS NULL;
CREATE INDEX IF NOT EXISTS radacct_start_user_idx ON radacct (AcctStartTime, UserName);
CREATE INDEX IF NOT EXISTS radacct_class_idx ON radacct (Class);
CREATE INDEX IF NOT EXISTS radcheck_username_attribute_idx ON radcheck (username, attribute);
CREATE INDEX IF NOT EXISTS radreply_username_attribute_idx ON radreply (username, attribute);

CREATE TABLE IF NOT EXISTS radgroupcheck (
  id serial PRIMARY KEY,
  GroupName text NOT NULL DEFAULT '',
  Attribute text NOT NULL DEFAULT '',
  op varchar(2) NOT NULL DEFAULT '==',
  Value text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS radgroupcheck_groupname_idx ON radgroupcheck (GroupName, Attribute);

CREATE TABLE IF NOT EXISTS radgroupreply (
  id serial PRIMARY KEY,
  GroupName text NOT NULL DEFAULT '',
  Attribute text NOT NULL DEFAULT '',
  op varchar(2) NOT NULL DEFAULT '=',
  Value text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS radgroupreply_groupname_idx ON radgroupreply (GroupName, Attribute);

CREATE TABLE IF NOT EXISTS radusergroup (
  id serial PRIMARY KEY,
  UserName text NOT NULL DEFAULT '',
  GroupName text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS radusergroup_username_idx ON radusergroup (UserName);

CREATE TABLE IF NOT EXISTS radpostauth (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  pass text,
  reply text,
  CalledStationId text,
  CallingStationId text,
  authdate timestamp with time zone NOT NULL DEFAULT now(),
  Class text
);
CREATE INDEX IF NOT EXISTS radpostauth_username_idx ON radpostauth (username);
CREATE INDEX IF NOT EXISTS radpostauth_class_idx ON radpostauth (Class);

CREATE TABLE IF NOT EXISTS nas (
  id serial PRIMARY KEY,
  nasname text NOT NULL,
  shortname text NOT NULL,
  type text NOT NULL DEFAULT 'other',
  ports integer,
  secret text NOT NULL,
  server text,
  community text,
  description text
);
CREATE INDEX IF NOT EXISTS nas_nasname_idx ON nas (nasname);

CREATE TABLE IF NOT EXISTS nasreload (
  NASIPAddress inet PRIMARY KEY,
  ReloadTime timestamp with time zone NOT NULL
);
