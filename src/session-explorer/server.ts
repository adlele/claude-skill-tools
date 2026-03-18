// session-explorer/server.ts — Local HTTP server for the session browser.
// Serves the session browser app and provides an API for on-demand session parsing.

import * as http from "node:http";
import * as os from "node:os";
import {
  listAllSessions,
  findSessionFile,
  parseSessionDeep,
} from "./parser.js";
import { generateBrowserApp } from "./report.js";
import { cyan, dim, bold } from "../shared/ui.js";

export function startServer(port: number): void {
  // Pre-fetch session list for the initial page
  console.log(`  ${dim("Scanning sessions...")}`);
  const sessions = listAllSessions();
  console.log(
    `  ${dim("Found")} ${bold(String(sessions.length))} ${dim("sessions across all projects")}`,
  );

  const appHtml = generateBrowserApp(sessions);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // API: parse a single session on demand
    if (url.pathname.startsWith("/api/session/")) {
      const sessionId = url.pathname.slice("/api/session/".length);
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing session ID" }));
        return;
      }

      try {
        const info = findSessionFile(sessionId);
        const analysis = parseSessionDeep(info.mainFile, info.sessionDir);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(analysis));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // API: refresh session list
    if (url.pathname === "/api/sessions") {
      try {
        const fresh = listAllSessions();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(fresh));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // Serve the app HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(appHtml);
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Session Browser running at ${cyan(url)}`);
    console.log(`  ${dim("Press Ctrl+C to stop")}\n`);

    // Auto-open on macOS
    if (process.platform === "darwin") {
      import("node:child_process").then(({ execSync }) => {
        try {
          execSync(`open "${url}"`);
        } catch {
          /* ignore */
        }
      });
    }
  });
}
