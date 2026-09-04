# MikroTik to CAPTYN WiFi FreeRADIUS

CAPTYN WiFi FreeRADIUS is hosted on VPS1 and listens on the private WireGuard address:

- RADIUS auth: `10.8.0.2:1812/udp`
- RADIUS accounting: `10.8.0.2:1813/udp`

The shared secret is stored in `/home/captyn/captyn-wifi/.env` as `CAPTYN_WIFI_RADIUS_SECRET`.
Do not paste the secret into tickets, chat, or screenshots.

## RouterOS Commands

On the MikroTik L009, after it can reach `10.8.0.2` over WireGuard/private routing:

```routeros
/radius add service=hotspot address=10.8.0.2 secret="<CAPTYN_WIFI_RADIUS_SECRET>" authentication-port=1812 accounting-port=1813 timeout=3s
/ip hotspot profile set [find name="<HOTSPOT_PROFILE_NAME>"] use-radius=yes radius-accounting=yes radius-interim-update=2m
/ip hotspot profile set [find name="<HOTSPOT_PROFILE_NAME>"] login-by=cookie,http-chap,http-pap,mac-cookie http-cookie-lifetime=3d
/ip hotspot user profile set [find] add-mac-cookie=yes mac-cookie-timeout=3d
```

If you also use PPP/PPPoE later, add those services explicitly:

```routeros
/radius set [find address=10.8.0.2] service=hotspot,ppp
```

## Captive Portal Walled Garden

Unauthenticated users must be able to reach CAPTYN WiFi payment pages:

```routeros
/ip hotspot walled-garden add dst-host=captyn.shop comment="CAPTYN WiFi portal"
/ip hotspot walled-garden add dst-host=www.captyn.shop comment="CAPTYN WiFi portal"
/ip hotspot walled-garden add dst-host=housing.captyn.shop comment="CAPTYN Housing portal"
/ip hotspot walled-garden add dst-host=api.safaricom.co.ke comment="M-PESA live"
```

Use the sandbox Safaricom host only when testing sandbox M-PESA.

## Hotspot Login Page

MikroTik should keep only a small bridge page in `hotspot/login.html`. The full
customer experience lives on CAPTYN WiFi at `https://captyn.shop/wifi/`; the
bridge page forwards MikroTik placeholders such as `$(mac)`, `$(ip)`,
`$(link-login-only)`, and `$(link-orig-esc)` into the hosted portal.

The source of truth is `public/hotspot-login.html`. Do not fetch it from the
public Cloudflare URL when updating RouterOS, because Cloudflare may append
challenge scripts. Serve the clean repo file over the WireGuard address
temporarily instead:

```bash
cd /home/captyn/captyn-wifi/public
python3 -m http.server 8088 --bind 10.8.0.2
```

Before replacing the router copy, download a local rollback copy:

```bash
scp -O admin@10.8.0.5:hotspot/login.html /tmp/mikrotik-hotspot-login.backup-YYYYMMDD-HHMM.html
```

Then run on RouterOS:

```routeros
/tool fetch url="http://10.8.0.2:8088/hotspot-login.html" dst-path="hotspot/login.html" keep-result=yes
/file print terse where name="hotspot/login.html"
```

## Validate From RouterOS

```routeros
/ping 10.8.0.2
/radius monitor [find address=10.8.0.2]
/log print where message~"radius"
```

A paid WiFi entitlement should create rows in `radcheck` and `radreply`; FreeRADIUS should then return `Access-Accept` with attributes such as `Mikrotik-Rate-Limit` and `Session-Timeout`.
