-- Keep each saved color band aligned with the same package tier after
-- customer badges switch from base speed to the 2x burst maximum.
UPDATE "WifiSpeedColorSetting"
SET "tiers" = (
  SELECT jsonb_agg(
    CASE
      WHEN entry.ordinality < jsonb_array_length("WifiSpeedColorSetting"."tiers")
      THEN jsonb_set(entry.tier, '{maxMbps}', to_jsonb((entry.tier->>'maxMbps')::numeric * 2))
      ELSE entry.tier
    END
    ORDER BY entry.ordinality
  )
  FROM jsonb_array_elements("WifiSpeedColorSetting"."tiers") WITH ORDINALITY AS entry(tier, ordinality)
)
WHERE id = 'default'
  AND jsonb_typeof("tiers") = 'array'
  AND jsonb_array_length("tiers") = 4;
