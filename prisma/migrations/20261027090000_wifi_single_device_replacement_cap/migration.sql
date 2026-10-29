-- Keep the lifetime device ledger to one replacement beyond the package's
-- concurrent device limit, regardless of package duration. Existing devices
-- remain allowed by captyn_device_over_cap; only new device registrations
-- beyond the revised cap are rejected.
CREATE OR REPLACE FUNCTION captyn_device_cap(p_device_limit integer, p_starts timestamp, p_expires timestamp)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT p_device_limit + 1
$$;
