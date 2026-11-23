import { createHmac } from "node:crypto";
import {
  canonicalJSON,
  checkoutURL,
  equalSignature,
  money,
  requireValue,
  responseJSON,
} from "../core.mjs";

function cryptoAmount(value) {
  const text = String(value);
  requireValue(
    /^\d{1,20}(\.\d{1,18})?$/.test(text),
    "invalid_crypto_amount",
    502,
  );
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}

export function createProvider(config, context) {
  const apiKey = context.secret(config.apiKeyEnv);
  const ipnSecret = context.secret(config.ipnSecretEnv);
  requireValue(
    config.currency === "USD" && config.environment === "live",
    "invalid_nowpayments_config",
  );
  const api = async (path, body) =>
    responseJSON(
      await context.http(`https://api.nowpayments.io/v1${path}`, {
        method: body ? "POST" : "GET",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return {
    async create(order) {
      const result = await api("/invoice", {
        price_amount: Number(money(order.target_minor)),
        price_currency: "usd",
        order_id: order.id,
        order_description: "Shiny API credit",
        ipn_callback_url: `${context.origin}/webhooks/nowpayments`,
        success_url: `${context.origin}/checkout/${order.id}`,
        cancel_url: `${context.origin}/checkout/${order.id}`,
        partially_paid_url: `${context.origin}/checkout/${order.id}`,
        is_fixed_rate: true,
        is_fee_paid_by_user: false,
        ...(config.payCurrency ? { pay_currency: config.payCurrency } : {}),
      });
      requireValue(
        /^\d{1,30}$/.test(String(result.id)) && result.order_id === order.id,
        "invalid_invoice",
        502,
      );
      requireValue(
        String(result.price_currency).toUpperCase() === order.currency &&
          Number(result.price_amount) === order.target_minor / 100,
        "invoice_amount_mismatch",
        502,
      );
      return {
        remoteId: String(result.id),
        url: checkoutURL(result.invoice_url, ["nowpayments.io"]),
      };
    },
    async webhook(raw, headers) {
      const data = JSON.parse(raw.toString("utf8"));
      const expected = createHmac("sha512", ipnSecret)
        .update(canonicalJSON(data))
        .digest();
      requireValue(
        equalSignature(expected, headers["x-nowpayments-sig"], "hex"),
        "invalid_webhook_signature",
        401,
      );
      requireValue(
        /^\d{1,30}$/.test(String(data.payment_id)),
        "invalid_payment_id",
      );
      return {
        reference: data.order_id,
        paymentId: String(data.payment_id),
        eventId: `${data.payment_id}:${data.payment_status}`,
      };
    },
    async query(order, event) {
      const paymentId = event?.paymentId ?? order.payment_id;
      if (!paymentId) return null; // invoice ID is NOT a payment ID
      requireValue(/^\d{1,30}$/.test(paymentId), "invalid_payment_id");
      const result = await api(`/payment/${paymentId}`);
      requireValue(
        String(result.payment_id) === paymentId,
        "payment_identity_mismatch",
        409,
      );
      return {
        reference: result.order_id,
        remoteId: String(result.invoice_id),
        amount: result.price_amount,
        currency: String(result.price_currency).toUpperCase(),
        paid:
          result.payment_status === "finished" &&
          cryptoAmount(result.pay_amount) > 0n &&
          cryptoAmount(result.actually_paid) >= cryptoAmount(result.pay_amount),
      };
    },
  };
}
