import Fastify from "fastify";

export const SERVICE_NAME = "farside";

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    status: "ok" as const,
    service: SERVICE_NAME,
  }));

  return app;
}
