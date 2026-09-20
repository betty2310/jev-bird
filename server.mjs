import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createJevLog } from "./jev-log.mjs";

const publicRoot = fileURLToPath(new URL("./public/", import.meta.url));
const MODEL = "jev-1.13.0";
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const instructions = [
  "You are flying a Flappy Bird game. Choose FLAP once or WAIT to stay alive and fly through the next opening.",
  "The game continues while this request travels. Use `atExpectedArrival` as the bird and pipe state WHEN your action will be applied. Its observations are computed by the game; current numeric state is also supplied.",
  "Use `trajectoryPreviews.actions`: code has simulated FLAP and WAIT through the next decision. Prefer an action whose path is clear over one that predicts a collision, especially a flap into an upper pipe. If neither path is clear, favor the later collision. These previews already handle the arithmetic.",
  "A flap sets vertical velocity upward. Gravity then slows the rise and pulls the bird down. WAIT lets this arc continue. Never flap repeatedly just because the bird is above the ground.",
  "Steer around the next gap center. If below center and falling, flap. If rising safely, generally wait. If above center, generally wait to descend; flapping near the upper edge or ceiling can crash.",
  "Anticipate the wait until the next decision: a fast fall near the gap center or lower edge may need a flap now. Stay comfortably above the water. When far from a pipe, maintain a stable altitude around its gap center.",
  "Choose the action yourself from the observed geometry and motion. Return the one action to apply now.",
].join(" ");
const clientEvents = new Set(["run_start", "run_end", "manual_flap", "score", "paused", "resumed",
  "mode_changed", "auto_connected", "auto_disconnected", "decision_requested", "decision_received",
  "decision_cancelled", "decision_failed", "decision_discarded", "action_applied", "action_discarded", "page_exit"]);
const validId = s => typeof s === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(s);

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function validState(s) {
  return (
    s &&
    typeof s === "object" &&
    Number.isSafeInteger(s.runId) &&
    Number.isSafeInteger(s.frameId) &&
    s.bird &&
    ["x", "y", "vy", "radius"].every((k) => Number.isFinite(s.bird[k])) &&
    Array.isArray(s.pipes) &&
    s.pipes.length > 0 &&
    s.pipes.length <= 4 &&
    s.atExpectedArrival?.bird &&
    s.atExpectedArrival?.observations &&
    (s.arrivalCases === undefined || (Array.isArray(s.arrivalCases) && s.arrivalCases.length > 0 && s.arrivalCases.length <= 7 &&
      new Set(s.arrivalCases.map(c => c?.id)).size === s.arrivalCases.length &&
      s.arrivalCases.every(c => /^at_\d{3}$/.test(c?.id) && Number.isFinite(c.delayMs) && c.delayMs >= 0 && c.delayMs <= 900 &&
        c.atExpectedArrival?.bird && c.atExpectedArrival?.observations && c.trajectoryPreviews?.actions)))
  );
}

function validAnswer(a) {
  return a && ["FLAP", "WAIT"].includes(a.choice) &&
    [a.probabilities?.FLAP, a.probabilities?.WAIT, a.confidence].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
    Math.abs(a.probabilities.FLAP + a.probabilities.WAIT - 1) <= 0.03;
}

