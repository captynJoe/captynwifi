#!/bin/sh
set -eu

: "${DB_PASSWORD:?DB_PASSWORD must be set}"
: "${CAPTYN_WIFI_RADIUS_SECRET:?CAPTYN_WIFI_RADIUS_SECRET must be set}"

sed   -e "s|__CAPTYN_WIFI_RADIUS_SECRET__|${CAPTYN_WIFI_RADIUS_SECRET}|g"   /etc/raddb/templates/clients.conf.template > /etc/raddb/clients.conf

sed   -e "s|__DB_PASSWORD__|${DB_PASSWORD}|g"   /etc/raddb/templates/sql.template > /etc/raddb/mods-available/sql

# Auth request/result logging is off by default, which is why radius.log
# has only ever shown startup messages and errors -- never a trace of
# individual Access-Accept/Access-Reject decisions. Turn it on so a future
# "RADIUS server is not responding" report can be matched against an actual
# log line instead of inferred from silence.
sed -i 's/^\tauth = no$/\tauth = yes/' /etc/raddb/radiusd.conf

# Device-limit enforcement (Simultaneous-Use, set per-entitlement in
# radiusProjection.ts) is a no-op unless the "session" virtual server
# section actually queries for it -- stock config has that call commented
# out. simul_count_query/simul_verify_query are already active by default
# in mods-config/sql/main/postgresql/queries.conf, and the nasreload table
# they join against exists in the schema, so uncommenting this is enough.
sed -i '/^session {$/,/^}$/ s/^#\tsql$/\tsql/' /etc/raddb/sites-available/default

# Device ledger + switch cap (policy.d/captyn): check the cap right after the
# SQL lookup in authorize, and record the device after an accepted login in
# post-auth -- the first top-level -sql there, not the one inside
# Post-Auth-Type REJECT.
if ! grep -q "captyn_device_cap" /etc/raddb/sites-available/default; then
  awk '
    /^authorize \{$/ { section = "authorize" }
    /^post-auth \{$/ { section = "post-auth" }
    /^\tPost-Auth-Type REJECT/ { section = "" }
    { print }
    section == "authorize" && $0 == "\t-sql" { print "\tcaptyn_device_cap"; section = "" }
    section == "post-auth" && $0 == "\t-sql" { print "\tcaptyn_record_device"; section = "" }
  ' /etc/raddb/sites-available/default > /tmp/default.captyn && cat /tmp/default.captyn > /etc/raddb/sites-available/default
fi

exec /docker-entrypoint.sh "$@"
