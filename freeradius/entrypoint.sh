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

exec /docker-entrypoint.sh "$@"
