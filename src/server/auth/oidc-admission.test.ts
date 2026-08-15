import assert from "node:assert/strict";
import test from "node:test";

import type { PoolClient } from "pg";

import { HttpError } from "@/server/http-error";
import { upsertOidcUser } from "./oidc";

const identity = {
  issuer: "https://identity.example/",
  subject: "subject-1",
  email: "person@example.com",
  name: "Example Person",
};

function recordingClient(existingUserId?: string) {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes("SELECT * FROM users")) {
        return { rows: existingUserId ? [{ id: existingUserId }] : [] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, statements };
}

test("closed registration rejects an unknown OIDC identity before writes", async () => {
  const { client, statements } = recordingClient();

  await assert.rejects(
    upsertOidcUser(client, identity, false),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 403 &&
      error.code === "registration_closed",
  );
  assert.equal(statements.length, 1);
  assert.match(statements[0] ?? "", /SELECT \* FROM users/);
});

test("closed registration still refreshes an existing OIDC user", async () => {
  const { client, statements } = recordingClient("user-existing");

  const principal = await upsertOidcUser(client, identity, false);

  assert.equal(principal.userId, "user-existing");
  assert.equal(principal.email, identity.email);
  assert.equal(statements.length, 2);
  assert.match(statements[1] ?? "", /UPDATE users/);
});

test("open registration creates the user, environment, and preferences", async () => {
  const { client, statements } = recordingClient();

  const principal = await upsertOidcUser(client, identity, true);

  assert.match(principal.userId, /^user_/);
  assert.equal(statements.length, 4);
  assert.match(statements[1] ?? "", /INSERT INTO users/);
  assert.match(statements[2] ?? "", /INSERT INTO environments/);
  assert.match(statements[3] ?? "", /INSERT INTO user_preferences/);
});
