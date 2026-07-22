import pino from "pino";

/** Structured logger for AgentMesh services. Import via the "/logger" subpath
 *  (`@agentmesh/shared/logger`) — deliberately NOT re-exported from the package
 *  root so browser consumers of the shared wire types never pull in pino.
 *
 *  LOG_LEVEL env controls verbosity (default "info"). Output is one JSON line
 *  per event; pipe through `pino-pretty` for human reading in dev. */
export function createLogger(service: string): pino.Logger {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
  });
}

export type { Logger } from "pino";
