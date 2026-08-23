import "fastify";

declare module "fastify" {
  interface Session {
    sid?: string;
    csrf?: string;
  }
}
