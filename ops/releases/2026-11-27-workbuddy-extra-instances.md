# WorkBuddy2API optional instances — 2026-11-27

Authorized scope: add two independent local backend instances on ports 7861
and 7862, keep the primary backend/manager running, and provide easy retirement.

## Deployed

- `workbuddy2api-7861.service`: `127.0.0.1:7861`, manager upstream ID 5,
  `独立号池-7861`, `/opt/workbuddy2api-instances/7861`.
- `workbuddy2api-7862.service`: `127.0.0.1:7862`, manager upstream ID 6,
  `独立号池-7862`, `/opt/workbuddy2api-instances/7862`.
- Binary SHA-256 for each pinned copy:
  `84811ce620e2557bae4b8edc4df350aa8c080a5e57ed8430fd0449d9368a14c0`.
- Independent API keys, credential directories, state paths and journald logs.
  Both started with zero accounts and zero bound manager keys. No accounts or
  runtime state were copied. No New API channel was created or changed.
- The existing Tailscale-only manager is reused. Its backend settings, default
  upstream, current keys, SQLite schema and existing group registrations were
  not changed. Only the two new upstream rows were added.

The native manager/backend use the same `workbuddy` UID to preserve ownership
when credentials are atomically replaced. New systemd mount namespaces hide
the primary deployment, manager directory and sibling instance; both instances
can write only their own auth/state directories. Both sibling paths are created
before either service starts, because a missing optional `InaccessiblePaths`
target would otherwise remain visible if created later.

## Verification

- Both services are active, enabled at boot, and have zero automatic restarts.
- Each instance answers authenticated `/status` and `/v1/models` with HTTP 200;
  missing, invalid and sibling-instance keys receive HTTP 401.
- Empty pools correctly report `/healthz` HTTP 503 with service identity
  `workbuddy2api` and `total=0`; this is readiness, not process failure.
  Actual inference has not been tested because no accounts are installed.
- The manager's own upstream resolver, serialization and `get_status` code
  connect to both new pools. It omits upstream keys from serialized responses.
- Manager credential-file atomic create/update works in each new auth
  directory using a non-credential temporary fixture; the fixture was deleted.
- From each live service mount namespace, the service UID can read its own
  configuration and write its auth directory, but cannot read the primary,
  manager or sibling configuration.
- Stop/resume was exercised on 7862. The associated manager row disabled and
  re-enabled correctly; 7861 and the original services continued running.
- Re-running installation retained the same keys/configs and upstream IDs.
- Primary backend PID 1168116 and manager PID 982607 remained unchanged. Their
  authenticated status and manager health requests returned HTTP 200.
- Listening sockets are strictly `127.0.0.1:7861/7862`. Existing UFW rules
  allow only SSH, HTTP and HTTPS; there are no NAT port-forward rules for these
  backends. No public listener or firewall rule was added.
- The two empty backend processes used about 2.7 MiB each in their service
  cgroups at final observation. Each independent directory uses about 9 MiB.

## Operating and retiring

The helper is installed at `/usr/local/sbin/shiny-workbuddy-instances`.

```sh
sudo shiny-workbuddy-instances status 7861 7862
sudo shiny-workbuddy-instances stop 7861
sudo shiny-workbuddy-instances start 7861
sudo shiny-workbuddy-instances restart 7861
sudo shiny-workbuddy-instances remove 7861
```

Before retirement, disable any directly connected New API channel and drain
requests. Stop disables the manager upstream and boot startup but keeps data.
Removal refuses when accounts or manager-key references remain, then removes
only the corresponding upstream row, service unit and binary. It retains
configuration/state for review or reinstall. It never recursively deletes data.

In the manager, use **Accounts → corresponding group** to import accounts and
**Keys → bind upstream** for routing. Native account changes normally hot-load
within about five seconds. The non-default-group restart button currently
expects Docker; use the per-instance systemd helper for manual restarts.

The uploaded temporary installer and permission-check fixtures were removed.
No backup, dump, provider credential, OAuth file or binary is committed.
