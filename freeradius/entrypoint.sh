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

# RouterOS can reuse Acct-Session-Id values after a reconnect/reboot. Derive
# the original session-start epoch from each accounting packet and include it
# in Acct-Unique-Session-Id. Event-Timestamp minus Acct-Session-Time stays
# stable for
# Start, Interim-Update, and Stop packets, while distinguishing later sessions
# that reuse the same RouterOS session id.
# Except it is not exactly stable: both values are whole seconds read at
# slightly different moments, so the derived start wobbles by a second.
# Hashing the wobble split one connection into two radacct rows; the copy
# that stopped getting updates stayed open until the Stale-Session sweep and
# counted against Simultaneous-Use, refusing the customer's own reconnect.
# So reuse the row this connection already started within a few seconds,
# and only hash a new identity when there is none.
# The v1 block replaced the acct_unique line, so a restarted (not recreated)
# container cannot be upgraded in place: rebuild/recreate to pick up v2.
if grep -q "captyn_session_identity:" /etc/raddb/sites-available/default; then
  echo "WARNING: old Captyn accounting identity policy found; recreate this container to apply v2" >&2
elif ! grep -q "captyn_session_identity_v2" /etc/raddb/sites-available/default; then
  awk '
    /^preacct \{$/ { section = "preacct" }
    {
      if (section == "preacct" && $0 == "\tacct_unique") {
        found = 1
        q = "\047"
        print "\t# captyn_session_identity_v2: make reused RouterOS ids unique per connection"
        print "\tif (!&Event-Timestamp) {"
        print "\t\tupdate request {"
        print "\t\t\t&Event-Timestamp := \"%{expr: %l - %{%{Acct-Delay-Time}:-0}}\""
        print "\t\t}"
        print "\t}"
        print "\tupdate request {"
        print "\t\t&Tmp-String-0 := \"%{expr: %{integer:Event-Timestamp} - %{%{Acct-Session-Time}:-0}}\""
        print "\t}"
        print "\tif (&Acct-Session-Id && &User-Name) {"
        print "\t\tupdate request {"
        print "\t\t\t&Tmp-String-1 := \"%{sql:SELECT acctuniqueid FROM radacct WHERE acctstarttime BETWEEN to_timestamp(%{Tmp-String-0} - 5) AND to_timestamp(%{Tmp-String-0} + 5) AND username = " q "%{User-Name}" q " AND acctsessionid = " q "%{Acct-Session-Id}" q " AND nasipaddress = " q "%{NAS-IP-Address}" q " AND callingstationid = " q "%{Calling-Station-Id}" q " ORDER BY radacctid LIMIT 1}\""
        print "\t\t}"
        print "\t}"
        print "\tif (&Tmp-String-1 && &Tmp-String-1 != \"\") {"
        print "\t\tupdate request {"
        print "\t\t\t&Acct-Unique-Session-Id := \"%{Tmp-String-1}\""
        print "\t\t}"
        print "\t}"
        print "\telse {"
        print "\t\tupdate request {"
        print "\t\t\t&Acct-Unique-Session-Id := \"%{md5:%{User-Name}|%{Acct-Session-Id}|%{NAS-IP-Address}|%{NAS-Port}|%{NAS-Port-Type}|%{Calling-Station-Id}|%{Called-Station-Id}|%{Tmp-String-0}}\""
        print "\t\t}"
        print "\t}"
        section = ""
        next
      }
      print
    }
    END { if (!found) exit 1 }
  ' /etc/raddb/sites-available/default > /tmp/default.captyn || { echo "Could not insert Captyn accounting identity policy" >&2; exit 1; }
  cat /tmp/default.captyn > /etc/raddb/sites-available/default
fi

# Per-login entitlement expiry + device ledger (policy.d/captyn): compute the
# current WiFi time limit after SQL loads the static RADIUS rows, enforce the
# device cap, and record the device after an accepted login. The first
# top-level -sql is in authorize, not the one inside Post-Auth-Type REJECT.
if ! grep -q "captyn_device_cap" /etc/raddb/sites-available/default; then
  awk '
    /^authorize \{$/ { section = "authorize" }
    /^post-auth \{$/ { section = "post-auth" }
    /^\tPost-Auth-Type REJECT/ { section = "" }
    { print }
    section == "authorize" && $0 == "\t-sql" { print "\tcaptyn_session_expiry"; print "\tcaptyn_device_cap"; section = "" }
    section == "post-auth" && $0 == "\t-sql" { print "\tcaptyn_record_device"; section = "" }
  ' /etc/raddb/sites-available/default > /tmp/default.captyn && cat /tmp/default.captyn > /etc/raddb/sites-available/default
fi

exec /docker-entrypoint.sh "$@"
