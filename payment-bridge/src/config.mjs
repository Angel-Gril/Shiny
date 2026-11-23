import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  convertAmount,
  httpRequest,
  requireValue,
  minorUnits,
} from "./core.mjs";

export const catalog = {
  nowpayments: {
    label: "Crypto · NOWPayments",
    currencies: ["USD"],
    module: "./providers/nowpayments.mjs",
  },
  lianlian: {
    label: "LianLian Global",
    currencies: ["USD", "EUR", "CNY", "HKD", "RUB"],
    module: "./providers/lianlian.mjs",
  },
  paypal: {
    label: "PayPal",
    currencies: ["USD", "EUR", "HKD"],
    module: "./providers/paypal.mjs",
  },
};

function httpsOrigin(value) {
  const url = new URL(value);
  requireValue(
    url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password,
    "invalid_https_origin",
  );
  return value;
}

export async function loadConfig(
  filename,
  env = process.env,
  http = httpRequest,
) {
  const config = JSON.parse(readFileSync(filename, "utf8"));
  requireValue(
    ["test", "live"].includes(config.environment),
    "invalid_payment_environment",
  );
  config.origin = httpsOrigin(config.origin);
  config.newapi.origin = httpsOrigin(config.newapi.origin);
  requireValue(
    config.origin !== config.newapi.origin,
    "payment_origin_must_be_separate",
  );
  requireValue(
    ["CNY", "USD", "EUR", "HKD", "RUB"].includes(config.newapi.currency),
    "invalid_source_currency",
  );
  requireValue(
    /^[A-Za-z0-9_-]{1,50}$/.test(config.newapi.merchantId),
    "invalid_merchant",
  );
  requireValue(
    ["MD5", "RSA"].includes(config.newapi.signType),
    "invalid_sign_type",
  );
  requireValue(
    config.host === "127.0.0.1" &&
      Number.isInteger(config.port) &&
      config.port > 1024 &&
      config.port <= 65535,
    "invalid_listen_address",
  );
  const configDir = dirname(resolve(filename));
  const context = {
    origin: config.origin,
    http,
    secret(name) {
      requireValue(
        typeof name === "string" &&
          /^[A-Z][A-Z0-9_]+$/.test(name) &&
          env[name]?.length >= 16,
        "missing_or_short_secret",
      );
      return env[name];
    },
    privateKey(file) {
      requireValue(typeof file === "string" && file, "missing_private_key");
      const key = createPrivateKey(readFileSync(resolve(configDir, file)));
      requireValue(
        key.asymmetricKeyType === "rsa" &&
          key.asymmetricKeyDetails.modulusLength >= 2048,
        "invalid_rsa_key",
      );
      return key;
    },
    publicKey(file) {
      requireValue(typeof file === "string" && file, "missing_public_key");
      const key = createPublicKey(readFileSync(resolve(configDir, file)));
      requireValue(
        key.asymmetricKeyType === "rsa" &&
          key.asymmetricKeyDetails.modulusLength >= 2048,
        "invalid_rsa_key",
      );
      return key;
    },
  };
  config.csrfSecret = context.secret(config.csrfSecretEnv);
  if (config.newapi.signType === "RSA") {
    config.newapi.publicKey = context.publicKey(config.newapi.publicKeyFile);
    config.newapi.privateKey = context.privateKey(config.newapi.privateKeyFile);
  } else config.newapi.secret = context.secret(config.newapi.secretEnv);
  config.maxSourceMinor = minorUnits(config.maxSourceAmount);
  config.database = resolve(configDir, config.database);
  config.newapi.notifyURL = `${config.newapi.origin}/api/user/epay/notify`;
  config.newapi.returnURL = `${config.newapi.origin}/wallet?show_history=true`;
  config.adapters = {};
  for (const [name, options] of Object.entries(config.providers)) {
    requireValue(Object.hasOwn(catalog, name), "unknown_provider");
    requireValue(
      typeof options.enabled === "boolean" &&
        typeof options.acceptNew === "boolean",
      "invalid_provider_switch",
    );
    if (!options.enabled) continue;
    requireValue(
      (config.environment === "live") === (options.environment === "live"),
      "mixed_payment_environments",
    );
    requireValue(
      catalog[name].currencies.includes(options.currency),
      "unsupported_settlement_currency",
    );
    convertAmount(10000, options.sourceUnitsPerSettlementUnit);
    requireValue(
      options.currency !== config.newapi.currency ||
        Number(options.sourceUnitsPerSettlementUnit) === 1,
      "same_currency_rate_must_be_one",
    );
    // Dynamic import: only explicitly enabled provider modules are loaded.
    config.adapters[name] = (await import(catalog[name].module)).createProvider(
      options,
      context,
    );
  }
  return config;
}
