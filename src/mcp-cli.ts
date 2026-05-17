#!/usr/bin/env node
/**
 * MCP stdio entry point for Claude Session Manager.
 *
 * Usage:
 *   CSM_URL=http://lab:8321 npx claude-session-manager-mcp
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./mcp.js";

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
