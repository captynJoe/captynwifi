# CAPTYN Housing Integration

CAPTYN Wi-Fi is a sibling service to CAPTYN Housing.

Housing remains responsible for:

- resident and landlord UX
- buildings and room context
- package editing
- collecting or initiating payment
- showing payment/provisioning state to residents

CAPTYN Wi-Fi owns:

- payment intent replay/idempotency
- entitlements
- RADIUS projection rows
- RADIUS accounting ingestion
- MikroTik/RouterOS control-plane actions
- session disconnect/CoA workflows

## First Integration

When Housing confirms a Wi-Fi payment, call:

```http
POST /api/integrations/housing/payments/confirmed
x-captyn-wifi-token: <CAPTYN_WIFI_INTEGRATION_TOKEN>
content-type: application/json
```

```json
{
  "sourceReference": "WIFI-1785555012345-000042",
  "providerReference": "MPESA-ABC123",
  "site": {
    "id": "CAPTYN-BLDG-00002",
    "name": "Village Inn"
  },
  "package": {
    "id": "day_24",
    "name": "Day Pass",
    "hours": 24,
    "priceKsh": 120,
    "rateLimit": "3M/10M 5M/15M 3M/10M 20/20",
    "deviceLimit": 1,
    "enabled": true
  },
  "customerPhone": "+254712345678",
  "deviceMac": "AA:BB:CC:DD:EE:FF",
  "amountKsh": 120,
  "confirmedAt": "2026-08-01T00:00:00.000Z"
}
```

The response contains the `WifiEntitlement` and pending `WifiRadiusProjection`.
The next worker should project those JSON attributes into FreeRADIUS SQL tables.

## Why Separate

Housing should not become the customer database for RouterOS. RouterOS should
ask FreeRADIUS. FreeRADIUS should read its own projection tables. CAPTYN Wi-Fi
bridges Housing payments into network authorization without coupling rent and
room operations to the access network.
