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

# --- check (rate should move with traffic; queued > 0 when the line is full) ---
# /queue tree print stats where name~"captyn-fair"

# --- roll back (removes everything above) ---
# /queue tree remove [find name~"captyn-fair"]
# /ip firewall mangle remove [find comment~"CAPTYN fair share"]
# /queue type remove [find name~"captyn-pcq"]