export function createApp({ upstreamFetch = fetch, log = null } = {}) {
  return createServer(async (req, res) => {
    const serverReceivedAt = performance.now();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/log-status" && req.method === "GET") {
        return json(res, 200, log ? { enabled: true, serverSessionId: log.serverSessionId, healthy: !log.status().failure } : { enabled: false });
      }
      if (req.method !== "POST")
        return json(res, 405, { error: "Use POST for a decision." });
      // Reject cross-origin browser requests; the app never needs CORS.
      if (req.headers.origin) {
        let originHost;
        try {
          originHost = new URL(req.headers.origin).host;
        } catch {
          /* rejected below */
        }
        if (originHost !== req.headers.host)
          return json(res, 403, { error: "Use the game on the same origin." });
      }
    }
    if (url.pathname === "/api/telemetry") {
      if (!req.headers["content-type"]?.startsWith("application/json")) return json(res, 415, { error: "Send JSON telemetry." });
      try {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (Buffer.byteLength(raw) > 52000) return json(res, 413, { error: "Telemetry batch is too large." });
        }
        const { events, dropped = 0 } = JSON.parse(raw);
        if (!Array.isArray(events) || events.length > 16 || !events.every(e => clientEvents.has(e?.event) && validId(e.sessionId))) {
          return json(res, 400, { error: "Invalid telemetry events." });
        }
        for (const { event, loggedAt, schemaVersion, serverSessionId, ...data } of events) {
          log?.write(event, { ...data, reportedBy: "client", clientQueueDropped: Number.isSafeInteger(dropped) ? dropped : null });
        }
        return json(res, 200, { accepted: events.length, loggingEnabled: Boolean(log) });
      } catch { return json(res, 400, { error: "Send valid JSON telemetry." }); }
    }
    if (url.pathname === "/api/decision") {
      const authorization = req.headers.authorization;
      if (
        !authorization?.startsWith("Bearer ") ||
        authorization.slice(7).trim().length < 8 ||
        authorization.length > 1024
      ) {
        return json(res, 401, {
          error: "Enter your TypeSafe API key to use Auto.",
        });
      }
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "Send JSON game state." });
      let body = "";
      let context = null;
      let upstreamStarted = null;
      let clientCancelled = false;
      try {
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 24000)
            return json(res, 413, { error: "The game state is too large." });
        }
        const { state, client = {} } = JSON.parse(body);
        if (!validState(state))
          return json(res, 400, { error: "The game state is incomplete." });
        context = { requestId: validId(client.requestId) ? client.requestId : randomUUID(),
          sessionId: validId(client.sessionId) ? client.sessionId : "unknown",
          purpose: client.purpose === "validation" ? "validation" : "flight", runId: state.runId, frameId: state.frameId };
        const question = (caseId) => ({
          type: "choice", instructions: caseId
            ? `Evaluate ONLY arrivalCases entry with id ${caseId}. Use that entry's atExpectedArrival and trajectoryPreviews for this question, not the other arrival cases or the top-level forecast. ${instructions}`
            : instructions,
          criteria: { FLAP: "Flap ONCE now: set vy upward to the flap velocity.", WAIT: "Do not flap now; let the current flight arc continue under gravity." },
        });
        const questions = state.arrivalCases ? Object.fromEntries(state.arrivalCases.map(c => [c.id, question(c.id)])) : { action: question() };
        const payload = { model: MODEL, state, questions };
        const requestBody = JSON.stringify(payload);
        log?.write("api_request", { ...context, request: payload, requestBytes: Buffer.byteLength(requestBody),
          clientClockMs: Number.isFinite(client.clockMs) ? client.clockMs : null }, [authorization.slice(7)]);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const cancel = () => {
          if (!res.writableEnded) { clientCancelled = true; controller.abort(); }
        };
        res.once("close", cancel);
        try {
          const start = performance.now();
          upstreamStarted = start;
          const response = await upstreamFetch(
            "https://api.typesafe.ai/v1/systemone",
            {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: {
                Authorization: authorization,
                "Content-Type": "application/json",
              },
              body: requestBody,
            },
          );
          const headersMs = Math.round(performance.now() - start);
          if (!response.ok) {
            // Do not reflect upstream bodies; they may contain sensitive request details.
            await response.body?.cancel();
            log?.write("api_error", { ...context, code: `HTTP_${response.status}`, upstreamMs: Math.round(performance.now() - start) });
            const messages = {
              401: "That API key was not accepted. Check it and try again.",
              403: "This API key does not have access to Jev.",
              402: "Your TypeSafe account needs credits to continue.",
              429: "TypeSafe is rate limiting requests. Wait a moment and reconnect.",
              529: "TypeSafe is busy right now. Try reconnecting shortly.",
            };
            return json(
              res,
              [401, 402, 403, 429].includes(response.status)
                ? response.status
                : 502,
              {
                error:
                  messages[response.status] ||
                  "TypeSafe is unavailable right now. Please try again.",
              },
            );
          }
          const result = await response.json();
          const a = result.answers?.action;
          if (!Object.keys(questions).every(id => validAnswer(result.answers?.[id]))) {
            log?.write("api_error", { ...context, code: "INVALID_RESPONSE", upstreamMs: Math.round(performance.now() - start) });
            return json(res, 502, {
              error: "TypeSafe returned an invalid decision. Please reconnect.",
            });
          }
          const serviceMs = Math.round(performance.now() - start);
          const arrivalChoices = state.arrivalCases?.map(c => ({ id: c.id, delayMs: c.delayMs,
            action: result.answers[c.id].choice, probabilities: result.answers[c.id].probabilities, confidence: result.answers[c.id].confidence }));
          log?.write("api_response", { ...context, action: a?.choice || "ARRIVAL_PLAN", probabilities: a?.probabilities, arrivalChoices,
            confidence: a?.confidence, model: result.model, usage: result.usage, headersMs,
            upstreamMs: serviceMs, serverTotalMs: Math.round(performance.now() - serverReceivedAt) }, [authorization.slice(7)]);
          return json(res, 200, {
            action: a?.choice,
            probabilities: a?.probabilities,
            confidence: a?.confidence,
            arrivalChoices,
            model: result.model,
            serviceMs,
            requestId: context.requestId,
            runId: state.runId,
            frameId: state.frameId,
          });
        } finally {
          clearTimeout(timeout);
          res.off("close", cancel);
        }
      } catch (error) {
        if (context) log?.write("api_error", { ...context,
          code: clientCancelled ? "CLIENT_DISCONNECTED" : error.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FAILED",
          upstreamMs: upstreamStarted === null ? null : Math.round(performance.now() - upstreamStarted) });
        if (res.destroyed) return;
        return json(res, error instanceof SyntaxError ? 400 : 502, {
          error:
            error instanceof SyntaxError
              ? "Send valid JSON game state."
              : "The connection to TypeSafe failed. Please try again.",
        });
      }
    }
    if (!["GET", "HEAD"].includes(req.method))
      return json(res, 405, { error: "Method not allowed." });
    let path;
    try {
      path = resolve(
        publicRoot,
        "." +
          decodeURIComponent(
            url.pathname === "/" ? "/index.html" : url.pathname,
          ),
      );
    } catch {
      return json(res, 400, { error: "Invalid path." });
    }
    if (!path.startsWith(publicRoot) || !contentTypes[extname(path)])
      return json(res, 404, { error: "Not found." });
    try {
      const data = await readFile(path);
      res.writeHead(200, {
        "Content-Type": contentTypes[extname(path)],
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      json(res, 404, { error: "Not found." });
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const log = process.env.JEV_LOG_ENABLED === "0" ? null : createJevLog({ directory: process.env.JEV_LOG_DIR || "logs/jev" });
  const sources = await Promise.all(["server.mjs", "public/engine.js", "public/autopilot.js", "public/app.js"].map(p => readFile(new URL(p, import.meta.url))));
  log?.write("build", { model: MODEL, sourceSha256: createHash("sha256").update(Buffer.concat(sources)).digest("hex") });
  const server = createApp({ log }).listen(port, host, () => {
    console.log(`Pipeworks is ready at http://${host}:${port}`);
    if (log) console.log(`[jev] Saving request, response, and flight logs to ${log.path}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
    server.close(); server.closeAllConnections();
    log?.write("log_stopped", { signal });
    await log?.flush();
    process.exit(0);
  });
}
