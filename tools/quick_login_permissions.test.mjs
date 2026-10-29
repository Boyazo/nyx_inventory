// Run with Node 23.2+: node --test tools/quick_login_permissions.test.mjs
// Exercise the actual edge handler with an in-memory Supabase boundary.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import test from "node:test";

const source = stripTypeScriptTypes(readFileSync(new URL("../supabase/functions/quick-login/index.ts", import.meta.url), "utf8")
  .replace('import { createClient } from "npm:@supabase/supabase-js@2";', ""));

function setup(actorRole, targetRole, { self = false, missing = false, lookupError = false, signedIn = true } = {}) {
  const profile = (id, role) => ({ id, full_name: id, is_approved: true, is_admin: role === "admin", is_moderator: role === "moderator" });
  const actor = profile("actor", actorRole);
  const target = self ? actor : profile("target", targetRole);
  const codes = new Map([[target.id, { user_id: target.id, code_hmac: "original" }]]);
  const writes = [];
  const db = {
    from(table) {
      let operation = "select", payload;
      const filters = {};
      const query = {
        select() { return query; },
        eq(key, value) { filters[key] = value; return query; },
        upsert(value) { operation = "upsert"; payload = value; return query; },
        insert(value) { operation = "insert"; payload = value; return query; },
        delete() { operation = "delete"; return query; },
        maybeSingle() { return query; },
        then(resolve, reject) {
          let data = null, error = null;
          if (operation === "select" && table === "profiles") {
            data = filters.id === actor.id ? actor : missing ? null : target;
            if (filters.id !== actor.id && lookupError) { data = null; error = { message: "lookup failed" }; }
          } else if (operation === "select" && table === "quick_login_codes") {
            data = [...codes.values()].find(row => Object.entries(filters).every(([key, value]) => row[key] === value)) || null;
          } else if (operation !== "select") {
            writes.push({ table, operation, payload });
            if (table === "quick_login_codes") {
              if (operation === "delete") codes.delete(filters.user_id);
              else codes.set(payload.user_id, payload);
            }
          }
          return Promise.resolve({ data, error }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  let handler;
  runInNewContext(source, {
    createClient: (_url, key) => key === "SUPABASE_SERVICE_ROLE_KEY" ? db : {
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: actor.id } : null } }) },
    },
    Deno: { env: { get: key => key }, serve: fn => { handler = fn; } },
    Response, TextEncoder, crypto: webcrypto, console,
  });
  return {
    codes, writes, target,
    request: (action, extra = {}) => handler(new Request("https://example.test/quick-login", {
      method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ action, user_id: target.id, ...extra }),
    })),
  };
}

for (const action of ["set_code", "clear_code"]) {
  for (const actor of ["admin", "moderator", "member"]) {
    test(`${actor} cannot ${action} for another admin`, async () => {
      const app = setup(actor, "admin");
      assert.equal((await app.request(action)).status, 403);
      assert.equal(app.codes.get("target").code_hmac, "original");
      assert.deepEqual(app.writes, []);
    });
    test(`${actor} can ${action} for self`, async () => {
      const app = setup(actor, actor, { self: true });
      assert.equal((await app.request(action)).status, 200);
      if (action === "clear_code") assert.equal(app.codes.has("actor"), false);
      else assert.notEqual(app.codes.get("actor").code_hmac, "original");
    });
    for (const target of ["member", "moderator"]) {
      test(`${actor} ${action} for ${target} respects staff permissions`, async () => {
        const app = setup(actor, target);
        assert.equal((await app.request(action)).status, actor === "member" ? 403 : 200);
        if (actor === "member") assert.deepEqual(app.writes, []);
      });
    }
  }
  for (const option of ["missing", "lookupError", "signedIn"]) {
    test(`${action} fails closed on ${option}`, async () => {
      const app = setup("admin", "admin", { [option]: option !== "signedIn" });
      assert.equal((await app.request(action)).status, option === "signedIn" ? 401 : 400);
      assert.deepEqual(app.writes, []);
    });
  }
}

test("admin can choose their own PIN", async () => {
  const app = setup("admin", "admin", { self: true });
  const res = await app.request("set_code", { pin: "395827" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, "395827");
});

test("chosen PIN request cannot bypass another admin's protection", async () => {
  const app = setup("admin", "admin");
  assert.equal((await app.request("set_code", { pin: "395827" })).status, 403);
  assert.deepEqual(app.writes, []);
});
