import assert from "node:assert/strict";
import { test } from "node:test";
import { readApiJson } from "../src/portal/apiResponse.js";

test("readApiJson parses a successful JSON response", async () => {
  const response = new Response(JSON.stringify({ data: [{ id: "site-1" }] }), {
    headers: { "Content-Type": "application/json" },
  });

  assert.deepEqual(await readApiJson<{ data: Array<{ id: string }> }>(response, "Unable to load packages."), {
    data: [{ id: "site-1" }],
  });
});

test("readApiJson turns an HTML 429 response into a retryable message", async () => {
  const response = new Response("<html><h1>429 Too Many Requests</h1></html>", {
    status: 429,
    headers: { "Content-Type": "text/html" },
  });

  await assert.rejects(
    readApiJson(response, "Unable to load packages."),
    /temporarily busy.*try again/,
  );
});

test("readApiJson preserves a JSON API error on failure", async () => {
  const response = new Response(JSON.stringify({ error: "Packages are unavailable." }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

  await assert.rejects(readApiJson(response, "Unable to load packages."), /Packages are unavailable\./);
});

test("readApiJson reports invalid successful responses without exposing a JSON parse error", async () => {
  const response = new Response("<html>Unexpected upstream response</html>", {
    headers: { "Content-Type": "text/html" },
  });

  await assert.rejects(
    readApiJson(response, "Unable to load packages."),
    /unexpected response.*refresh/,
  );
});
