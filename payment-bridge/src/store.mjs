import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { requireValue } from "./core.mjs";

// A separate delivery ledger, never a replacement for New API's balance database.
export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    requireValue(
      this.db.prepare("PRAGMA user_version").get().user_version <= 1,
      "unsupported_ledger_version",
    );
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, source_ref TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL, source_minor INTEGER NOT NULL,
        source_currency TEXT NOT NULL, target_minor INTEGER NOT NULL,
        currency TEXT NOT NULL, rate TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'new', remote_id TEXT, checkout_url TEXT,
        payment_id TEXT, delivered_at INTEGER,
        notify_attempts INTEGER NOT NULL DEFAULT 0, next_notify_at INTEGER NOT NULL DEFAULT 0,
        next_poll_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(provider, remote_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        provider TEXT NOT NULL, event_id TEXT NOT NULL, order_id TEXT NOT NULL,
        received_at INTEGER NOT NULL, PRIMARY KEY(provider, event_id)
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
  }

  bindIdentity(identity, key = "identity") {
    const value = JSON.stringify(identity);
    this.db
      .prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)")
      .run(key, value);
    requireValue(
      this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key)
        .value === value,
      "ledger_identity_changed",
    );
  }

  get(id) {
    return this.db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  }
  byReference(reference) {
    return this.db
      .prepare("SELECT * FROM orders WHERE source_ref=?")
      .get(reference);
  }
  byRemote(provider, remoteId) {
    return this.db
      .prepare("SELECT * FROM orders WHERE provider=? AND remote_id=?")
      .get(provider, remoteId);
  }

  activeProviders() {
    return this.db
      .prepare(
        "SELECT DISTINCT provider FROM orders WHERE state NOT IN ('new','delivered')",
      )
      .all()
      .map((row) => row.provider);
  }

  recover(id, remoteId, paymentId) {
    this.db
      .prepare(
        "UPDATE orders SET state='pending',remote_id=?,payment_id=? WHERE id=? AND state='creation_unknown'",
      )
      .run(remoteId, paymentId ?? null, id);
  }

  create(order) {
    const id = randomBytes(24).toString("base64url");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orders
      (id, source_ref, provider, source_minor, source_currency, target_minor, currency, rate, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        order.reference,
        order.provider,
        order.sourceMinor,
        order.sourceCurrency,
        order.targetMinor,
        order.currency,
        order.rate,
        order.createdAt,
        order.expiresAt,
      );
    const saved = this.byReference(order.reference);
    requireValue(
      saved.provider === order.provider &&
        saved.source_minor === order.sourceMinor,
      "order_conflict",
      409,
    );
    return saved;
  }

  claimCreation(id) {
    return (
      this.db
        .prepare(
          "UPDATE orders SET state='creating' WHERE id=? AND state='new'",
        )
        .run(id).changes === 1
    );
  }

  created(id, remoteId, checkoutUrl) {
    this.db
      .prepare(
        "UPDATE orders SET remote_id=?, checkout_url=?, state='pending' WHERE id=? AND state='creating'",
      )
      .run(remoteId, checkoutUrl, id);
  }

  creationUnknown(id) {
    this.db
      .prepare(
        "UPDATE orders SET state='creation_unknown' WHERE id=? AND state='creating'",
      )
      .run(id);
  }

  recoverInterrupted() {
    this.db
      .prepare(
        "UPDATE orders SET state='creation_unknown' WHERE state='creating'",
      )
      .run();
  }

  recordEvent(provider, eventId, id) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO events(provider,event_id,order_id,received_at) VALUES (?,?,?,?)",
      )
      .run(provider, eventId, id, Date.now());
    requireValue(
      this.db
        .prepare("SELECT order_id FROM events WHERE provider=? AND event_id=?")
        .get(provider, eventId).order_id === id,
      "event_identity_mismatch",
      409,
    );
  }

  rememberPayment(id, paymentId) {
    // NOWPayments may create several attempts per invoice. A finished attempt
    // must still match the stored invoice and full amount before crediting once.
    this.db
      .prepare("UPDATE orders SET payment_id=? WHERE id=?")
      .run(paymentId, id);
  }

  paid(id) {
    this.db
      .prepare("UPDATE orders SET state='paid' WHERE id=? AND state='pending'")
      .run(id);
  }

  delivered(id) {
    this.db
      .prepare(
        "UPDATE orders SET state='delivered', delivered_at=? WHERE id=? AND state='paid'",
      )
      .run(Date.now(), id);
  }

  deferNotify(id, attempts) {
    const delay = Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7));
    this.db
      .prepare(
        "UPDATE orders SET notify_attempts=notify_attempts+1,next_notify_at=? WHERE id=?",
      )
      .run(Date.now() + delay, id);
  }

  dueNotifications() {
    return this.db
      .prepare(
        "SELECT * FROM orders WHERE state='paid' AND next_notify_at<=? ORDER BY next_notify_at LIMIT 20",
      )
      .all(Date.now());
  }

  duePolls() {
    return this.db
      .prepare(
        "SELECT * FROM orders WHERE state='pending' AND next_poll_at<=? ORDER BY next_poll_at LIMIT 10",
      )
      .all(Date.now());
  }

  deferPoll(id) {
    this.db
      .prepare("UPDATE orders SET next_poll_at=? WHERE id=?")
      .run(Date.now() + 300000, id);
  }

  close() {
    this.db.close();
  }
}
