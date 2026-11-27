# CAPTYN WiFi -- second ISP (dual WAN), RouterOS 7 on the L009
#
# Design (see docs/network-plan.md):
# - ISP1 stays on ether1 (modem 192.168.100.1). ISP2 goes on ether3.
# - Each CUSTOMER sticks to one ISP (PCC by source address): M-PESA, banking,
#   video calls and logins never see their IP change mid-session. New
#   customers are spread across both lines.
# - If either line dies, its customers move to the other automatically
#   (recursive health checks through a public host, not just the modem --
#   a modem answers even when its internet is down).
# - The router's own traffic (WireGuard to the server, i.e. RADIUS sign-ins,
#   and the ISP probes) uses ISP1, falling back to ISP2.
# - The fair-share queue covers both lines (docs/fair-share.rsc).
#
# Before running: replace ISP2_GW with ISP2's modem LAN address (e.g.
# 192.168.1.1) and ISP2_NET with its subnet (e.g. 192.168.1.0/24). If ISP2's
# modem uses 192.168.100.0/24 too (same as ISP1), change one modem's LAN
# subnet first -- two WANs on the same subnet won't route.
# Apply in order; each block is safe on its own. Nothing here touches the
# hotspot, RADIUS or the PPPoE server.

# --- 1. ISP2 port (no default route yet: we add monitored ones) ----------
/interface list member add list=WAN interface=ether3 comment="ISP2"
/ip dhcp-client add interface=ether3 add-default-route=no use-peer-dns=no comment="ISP2"
# (or, if ISP2 gives a static address: /ip address add address=... interface=ether3)

# --- 2. Health checks: each line is judged by reaching a public host -----
/ip route add dst-address=1.0.0.1/32 gateway=192.168.100.1 scope=10 comment="ISP1 health check"
/ip route add dst-address=9.9.9.9/32 gateway=ISP2_GW scope=10 comment="ISP2 health check"

# --- 3. Routing tables: one per ISP, each falling back to the other ------
/routing table add name=to-isp1 fib
/routing table add name=to-isp2 fib
/ip route add dst-address=0.0.0.0/0 gateway=1.0.0.1 target-scope=11 check-gateway=ping distance=1 routing-table=to-isp1 comment="ISP1 table"
/ip route add dst-address=0.0.0.0/0 gateway=9.9.9.9 target-scope=11 check-gateway=ping distance=2 routing-table=to-isp1 comment="ISP1 table: fallback"
/ip route add dst-address=0.0.0.0/0 gateway=9.9.9.9 target-scope=11 check-gateway=ping distance=1 routing-table=to-isp2 comment="ISP2 table"
/ip route add dst-address=0.0.0.0/0 gateway=1.0.0.1 target-scope=11 check-gateway=ping distance=2 routing-table=to-isp2 comment="ISP2 table: fallback"

# --- 4. Router's own traffic (WireGuard/RADIUS, probes): ISP1, then ISP2 --
# Add these BEFORE removing the DHCP default route, so there's no gap.
/ip route add dst-address=0.0.0.0/0 gateway=1.0.0.1 target-scope=11 check-gateway=ping distance=1 comment="Main: ISP1"
/ip route add dst-address=0.0.0.0/0 gateway=9.9.9.9 target-scope=11 check-gateway=ping distance=2 comment="Main: ISP2"
/ip dhcp-client set [find interface=ether1] add-default-route=no

# --- 5. Spread customers across both lines (PCC, sticky per customer) ----
/ip firewall address-list add list=captyn-local address=192.168.88.0/24 comment="hotspot"
/ip firewall address-list add list=captyn-local address=10.50.0.0/24 comment="PPPoE"
/ip firewall address-list add list=captyn-local address=10.8.0.0/24 comment="WireGuard to server"
/ip firewall address-list add list=captyn-local address=192.168.100.0/24 comment="ISP1 modem"
/ip firewall address-list add list=captyn-local address=ISP2_NET comment="ISP2 modem"
/ip firewall mangle
# Replies to connections that came IN on a line leave on that line.
add chain=prerouting in-interface=ether1 connection-mark=no-mark action=mark-connection new-connection-mark=isp1-conn passthrough=yes comment="dual WAN: in via ISP1"
add chain=prerouting in-interface=ether3 connection-mark=no-mark action=mark-connection new-connection-mark=isp2-conn passthrough=yes comment="dual WAN: in via ISP2"
# Customers: half the addresses on each line (change 2/0, 2/1 to 3/0, 3/1, 3/2
# with two rules on the faster ISP to weight it 2:1).
add chain=prerouting in-interface-list=!WAN dst-address-list=!captyn-local dst-address-type=!local connection-mark=no-mark per-connection-classifier=src-address:2/0 action=mark-connection new-connection-mark=isp1-conn passthrough=yes comment="dual WAN: customers -> ISP1"
add chain=prerouting in-interface-list=!WAN dst-address-list=!captyn-local dst-address-type=!local connection-mark=no-mark per-connection-classifier=src-address:2/1 action=mark-connection new-connection-mark=isp2-conn passthrough=yes comment="dual WAN: customers -> ISP2"
add chain=prerouting in-interface-list=!WAN connection-mark=isp1-conn action=mark-routing new-routing-mark=to-isp1 passthrough=yes comment="dual WAN: route ISP1"
add chain=prerouting in-interface-list=!WAN connection-mark=isp2-conn action=mark-routing new-routing-mark=to-isp2 passthrough=yes comment="dual WAN: route ISP2"
add chain=output connection-mark=isp1-conn action=mark-routing new-routing-mark=to-isp1 passthrough=yes comment="dual WAN: replies ISP1"
add chain=output connection-mark=isp2-conn action=mark-routing new-routing-mark=to-isp2 passthrough=yes comment="dual WAN: replies ISP2"

# --- 6. Fair share over BOTH lines ----------------------------------------
/ip firewall mangle set [find comment="CAPTYN fair share: download"] in-interface="" in-interface-list=WAN
/ip firewall mangle set [find comment="CAPTYN fair share: upload"] out-interface="" out-interface-list=WAN
# The server sets captyn-fair-down to 90% of ISP1 + ISP2 as probed.

# --- check ---------------------------------------------------------------
# /ip route print where comment~"ISP"            (active = A flag)
# /ip firewall mangle print stats where comment~"dual WAN"
# /interface monitor-traffic ether1,ether3 once   (both should carry traffic)
# Unplug ISP1's cable: within ~30 s everyone should be on ISP2, sign-ins work.

# --- roll back -----------------------------------------------------------
# /ip firewall mangle remove [find comment~"dual WAN"]
# /ip dhcp-client set [find interface=ether1] add-default-route=yes
# /ip route remove [find comment~"ISP"]
# /routing table remove [find name~"to-isp"]
# /ip firewall address-list remove [find list=captyn-local]
# /ip dhcp-client remove [find interface=ether3]
# /interface list member remove [find interface=ether3]
# /ip firewall mangle set [find comment="CAPTYN fair share: download"] in-interface-list="" in-interface=ether1
# /ip firewall mangle set [find comment="CAPTYN fair share: upload"] out-interface-list="" out-interface=ether1
