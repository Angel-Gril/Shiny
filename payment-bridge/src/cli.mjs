import { resolve } from "node:path";
import { catalog, loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { acquireLock } from "./server.mjs";
import { PaymentError, requireValue } from "./core.mjs";

async function main() {
  process.umask(0o077);
  const command = process.argv[2];
  if (command === "catalog") {
    console.log(
      JSON.stringify(
        {
          bridge: Object.fromEntries(
            Object.entries(catalog).map(([key, value]) => [
              key,
              { name: value.label, currencies: value.currencies },
            ]),
          ),
          nativeNewAPI: ["Epay", "Stripe", "Creem", "Waffo", "Waffo Pancake"],
          candidateOnly: ["YooKassa / SBP / Mir (no adapter in this release)"],
        },
        null,
        2,
      ),
    );
    return;
  }
  const config = await loadConfig(
    process.env.PAYMENT_CONFIG ?? resolve("config.json"),
  );
  if (command === "check") {
    const methods = Object.keys(config.adapters).filter(
      (name) => config.providers[name].acceptNew !== false,
    );
    console.log(
      JSON.stringify(
        {
          environment: config.environment,
          configured: Object.keys(config.adapters),
          acceptsNewOrders: methods,
          liveMerchantVerified: false,
          newapi: {
            PayAddress: config.origin,
            EpayId: config.newapi.merchantId,
            "payment_setting.epay_sign_type": config.newapi.signType,
            PayMethods: methods.map((type) => ({
              name: catalog[type].label,
              type,
              color: "#B6F977",
            })),
            CustomCallbackAddress: config.newapi.origin,
            sourceCurrency: config.newapi.currency,
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  requireValue(
    ["reconcile", "recover", "link-payment"].includes(command),
    "usage_catalog_check_reconcile_recover_link-payment",
  );
  const release = acquireLock(config.database);
  const store = new Store(config.database);
  try {
    const engine = new Engine(config, store);
    const orderId = process.argv[3]
      ? (store.byReference(process.argv[3])?.id ?? process.argv[3])
      : null;
    if (command === "link-payment")
      await engine.linkPayment(orderId, process.argv[4]);
    else if (command === "recover")
      await engine.recover(orderId, process.argv[4], process.argv[5]);
    else if (orderId) await engine.reconcileUnlocked(orderId);
    else await engine.tick();
  } finally {
    store.close();
    release();
  }
}

main().catch((error) => {
  console.error(
    error instanceof PaymentError
      ? error.code
      : "payment_configuration_or_operation_failed",
  );
  process.exitCode = 1;
});
