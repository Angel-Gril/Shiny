# Main-site Turnstile integration

The main New API instance reads its existing `TurnstileSiteKey`, server-only
`TurnstileSecretKey` and `TurnstileCheckEnabled` settings. No replacement widget
or new secret slot is created. Secret values must never appear in source,
browser responses, URL parameters, diffs, request logs or test receipts.

The [Cloudflare existing-widget flow](https://developers.cloudflare.com/turnstile/spin/prompt.md)
was read for this repair. The supplied public sitekey already matches the live
main-site setting and its stored secret passed the canonical dummy-token probe
(`invalid-input-response`, without `invalid-input-secret`). No secret retrieval,
rotation or Cloudflare account change was needed. If recovery is needed later,
follow that flow's explicit destination and confirmation requirements before
any credential-bearing widget getter; do not paste a secret into chat.

## Protected actions

| Existing endpoint | Widget action |
| --- | --- |
| `POST /api/user/login` | `login` |
| `POST /api/user/register` | `signup` |
| `GET /api/verification` | `signup` |
| `GET /api/reset_password` | `password_reset` |
| `POST /api/user/checkin` | `checkin` |

The widget uses explicit rendering. Expiry, timeout and error clear the parent
form's token. Every submitted action consumes one token, including rejected or
failed submissions; a page that remains open renders a new widget before a retry.
Sending a registration email and completing registration require separate fresh
tokens. A script/network/render error exposes a translated retry control and
never grants verification. Narrow forms retain compact/flexible sizing.

Current clients send tokens in `CF-Turnstile-Response`; the backend still accepts
the old `turnstile` query transport for previously loaded clients. An old client
without a widget action must refresh to load the matching frontend; an absent or
wrong action is rejected rather than weakening the new gate.

The existing Go middleware verifies with canonical Cloudflare Siteverify using
a 10-second request timeout and no credential redirects. It requires success,
the exact endpoint action and the hostname from the administrator's configured
`ServerAddress`, never a caller-supplied Host/Origin. A production ServerAddress
must use the public production hostname, not a local preview address.

Cloudflare documents eventual consistency in token replay detection. Therefore,
after successful provider validation the gateway atomically claims the token's
SHA256 fingerprint for five minutes. Redis shares claims across nodes; an enabled
but unavailable Redis fails closed. Single-process deployments without Redis use
a bounded memory map. Only the fingerprint is stored. The existing handler runs
unchanged after that gate; Cloudflare or cache errors never bypass it.

## Validation

Focused Go tests cover wrong/missing/oversized tokens, wrong action/hostname,
provider failure/malformed data, repeat success responses, memory and Redis
claims, cache failure and the disabled-switch contract. Frontend tests cover
shared script loading, narrow sizing, live callbacks, stale token clearing,
visible script-error recovery and header-based transport. Auth and registration
rate-limit route tests preserve the existing endpoint behavior.

Use a real production widget token through an existing protected endpoint to
complete production validation. A failed synthetic username/password login may
confirm the gate succeeded without creating an account or sending mail; replay
must be rejected by Turnstile. A mock/test key or dummy secret probe is not a
real-token end-to-end acceptance. If automation is challenged, an operator must
complete that browser verification; do not disable or substitute the live gate.

OWASP references: [Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html),
[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
[Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
Existing authentication, email verification, password policy, sessions, CSRF
controls, rate limits and recovery handlers remain in force. This repair is not
a claim of complete ASVS compliance. RU has its own settings and release and is
not updated by the main-site rollout.
