# CAPTYN WiFi fair share -- MikroTik (RouterOS 7, L009)
#
# Every active customer (hotspot and PPPoE) gets an equal share of the line
# when it's full. Package caps still apply on top (per-user hotspot queues).
# Nobody is disconnected; nothing changes in RADIUS.
#
# The shared queue sits just below the line's real speed so the queue forms
# here, not at the ISP. The WiFi server re-sets captyn-fair-down after every
# ISP probe (hourly by day, every 30 min in the evening) to 90% of the
# measured line (CAPTYN_WIFI_FAIR_SHARE=true). Router-originated traffic (the
# probe itself, WireGuard to the VPS) isn't in the forward chain, so it's
# never limited by this.
#
# Checked 2026-11-27: FastTrack is disabled (it would bypass queues), no queue
# tree or packet marks exist, CPU 10% on 2 cores.

# --- apply ---
/queue type add name=captyn-pcq-down kind=pcq pcq-classifier=dst-address pcq-rate=0 pcq-limit=100KiB pcq-total-limit=4000KiB
/queue type add name=captyn-pcq-up kind=pcq pcq-classifier=src-address pcq-rate=0 pcq-limit=100KiB pcq-total-limit=4000KiB
/ip firewall mangle add chain=forward in-interface=ether1 action=mark-packet new-packet-mark=captyn-down passthrough=no comment="CAPTYN fair share: download"
/ip firewall mangle add chain=forward out-interface=ether1 action=mark-packet new-packet-mark=captyn-up passthrough=no comment="CAPTYN fair share: upload"
/queue tree add name=captyn-fair-down parent=global packet-mark=captyn-down queue=captyn-pcq-down max-limit=20M comment="CAPTYN fair share: limit set by the ISP probe"
/queue tree add name=captyn-fair-up parent=global packet-mark=captyn-up queue=captyn-pcq-up max-limit=30M comment="CAPTYN fair share: upload"

# --- watchdog: if the server stops updating the queue for 70 minutes, the
# router opens it by itself, so a stopped server can never leave everyone on
# a stale, low limit. The server runs captyn-fair-heartbeat after each probe.
/system script add name=captyn-fair-heartbeat policy=read,write,test source=":global captynFairTicks 0" comment="CAPTYN fair share: the server runs this after each probe"
/system scheduler add name=captyn-fair-watchdog interval=10m policy=read,write,test comment="CAPTYN fair share: opens the queue if the server goes quiet for 70 min" on-event=":global captynFairTicks\r\n:if ([:typeof \$captynFairTicks] = \"nothing\") do={ :set captynFairTicks 0 }\r\n:set captynFairTicks (\$captynFairTicks + 1)\r\n:if (\$captynFairTicks >= 7) do={ /queue tree set [find name=\"captyn-fair-down\"] max-limit=1000M; :log warning \"CAPTYN fair share: no update from the server for 70 min, queue opened\" }"

# How the limit is set (server, src/services/ispProbe.ts): every 30 min the
# queue opens for 4 s, the line is measured (customers on every WAN port +
# a 10 MB test), then the limit = 90% of that, floor 15 Mbps. It rises at
# once but only falls after two low readings in a row; if a test fails the
# queue is left open (1000M).

# --- check (rate should move with traffic; queued > 0 when the line is full) ---
# /queue tree print stats where name~"captyn-fair"

# --- roll back (removes everything above) ---
# /queue tree remove [find name~"captyn-fair"]
# /ip firewall mangle remove [find comment~"CAPTYN fair share"]
# /queue type remove [find name~"captyn-pcq"]
# /system scheduler remove [find name=captyn-fair-watchdog]
# /system script remove [find name=captyn-fair-heartbeat]
