-- Signing a device out of a package now sticks. Before, any accepted
-- login (often the router's own mac-cookie re-login seconds after the
-- kick) went through captyn_record_device, which cleared "signedOutAt",
-- and captyn_device_over_cap let signed-out devices straight back in. On
-- shared packages the devices took turns kicking each other.

-- 0 = allowed, 1 = over the package's device cap, 2 = this device was
-- signed out of the package. FreeRADIUS rejects 1 and 2; a policy that only
-- knows "1" keeps letting signed-out devices in, so either order of
-- deploying this and the freeradius image is safe.
CREATE OR REPLACE FUNCTION captyn_device_over_cap(p_username text, p_mac text)
RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE
  e "WifiEntitlement";
  mac text := upper(trim(coalesce(p_mac, '')));
  signed_out timestamp;
  used integer;
BEGIN
  e := captyn_active_entitlement(p_username);
  IF e.id IS NULL OR mac = '' THEN RETURN 0; END IF;
  SELECT "signedOutAt" INTO signed_out FROM "WifiEntitlementDevice" WHERE "entitlementId" = e.id AND "deviceMac" = mac;
  IF FOUND THEN RETURN CASE WHEN signed_out IS NULL THEN 0 ELSE 2 END; END IF;
  SELECT count(*) INTO used FROM "WifiEntitlementDevice" WHERE "entitlementId" = e.id;
  RETURN CASE WHEN used >= captyn_device_cap(e."deviceLimit", e."startsAt", e."expiresAt") THEN 1 ELSE 0 END;
END
$$;

-- Recording an accepted login no longer un-signs-out the device; only a
-- deliberate portal action (link-device with rejoin) does that.
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
  ON CONFLICT ("entitlementId", "deviceMac") DO UPDATE SET "lastSeenAt" = now();
  RETURN 1;
END
$$;
