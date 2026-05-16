#!/usr/bin/env node
/**
 * CLI entry point for Claude Session Manager.
 */

import { serve } from "@hono/node-server";

import { app } from "./server.js";

const host = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "8321", 10);

console.log(`✻ Claude Session Manager listening on http://${host}:${port}`);

serve({ fetch: app.fetch, hostname: host, port });
