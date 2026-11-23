import {
  createHash,
  createHmac,
  timingSafeEqual,
  sign,
  verify,
} from "node:crypto";

export class PaymentError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function requireValue(condition, code, status = 400) {
  if (!condition) throw new PaymentError(code, status);
}

// Only two-decimal fiat currencies are supported. Never round an incoming amount.
export function minorUnits(value) {
  const text = String(value);
  requireValue(/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(text), "invalid_amount");
  const [whole, fraction = ""] = text.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  requireValue(result > 0n && result <= 100000000n, "amount_out_of_range");
  return Number(result);
}

export function money(minor) {
  requireValue(Number.isSafeInteger(minor) && minor > 0, "invalid_amount");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

// Rate = source currency units per one settlement currency unit, six decimals max.
export function convertAmount(sourceMinor, rate) {
  requireValue(
    /^[1-9]\d{0,5}(\.\d{1,6})?$|^0\.\d{1,6}$/.test(rate),
    "invalid_rate",
  );
  const [whole, fraction = ""] = rate.split(".");
  const denominator =
    BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  requireValue(denominator > 0n, "invalid_rate");
  const converted =
    (BigInt(sourceMinor) * 1000000n + denominator / 2n) / denominator;
  requireValue(
    converted > 0n && converted <= 100000000n,
    "converted_amount_out_of_range",
  );
  return Number(converted);
}

export function equalSignature(expected, received, encoding) {
  if (typeof received !== "string") return false;
  const bytes = Buffer.from(received, encoding);
  return (
    bytes.toString(encoding) === received &&
    bytes.length === expected.length &&
    timingSafeEqual(expected, bytes)
  );
}

export function epayContent(params) {
  return Object.keys(params)
    .sort()
    .filter((k) => !["sign", "sign_type"].includes(k) && params[k] !== "")
    .map((k) => {
      requireValue(
        k &&
          !/[&=]/.test(k) &&
          typeof params[k] === "string" &&
          !params[k].includes("&"),
        "invalid_epay_parameters",
      );
      return `${k}=${params[k]}`;
    })
    .join("&");
}

export function verifyEpay(params, config, now = Date.now()) {
  requireValue(
    params.pid === config.merchantId && params.sign_type === config.signType,
    "invalid_merchant_signature",
    401,
  );
  const content = epayContent(params);
  let valid;
  if (config.signType === "RSA") {
    requireValue(
      /^\d{10}$/.test(params.timestamp ?? "") &&
        Math.abs(now / 1000 - Number(params.timestamp)) <= 300,
      "expired_signature",
      401,
    );
    valid = verify(
      "RSA-SHA256",
      Buffer.from(content),
      config.publicKey,
      Buffer.from(params.sign ?? "", "base64"),
    );
  } else {
    valid = equalSignature(
      createHash("md5")
        .update(content + config.secret)
        .digest(),
      params.sign,
      "hex",
    );
  }
  requireValue(valid, "invalid_merchant_signature", 401);
}

export function signEpay(params, config) {
  const signed = {
    ...params,
    pid: config.merchantId,
    sign_type: config.signType,
  };
  if (config.signType === "RSA")
    signed.timestamp = String(Math.floor(Date.now() / 1000));
  const content = epayContent(signed);
  signed.sign =
    config.signType === "RSA"
      ? sign("RSA-SHA256", Buffer.from(content), config.privateKey).toString(
          "base64",
        )
      : createHash("md5")
          .update(content + config.secret)
          .digest("hex");
  return signed;
}

export function parseForm(raw) {
  const params = new URLSearchParams(raw.toString("utf8"));
  const result = Object.create(null);
  for (const [key, value] of params) {
    requireValue(!Object.hasOwn(result, key), "duplicate_form_field");
    result[key] = value;
  }
  return result;
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function confirmPayment(order, result) {
  requireValue(
    result.reference === order.id && result.remoteId === order.remote_id,
    "payment_identity_mismatch",
    409,
  );
  requireValue(
    result.currency === order.currency &&
      minorUnits(result.amount) === order.target_minor,
    "payment_amount_mismatch",
    409,
  );
  return result.paid === true;
}

export function checkoutURL(value, hosts) {
  const url = new URL(value);
  requireValue(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      hosts.includes(url.hostname),
    "invalid_checkout_url",
    502,
  );
  return url.href;
}

export function csrfToken(order, secret) {
  return createHmac("sha256", secret)
    .update(`checkout:${order.id}`)
    .digest("hex");
}

export async function readLimited(stream, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    requireValue(size <= limit, "body_too_large", 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function httpRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const raw = await readLimited(response.body, 262144);
  return { status: response.status, headers: response.headers, raw };
}

export function responseJSON(response) {
  requireValue(
    response.status >= 200 && response.status < 300,
    "provider_request_failed",
    502,
  );
  try {
    return JSON.parse(response.raw.toString("utf8"));
  } catch {
    throw new PaymentError("provider_response_invalid", 502);
  }
}
