# Shiny request audit

This describes the optional content-audit provider and the Abuse Reviews
operator page. The feature branch adds a TypeSafe/Jev adapter; it does not
enable Jev or change the production provider. Existing Chat Completions
(including DeepSeek) remains the default, existing review history is retained,
and no account ban, balance, quota, or permission change is automated.

## Jev setup

1. In **System settings → Request policies → Content audit**, select the audit
   protocol, enter the endpoint, enter an API key, and use **Test connection
   and fetch models**. Jev defaults to `https://api.typesafe.ai/v1/systemone`
   and `jev-1.14.0`. Credentials are saved separately for each protocol and
   are never returned to the browser. A blank key leaves the saved key intact;
   an explicit clear falls back to that provider's environment key, if set.
2. Console-entered keys are encrypted with AES-GCM before storage in the
   existing options table. Encryption derives from a stable `CRYPTO_SECRET`
   (at least 32 characters), or `SESSION_SECRET` when `CRYPTO_SECRET` is absent.
   Keep the selected server secret stable across restarts and all New API
   instances sharing the database. The console refuses to save keys if no
   qualifying secret is configured. Environment variables `TYPESAFE_API_KEY`
   and `CONTENT_AUDIT_API_KEY` remain supported as fallback credentials.
3. Keep mode **Off** while saving and testing credentials, then select
   **Shadow** for an initial sample. Shadow does not delay or block the model
   request. Signal matches are audited, with the configured background sample
   rate applying to other requests.
4. Review provider, model version, category probabilities, request context,
   audit usage and latency in the Abuse Reviews page. Resolve false positives
   with an operator note. Tune thresholds against labeled benign, defensive,
   quoted, ambiguous, and abusive examples before considering **Preflight**.

The Jev adapter sends one structured request containing six independent abuse
questions and one request-context classification. It does not ask Jev to write
free-form evidence or a policy decision. Code validates the response, applies
the configured review/rejection thresholds, and maps fixed category IDs to
reason codes. A malformed or incomplete response is an audit error; it cannot
be interpreted as a clean decision. Provider errors are not retried.

The `state` field contains the selected audit text segments and their source
labels. Depending on the request, this can include current and prior user text,
system/instruction text, and tool output. Image/audio payloads are excluded, and
the adapter does not fetch URLs. Treat enabling an external provider as sending
request content to that provider; review data-handling requirements first.

`ContentAuditMaxChunks` bounds asynchronous shadow work to 1–16 chunks, each
up to 3,000 characters. When the request exceeds this budget, the review is
marked as incomplete; incomplete coverage is not a clean result. Preflight
keeps its existing bounded coverage behavior and fails with 503 on an audit
error before forwarding. It can reject only a direct abusive request above the
configured rejection threshold. Start with Shadow; do not switch to Preflight
until the selected provider and thresholds have been evaluated against
representative data.

The Abuse Reviews page displays a bounded summary. Full redacted metadata is
available in a dialog with a copy action; it does not expose the complete user
prompt. Long identifiers and unknown historical reason codes wrap safely.

## Provider cost and data handling

At the time this integration was researched, TypeSafe listed Jev 1.14.0 input
at `$0.042 / 1M tokens` and output as free. Confirm current terms and account
limits with TypeSafe before enabling a broad sample. Health token totals are
process-lifetime counters across provider switches, not a bill or durable ledger; responses without
reported usage are counted separately rather than added as zero-token calls.
No cache discount was confirmed. TypeSafe documents US processing and says ordinary accounts are
not automatically zero-data-retention; check current terms and obtain any
required privacy approval before sending production requests.

## Compatibility and verification

The policy values and encrypted credentials are stored in the existing options
table; no database schema or billing changes are required. Older servers may
reject the new option names, so deploy the matching application build before
configuring Jev. Switching providers does not copy the DeepSeek prompt, change
the mode, or enable auditing.

Focused checks:

```powershell
go test ./service -run '^(TestTypesafe|TestContentAudit|TestAudit|TestEvaluateContentAudit|TestFetchContentAudit)' -count=1
go test ./model -run '^(TestRequestPolicyDatabaseMatrix|TestContentAuditPolicyOptions)' -count=1 -v
bunx vitest run src/features/system-settings/request-policies/__tests__/settings.test.tsx src/features/usage-logs/audit/__tests__/review-queue.test.tsx --maxWorkers=1 --no-file-parallelism
```

## Credential handling

The settings endpoints stay under the existing root-admin authorization and
must be used over HTTPS. Provider endpoints must use HTTPS too; HTTP is accepted
only for `localhost` or loopback IPs such as `127.0.0.1` and `::1`. Embedded URL
credentials and query parameters are rejected. The console never reads a saved
key back. A connection test sends the unsaved key only to the selected provider's model-list endpoint
and returns model IDs, not the key. A successful key save writes an operation
audit listing updated and cleared provider IDs; it never records the
credential or encrypted value. Generic option reads omit both audit API-key
fields, and generic option writes reject them.

Stored keys use AES-GCM with a fresh random nonce. The encryption key is derived
from a stable server `CRYPTO_SECRET` (at least 32 characters), or from
`SESSION_SECRET` when the former is absent, so the encryption key remains
outside the database. Keep the chosen server secret stable across restarts and
all New API instances sharing the database. Rotating `CRYPTO_SECRET` also
invalidates existing signed task artifact URLs; rotating `SESSION_SECRET`
invalidates active sessions. Either rotation makes stored audit credentials
unreadable, so re-enter provider keys after planned rotation. This is
application-level encryption, not a KMS/HSM-backed secret manager.

The credential flow follows the relevant OWASP guidance for authenticated TLS
transport, least-privilege access, safe secret storage, and logging secret
administration without logging secret material:

- [Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

This change does not claim ASVS certification or a complete security audit.

## Open-source references

These projects informed the design; this patch adds no runtime dependency or
copied project code:

- [LiteLLM](https://github.com/BerriAI/litellm), MIT-licensed OSS components:
  keep asynchronous observation distinct from enforcement and report provider
  errors separately from policy decisions.
- [Promptfoo](https://github.com/promptfoo/promptfoo), MIT: maintain labeled
  regression cases for benign, abusive, quoted, defensive, and indirect
  instruction examples. Its older prompt-injection strategy is not copied.
- [TypeSafe API](https://docs.typesafe.ai/api/system-one): structured
  probability answers and explicit context are validated before code maps them
  to review outcomes.

No real Jev API key or production request data was used for the adapter tests.
Fixture tests prove request/response handling, not Jev accuracy or latency.
