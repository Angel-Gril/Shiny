import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  createHmac,
  randomBytes,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { once } from "node:events";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { createPaymentServer, acquireLock } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import {
  convertAmount,
  minorUnits,
  money,
  signEpay,
  verifyEpay,
  parseForm,
  csrfToken,
} from "../src/core.mjs";
import { createProvider as nowpayments } from "../src/providers/nowpayments.mjs";
import { createProvider as lianlian } from "../src/providers/lianlian.mjs";
import { createProvider as paypal } from "../src/providers/paypal.mjs";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

function directory(t, beforeCleanup = () => {}) {
  const prefix = join(tmpdir(), "shiny-payment-test-");
  const dir = mkdtempSync(prefix);
  t.after(() => {
    beforeCleanup();
    assert.ok(resolve(dir).startsWith(resolve(prefix)));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function jsonResponse(value, status = 200, headers = {}) {
  return {
    status,
    headers: new Headers(headers),
    raw: Buffer.from(JSON.stringify(value)),
  };
}

async function fixture(t) {
  let store;
  const dir = directory(t, () => store?.close());
  const secret = randomBytes(32).toString("hex");
  const calls = [];
  const receipts = new Map();
  const events = [];
  const config = {
    origin: "https://pay.example.com",
    csrfSecret: secret,
    maxSourceMinor: 720000,
    newapi: {
      origin: "https://ru.example.com",
      merchantId: "ru",
      currency: "CNY",
      signType: "RSA",
      publicKey: rsa.publicKey,
      privateKey: rsa.privateKey,
      notifyURL: "https://ru.example.com/api/user/epay/notify",
      returnURL: "https://ru.example.com/wallet?show_history=true",
    },
    providers: {
      nowpayments: {
        enabled: true,
        environment: "live",
        currency: "USD",
        sourceUnitsPerSettlementUnit: "7.2",
        apiKeyEnv: "TEST",
        ipnSecretEnv: "TEST",
      },
      lianlian: {
        enabled: true,
        environment: "test",
        currency: "USD",
        sourceUnitsPerSettlementUnit: "7.2",
        signatureType: "HMAC-SHA256",
        apiKeyEnv: "TEST",
        apiSecretEnv: "API_SECRET",
        webhookSecretEnv: "TEST",
        storeId: "store-1",
        userId: "user-1",
        developerUserId: "developer-1",
        countryCode: "HK",
        checkoutHosts: ["checkout.example.com"],
        shippingProvider: "MERCHANT_APPROVED_DIGITAL",
        goodsURL: "https://ru.example.com/catalog/",
      },
      paypal: {
        enabled: true,
        environment: "sandbox",
        currency: "USD",
        sourceUnitsPerSettlementUnit: "7.2",
        clientIdEnv: "TEST",
        clientSecretEnv: "TEST",
        merchantId: "MERCHANT1",
        webhookId: "WEBHOOK1",
      },
    },
    adapters: {},
  };
  const state = {
    np: null,
    ll: null,
    pp: null,
    captures: 0,
    failNotify: false,
    corruptLianSignature: false,
    paypalSignature: "SUCCESS",
  };
  const apiSecret = randomBytes(32);
  const http = async (url, request = {}) => {
    calls.push({ url, request });
    const body =
      request.body &&
      JSON.parse(request.body.startsWith("{") ? request.body : "{}");
    if (url === config.newapi.notifyURL) {
      const params = Object.fromEntries(new URLSearchParams(request.body));
      verifyEpay(params, config.newapi);
      assert.equal(params.money, "72.00");
      assert.equal(params.trade_status, "TRADE_SUCCESS");
      receipts.set(params.out_trade_no, params.money);
      if (state.failNotify) throw Error("simulated lost acknowledgement");
      return { status: 200, raw: Buffer.from("success") };
    }
    if (url.endsWith("/v1/invoice")) {
      assert.equal(body.price_amount, 10);
      assert.equal(body.price_currency, "usd");
      state.np = {
        payment_id: "5001",
        invoice_id: "6001",
        order_id: body.order_id,
        price_amount: 10,
        price_currency: "usd",
        payment_status: "waiting",
        pay_amount: "10.01",
        actually_paid: "0",
      };
      return jsonResponse({
        id: "6001",
        order_id: body.order_id,
        price_amount: "10.00",
        price_currency: "usd",
        invoice_url: "https://nowpayments.io/payment/?iid=6001",
      });
    }
    if (url.endsWith("/payment/5001")) return jsonResponse(state.np);
    if (url.startsWith("https://api-test.lianlianpay.com/")) {
      const headers = request.headers;
      const expected = createHmac("sha256", apiSecret)
        .update(
          `${headers["LL-Timestamp"]}\n${headers["LL-Nonce"]}\n${request.body ?? ""}`,
        )
        .digest("base64");
      assert.equal(headers["LL-Signature"], expected);
      let result;
      if (url.endsWith("/apply")) {
        assert.equal(body.integration_mode, "CHECKOUT");
        assert.equal(body.txn_type, "PAYMENT");
        assert.equal(headers["Idempotency-Key"], body.merchant_order_no);
        state.ll = {
          pay_order_no: "LL1",
          merchant_order_no: body.merchant_order_no,
          store_id: "store-1",
          user_id: "user-1",
          amount: "10.00",
          currency: "USD",
          payment_status: "PROCESSING",
        };
        result = {
          ...state.ll,
          gateway_url: "https://checkout.example.com/session",
        };
      } else {
        assert.equal(headers["Idempotency-Key"], undefined);
        result = state.ll;
      }
      const response = jsonResponse(result);
      response.headers.set("ll-signature-type", "HMAC-SHA256");
      response.headers.set(
        "ll-signature",
        createHmac("sha256", state.corruptLianSignature ? secret : apiSecret)
          .update(response.raw)
          .digest("base64"),
      );
      return response;
    }
    if (url.endsWith("/v1/oauth2/token"))
      return jsonResponse({
        access_token: "fixture-runtime-access",
        expires_in: 3600,
      });
    if (url.endsWith("/verify-webhook-signature"))
      return jsonResponse({ verification_status: state.paypalSignature });
    if (url.endsWith("/v2/checkout/orders")) {
      state.pp = {
        id: "PP1",
        status: "CREATED",
        purchase_units: body.purchase_units,
      };
      return jsonResponse({
        ...state.pp,
        links: [
          {
            rel: "payer-action",
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PP1",
          },
        ],
      });
    }
    if (url.endsWith("/PP1/capture")) {
      state.captures++;
      state.pp.status = "COMPLETED";
      state.pp.purchase_units[0].payments = {
        captures: [
          {
            id: "CAP1",
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "10.00" },
          },
        ],
      };
      return jsonResponse(state.pp);
    }
    if (url.endsWith("/orders/PP1")) return jsonResponse(state.pp);
    throw Error("Unexpected boundary request");
  };
  const context = {
    origin: config.origin,
    http,
    secret: (name) =>
      name === "API_SECRET" ? apiSecret.toString("base64") : secret,
    publicKey: () => rsa.publicKey,
    privateKey: () => rsa.privateKey,
  };
  config.adapters = {
    nowpayments: nowpayments(config.providers.nowpayments, context),
    lianlian: lianlian(config.providers.lianlian, context),
    paypal: paypal(config.providers.paypal, context),
  };
  store = new Store(join(dir, "ledger.sqlite"));
  const engine = new Engine(config, store, http, (event) => events.push(event));
  function submission(provider = "nowpayments", extra = {}) {
    return signEpay(
      {
        out_trade_no: "USR1NOtest",
        type: provider,
        money: "72.00",
        name: "TUC10",
        device: "pc",
        notify_url: config.newapi.notifyURL,
        return_url: config.newapi.returnURL,
        ...extra,
      },
      config.newapi,
    );
  }
  function npEvent(status = "finished") {
    // Explicit documented sorted-key representation, independent of the adapter serializer.
    const data = {
      order_id: state.np.order_id,
      payment_id: "5001",
      payment_status: status,
    };
    const raw = Buffer.from(JSON.stringify(data));
    return [
      raw,
      {
        "x-nowpayments-sig": createHmac("sha512", secret)
          .update(raw)
          .digest("hex"),
      },
    ];
  }
  function llEvent(overrides = {}, timestamp = String(Date.now())) {
    const raw = Buffer.from(
      JSON.stringify({
        event_type: "acquiring.payment.succeeded",
        developer_user_id: "developer-1",
        data: state.ll,
        ...overrides,
      }),
    );
    const eventId = "evt_fixture";
    const signature = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}\n${eventId}\n`), raw]))
      .digest("base64");
    return [
      raw,
      {
        "ll-timestamp": timestamp,
        "ll-event-id": eventId,
        "ll-signature-type": "HMAC-SHA256",
        "ll-signature": signature,
      },
    ];
  }
  return {
    dir,
    config,
    context,
    state,
    store,
    engine,
    calls,
    receipts,
    events,
    submission,
    npEvent,
    llEvent,
  };
}

test("fiat boundaries reject rounding, overflow and invalid rates; conversion rounds once", () => {
  for (const value of [
    "-1",
    "0",
    "1.001",
    "1e6",
    "NaN",
    "1000000.01",
    " 10",
    "01",
  ])
    assert.throws(() => minorUnits(value));
  assert.equal(convertAmount(7200, "7.2"), 1000);
  assert.equal(convertAmount(100, "3"), 33);
  assert.equal(convertAmount(101, "2"), 51);
  assert.equal(money(1), "0.01");
  for (const rate of ["0", "-1", "Infinity", "1e2", "0.0000001"])
    assert.throws(() => convertAmount(100, rate));
});

test("Epay RSA rejects tampering, stale signatures, ambiguous fields and duplicate parameters", async (t) => {
  const f = await fixture(t);
  const params = f.submission();
  assert.doesNotThrow(() => verifyEpay(params, f.config.newapi));
  assert.throws(() =>
    verifyEpay({ ...params, money: "1.00" }, f.config.newapi),
  );
  assert.throws(() => verifyEpay(params, f.config.newapi, Date.now() + 301000));
  assert.throws(() =>
    f.engine.submit(
      f.submission("nowpayments", {
        notify_url: "https://attacker.example/notify",
      }),
    ),
  );
  assert.throws(() => f.submission("nowpayments", { name: "x&money=1" }));
  assert.throws(() => parseForm(Buffer.from("money=10&money=1")));
  const md5 = {
    merchantId: "legacy",
    signType: "MD5",
    secret: randomBytes(32).toString("hex"),
  };
  const signed = signEpay({ money: "10.00", out_trade_no: "legacy1" }, md5);
  assert.doesNotThrow(() => verifyEpay(signed, md5));
  assert.throws(() => verifyEpay({ ...signed, pid: "other" }, md5));
});

test("signed order replays retain the original exchange quote and create one invoice", async (t) => {
  const f = await fixture(t);
  const order = f.engine.submit(f.submission());
  f.config.providers.nowpayments.sourceUnitsPerSettlementUnit = "9";
  assert.equal(f.engine.submit(f.submission()).target_minor, 1000);
  assert.throws(
    () => f.engine.submit(f.submission("nowpayments", { money: "71.00" })),
    /order_conflict/,
  );
  await Promise.all([f.engine.start(order.id), f.engine.start(order.id)]);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/invoice")).length, 1);
  assert.equal(f.store.get(order.id).state, "pending");
});

test("NOWPayments requires verified finished full payment matching invoice, currency and order", async (t) => {
  const f = await fixture(t);
  const order = f.engine.submit(f.submission());
  await f.engine.start(order.id);
  const [raw, headers] = f.npEvent();
  await assert.rejects(
    f.engine.webhook("nowpayments", raw, {
      ...headers,
      "x-nowpayments-sig": "00",
    }),
    /signature/,
  );
  const original = { ...f.state.np };
  for (const patch of [
    { invoice_id: "other" },
    { order_id: "other" },
    { price_currency: "eur" },
    { price_amount: 1 },
  ]) {
    Object.assign(f.state.np, original, patch);
    await assert.rejects(
      f.engine.webhook("nowpayments", raw, headers),
      /mismatch/,
    );
    assert.equal(f.receipts.size, 0);
  }
  for (const patch of [
    { payment_status: "confirmed", actually_paid: "10.01" },
    { payment_status: "partially_paid", actually_paid: "9" },
    { payment_status: "finished", actually_paid: "10.00" },
  ]) {
    Object.assign(f.state.np, original, patch);
    await f.engine.webhook("nowpayments", raw, headers);
    assert.equal(f.receipts.size, 0);
  }
  Object.assign(f.state.np, original, {
    payment_status: "finished",
    actually_paid: "10.02",
  });
  await Promise.all([
    f.engine.webhook("nowpayments", raw, headers),
    f.engine.webhook("nowpayments", raw, headers),
  ]);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.store.get(order.id).state, "delivered");
});

test("paid callback retry survives restart and does not turn a lost acknowledgement into another credit", async (t) => {
  const f = await fixture(t);
  const order = f.engine.submit(f.submission());
  await f.engine.start(order.id);
  Object.assign(f.state.np, {
    payment_status: "finished",
    actually_paid: "10.01",
  });
  f.state.failNotify = true;
  await f.engine.webhook("nowpayments", ...f.npEvent());
  assert.equal(f.store.get(order.id).state, "paid");
  assert.equal(f.receipts.size, 1);
  // Reopening an existing SQLite DB twice also exercises startup idempotency and data preservation.
  for (let i = 0; i < 2; i++) {
    const reopened = new Store(join(f.dir, "ledger.sqlite"));
    assert.equal(reopened.get(order.id).state, "paid");
    reopened.close();
  }
  f.state.failNotify = false;
  f.store.db
    .prepare("UPDATE orders SET next_notify_at=0 WHERE id=?")
    .run(order.id);
  const restarted = new Engine(f.config, f.store, f.context.http, (event) =>
    f.events.push(event),
  );
  await restarted.tick();
  assert.equal(f.store.get(order.id).state, "delivered");
  assert.equal(f.receipts.size, 1);
  assert.equal(
    f.calls.filter((c) => c.url === f.config.newapi.notifyURL).length,
    2,
  );
});

test("LianLian verifies raw signatures and queries only acquiring success with the correct merchant", async (t) => {
  const f = await fixture(t);
  const order = f.engine.submit(f.submission("lianlian"));
  await f.engine.start(order.id);
  await assert.rejects(
    f.engine.webhook("lianlian", ...f.llEvent({}, String(Date.now() - 301000))),
    /expired_signature/,
  );
  const [raw, headers] = f.llEvent();
  await assert.rejects(
    f.engine.webhook(
      "lianlian",
      Buffer.concat([raw, Buffer.from(" ")]),
      headers,
    ),
    /signature/,
  );
  await assert.rejects(
    f.engine.webhook("lianlian", ...f.llEvent({ developer_user_id: "wrong" })),
    /merchant/,
  );
  await f.engine.webhook(
    "lianlian",
    ...f.llEvent({ event_type: "documents.audit.approved" }),
  );
  assert.equal(f.receipts.size, 0);
  await f.engine.webhook("lianlian", ...f.llEvent());
  assert.equal(f.receipts.size, 0);
  f.state.ll.payment_status = "SUCCESS";
  f.state.corruptLianSignature = true;
  await assert.rejects(
    f.engine.webhook("lianlian", ...f.llEvent()),
    /response_signature/,
  );
  f.state.corruptLianSignature = false;
  await f.engine.webhook("lianlian", ...f.llEvent());
  assert.equal(f.receipts.size, 1);
});

test("LianLian RSA request, response and webhook signatures follow SHA256withRSA", async (t) => {
  const f = await fixture(t);
  const cfg = { ...f.config.providers.lianlian, signatureType: "RSA" };
  const order = f.engine.submit(f.submission("lianlian"));
  const provider = lianlian(cfg, {
    ...f.context,
    http: async (url, request) => {
      const h = request.headers;
      assert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(
            `${h["LL-Timestamp"]}\n${h["LL-Nonce"]}\n${request.body}`,
          ),
          rsa.publicKey,
          Buffer.from(h["LL-Signature"], "base64"),
        ),
      );
      const response = jsonResponse({
        pay_order_no: "L1",
        merchant_order_no: order.id,
        amount: "10.00",
        currency: "USD",
        gateway_url: "https://checkout.example.com/pay",
      });
      response.headers.set("ll-signature-type", "RSA");
      response.headers.set(
        "ll-signature",
        sign("RSA-SHA256", response.raw, rsa.privateKey).toString("base64"),
      );
      return response;
    },
  });
  assert.equal((await provider.create(order)).remoteId, "L1");
  const timestamp = String(Date.now());
  const eventId = "evt_rsa";
  const raw = Buffer.from(
    JSON.stringify({
      event_type: "acquiring.payment.succeeded",
      developer_user_id: "developer-1",
      data: {
        user_id: "user-1",
        store_id: "store-1",
        merchant_order_no: order.id,
        pay_order_no: "L1",
      },
    }),
  );
  const signature = sign(
    "RSA-SHA256",
    Buffer.concat([Buffer.from(`${timestamp}\n${eventId}\n`), raw]),
    rsa.privateKey,
  ).toString("base64");
  assert.equal(
    (
      await provider.webhook(raw, {
        "ll-timestamp": timestamp,
        "ll-event-id": eventId,
        "ll-signature-type": "RSA",
        "ll-signature": signature,
      })
    ).reference,
    order.id,
  );
});

test("PayPal approves then captures once; wrong payee and incomplete capture cannot credit", async (t) => {
  const f = await fixture(t);
  const order = f.engine.submit(f.submission("paypal"));
  await f.engine.start(order.id);
  f.state.pp.status = "APPROVED";
  f.state.pp.purchase_units[0].payee.merchant_id = "WRONG";
  await assert.rejects(f.engine.reconcileUnlocked(order.id), /merchant/);
  assert.equal(f.state.captures, 0);
  f.state.pp.purchase_units[0].payee.merchant_id = "MERCHANT1";
  await f.engine.reconcileUnlocked(order.id);
  await f.engine.reconcileUnlocked(order.id);
  assert.equal(f.state.captures, 1);
  assert.equal(f.receipts.size, 1);
  const capture = f.state.pp.purchase_units[0].payments.captures[0];
  capture.status = "PENDING";
  assert.equal(
    (await f.config.adapters.paypal.query(f.store.get(order.id))).paid,
    false,
  );
  const raw = Buffer.from(
    JSON.stringify({
      id: "evt_pp",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource: { id: "PP1" },
    }),
  );
  const headers = Object.fromEntries(
    [
      "auth-algo",
      "cert-url",
      "transmission-id",
      "transmission-sig",
      "transmission-time",
    ].map((k) => [`paypal-${k}`, "fixture"]),
  );
  f.state.paypalSignature = "FAILURE";
  await assert.rejects(f.engine.webhook("paypal", raw, headers), /signature/);
  f.state.paypalSignature = "SUCCESS";
  await f.engine.webhook("paypal", raw, headers);
  assert.equal(f.receipts.size, 1);
});

test("uncertain invoice creation is not retried; verified recovery uses the original order", async (t) => {
  const f = await fixture(t);
  const order = f.engine.submit(f.submission());
  f.store.claimCreation(order.id);
  const invoice = await f.config.adapters.nowpayments.create(order);
  new Engine(f.config, f.store, f.context.http, () => {}); // interrupted after provider accepted
  assert.equal(f.store.get(order.id).state, "creation_unknown");
  await assert.rejects(f.engine.start(order.id), /not_ready/);
  await assert.rejects(f.engine.recover(order.id, "wrong", "5001"), /mismatch/);
  await f.engine.recover(order.id, invoice.remoteId, "5001");
  assert.equal(f.store.get(order.id).state, "pending");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/invoice")).length, 1);
});

test("lost first IPN can be reconciled by linking a verified payment ID", async (t) => {
  const f = await fixture(t);
  const order = f.engine.submit(f.submission());
  await f.engine.start(order.id);
  Object.assign(f.state.np, {
    payment_status: "finished",
    actually_paid: "10.01",
  });
  await f.engine.reconcileUnlocked(order.id);
  assert.equal(f.receipts.size, 0);
  f.state.np.invoice_id = "wrong";
  await assert.rejects(f.engine.linkPayment(order.id, "5001"), /mismatch/);
  assert.equal(f.store.get(order.id).payment_id, null);
  f.state.np.invoice_id = "6001";
  await f.engine.linkPayment(order.id, "5001");
  assert.equal(f.receipts.size, 1);
  assert.equal(f.store.get(order.id).state, "delivered");
});

test("late verified payment is accepted after checkout expiry; site and environment cannot share a ledger", async (t) => {
  const f = await fixture(t);
  const order = f.engine.submit(f.submission());
  await f.engine.start(order.id);
  f.store.db.prepare("UPDATE orders SET expires_at=0 WHERE id=?").run(order.id);
  await assert.rejects(f.engine.start(order.id), /expired/);
  Object.assign(f.state.np, {
    payment_status: "finished",
    actually_paid: "10.01",
  });
  await f.engine.webhook("nowpayments", ...f.npEvent());
  assert.equal(f.receipts.size, 1);
  assert.throws(
    () =>
      new Engine(
        {
          ...f.config,
          newapi: { ...f.config.newapi, origin: "https://main.example.com" },
        },
        f.store,
      ),
    /identity/,
  );
  f.config.providers.paypal.environment = "live";
  assert.throws(() => new Engine(f.config, f.store), /identity/);
});

test("HTTP checkout uses Russian by default, requires CSRF, and return URL cannot claim payment", async (t) => {
  const f = await fixture(t);
  const server = createPaymentServer(f.config, f.engine);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolveClose) => {
        server.close(resolveClose);
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/pay/submit`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: f.config.newapi.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(f.submission()),
  });
  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  const id = location.split("/").at(-1);
  const page = await fetch(base + location + "?token=forged&status=COMPLETED");
  assert.match(await page.text(), /<html lang="ru">/);
  assert.equal(f.receipts.size, 0);
  assert.equal(page.headers.get("referrer-policy"), "strict-origin");
  const blocked = await fetch(base + location + "/start", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "csrf=forged",
  });
  assert.equal(blocked.status, 403);
  const started = await fetch(base + location + "/start", {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: f.config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrf: csrfToken(f.store.get(id), f.config.csrfSecret),
    }),
  });
  assert.equal(started.status, 303);
  assert.match(started.headers.get("location"), /^https:\/\/nowpayments.io\//);
  const oversized = await fetch(`${base}/webhooks/nowpayments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "a".repeat(65537),
  });
  assert.equal(oversized.status, 413);
  assert.ok(!JSON.stringify(f.events).includes(f.config.csrfSecret));
});

test("configuration enables only selected adapters and rejects missing credentials and a second process", async (t) => {
  const dir = directory(t);
  const filename = join(dir, "config.json");
  const config = JSON.parse(
    readFileSync(new URL("../config.example.json", import.meta.url)),
  );
  config.newapi.signType = "MD5";
  writeFileSync(filename, JSON.stringify(config));
  const secret = randomBytes(32).toString("hex");
  const env = { PAYMENT_EPAY_SECRET: secret, PAYMENT_CSRF_SECRET: secret };
  assert.deepEqual(Object.keys((await loadConfig(filename, env)).adapters), []);
  config.providers.nowpayments.enabled = true;
  writeFileSync(filename, JSON.stringify(config));
  await assert.rejects(loadConfig(filename, env), /mixed_payment_environments/);
  config.environment = "live";
  writeFileSync(filename, JSON.stringify(config));
  await assert.rejects(loadConfig(filename, env), /secret/);
  env.NOWPAYMENTS_API_KEY = secret;
  env.NOWPAYMENTS_IPN_SECRET = secret;
  assert.deepEqual(Object.keys((await loadConfig(filename, env)).adapters), [
    "nowpayments",
  ]);
  const release = acquireLock(join(dir, "ledger.sqlite"));
  assert.throws(() => acquireLock(join(dir, "ledger.sqlite")), /ledger_in_use/);
  release();
});
