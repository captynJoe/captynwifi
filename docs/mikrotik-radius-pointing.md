# MikroTik to CAPTYN WiFi FreeRADIUS

CAPTYN WiFi FreeRADIUS is hosted on VPS6 and listens on the private WireGuard address:

- RADIUS auth: `10.8.0.6:1812/udp`
- RADIUS accounting: `10.8.0.6:1813/udp`

The shared secret is stored in `/home/captyn/captyn-wifi/.env` as `CAPTYN_WIFI_RADIUS_SECRET`.
Do not paste the secret into tickets, chat, or screenshots.

RouterOS API control-plane actions should target the MikroTik WireGuard address `10.8.0.50`. VPS node addresses `10.8.0.1` through `10.8.0.6` are reserved for servers, so do not reuse them for MikroTik.

## RouterOS Commands

On the MikroTik L009, after it can reach `10.8.0.6` over WireGuard/private routing:

```routeros
/radius add service=hotspot address=10.8.0.6 secret="<CAPTYN_WIFI_RADIUS_SECRET>" authentication-port=1812 accounting-port=1813 timeout=3s
/ip hotspot profile set [find name="<HOTSPOT_PROFILE_NAME>"] use-radius=yes radius-accounting=yes radius-interim-update=2m
/ip hotspot profile set [find name="<HOTSPOT_PROFILE_NAME>"] login-by=cookie,http-chap,http-pap,mac-cookie http-cookie-lifetime=3d
/ip hotspot user profile set [find] add-mac-cookie=yes mac-cookie-timeout=3d
```

If you also use PPP/PPPoE later, add those services explicitly:

```routeros
/radius set [find address=10.8.0.6] service=hotspot,ppp
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

The router serves five CAPTYN-branded pages from its `hotspot/` folder; the
full customer experience lives on CAPTYN WiFi at `https://captyn.shop/wifi/`.

| Router file | Shown when |
|---|---|
| `login.html` | A device that isn't signed in -- forwards `$(mac)`, `$(ip)`, `$(link-login-only)`, `$(link-orig-esc)` and `$(error)` to the portal |
| `alogin.html` | Right after a successful sign-in, then on to the portal |
| `status.html` | A signed-in device opening the router |
| `logout.html` | After signing out |
| `error.html` | When the router can't sign a device in |

The source of truth is `public/hotspot/`. Everything is inline (no external
fonts or scripts), since these load before the device has internet. The WiFi
API serves this folder as-is at `http://10.8.0.6:4120/portal/hotspot/` over
WireGuard -- fetch from there, not the public Cloudflare URL (Cloudflare may
inject challenge scripts) and not a temporary server on another port (the
VPS firewall only admits 22/80/443/51820; Docker-published ports like 4120
are reachable).

Keep a rollback copy of the router's current pages first: in Winbox open
Files -> hotspot and drag `login.html`, `alogin.html`, `status.html`,
`logout.html` and `error.html` to your computer.

Then run on RouterOS:

```routeros
:foreach f in={"login";"alogin";"status";"logout";"error"} do={
  /tool fetch url=("http://10.8.0.6:4120/portal/hotspot/" . $f . ".html") dst-path=("hotspot/" . $f . ".html") keep-result=yes
}
/file print terse where name~"^hotspot/(login|alogin|status|logout|error).html"
```

## Validate From RouterOS

```routeros
/ping 10.8.0.6
/radius monitor [find address=10.8.0.6]
/log print where message~"radius"
```

A paid WiFi entitlement should create rows in `radcheck` and `radreply`; FreeRADIUS should then return `Access-Accept` with attributes such as `Mikrotik-Rate-Limit` and `Session-Timeout`.

## Short Portal Address (wifi.captyn.shop)

Customers whose captive portal doesn't pop up open `wifi.captyn.shop`, which
lands on the hotspot login page and forwards into the portal with the
device's MAC and login link. The portal shows this address next to each
access record's 6-character device code.

```routeros
/ip hotspot profile set default dns-name=wifi.captyn.shop hotspot-address=192.168.88.1
```

Cloudflare: `A wifi -> 192.168.88.1`, DNS only (not proxied), so it also
resolves for phones using Private DNS instead of the router.

The RouterOS API must accept the VPS for governor kicks:

```routeros
/ip service set api disabled=no address=10.8.0.0/24
/ip firewall filter add chain=input protocol=tcp dst-port=8728 src-address=10.8.0.0/24 action=accept place-before=0 comment="CAPTYN governor API"
```
