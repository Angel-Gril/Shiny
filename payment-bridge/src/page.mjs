import { money, csrfToken } from "./core.mjs";
import { catalog } from "./config.mjs";

const words = {
  ru: {
    title: "Пополнение Shiny",
    eyebrow: "SHINY / ПЛАТЕЖИ",
    heading: "Больше возможностей.\nОдин баланс.",
    description: "Безопасное пополнение для ваших AI-проектов.",
    quote: "Сумма к оплате",
    source: "Сумма заказа",
    rate: "Курс зафиксирован для этого заказа",
    fee: "Итоговая сумма и возможные комиссии сети указаны на странице платёжного сервиса.",
    pay: "Перейти к оплате",
    redirect: "Открываем страницу оплаты…",
    back: "Вернуться в кошелёк",
    refresh: "Проверить оплату",
    new: "Подтвердите сумму и продолжите оплату.",
    pending: "Ожидаем подтверждение платёжного сервиса.",
    paid: "Платёж подтверждён. Зачисляем средства на баланс.",
    delivered: "Готово. Средства зачислены на ваш баланс.",
    creation_unknown:
      "Статус создания платежа уточняется. Обратитесь в поддержку с номером заказа.",
    creating: "Создаём платёж. Обновите страницу через несколько секунд.",
    expired: "Время оплаты истекло. Начните новое пополнение в кошельке.",
    note: "Возврат на эту страницу не подтверждает оплату. Баланс обновляется после проверки платежа.",
    support: "Номер заказа",
    error: "Не удалось выполнить операцию",
    errorText: "Вернитесь в кошелёк или обратитесь в поддержку.",
  },
  en: {
    title: "Top up Shiny",
    eyebrow: "SHINY / PAYMENTS",
    heading: "More possibilities.\nOne balance.",
    description: "Secure payments for your AI projects.",
    quote: "Amount to pay",
    source: "Order amount",
    rate: "Exchange rate fixed for this order",
    fee: "The payment provider displays the final amount and any network fees.",
    pay: "Continue to payment",
    redirect: "Opening the payment page…",
    back: "Back to wallet",
    refresh: "Check payment",
    new: "Confirm the amount and continue to payment.",
    pending: "Waiting for payment confirmation.",
    paid: "Payment verified. Adding funds to your balance.",
    delivered: "Done. Funds have been added to your balance.",
    creation_unknown:
      "The payment creation status is uncertain. Contact support with your order number.",
    creating: "Creating your payment. Refresh this page in a few seconds.",
    expired: "Checkout expired. Start a new top-up in your wallet.",
    note: "Returning to this page does not confirm payment. Your balance updates after payment verification.",
    support: "Order number",
    error: "Unable to complete this action",
    errorText: "Return to your wallet or contact support.",
  },
};

function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

// Commit a same-origin document before navigating to the hosted checkout.
// Browsers differ in how form-action applies to cross-origin 303 chains.
export function renderRedirect(url, language = "ru") {
  const lang = language === "en" ? "en" : "ru";
  const text = words[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="0;url=${escape(url)}"><title>${text.title}</title><link rel="stylesheet" href="/style.css"></head>
    <body><main><section class="card"><h1>${text.redirect}</h1><a href="${escape(url)}">${text.pay} ↗</a></section></main></body></html>`;
}

export function renderPage(order, config, language = "ru", errorCode) {
  const lang = language === "en" ? "en" : "ru";
  const text = words[lang];
  const expired = order && Date.now() >= order.expires_at;
  const canPay =
    order &&
    ["new", "pending"].includes(order.state) &&
    !expired &&
    config.adapters[order.provider] &&
    (order.state === "new" || order.checkout_url) &&
    config.providers[order.provider]?.acceptNew !== false;
  const status = order ? text[order.state] : text.errorText;
  const csrf = order ? csrfToken(order, config.csrfSecret) : "";
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><title>${text.title}</title><link rel="stylesheet" href="/style.css"></head>
    <body><header><a class="brand" href="${escape(config.newapi.returnURL)}">shiny<span>✦</span></a><nav aria-label="Language"><a href="?lang=ru" lang="ru">RU</a><a href="?lang=en" lang="en">EN</a></nav></header>
    <main><section class="intro"><p class="eyebrow">${text.eyebrow}</p><h1>${text.heading.split("\n").map(escape).join("<br>")}</h1><p>${text.description}</p><div class="orbit" aria-hidden="true"><span>✦</span></div></section>
    <section class="card" aria-labelledby="payment-title"><p class="eyebrow">${escape(order ? catalog[order.provider].label : "Shiny")}</p>
    <h2 id="payment-title">${errorCode ? text.error : text.quote}</h2>
    ${
      order
        ? `<div class="amount">${money(order.target_minor)} <span>${escape(order.currency)}</span></div>
    <dl><div><dt>${text.source}</dt><dd>${money(order.source_minor)} ${escape(order.source_currency)}</dd></div></dl>
    <p class="muted">${text.rate}: 1 ${escape(order.currency)} = ${escape(order.rate)} ${escape(order.source_currency)}</p>
    <p class="status" role="status">${escape(expired && order.state === "new" ? text.expired : status)}</p>
    ${canPay ? `<form method="post" action="/checkout/${order.id}/start?lang=${lang}"><input type="hidden" name="csrf" value="${csrf}"><button>${text.pay} <span aria-hidden="true">↗</span></button></form>` : ""}
    ${order.state === "pending" ? `<form method="post" action="/checkout/${order.id}/check?lang=${lang}"><input type="hidden" name="csrf" value="${csrf}"><button class="secondary">${text.refresh}</button></form>` : ""}
    <p class="muted">${text.fee}</p><p class="order">${text.support}<br><code>${escape(order.source_ref)}</code></p>`
        : `<p>${text.errorText}</p>`
    }
    <a class="back" href="${escape(config.newapi.returnURL)}">← ${text.back}</a><p class="fine">${text.note}</p></section></main>
    <footer>Shiny API <span>·</span> ${lang === "ru" ? "Платежи" : "Payments"}</footer></body></html>`;
}
