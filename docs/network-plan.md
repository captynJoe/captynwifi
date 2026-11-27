# CAPTYN WiFi network plan: two ISPs and room to grow

Written 2026-11-27, from the live router and Omada data.

## Today

```
ISP1 modem (192.168.100.1) ──ether1──┐
                                     │  MikroTik L009 (2 cores, 7.20.8)
             ether2 ── 100 Mbps dumb switch ── EAP245, E2-DE, Outdoor 6C-4C, Outdoor 50-3D
             ether8 ── EAP225 E5-F6 (PoE)
             ether5, ether7 ── PPPoE customers
             ether6 ── owner's PC (Omada controller)
             wg-captyn ── WireGuard to the server (RADIUS, payments, portal API)
```

What the data says:
- The ISP line carries ~70 Mbps by day and ~22 Mbps from 20:30 to midnight,
  every night (ISP probe). That cap is the main evening problem.
- Wi-Fi: 32 of 35 phones on 2.4 GHz; the Outdoors' 2.4 radios ran 66-79%
  busy. Omada rates 4 of 5 APs high co-channel interference (2.4 GHz has only
  3 clean channels for 5 APs). The new Outdoor's 8 dBi antennas reach far but
  are weak close in.
- Router: ~14% CPU at ~20 Mbps with hotspot + per-user queues + fair queue.

## With the second ISP (docs/dual-wan.rsc)

```
ISP1 ──ether1──┐                   ┌── PCC: each customer sticks to one line
ISP2 ──ether3──┤  L009             ├── failover: a dead line's customers move
               │                   │   to the other within ~30 s
               └── fair queue ─────┘   over both lines, limit = 90% of the sum
```

- **Per-customer split, not per-packet.** A customer stays on one ISP, so
  M-PESA, banking, calls and logins don't break. New customers are spread
  evenly (or 2:1 toward the faster ISP).
- **Real failover.** Each line is judged by reaching a public host through
  it, not by its modem answering (a modem answers even with its fibre down).
- **Sign-ins survive a line failure.** The router's own traffic, WireGuard to
  the server, which carries every RADIUS sign-in, prefers ISP1 and falls back
  to ISP2. The server side of WireGuard follows the router's new address on
  its own (keepalive every 25 s).
- **"More generous when there's plenty"**, driven by measurement, not a
  fixed number:
  1. The ISP probe tests each line hourly by day, every 30 min in the
     evening. Total capacity = ISP1 + ISP2 as measured.
  2. The fair queue's limit follows that total (90%), so the full combined
     speed is used by day and shared fairly when it's tight.
  3. The dynamic plan engine should use that measured total instead of its
     fixed 80 Mbps. Then with lots of headroom it publishes the generous
     menu (faster, longer, cheaper), and when the lines are full it
     tightens. Today it reads the full evening line as "quiet" and does the
     opposite.
  4. Promos and weekly rewards can be scheduled into measured quiet hours.

What I still need for ISP2: its link type (fibre / 5G / wireless), its
speed, and its modem's LAN address (it must not also be 192.168.100.x).

## Expansion, in order

1. **Gigabit PoE switch, Omada-managed** (e.g. TP-Link SG2210P/ES210GP), in
   place of the 100 Mbps dumb switch on ether2. Removes the shared 100 Mbps
   cap on four APs, powers APs without injectors, and shows real topology.
2. **Omada controller that's always on.** Today it's the owner's PC: when the
   PC is off, nothing can be adopted or changed. Options: an OC200 hardware
   controller on the switch (simplest), or the controller in Docker on the
   server, reached over WireGuard.
3. **APs where people sit.** Indoor APs within one wall of each cluster of
   houses; Outdoors only for long reach (antennas vertical, modest height).
   Swap the new EAP245 into the new Outdoor's spot and move that Outdoor to a
   long-reach position. On 2.4 GHz, no two APs that hear each other share a
   channel (1/6/11); use 5 GHz channels freely.
4. **Separate management network (VLANs).** APs, switch and controller on a
   management VLAN; customers on the hotspot VLAN. Customers then can't reach
   AP or controller admin pages, and growth stays tidy.
5. **Bigger router when traffic grows.** The L009 is fine for two ~70-100
   Mbps lines at today's user count. Past ~150 Mbps combined or ~100
   concurrent users, move to an RB5009 (4 cores, 2.5G/SFP+), same config.
   Watch router CPU on the Capacity page after ISP2 goes in.

## Applying ISP2 tomorrow

1. Connect ISP2's modem to ether3.
2. Send its modem LAN address/subnet (or let me read the lease from ether3).
3. I fill ISP2_GW / ISP2_NET in docs/dual-wan.rsc and apply it block by
   block through the router API, checking each step; block 4 is ordered so
   there's no moment without internet.
4. Test: unplug ISP1 for a minute; sign-ins and browsing should continue
   on ISP2.
