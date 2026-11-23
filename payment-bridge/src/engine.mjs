import {
  confirmPayment,
  convertAmount,
  httpRequest,
  minorUnits,
  money,
  requireValue,
  signEpay,
  verifyEpay,
} from "./core.mjs";

export class Engine {
  constructor(
    config,
    store,
    http = httpRequest,
    audit = (event) => console.log(JSON.stringify(event)),
  ) {
    this.config = config;
    this.store = store;
    this.http = http;
    this.audit = audit;
    this.locks = new Map();
    this.ticking = false;
    store.bindIdentity({
      origin: config.newapi.origin,
      merchantId: config.newapi.merchantId,
      currency: config.newapi.currency,
      paymentOrigin: config.origin,
      environment: config.environment,
    });
    for (const name of Object.keys(config.adapters)) {
      const provider = config.providers[name];
      store.bindIdentity(
        {
          environment: provider.environment,
          merchantId: provider.merchantId,
          storeId: provider.storeId,
          userId: provider.userId,
          developerUserId: provider.developerUserId,
        },
        `provider:${name}`,
      );
    }
    requireValue(
      store.activeProviders().every((name) => config.adapters[name]),
      "pending_provider_cannot_be_disabled",
    );
    store.recoverInterrupted();
  }

  async exclusive(id, action) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.locks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  submit(params) {
    verifyEpay(params, this.config.newapi);
    requireValue(
      params.notify_url === this.config.newapi.notifyURL &&
        params.return_url === this.config.newapi.returnURL,
      "callback_url_not_allowed",
    );
    requireValue(
      /^[A-Za-z0-9_-]{1,100}$/.test(params.out_trade_no ?? ""),
      "invalid_order_reference",
    );
    const provider = params.type;
    const options = this.config.providers[provider];
    requireValue(
      Object.hasOwn(this.config.adapters, provider) &&
        options.acceptNew !== false,
      "provider_disabled",
      409,
    );
    const sourceMinor = minorUnits(params.money);
    requireValue(
      sourceMinor <= this.config.maxSourceMinor,
      "order_limit_exceeded",
    );
    const order = this.store.create({
      reference: params.out_trade_no,
      provider,
      sourceMinor,
      sourceCurrency: this.config.newapi.currency,
      currency: options.currency,
      targetMinor: convertAmount(
        sourceMinor,
        options.sourceUnitsPerSettlementUnit,
      ),
      rate: options.sourceUnitsPerSettlementUnit,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60000,
    });
    this.audit({ event: "checkout_opened", order: order.source_ref, provider });
    return order;
  }

  async start(id) {
    return this.exclusive(id, async () => {
      const order = this.store.get(id);
      requireValue(
        order && order.expires_at > Date.now(),
        "checkout_expired",
        409,
      );
      requireValue(
        this.config.adapters[order.provider] &&
          this.config.providers[order.provider]?.acceptNew !== false,
        "provider_disabled",
        409,
      );
      if (order.state === "pending") return order.checkout_url;
      requireValue(this.store.claimCreation(id), "order_not_ready", 409);
      try {
        const result = await this.config.adapters[order.provider].create(order);
        this.store.created(id, result.remoteId, result.url);
        this.audit({
          event: "invoice_created",
          order: order.source_ref,
          provider: order.provider,
        });
        return result.url;
      } catch (error) {
        // No automatic create retry after an uncertain remote outcome. An
        // operator can recover the original provider order with verified query.
        this.store.creationUnknown(id);
        throw error;
      }
    });
  }

  async webhook(provider, raw, headers) {
    const adapter = this.config.adapters[provider];
    requireValue(adapter, "provider_disabled", 404);
    const event = await adapter.webhook(raw, headers);
    if (!event) {
      this.audit({ event: "non_credit_webhook", provider });
      return;
    }
    requireValue(
      typeof event.eventId === "string" && event.eventId.length <= 160,
      "invalid_event_id",
    );
    const order = event.reference
      ? this.store.get(event.reference)
      : this.store.byRemote(provider, event.remoteId ?? "");
    requireValue(
      order && order.provider === provider,
      "unknown_payment_order",
      404,
    );
    requireValue(
      !event.remoteId || event.remoteId === order.remote_id,
      "payment_identity_mismatch",
      409,
    );
    return this.exclusive(order.id, async () => {
      this.store.recordEvent(provider, event.eventId, order.id);
      return this.reconcileUnlocked(order.id, event);
    });
  }

  async reconcileUnlocked(id, event) {
    const order = this.store.get(id);
    requireValue(order, "unknown_payment_order", 404);
    if (order.state === "delivered") return;
    if (order.state === "paid") return this.notify(order);
    requireValue(order.state === "pending", "payment_not_queryable", 409);
    const result = await this.config.adapters[order.provider].query(
      order,
      event,
    );
    if (!result) return;
    const paid = confirmPayment(order, result);
    if (event?.paymentId) this.store.rememberPayment(id, event.paymentId);
    if (!paid) return;
    this.store.paid(id);
    this.audit({
      event: "payment_verified",
      order: order.source_ref,
      provider: order.provider,
    });
    await this.notify(this.store.get(id));
  }

  async notify(order) {
    if (order.state !== "paid") return;
    const params = signEpay(
      {
        out_trade_no: order.source_ref,
        trade_no: order.id,
        type: order.provider,
        money: money(order.source_minor),
        name: "Shiny API credit",
        trade_status: "TRADE_SUCCESS",
      },
      this.config.newapi,
    );
    try {
      const response = await this.http(this.config.newapi.notifyURL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
      requireValue(
        response.status === 200 &&
          response.raw.toString("utf8").trim() === "success",
        "newapi_notify_failed",
        502,
      );
      this.store.delivered(order.id);
      this.audit({
        event: "newapi_credited",
        order: order.source_ref,
        provider: order.provider,
      });
    } catch {
      this.store.deferNotify(order.id, order.notify_attempts);
      this.audit({
        event: "newapi_notify_retry",
        order: order.source_ref,
        provider: order.provider,
      });
    }
  }

  async recover(id, remoteId, paymentId) {
    const order = this.store.get(id);
    requireValue(
      order?.state === "creation_unknown" &&
        typeof remoteId === "string" &&
        remoteId.length <= 100,
      "order_not_recoverable",
    );
    const candidate = {
      ...order,
      remote_id: remoteId,
      payment_id: paymentId ?? null,
    };
    const result = await this.config.adapters[order.provider].query(candidate);
    requireValue(result, "payment_id_required");
    confirmPayment(candidate, result);
    this.store.recover(id, remoteId, paymentId);
    await this.reconcileUnlocked(id);
  }

  async linkPayment(id, paymentId) {
    const order = this.store.get(id);
    requireValue(
      order?.state === "pending" && order.provider === "nowpayments",
      "order_not_linkable",
    );
    const result = await this.config.adapters.nowpayments.query(order, {
      paymentId,
    });
    requireValue(result, "payment_id_required");
    confirmPayment(order, result);
    this.store.rememberPayment(id, paymentId);
    await this.reconcileUnlocked(id);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const order of this.store.dueNotifications())
        await this.exclusive(order.id, () =>
          this.notify(this.store.get(order.id)),
        );
      for (const order of this.store.duePolls()) {
        this.store.deferPoll(order.id);
        try {
          await this.exclusive(order.id, () =>
            this.reconcileUnlocked(order.id),
          );
        } catch (error) {
          this.audit({
            event: "reconcile_failed",
            order: order.source_ref,
            code: error.code ?? "provider_unavailable",
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
