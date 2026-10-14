# CAPTYN WiFi

Hotspot control plane: packages, M-Pesa payments, entitlements, RADIUS projection, loyalty. Public portal at captyn.shop/wifi; admin is "WiFi Operations". Production runs in Docker on the owner's host (wifi_api, radius_worker, wifi_governor, freeradius, wifi_db) behind a MikroTik router.

## Layout

- `src/services/` — business logic (pricing, loyalty, promo, credits, outage credit, governor, RADIUS projection, M-Pesa, RouterOS)
- `src/routes/` — `public.ts` (portal API), `admin.ts`, `integration.ts` (housing)
- `src/portal/` — customer portal frontend (`tsconfig.portal.json`)
- `src/workers/` — RADIUS SQL worker, dynamic governor worker
- `prisma/schema.prisma` — data model
- `tests/*.test.ts` — Node built-in test runner via tsx

## Verify

```bash
npm run typecheck
npm test
```

That is enough. Do not run `npm run build` or docker builds; the owner builds and deploys.

## Never

- Touch production: no deploys, container restarts, `prisma migrate deploy`, SQL against the live DB, RouterOS/MikroTik or Omada commands. Write the code and hand over exact commands for the owner to run.
- Commit `.env`, backups (`*.bak*`), secrets, router IPs, RADIUS secrets or customer phone numbers.
- Enable the governor's live modes (`APPLY_RADIUS_SQL`, `KICK_ON_CHANGE`) by default; it stays dry-run unless the owner says otherwise.

## Product rules

- **Speeds** are always shown as "x Mbps + burst" (packages burst to 2x). Never advertise a flat boosted number.
- **Pricing** competes on quality and reliability, not on matching the nearby competitor's menu. Don't propose price cuts just to match them; judge prices against CAPTYN's own sales data.
- **Weekly rewards** (`src/services/loyalty.ts`):
  - Points are a calendar-month score (Nairobi time), reset on the 1st, never spent or reset by claiming.
  - 70 points from spend vs the month's top spender, 30 from regularity (distinct paid days, recent days weigh more). A minimum number of paid days is required to rank, so one big purchase can't win. Amount must weigh more than frequency.
  - Tiers by rank (default Gold 1–5 / Silver 6–15 / Bronze 16–30), each with free hours, bonus hours and speed +%; admin-editable.
  - Ranking freezes each Sunday; rewards go out at a random daytime moment Mon–Sat; the customer picks ONE card (free time, or a suggested package with bonus time + boosted speed). Unclaimed rewards expire.
  - Customers see their exact rank, points, tier and the KSh needed to pass the next rank / reach the next tier.
  - The open "Giveaway" promo stays alongside loyalty.
- Customer-facing copy: short, action-first. No explanatory eyebrow labels or subtitles; admin screens get one clear action, no icon clutter or duplicate counts.
