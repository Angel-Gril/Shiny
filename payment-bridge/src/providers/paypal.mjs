import {
  checkoutURL,
  minorUnits,
  money,
  requireValue,
  responseJSON,
} from "../core.mjs";

export function createProvider(config, context) {
  requireValue(
    ["sandbox", "live"].includes(config.environment) &&
      config.merchantId &&
      config.webhookId,
    "invalid_paypal_config",
  );
  const clientId = context.secret(config.clientIdEnv);
  const clientSecret = context.secret(config.clientSecretEnv);
  const base =
    config.environment === "sandbox"
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";
  let token;
  let tokenExpiry = 0;
  async function api(path, body, requestId) {
    if (!token || Date.now() >= tokenExpiry) {
      const auth = responseJSON(
        await context.http(`${base}/v1/oauth2/token`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
        }),
      );
      requireValue(
        auth.access_token && Number(auth.expires_in) > 60,
        "invalid_provider_token",
        502,
      );
      token = auth.access_token;
      tokenExpiry = Date.now() + (Number(auth.expires_in) - 30) * 1000;
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    return responseJSON(
      await context.http(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }
  function purchaseUnit(result, order) {
    requireValue(
      result.id === order.remote_id && result.purchase_units?.length === 1,
      "payment_identity_mismatch",
      409,
    );
    const unit = result.purchase_units[0];
    requireValue(
      unit.reference_id === order.id &&
        unit.custom_id === order.id &&
        unit.payee?.merchant_id === config.merchantId,
      "wrong_payment_merchant",
      409,
    );
    requireValue(
      unit.amount?.currency_code === order.currency &&
        minorUnits(unit.amount.value) === order.target_minor,
      "payment_amount_mismatch",
      409,
    );
    return unit;
  }
  return {
    async create(order) {
      const result = await api(
        "/v2/checkout/orders",
        {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: order.id,
              custom_id: order.id,
              invoice_id: order.id,
              amount: {
                currency_code: order.currency,
                value: money(order.target_minor),
              },
              payee: { merchant_id: config.merchantId },
              description: "Shiny API credit",
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                shipping_preference: "NO_SHIPPING",
                user_action: "PAY_NOW",
                return_url: `${context.origin}/checkout/${order.id}`,
                cancel_url: `${context.origin}/checkout/${order.id}`,
              },
            },
          },
        },
        order.id,
      );
      requireValue(
        typeof result.id === "string" && /^[A-Z0-9]{1,40}$/.test(result.id),
        "invalid_invoice",
        502,
      );
      const approval = result.links?.find((link) =>
        ["payer-action", "approve"].includes(link.rel),
      );
      const hosts =
        config.environment === "sandbox"
          ? ["www.sandbox.paypal.com", "sandbox.paypal.com"]
          : ["www.paypal.com", "paypal.com"];
      return { remoteId: result.id, url: checkoutURL(approval?.href, hosts) };
    },
    async webhook(raw, headers) {
      const event = JSON.parse(raw.toString("utf8"));
      const fields = [
        "auth-algo",
        "cert-url",
        "transmission-id",
        "transmission-sig",
        "transmission-time",
      ];
      requireValue(
        fields.every((key) => typeof headers[`paypal-${key}`] === "string"),
        "missing_webhook_signature",
        401,
      );
      const payload = Object.fromEntries(
        fields.map((key) => [
          key.replaceAll("-", "_"),
          headers[`paypal-${key}`],
        ]),
      );
      const verified = await api("/v1/notifications/verify-webhook-signature", {
        ...payload,
        webhook_id: config.webhookId,
        webhook_event: event,
      });
      requireValue(
        verified.verification_status === "SUCCESS",
        "invalid_webhook_signature",
        401,
      );
      if (
        !["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED"].includes(
          event.event_type,
        )
      )
        return null;
      const resource = event.resource;
      const remoteId =
        event.event_type === "CHECKOUT.ORDER.APPROVED"
          ? resource?.id
          : resource?.supplementary_data?.related_ids?.order_id;
      requireValue(
        typeof remoteId === "string" && typeof event.id === "string",
        "invalid_payment_id",
      );
      return { remoteId, eventId: event.id };
    },
    async query(order) {
      let result = await api(
        `/v2/checkout/orders/${encodeURIComponent(order.remote_id)}`,
      );
      let unit = purchaseUnit(result, order);
      // A verified APPROVED order is captured server-side. Browser return params
      // never authorize balance credit, and repeated captures share one key.
      if (result.status === "APPROVED") {
        await api(
          `/v2/checkout/orders/${encodeURIComponent(order.remote_id)}/capture`,
          {},
          `${order.id}-cap`,
        );
        result = await api(
          `/v2/checkout/orders/${encodeURIComponent(order.remote_id)}`,
        );
        unit = purchaseUnit(result, order);
      }
      const captures = unit.payments?.captures ?? [];
      const capture = captures[0];
      const paid =
        result.status === "COMPLETED" &&
        captures.length === 1 &&
        capture.status === "COMPLETED" &&
        capture.amount?.currency_code === order.currency &&
        minorUnits(capture.amount.value) === order.target_minor;
      return {
        reference: unit.reference_id,
        remoteId: result.id,
        currency: unit.amount.currency_code,
        amount: unit.amount.value,
        paid,
      };
    },
  };
}
