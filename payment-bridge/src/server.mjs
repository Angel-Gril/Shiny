import { createServer } from "node:http";
import {
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { Engine } from "./engine.mjs";
import {
  csrfToken,
  equalSignature,
  parseForm,
  PaymentError,
  readLimited,
  requireValue,
} from "./core.mjs";
import { renderPage, renderRedirect } from "./page.mjs";

const css = readFileSync(new URL("./style.css", import.meta.url));

// One writer/worker per SQLite ledger. Multiple sites use separate instances.
export function acquireLock(database) {
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const path = database + ".lock";
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(path, "utf8"));
    requireValue(Number.isInteger(pid) && pid > 0, "invalid_ledger_lock");
    try {
      process.kill(pid, 0);
      throw new PaymentError("ledger_in_use");
    } catch (probe) {
      if (probe.code !== "ESRCH") throw probe;
    }
    unlinkSync(path);
    descriptor = openSync(path, "wx", 0o600);
  }
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
  return () => unlinkSync(path);
}

export function createPaymentServer(config, engine) {
  let active = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "strict-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    let url;
    try {
      url = new URL(request.url, config.origin);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const language = url.searchParams.get("lang") === "en" ? "en" : "ru";
    const isWebhook = url.pathname.startsWith("/webhooks/");
    const redirect = (location) => {
      response.writeHead(303, { Location: location });
      response.end();
    };
    const html = (order, code, status = 200) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(renderPage(order, config, language, code));
    };
    active++;
    try {
      requireValue(active <= 32, "too_many_requests", 503);
      if (request.method === "GET" && url.pathname === "/healthz") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      if (request.method === "GET" && url.pathname === "/style.css") {
        response.writeHead(200, { "Content-Type": "text/css" });
        response.end(css);
        return;
      }
      if (
        request.method === "POST" &&
        ["/submit.php", "/api/pay/submit"].includes(url.pathname)
      ) {
        requireValue(
          !request.headers.origin ||
            request.headers.origin === config.newapi.origin,
          "invalid_origin",
          403,
        );
        requireValue(
          request.headers["content-type"]?.split(";")[0] ===
            "application/x-www-form-urlencoded",
          "invalid_content_type",
          415,
        );
        const order = engine.submit(
          parseForm(await readLimited(request, 16384)),
        );
        redirect(`/checkout/${order.id}`);
        return;
      }
      const webhook = /^\/webhooks\/(nowpayments|lianlian|paypal)$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && webhook) {
        requireValue(
          request.headers["content-type"]?.split(";")[0] === "application/json",
          "invalid_content_type",
          415,
        );
        await engine.webhook(
          webhook[1],
          await readLimited(request),
          request.headers,
        );
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
        return;
      }
      const match =
        /^\/checkout\/([A-Za-z0-9_-]{32})(?:\/(start|check))?$/.exec(
          url.pathname,
        );
      if (match) {
        const order = engine.store.get(match[1]);
        requireValue(
          order && Date.now() - order.created_at < 7 * 86400000,
          "checkout_not_found",
          404,
        );
        if (request.method === "GET" && !match[2]) {
          html(order);
          return;
        }
        if (request.method === "POST" && match[2]) {
          requireValue(
            request.headers.origin === config.origin,
            "invalid_origin",
            403,
          );
          requireValue(
            request.headers["content-type"]?.split(";")[0] ===
              "application/x-www-form-urlencoded",
            "invalid_content_type",
            415,
          );
          const form = parseForm(await readLimited(request, 4096));
          requireValue(
            equalSignature(
              Buffer.from(csrfToken(order, config.csrfSecret), "hex"),
              form.csrf,
              "hex",
            ),
            "invalid_csrf",
            403,
          );
          if (match[2] === "start") {
            const checkout = await engine.start(order.id);
            response.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
            });
            response.end(renderRedirect(checkout, language));
            return;
          }
          // Throttle customer refreshes independently of webhook handling.
          if (order.next_poll_at <= Date.now()) {
            engine.store.deferPoll(order.id);
            await engine.exclusive(order.id, () =>
              engine.reconcileUnlocked(order.id),
            );
          }
          redirect(`/checkout/${order.id}?lang=${language}`);
          return;
        }
      }
      throw new PaymentError("not_found", 404);
    } catch (error) {
      const code =
        error instanceof PaymentError ? error.code : "payment_unavailable";
      const status = error instanceof PaymentError ? error.status : 502;
      engine.audit({ event: "request_failed", code, webhook: isWebhook });
      // Never log request URLs, signatures, provider bodies, or credential errors.
      if (isWebhook) {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end('{"ok":false}');
      } else html(null, code, status);
    } finally {
      active--;
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.maxConnections = 128;
  return server;
}

async function main() {
  process.umask(0o077);
  const config = await loadConfig(
    process.env.PAYMENT_CONFIG ?? resolve("config.json"),
  );
  const releaseLock = acquireLock(config.database);
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const server = createPaymentServer(config, engine);
  let task = null;
  const timer = setInterval(() => {
    if (task) return;
    task = engine
      .tick()
      .catch(() => engine.audit({ event: "worker_failed" }))
      .finally(() => {
        task = null;
      });
  }, 15000);
  server.listen(config.port, config.host, () =>
    engine.audit({
      event: "payment_bridge_started",
      providers: Object.keys(config.adapters),
    }),
  );
  async function shutdown() {
    clearInterval(timer);
    server.close(async () => {
      await task;
      store.close();
      releaseLock();
      process.exit(0);
    });
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      error instanceof PaymentError
        ? error.code
        : "payment_bridge_start_failed",
    );
    process.exitCode = 1;
  });
}
