import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import fastifyStatic from "@fastify/static";
import { settings } from "./config.js";
import { ClientError } from "./errors.js";
import { fail, ok } from "./responses.js";
import { registerRoutes } from "./routes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const webDist = join(root, "web", "dist");

async function main() {
  if (!settings.allowRemote && !["127.0.0.1", "localhost", "::1"].includes(settings.host)) {
    console.log(`WARNING: SQLSM_HOST=${settings.host} is not loopback. Set SQLSM_ALLOW_REMOTE=1 if intentional.`);
  }

  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: ["http://127.0.0.1:5173", "http://localhost:5173", `http://${settings.host}:${settings.port}`],
    credentials: true,
  });
  await app.register(cookie);
  await app.register(session, {
    secret: settings.secret.padEnd(32, "0").slice(0, 64),
    cookieName: "sqlsm",
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ClientError) {
      return reply.code(error.status).send(fail(error.message, { hint: error.hint, retryable: error.retryable }));
    }
    const message = error instanceof Error ? error.message : "An internal error occurred";
    return reply.code(500).send(fail(message));
  });

  await registerRoutes(app);

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send(fail("Not found"));
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () =>
      ok("SQL Server Management is running", {
        status: "online",
        health: "/health",
        api_version: "v1",
        ui: "http://127.0.0.1:5173",
      }),
    );
  }

  await app.listen({ host: settings.host, port: settings.port });
  const url = `http://${settings.host}:${settings.port}`;
  console.log("");
  console.log("SQL Server Management");
  console.log(`API: ${url}`);
  console.log(`UI (dev): http://127.0.0.1:5173`);
  console.log("Press Ctrl+C to stop.");
  console.log("");
}

void main();
