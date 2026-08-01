import { z } from "zod";

import { HttpError } from "@/server/http-error";

const githubAccountSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  type: z.string().min(1),
});

const githubInstallationSchema = z.object({
  id: z.number().int().positive(),
  account: githubAccountSchema,
  repository_selection: z.enum(["all", "selected"]),
});

const githubRepositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(1),
  private: z.boolean(),
  default_branch: z.string().min(1).nullable().optional(),
});

const githubInstallationsPageSchema = z.object({
  installations: z.array(githubInstallationSchema),
});

const githubRepositoriesPageSchema = z.object({
  repositories: z.array(githubRepositorySchema),
});

const githubOAuthTokenSchema = z.object({
  access_token: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
});

export interface GitHubInstallationInventory {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositories: Array<{
    id: string;
    fullName: string;
    private: boolean;
    defaultBranch?: string;
  }>;
}

export interface GitHubWebhookClient {
  exchangeAuthorizationCode(code: string): Promise<string>;
  listUserInstallations(accessToken: string): Promise<GitHubInstallationInventory[]>;
}

/** Calls only the GitHub App OAuth and installation inventory APIs. */
export class HttpGitHubWebhookClient implements GitHubWebhookClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly options: {
      fetch?: typeof fetch;
      githubUrl?: URL;
      apiUrl?: URL;
    } = {},
  ) {}

  async exchangeAuthorizationCode(code: string) {
    const response = await this.request(
      new URL(
        "/login/oauth/access_token",
        this.options.githubUrl ?? new URL("https://github.com"),
      ),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
        }),
      },
    );
    const body = githubOAuthTokenSchema.parse(await response.json());
    if (!body.access_token) {
      throw new HttpError(
        502,
        "github_webhook_authorization_failed",
        body.error_description ?? body.error ?? "GitHub did not return an access token.",
      );
    }
    return body.access_token;
  }

  async listUserInstallations(accessToken: string) {
    const installations = await this.allPages(
      new URL(
        "/user/installations?per_page=100",
        this.options.apiUrl ?? new URL("https://api.github.com"),
      ),
      accessToken,
      (value) => githubInstallationsPageSchema.parse(value).installations,
    );
    return Promise.all(
      installations.map(async (installation) => {
        const repositories = await this.allPages(
          new URL(
            `/user/installations/${installation.id}/repositories?per_page=100`,
            this.options.apiUrl ?? new URL("https://api.github.com"),
          ),
          accessToken,
          (value) => githubRepositoriesPageSchema.parse(value).repositories,
        );
        return {
          installationId: String(installation.id),
          accountId: String(installation.account.id),
          accountLogin: installation.account.login,
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection,
          repositories: repositories.map((repository) => ({
            id: String(repository.id),
            fullName: repository.full_name,
            private: repository.private,
            ...(repository.default_branch
              ? { defaultBranch: repository.default_branch }
              : {}),
          })),
        } satisfies GitHubInstallationInventory;
      }),
    );
  }

  private async allPages<T>(
    initialUrl: URL,
    accessToken: string,
    parse: (value: unknown) => T[],
  ) {
    const values: T[] = [];
    let url: URL | undefined = initialUrl;
    while (url) {
      const response = await this.request(url, {
        headers: githubApiHeaders(accessToken),
      });
      values.push(...parse(await response.json()));
      url = nextPageUrl(response.headers.get("link"));
    }
    return values;
  }

  private async request(url: URL, init: RequestInit) {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, init);
    } catch (error) {
      throw new HttpError(
        502,
        "github_webhook_unavailable",
        `GitHub could not be reached: ${errorMessage(error)}`,
      );
    }
    if (!response.ok) {
      throw new HttpError(
        502,
        "github_webhook_request_failed",
        `GitHub returned HTTP ${response.status}.`,
      );
    }
    return response;
  }
}

function githubApiHeaders(accessToken: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sandpi-github-webhooks",
  };
}

function nextPageUrl(link: string | null) {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return new URL(match[1]);
  }
  return undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
