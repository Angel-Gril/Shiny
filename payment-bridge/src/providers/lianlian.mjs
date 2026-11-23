import { createHmac, randomUUID, sign, verify } from "node:crypto";
import {
  checkoutURL,
  equalSignature,
  money,
  requireValue,
  responseJSON,
} from "../core.mjs";

// LianLian Open Platform v1, guide version 1.0.0 (2026-09-09).
// This adapter is for acquiring CHECKOUT, not receiving accounts or payouts.
export function createProvider(config, context) {
  requireValue(
    ["test", "live"].includes(config.environment) &&
      ["HMAC-SHA256", "RSA"].includes(config.signatureType),
    "invalid_lianlian_config",
  );
  requireValue(
    config.storeId &&
      config.userId &&
      config.developerUserId &&
      /^[A-Z]{2}$/.test(config.countryCode),
    "missing_lianlian_merchant",
  );
  requireValue(
    config.checkoutHosts?.length > 0 &&
      config.shippingProvider &&
      config.goodsURL,
    "missing_lianlian_product_config",
  );
  const apiKey = context.secret(config.apiKeyEnv);
  const rsa = config.signatureType === "RSA";
  const privateKey = rsa ? context.privateKey(config.privateKeyFile) : null;
  const publicKey = rsa
    ? context.publicKey(config.platformPublicKeyFile)
    : null;
  const apiSecret = rsa
    ? null
    : Buffer.from(context.secret(config.apiSecretEnv), "base64");
  requireValue(rsa || apiSecret.length >= 32, "invalid_lianlian_api_secret");
  const webhookSecret = rsa ? null : context.secret(config.webhookSecretEnv);
  const base =
    config.environment === "test"
      ? "https://api-test.lianlianpay.com"
      : "https://api.lianlianpay.com";
  function validSignature(raw, signature, webhook = false) {
    if (rsa)
      return verify(
        "RSA-SHA256",
        raw,
        publicKey,
        Buffer.from(signature ?? "", "base64"),
      );
    return equalSignature(
      createHmac("sha256", webhook ? webhookSecret : apiSecret)
        .update(raw)
        .digest(),
      signature,
      "base64",
    );
  }
  async function api(path, body, idempotencyKey) {
    const raw = body ? JSON.stringify(body) : "";
    const timestamp = String(Date.now());
    const nonce = randomUUID().replaceAll("-", "");
    const content = Buffer.from(`${timestamp}\n${nonce}\n${raw}`);
    const signature = rsa
      ? sign("RSA-SHA256", content, privateKey)
      : createHmac("sha256", apiSecret).update(content).digest();
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "LL-Timestamp": timestamp,
      "LL-Nonce": nonce,
      "LL-Signature-Type": config.signatureType,
      "LL-Signature": signature.toString("base64"),
    };
    if (config.onBehalfOf) headers["LL-On-Behalf-Of"] = config.onBehalfOf;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await context.http(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: raw } : {}),
    });
    requireValue(
      response.headers.get("ll-signature-type") === config.signatureType &&
        validSignature(response.raw, response.headers.get("ll-signature")),
      "invalid_provider_response_signature",
      502,
    );
    return responseJSON(response);
  }
  return {
    async create(order) {
      const result = await api(
        "/api/v1/acquiring/payments/apply",
        {
          store_id: config.storeId,
          merchant_order_no: order.id,
          amount: money(order.target_minor),
          currency: order.currency,
          country_code: config.countryCode,
          txn_type: "PAYMENT",
          integration_mode: "CHECKOUT",
          pay_expire: 30,
          return_url: `${context.origin}/checkout/${order.id}`,
          cancel_url: `${context.origin}/checkout/${order.id}`,
          order_info: {
            order_desc: "Shiny API credit",
            order_time: Math.floor(order.created_at / 1000),
            goods_info: [
              {
                product_id: "api-credit",
                goods_name: "Shiny API credit",
                sku: "api-credit",
                price: money(order.target_minor),
                quantity: 1,
                goods_url: config.goodsURL,
                shipping_provider: config.shippingProvider,
              },
            ],
          },
        },
        order.id,
      );
      requireValue(
        typeof result.pay_order_no === "string" &&
          result.pay_order_no &&
          result.merchant_order_no === order.id &&
          result.amount === money(order.target_minor) &&
          result.currency === order.currency,
        "invalid_invoice",
        502,
      );
      return {
        remoteId: result.pay_order_no,
        url: checkoutURL(result.gateway_url, config.checkoutHosts),
      };
    },
    async webhook(raw, headers) {
      const timestamp = headers["ll-timestamp"];
      const eventId = headers["ll-event-id"];
      requireValue(
        /^\d{13}$/.test(timestamp ?? "") &&
          Math.abs(Date.now() - Number(timestamp)) <= 300000,
        "expired_signature",
        401,
      );
      requireValue(
        /^evt_[A-Za-z0-9_-]{1,120}$/.test(eventId ?? ""),
        "invalid_event_id",
      );
      requireValue(
        headers["ll-signature-type"] === config.signatureType &&
          validSignature(
            Buffer.concat([Buffer.from(`${timestamp}\n${eventId}\n`), raw]),
            headers["ll-signature"],
            true,
          ),
        "invalid_webhook_signature",
        401,
      );
      const event = JSON.parse(raw.toString("utf8"));
      if (event.event_type !== "acquiring.payment.succeeded") return null;
      requireValue(
        event.developer_user_id === config.developerUserId &&
          event.data?.user_id === config.userId &&
          event.data?.store_id === config.storeId,
        "wrong_webhook_merchant",
        409,
      );
      return {
        reference: event.data.merchant_order_no,
        remoteId: event.data.pay_order_no,
        eventId,
      };
    },
    async query(order) {
      const result = await api(
        `/api/v1/acquiring/payments/${encodeURIComponent(order.remote_id)}`,
      );
      requireValue(
        result.user_id === config.userId && result.store_id === config.storeId,
        "wrong_payment_merchant",
        409,
      );
      return {
        reference: result.merchant_order_no,
        remoteId: result.pay_order_no,
        currency: result.currency,
        amount: result.amount,
        paid: result.payment_status === "SUCCESS",
      };
    },
  };
}
