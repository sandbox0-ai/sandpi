import type { FastifyRequest } from "fastify";

export interface Principal {
  userId: string;
  subject: string;
  email: string;
  name: string;
  kind: "builtin-admin" | "oidc-session" | "bearer";
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}

export function principalFor(request: FastifyRequest): Principal {
  return request.principal;
}
