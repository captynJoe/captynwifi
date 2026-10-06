-- Devices become a ledger of every device that has signed in on a package,
-- recorded by FreeRADIUS itself (post-auth) rather than only when the portal
-- happened to register one -- most packages showed 0 devices despite use.
-- Signing out marks a device instead of deleting it, so it still counts
-- toward the package's switch cap.

ALTER TABLE "WifiEntitlementDevice" ADD COLUMN "signedOutAt" TIMESTAMP(3);

-- Different devices allowed over a package's life: its concurrent device
-- limit, plus 1 switch for packages up to a day, plus 2 for longer ones.
CREATE OR REPLACE FUNCTION captyn_device_cap(p_device_limit integer, p_starts timestamp, p_expires timestamp)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT p_device_limit + CASE WHEN p_expires - p_starts <= interval '1 day' THEN 1 ELSE 2 END
$$;

-- The username's current access record (same rule as the app's
-- activeAccessWhere: active and unexpired, or paused).
CREATE OR REPLACE FUNCTION captyn_active_entitlement(p_username text)
RETURNS "WifiEntitlement" LANGUAGE sql STABLE AS $$
  SELECT * FROM "WifiEntitlement"
  WHERE username = p_username AND status = 'active'
    AND ("expiresAt" > now() OR "outagePausedAt" IS NOT NULL OR "promoPausedAt" IS NOT NULL)
  ORDER BY "expiresAt" DESC
  LIMIT 1
$$;

-- Called by FreeRADIUS in authorize: 1 = a new device beyond the cap (reject).
-- A device already used on the package is always let back in.
CREATE OR REPLACE FUNCTION captyn_device_over_cap(p_username text, p_mac text)
RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE
  e "WifiEntitlement";
  mac text := upper(trim(coalesce(p_mac, '')));
  used integer;
BEGIN
  e := captyn_active_entitlement(p_username);
  IF e.id IS NULL OR mac = '' THEN RETURN 0; END IF;
  IF EXISTS (SELECT 1 FROM "WifiEntitlementDevice" WHERE "entitlementId" = e.id AND "deviceMac" = mac) THEN RETURN 0; END IF;
  SELECT count(*) INTO used FROM "WifiEntitlementDevice" WHERE "entitlementId" = e.id;
  RETURN CASE WHEN used >= captyn_device_cap(e."deviceLimit", e."startsAt", e."expiresAt") THEN 1 ELSE 0 END;
END
$$;

-- Called by FreeRADIUS in post-auth (accepted logins only): record the device.
CREATE OR REPLACE FUNCTION captyn_record_device(p_username text, p_mac text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  e "WifiEntitlement";
  mac text := upper(trim(coalesce(p_mac, '')));
BEGIN
  e := captyn_active_entitlement(p_username);
  IF e.id IS NULL OR mac = '' THEN RETURN 0; END IF;
  INSERT INTO "WifiEntitlementDevice" (id, "entitlementId", "deviceMac", "addedAt", "lastSeenAt")
  VALUES (gen_random_uuid()::text, e.id, mac, now(), now())
  ON CONFLICT ("entitlementId", "deviceMac") DO UPDATE SET "lastSeenAt" = now(), "signedOutAt" = NULL;
  RETURN 1;
END
$$;

-- Backfill current packages from their session history.
INSERT INTO "WifiEntitlementDevice" (id, "entitlementId", "deviceMac", "addedAt", "lastSeenAt")
SELECT gen_random_uuid()::text, e.id, upper(r.callingstationid), min(r.acctstarttime), max(coalesce(r.acctupdatetime, r.acctstarttime))
FROM "WifiEntitlement" e
JOIN radacct r ON r.username = e.username AND r.acctstarttime >= e."startsAt" - interval '2 minutes'
WHERE e.status = 'active' AND e."expiresAt" > now() AND coalesce(r.callingstationid, '') <> ''
GROUP BY e.id, upper(r.callingstationid)
ON CONFLICT ("entitlementId", "deviceMac") DO NOTHING;
