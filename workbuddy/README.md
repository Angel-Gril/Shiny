# Optional WorkBuddy2API backends

The primary backend and manager keep their own lifecycle. These optional
instances copy the currently installed backend binary into fixed independent
directories and do not follow primary-backend updates automatically.
The four required scheduled-task Python helpers are pinned copies too.

| Component | Address | Service / data |
| --- | --- | --- |
| Primary | `127.0.0.1:7863` | Existing deployment |
| Optional 7861 | `127.0.0.1:7861` | `workbuddy2api-7861.service`, `/opt/workbuddy2api-instances/7861` |
| Optional 7862 | `127.0.0.1:7862` | `workbuddy2api-7862.service`, `/opt/workbuddy2api-instances/7862` |

Each optional instance has its own API key, empty `auths/` directory and
`data/state.json`. No production accounts or runtime state are copied. Redis
is not configured. API body limit is 256 MiB. Non-secret scheduling, pool,
timeout and session settings are copied from the primary configuration at
installation; explicit provider credentials/device IDs are cleared.

The services use the existing `workbuddy` UID because both the manager and
backend atomically replace OAuth credential files. Using unrelated UIDs would
break ownership during credential refresh. New services use systemd filesystem
restrictions to deny access to the primary deployment, manager directory and
other optional instance, and can write only their own account/state directories.
This protects against accidental file access; it is not a separate-host security
boundary against a fully compromised host or manager.

Install `manage-instances.py` as
`/usr/local/lib/shiny-workbuddy-instances/manage.py`, with a launcher named
`/usr/local/sbin/shiny-workbuddy-instances`. Run as root:

```sh
shiny-workbuddy-instances install 7861 7862
shiny-workbuddy-instances status 7861 7862
```

The installer verifies health/model discovery before registering the instances
in the existing manager's **Settings → Upstreams** list as `独立号池-7861` and
`独立号池-7862`. Import authorized accounts into the corresponding group from
the **Accounts** page. The current backend watches account files every five
seconds, so imports and edits normally take effect without restart. A manager
API key can be bound to the desired upstream to keep its traffic in that pool.
The existing New API channels and manager keys are not changed by installation.

For a new New API channel, the direct backend base address is
`http://127.0.0.1:7861` or `http://127.0.0.1:7862` (without `/v1` in the New API
channel Base URL). Its credential is that instance's `config.json` `api_key`.
Direct calls bypass the manager's request history, key limits and usage
statistics. To retain those, continue calling `127.0.0.1:7864` with a manager
key explicitly bound to the new upstream. An empty pool can list models and
answer authenticated status requests, but cannot complete real model inference.
Its `/healthz` correctly returns 503 with `total=0`; the manager's readiness
probe will also show it as unavailable until usable accounts are imported.

Do not put the same OAuth account into multiple pools without considering its
combined upstream concurrency and usage. Limits are local to each backend.

## Stop, resume, restart and remove

First disable any New API channel that calls the instance directly, and let
in-flight requests complete. Then:

```sh
# Disable the manager upstream and its service/autostart; preserve all data.
shiny-workbuddy-instances stop 7861

# Resume the same instance and re-enable its manager registration.
shiny-workbuddy-instances start 7861

# Restart a single backend after manually editing its config.
shiny-workbuddy-instances restart 7861
```

The manager's non-default upstream restart button currently supports Docker
containers only. These native instances use the command above; do not invent a
container name for them or restart the primary service as a substitute.

```sh
# Remove the manager registration, unit and binary. Keep config/state.
shiny-workbuddy-instances remove 7861
```

Removal refuses while manager keys reference the upstream or the account
directory contains files. Move accounts and rebind/delete manager keys first.
Configuration/state remain at the listed directory for review or reinstall.
Removing an instance never removes the primary or the other instance. There is
no recursive data-delete operation. The management database is accessed under
the manager's UID to preserve SQLite sidecar ownership.

Logs use journald:

```sh
journalctl -u workbuddy2api-7861.service --since today
```

No provider keys, OAuth files, runtime state, database files or binaries belong
in Git. The deployment helper reports only non-secret status and hashes.
