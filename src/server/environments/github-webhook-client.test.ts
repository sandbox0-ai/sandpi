import assert from "node:assert/strict";
import test from "node:test";

import { HttpGitHubWebhookClient } from "./github-webhook-client";

test("exchanges a GitHub code and reads only the user's installation inventory", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new HttpGitHubWebhookClient("github-client", "github-secret", {
    fetch: async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://github.test/login/oauth/access_token") {
        assert.equal(
          String(init.body),
          "client_id=github-client&client_secret=github-secret&code=oauth-code",
        );
        return Response.json({ access_token: "ephemeral-user-token" });
      }
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer ephemeral-user-token",
      );
      if (url.startsWith("https://api.github.test/user/installations?")) {
        return Response.json({
          installations: [
            {
              id: 123,
              account: { id: 456, login: "sandbox0-ai", type: "Organization" },
              repository_selection: "selected",
            },
          ],
        });
      }
      if (
        url.startsWith(
          "https://api.github.test/user/installations/123/repositories?",
        )
      ) {
        return Response.json({
          repositories: [
            {
              id: 789,
              full_name: "sandbox0-ai/sandpi",
              private: false,
              default_branch: "main",
            },
          ],
        });
      }
      return new Response(undefined, { status: 404 });
    },
    githubUrl: new URL("https://github.test"),
    apiUrl: new URL("https://api.github.test"),
  });

  const accessToken = await client.exchangeAuthorizationCode("oauth-code");
  const installations = await client.listUserInstallations(accessToken);

  assert.deepEqual(installations, [
    {
      installationId: "123",
      accountId: "456",
      accountLogin: "sandbox0-ai",
      accountType: "Organization",
      repositorySelection: "selected",
      repositories: [
        {
          id: "789",
          fullName: "sandbox0-ai/sandpi",
          private: false,
          defaultBranch: "main",
        },
      ],
    },
  ]);
  assert.equal(requests.length, 3);
});
