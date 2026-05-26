import type { FastifyRequest } from "fastify";

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function readBearer(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  const query = request.query as Record<string, unknown>;
  const token = query?.token;
  return typeof token === "string" ? token : undefined;
}

export function requireBearer(request: FastifyRequest, expectedToken: string): void {
  if (readBearer(request) !== expectedToken) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
}
