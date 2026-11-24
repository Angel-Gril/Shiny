"""Read-only RU configuration checks. Credentials stay in process environment.

This checks configuration, not merchant approval, DNS/TLS or a capacity benchmark.
Use --help and ops/ru/README.md for the candidate validation sequence.
"""

import argparse
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


class CheckError(Exception):
    pass


class NoAdminRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise CheckError("Management API redirects are not allowed")


class AdminClient:
    def __init__(self, url, token):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")):
            raise CheckError("Use a site origin without credentials, path or query")
        if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise CheckError("Administrator access requires HTTPS outside loopback")
        if not token:
            raise CheckError("Set the administrator access token environment variables")
        self.origin = url.rstrip("/")
        self.token = token

    def get(self, path, anonymous=False):
        headers = {"Accept": "application/json", "User-Agent": "Shiny-RU-readiness"}
        if not anonymous:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(self.origin + path, headers=headers)
        try:
            with urllib.request.build_opener(NoAdminRedirects()).open(request, timeout=20) as response:
                payload = json.loads(response.read(4 * 1024 * 1024), parse_float=Decimal)
        except (OSError, ValueError, urllib.error.HTTPError):
            # Never include raw URLs, response bodies or auth-bearing exceptions.
            raise CheckError("Candidate management API failed: " + path.split("?")[0]) from None
        if payload.get("success") is not True:
            raise CheckError("Candidate management API rejected: " + path.split("?")[0])
        return payload

    def rows(self, path):
        result = []
        for page in range(1, 101):
            data = self.get(path + "?p=" + str(page) + "&size=100")["data"]
            result.extend(data.get("items", []))
            if len(result) >= data.get("total", 0):
                return result
        raise CheckError("Configuration list exceeds the bounded 10000-row check")


def env_values(path):
    if not path:
        return {}
    values = {}
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        key, separator, value = text.partition("=")
        if separator:
            values[key.strip()] = value.strip().strip('"\'')
    return values


def options(client):
    return {row["key"]: row["value"] for row in client.get("/api/option/")["data"]}


def option_json(values, primary, alias=None, default=None):
    value = values.get(primary, values.get(alias, "") if alias else "")
    if not value:
        return default
    try:
        return json.loads(value, parse_float=Decimal)
    except (ValueError, TypeError):
        raise CheckError("Invalid JSON option: " + primary) from None


def storage_identity(dsn, sqlite_path=None):
    """Strip credentials/options and compare known endpoints, never print DSNs.

    Distinct endpoint tuples still require a deployment review of DNS aliases,
    connection proxies and mounts; this is a configuration check, not a probe.
    """
    if not dsn or dsn.startswith("local"):
        path = (sqlite_path or "").split("?", 1)[0]
        if not (PurePosixPath(path).is_absolute() or PureWindowsPath(path).is_absolute()):
            return None
        return ("sqlite", path.replace("\\", "/"))
    mysql = re.search(r"@(tcp|unix)\(([^)]*)\)/([^?]+)", dsn)
    if mysql:
        network, address, database = mysql.groups()
        if network == "unix":
            return ("mysql", "unix", address, urllib.parse.unquote(database))
        parsed = urllib.parse.urlsplit("//" + address)
        scheme, default_port = "mysql", 3306
    else:
        parsed = urllib.parse.urlsplit(dsn)
        scheme = parsed.scheme
        if scheme in ("postgres", "postgresql"):
            scheme, default_port = "postgres", 5432
        elif scheme in ("redis", "rediss"):
            scheme, default_port = "redis", 6379
        else:
            return None
        database = parsed.path.lstrip("/") or ("0" if scheme == "redis" else "")
    host = (parsed.hostname or "").lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        host = "loopback"
    if not host or not database:
        return None
    return (scheme, host, parsed.port or default_port, urllib.parse.unquote(database))


