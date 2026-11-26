import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalRedirect } from "../src/lib/cloudflare/canonical-host";

const site = "https://site.example";

test("www and workers.dev aliases redirect to the canonical origin, keeping path and query", () => {
  assert.equal(canonicalRedirect("https://www.site.example/guides?x=1", site), "https://site.example/guides?x=1");
  assert.equal(canonicalRedirect("https://app.acct.workers.dev/about", site), "https://site.example/about");
  assert.equal(canonicalRedirect("https://www.site.example/", site + "/"), "https://site.example/");
});

test("the canonical host and unrelated hosts pass through", () => {
  assert.equal(canonicalRedirect("https://site.example/learn", site), null);
  assert.equal(canonicalRedirect("https://internal.local/api/cron/email-drain", site), null);
  assert.equal(canonicalRedirect("https://other.example/", site), null);
});

test("workers.dev or missing/invalid site origins never redirect", () => {
  assert.equal(canonicalRedirect("https://www.app.acct.workers.dev/", "https://app.acct.workers.dev"), null);
  assert.equal(canonicalRedirect("https://app.acct.workers.dev/", "https://app.acct.workers.dev"), null);
  assert.equal(canonicalRedirect("https://www.site.example/", undefined), null);
  assert.equal(canonicalRedirect("https://www.site.example/", "not a url"), null);
  assert.equal(canonicalRedirect("https://www.site.example/", "http://site.example"), null);
});
