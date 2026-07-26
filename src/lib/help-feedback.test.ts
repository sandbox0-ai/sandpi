import assert from "node:assert/strict";
import test from "node:test";

import {
  SANDPI_DOCUMENTATION_URL,
  SANDPI_GITHUB_REPOSITORY_URL,
  sandpiFeedbackIssueUrl,
} from "./help-feedback";

test("builds privacy-bounded Sandpi bug reports", () => {
  const url = new URL(
    sandpiFeedbackIssueUrl("bug", {
      pageUrl:
        "https://sandpi.ai/?environment=env-private&session=session-private",
      userAgent: "Browser Test",
    }),
  );

  assert.equal(
    `${url.origin}${url.pathname}`,
    "https://github.com/sandbox0-ai/sandpi/issues/new",
  );
  assert.equal(url.searchParams.get("title"), "Bug: ");
  assert.match(url.searchParams.get("body") ?? "", /Page: https:\/\/sandpi\.ai\//);
  assert.match(url.searchParams.get("body") ?? "", /Browser: Browser Test/);
  assert.doesNotMatch(url.searchParams.get("body") ?? "", /env-private/);
  assert.doesNotMatch(url.searchParams.get("body") ?? "", /session-private/);
});

test("builds distinct feedback reports and stable documentation links", () => {
  const url = new URL(
    sandpiFeedbackIssueUrl("feedback", {
      pageUrl: "https://sandpi.ai/ide/?path=%2Fworkspace%2Fsecret",
      userAgent: " ",
    }),
  );

  assert.equal(url.searchParams.get("title"), "Feedback: ");
  assert.match(url.searchParams.get("body") ?? "", /Feedback or suggestion/);
  assert.match(url.searchParams.get("body") ?? "", /Browser: Unknown/);
  assert.doesNotMatch(url.searchParams.get("body") ?? "", /workspace/);
  assert.equal(
    SANDPI_DOCUMENTATION_URL,
    "https://github.com/sandbox0-ai/sandpi#readme",
  );
  assert.equal(
    SANDPI_GITHUB_REPOSITORY_URL,
    "https://github.com/sandbox0-ai/sandpi",
  );
});