def inspect_configuration(args):
    ru = AdminClient(args.ru_url, os.environ.get("SHINY_RU_ADMIN_ACCESS_TOKEN"))
    main = AdminClient(args.main_url, os.environ.get("SHINY_MAIN_ADMIN_ACCESS_TOKEN"))
    checks = []

    def report(code, passed, detail, manual=False):
        checks.append({"check": code, "status": "manual" if manual else ("pass" if passed else "fail"), "detail": detail})

    ru_status = ru.get("/api/status", anonymous=True)["data"]
    main_status = main.get("/api/status", anonymous=True)["data"]
    ru_options, main_options = options(ru), options(main)
    pricing = ru.get("/api/pricing", anonymous=True)
    report("ru_profile", ru_status.get("site_profile") == "ru" and ru_status.get("default_language") == "ru",
           "RU profile and default console language must both be ru")
    report("public_single_group", set(pricing.get("usable_group", {})) == {"default"}
           and set(pricing.get("group_ratio", {})) == {"default"}
           and Decimal(str(pricing.get("group_ratio", {}).get("default", 0))) > 0,
           "Anonymous pricing must expose one paid default group")
    # The option API includes legacy/canonical aliases that can hold an older
    # serialization. Query runtime group handlers for the effective result.
    active_groups = ru.get("/api/group/")["data"]
    administrator = ru.get("/api/user/self")["data"]
    signed_in_groups = ru.get("/api/user/self/groups")["data"]
    special_groups = option_json(ru_options, "group_ratio_setting.group_special_usable_group", default={})
    report("group_configuration", set(active_groups) == {"default"} and not any(special_groups.values()),
           "Remove alternate runtime price groups and special group permissions")
    if administrator.get("group") == "default":
        report("customer_group_price", set(signed_in_groups) == {"default"}
               and Decimal(str(signed_in_groups["default"]["ratio"])) == Decimal(str(pricing["group_ratio"]["default"])),
               "The default customer group must pay the same ratio as public pricing")
    else:
        report("customer_group_price", False, "Administrator uses another group; verify public prices with a default-group customer session", manual=True)
    report("auto_groups", option_json(ru_options, "AutoGroups", default=[]) == ["default"]
           and ru_options.get("DefaultUseAutoGroup") == "false", "Auto selection must not introduce other groups")
    report("usd_accounting", ru_status.get("quota_display_type") == "USD"
           and Decimal(str(ru_status.get("quota_per_unit", 0))) > 0
           and Decimal(str(pricing.get("quota_per_unit", 0))) == Decimal(str(ru_status.get("quota_per_unit", -1))),
           "RU wallet and pricing must use the same positive quota/USD conversion")
    users = ru.rows("/api/user/")
    report("customer_groups", all(user.get("group") == "default" for user in users if user.get("role", 0) < 10),
           "Every RU customer account must belong to default")
    report("single_retry_owner", int(ru_options.get("RetryTimes", "-1")) == 0,
           "RU retries must be zero; upstream failover belongs to the main site")
    channels = [channel for channel in ru.rows("/api/channel/") if channel.get("status") == 1]
    ru_authority = urllib.parse.urlsplit(ru.origin).netloc
    main_authority = urllib.parse.urlsplit(main.origin).netloc
    destinations = []
    for channel in channels:
        target = urllib.parse.urlsplit(channel.get("base_url") or "")
        destinations.append(target.netloc == main_authority and target.netloc != ru_authority
                            and not target.username and not target.password
                            and target.path in ("", "/") and not target.query and not target.fragment)
    report("upstream_destinations", bool(channels) and all(destinations)
           and all(channel.get("group") == "default" for channel in channels),
           "Enabled RU channels must use the supplied main origin, no /v1 suffix or RU loop")
    report("published_models", bool(pricing.get("data")) and all(
        "default" in row.get("enable_groups", []) or "all" in row.get("enable_groups", [])
        for row in pricing.get("data", [])), "Publish only enabled and validated default-group models")
    report("internal_service_accounts", bool(args.service_user), "Specify every main-site internal RU account ID")
    quota_per_unit = Decimal(str(main_status.get("quota_per_unit", 0)))
    global_capacity = int(main_options.get("ModelRequestConcurrencyGlobal", "0"))
    overrides = option_json(main_options, "ModelRequestConcurrencyUserOverrides", default={})
    for user_id in args.service_user:
        account = main.get("/api/user/" + str(user_id))["data"]
        capacity = int(overrides.get(str(user_id), main_options.get("ModelRequestConcurrencyPerUser", "0")))
        report("internal_account_" + str(user_id), account.get("role") == 1 and account.get("status") == 1,
               "Use an enabled ordinary service account, not an administrator")
        report("internal_balance_" + str(user_id), quota_per_unit > 0 and Decimal(account.get("quota", 0)) >= args.min_internal_usd * quota_per_unit,
               "Internal credit must cover the configured reserve in main-site quota units")
        report("internal_capacity_" + str(user_id), capacity >= args.target_concurrency and global_capacity >= args.target_concurrency + args.domestic_headroom,
               "Service-account concurrency and global domestic headroom must cover the target")
    ru_env, main_env = env_values(args.ru_env), env_values(args.main_env)
    if ru_env and main_env:
        for key in ("SESSION_SECRET", "CRYPTO_SECRET"):
            report("isolated_" + key.lower(), bool(ru_env.get(key)) and bool(main_env.get(key)) and ru_env[key] != main_env[key],
                   "Both instances require separate " + key + " values")
        ru_db = storage_identity(ru_env.get("SQL_DSN"), ru_env.get("SQLITE_PATH"))
        main_db = storage_identity(main_env.get("SQL_DSN"), main_env.get("SQLITE_PATH"))
        ru_log = storage_identity(ru_env.get("LOG_SQL_DSN") or ru_env.get("SQL_DSN"), ru_env.get("SQLITE_PATH"))
        main_log = storage_identity(main_env.get("LOG_SQL_DSN") or main_env.get("SQL_DSN"), main_env.get("SQLITE_PATH"))
        report("isolated_database", bool(ru_db and main_db) and ru_db not in (main_db, main_log),
               "RU database endpoint/name must differ; changing credentials alone does not isolate storage", manual=not (ru_db and main_db))
        report("isolated_logs", bool(ru_log and main_log and main_db) and ru_log not in (main_log, main_db),
               "RU logs must not use the main or main-log database", manual=not (ru_log and main_log and main_db))
        ru_cache = storage_identity(ru_env.get("REDIS_CONN_STRING")) if ru_env.get("REDIS_CONN_STRING") else None
        main_cache = storage_identity(main_env.get("REDIS_CONN_STRING")) if main_env.get("REDIS_CONN_STRING") else None
        report("isolated_cache", not ru_env.get("REDIS_CONN_STRING") or bool(ru_cache and main_cache and ru_cache != main_cache),
               "Use an independent Redis instance/database and ACL; credential changes do not isolate keys",
               manual=bool(ru_env.get("REDIS_CONN_STRING")) and not (ru_cache and main_cache))
        report("storage_identity_review", False,
               "Confirm DSN hosts/proxies and SQLite mounts map to distinct storage, with separate users and backup access", manual=True)
    else:
        report("instance_isolation", False, "Supply both private env files to check DB/session/cache separation", manual=True)
    report("retail_cost_margin", False, "Compare measured dual-hop charges for token/cache/context/image cases before publishing prices", manual=True)
    report("merchant_and_refunds", False, "Small real payments, under/overpayment, expiry and original-payment refunds need merchant acceptance", manual=True)
    report("capacity_and_network", False, "Measure actual concurrency and Russian-network access after candidate deployment", manual=True)
    return {"configuration_passed": all(item["status"] != "fail" for item in checks),
            "deployment_accepted": False, "checks": checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ru-url", required=True)
    parser.add_argument("--main-url", required=True, help="Use the actual internal origin configured on RU channels")
    parser.add_argument("--ru-env")
    parser.add_argument("--main-env")
    parser.add_argument("--service-user", type=int, action="append", default=[])
    parser.add_argument("--target-concurrency", type=int, default=20)
    parser.add_argument("--domestic-headroom", type=int, default=12)
    parser.add_argument("--min-internal-usd", type=Decimal, default=Decimal("100"))
    args = parser.parse_args()
    if args.target_concurrency < 1 or args.domestic_headroom < 0 or args.min_internal_usd < 0 or any(value < 1 for value in args.service_user):
        parser.error("Reserve and capacity parameters must be nonnegative; concurrency and IDs must be positive")
    try:
        result = inspect_configuration(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["configuration_passed"] else 1
    except (CheckError, InvalidOperation, KeyError, TypeError, ValueError):
        print("Readiness check failed: inspect candidate API access and configuration", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
