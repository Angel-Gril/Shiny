"""Exercise real RU -> main -> synthetic provider relay and independent billing.

No live service, merchant or credentials are used. Requires a built New API
candidate. Creates isolated temporary SQLite databases, launches two processes,
uses the real management/auth APIs and deletes only its own temporary directory.
"""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import contextlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


PRICES = {
    "main": 'len <= 2000 ? tier("short", p * 1 + c * 2 + cr * 0.25) : tier("long", p * 2 + c * 4 + cr * 0.5)',
    "ru": 'len <= 2000 ? tier("short", p * 2 + c * 4 + cr * 0.5) : tier("long", p * 4 + c * 8 + cr * 1)',
}
MODELS = ["gpt-fixture", "gpt-fixture-long", "gpt-fixture-retry", "gpt-fixture-fail", "gpt-fixture-hold", "gpt-fixture-cancel", "responses-fixture", "image-fixture"]


def wait_for(predicate, description, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        threading.Event().wait(0.05)
    raise AssertionError("Timeout waiting for " + description)


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class FixtureProvider(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), ProviderRequest)
        self.counts = Counter()
        self.lock = threading.Lock()
        self.hold = threading.Event()
        self.cancel = threading.Event()
        self.release = threading.Event()
        self.closed = threading.Event()
        self.invalid_key = False
        self.provider_secret = secrets.token_hex(24)

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class ProviderRequest(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def send_json(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()

    def send_events(self, events, anthropic=False):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        for event in events:
            if anthropic:
                self.wfile.write(("event: " + event["type"] + "\n").encode())
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()
        if not anthropic:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        model = body.get("model", "")
        if "/models/" in self.path:
            model = self.path.split("/models/", 1)[1].split(":")[0]
        provided = self.headers.get("Authorization", "").removeprefix("Bearer ")
        if not provided:
            provided = self.headers.get("x-api-key") or self.headers.get("x-goog-api-key", "")
        if provided != self.server.provider_secret:
            self.server.invalid_key = True
        with self.server.lock:
            self.server.counts[model] += 1
            attempt = self.server.counts[model]
        if model == "gpt-fixture-fail" or (model == "gpt-fixture-retry" and attempt == 1):
            self.send_json({"error": {"message": "Synthetic provider failure", "type": "server_error", "code": "fixture_failure"}}, 500)
            return
        if model == "gpt-fixture-hold":
            self.server.hold.set()
            if not self.server.release.wait(20):
                self.send_json({"error": {"message": "Fixture hold timed out"}}, 500)
                return
        usage = {"prompt_tokens": 3000 if model.endswith("-long") else 1000,
                 "completion_tokens": 100, "total_tokens": 3100 if model.endswith("-long") else 1100,
                 "prompt_tokens_details": {"cached_tokens": 200}}
        chat = {"id": "fixture-chat", "object": "chat.completion", "created": 1, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "fixture ok"}, "finish_reason": "stop"}], "usage": usage}
        if model == "gpt-fixture-cancel":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            # OpenAI-compatible handlers retain one frame for final usage.
            # Three valid chunks let the client observe content across two hops.
            for delta in ({"role":"assistant"}, {"content":"started"}, {"content":" waiting"}):
                chunk={"id":"fixture-cancel","object":"chat.completion.chunk","model":"gpt-fixture-cancel","choices":[{"index":0,"delta":delta,"finish_reason":None}]}
                self.wfile.write(("data: "+json.dumps(chunk)+"\n\n").encode())
                self.wfile.flush()
            self.server.cancel.set()
            self.connection.settimeout(20)
            try:
                self.connection.recv(1)
            except OSError:
                pass
            self.server.closed.set()
            return
        if self.path.startswith("/v1/messages"):
            message = {"id": "fixture-claude", "type": "message", "role": "assistant", "model": model,
                       "content": [{"type": "text", "text": "fixture ok"}], "stop_reason": "end_turn",
                       "stop_sequence": None, "usage": {"input_tokens": 800, "output_tokens": 100, "cache_read_input_tokens": 200, "cache_creation_input_tokens": 0}}
            if body.get("stream"):
                self.send_events([
                    {"type": "message_start", "message": {**message, "content": [], "stop_reason": None, "usage": {**message["usage"], "output_tokens": 0}}},
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "fixture ok"}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 100}},
                    {"type": "message_stop"},
                ], anthropic=True)
            else:
                self.send_json(message)
        elif "/models/" in self.path:
            message = {"candidates": [{"content": {"role": "model", "parts": [{"text": "fixture ok"}]}, "finishReason": "STOP", "index": 0}],
                       "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 100, "totalTokenCount": 1100, "cachedContentTokenCount": 200}, "modelVersion": model}
            if ":streamGenerateContent" in self.path:
                self.send_events([message])
            else:
                self.send_json(message)
        elif self.path.startswith("/v1/responses"):
            response = {"id": "resp_fixture", "object": "response", "created_at": 1, "model": model, "status": "completed",
                        "output": [{"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed",
                                    "content": [{"type": "output_text", "text": "fixture ok", "annotations": []}]}],
                        "usage": {"input_tokens": 1000, "output_tokens": 100, "total_tokens": 1100, "input_tokens_details": {"cached_tokens": 200}}}
            if body.get("stream"):
                self.send_events([{"type": "response.created", "response": {**response, "status": "in_progress", "output": [], "usage": None}},
                                  {"type": "response.output_text.delta", "item_id": "msg_fixture", "output_index": 0, "content_index": 0, "delta": "fixture ok"},
                                  {"type": "response.completed", "response": response}])
            else:
                self.send_json(response)
        elif self.path.startswith("/v1/images/generations"):
            self.send_json({"created": 1, "data": [{"b64_json": "aW1hZ2U=", "revised_prompt": "fixture"}]})
        elif body.get("stream"):
            chunk = {"id": "fixture-chat", "object": "chat.completion.chunk", "created": 1, "model": model}
            self.send_events([{**chunk, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "fixture ok"}, "finish_reason": None}]},
                              {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                              {**chunk, "choices": [], "usage": usage}])
        else:
            self.send_json(chat)


class Instance:
    def __init__(self, label, directory, binary):
        self.label = label
        self.directory = directory
        directory.mkdir()
        self.database = directory / "candidate.db"
        self.port = free_port()
        self.origin = "http://127.0.0.1:" + str(self.port)
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith(("SQL_", "LOG_SQL", "REDIS", "SESSION_", "CRYPTO_", "PAYMENTS_", "SHINY_SITE", "DEFAULT_LANGUAGE", "FRONTEND_BASE"))}
        self.environment.update({"HOST": "127.0.0.1", "PORT": str(self.port), "SQL_DSN": "local", "SQLITE_PATH": str(self.database),
                                 "SESSION_SECRET": secrets.token_hex(32), "CRYPTO_SECRET": secrets.token_hex(32), "SESSION_COOKIE_SECURE": "false",
                                 "MEMORY_CACHE_ENABLED": "true", "GENERATE_DEFAULT_TOKEN": "false", "PAYMENTS_PROVIDERS": "none",
                                 "GLOBAL_API_RATE_LIMIT_ENABLE": "false", "GLOBAL_WEB_RATE_LIMIT_ENABLE": "false", "CRITICAL_RATE_LIMIT_ENABLE": "false",
                                 "SEARCH_RATE_LIMIT_ENABLE": "false", "POLLING_INTERVAL": "60", "BATCH_UPDATE_INTERVAL": "1", "SQL_MAX_OPEN_CONNS": "1", "GIN_MODE": "release"})
        if label == "ru":
            self.environment["SHINY_SITE_PROFILE"] = "ru"
        self.output = (directory / "process.log").open("wb")
        startup = {}
        if os.name == "nt":
            startup["creationflags"] = subprocess.CREATE_NO_WINDOW
        self.process = subprocess.Popen([str(binary)], cwd=directory, env=self.environment, stdout=self.output, stderr=subprocess.STDOUT, **startup)

    def request(self, path, body=None, token=None, method=None, headers=None):
        request_headers = {"Content-Type": "application/json", "Origin": self.origin, "Accept-Language": "en"}
        if token:
            request_headers["Authorization"] = "Bearer " + token
        request_headers.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.origin + path, data=data, method=method, headers=request_headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()
        except (ConnectionResetError, TimeoutError):
            raise AssertionError(self.label + " connection interrupted: " + path.split("?")[0]) from None

    def api(self, path, body=None, token=None, method=None):
        status, _, content = self.request(path, body, token, method)
        value = json.loads(content)
        if status != 200 or value.get("success") is not True:
            # Auth keys, provider keys and raw responses are never printed.
            raise AssertionError(f"{self.label} {method or ('POST' if body else 'GET')} {path.split('?')[0]} rejected: HTTP {status}, code {value.get('code', 'business_error')}")
        return value.get("data")

    def initialize(self):
        def ready():
            if self.process.poll() is not None:
                raise AssertionError(self.label + " candidate process exited")
            try:
                self.api("/api/setup")
                return True
            except (OSError, ValueError):
                return False
        wait_for(ready, self.label + " startup", 90)
        password = "FixtureA9!" + secrets.token_hex(16)
        self.api("/api/setup", {"username": "fixtureadmin", "password": password, "confirmPassword": password, "SelfUseModeEnabled": False, "DemoSiteEnabled": False})
        self.admin = self.login("fixtureadmin", password)

    def login(self, username, password):
        return self.api("/api/user/login", {"username": username, "password": password})["access_token"]

    def option(self, key, value):
        self.api("/api/option/", {"key": key, "value": value}, self.admin, "PUT")

    def register(self, username, password, quota):
        self.api("/api/user/register", {"username": username, "password": password})
        token = self.login(username, password)
        user = self.api("/api/user/self", token=token)
        self.set_quota(user["id"], quota)
        return user["id"], token

    def set_quota(self, user_id, quota):
        # Quota edits deliberately use the audited balance endpoint; generic
        # profile edits ignore quota and must not manufacture paid provenance.
        self.api("/api/user/manage", {"id": user_id, "action": "add_quota", "mode": "override", "value": quota}, self.admin)

    def key(self, access, name="fixture", remain=50000000, unlimited=False):
        self.api("/api/token/", {"name": name, "expired_time": -1, "remain_quota": remain, "unlimited_quota": unlimited, "group": "default"}, access)
        keys = self.api("/api/token/?p=1&size=100", token=access)["items"]
        key_id = next(item["id"] for item in keys if item["name"] == name)
        return self.api("/api/token/" + str(key_id) + "/key", {}, access)["key"], key_id

    def channel(self, name, channel_type, destination, key, models):
        self.api("/api/channel/", {"mode": "single", "channel": {"type": channel_type, "name": name, "base_url": destination,
                  "key": key, "models": ",".join(models), "group": "default", "status": 1, "priority": 0, "weight": 10, "auto_ban": 0}}, self.admin)

    def prices(self, models, expression):
        query = "&".join("model=" + model for model in models)
        snapshot = self.api("/api/option/model_pricing?" + query, token=self.admin)
        self.api("/api/option/model_pricing", {"changes": [{"model_name": item["model_name"], "expected_version": item["version"],
                 "pricing": {"billing_setting.billing_mode": "tiered_expr", "billing_setting.billing_expr": expression}} for item in snapshot["entries"]]}, self.admin, "PATCH")

    def synced(self):
        # Channel writes intentionally publish a sync topic. Wait for the
        # running node to report applying it before making model requests.
        def applied():
            status = self.api("/api/system-info/sync", token=self.admin)
            nodes = [node for node in status["nodes"] if node["online"]]
            return bool(nodes) and all(topic["synced"] for node in nodes for topic in node["topics"].values())
        wait_for(applied, self.label + " configuration sync", 30)

    def db(self, query, parameters=()):
        with contextlib.closing(sqlite3.connect("file:" + self.database.as_posix() + "?mode=ro", uri=True, timeout=5)) as database:
            database.row_factory = sqlite3.Row
            return [dict(row) for row in database.execute(query, parameters)]

    def consumption(self, user_id):
        return self.db("SELECT * FROM logs WHERE user_id = ? AND type = 2 ORDER BY id", (user_id,))

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(5)
        self.output.close()


def run(binary):
    outcomes = []
    with tempfile.TemporaryDirectory(prefix="shiny-ru-two-instance-") as temporary:
        directory = Path(temporary)
        provider = FixtureProvider()
        thread = threading.Thread(target=provider.serve_forever, daemon=True)
        thread.start()
        instances = []
        try:
            main = Instance("main", directory / "main", binary)
            instances.append(main)
            ru = Instance("ru", directory / "ru", binary)
            instances.append(ru)
            main.initialize()
            ru.initialize()
            for instance in instances:
                instance.option("ServerAddress", instance.origin)
                instance.option("general_setting.docs_link", instance.origin + "/docs/")
                instance.option("legal.user_agreement", instance.label + " fixture terms")
                instance.option("legal.privacy_policy", instance.label + " fixture privacy")
                instance.option("QuotaForNewUser", "0")
                instance.option("QuotaForInviter", "0")
                instance.option("QuotaForInvitee", "0")
                instance.option("ModelRequestConcurrencyPerUser", "2")
                instance.option("ModelRequestConcurrencyGlobal", "8")
                instance.option("quota_setting.trust_quota_usd", "0")
            main.option("GroupRatio", '{"default":1,"domestic":1.25}')
            main.option("UserUsableGroups", '{"default":"Default group","domestic":"Domestic group"}')
            main.option("RetryTimes", "1")
            shared_password = "FixtureB9!" + secrets.token_hex(16)
            main_user, main_access = main.register("samecustomer", shared_password, 50000000)
            ru_user, ru_access = ru.register("samecustomer", shared_password, 50000000)
            service_user, service_access = main.register("ruservice", shared_password, 100000000)
            ru_user2, ru_access2 = ru.register("rucustomer2", shared_password, 50000000)
            internal_key, _ = main.key(service_access, "internal")
            domestic_key, _ = main.key(main_access, "domestic")
            ru_key, ru_key_id = ru.key(ru_access)
            ru_key2, _ = ru.key(ru_access2)
            provider_origin = "http://127.0.0.1:" + str(provider.server_port)
            main.channel("fixture-openai", 1, provider_origin, provider.provider_secret, MODELS)
            main.channel("fixture-claude", 14, provider_origin, provider.provider_secret, ["claude-fixture"])
            main.channel("fixture-gemini", 24, provider_origin, provider.provider_secret, ["gemini-fixture"])
            ru.channel("main-relay", 60, main.origin, internal_key, MODELS + ["claude-fixture", "gemini-fixture"])
            for instance in instances:
                instance.prices([model for model in MODELS if model != "image-fixture"] + ["claude-fixture", "gemini-fixture"], PRICES[instance.label])
                instance.prices(["image-fixture"], 'tier("image", fixed(0.04)) * image_count' if instance is ru else 'tier("image", fixed(0.02)) * image_count')
            main.option("ModelRequestConcurrencyPerUser", "1")
            main.option("ModelRequestConcurrencyUserOverrides", json.dumps({str(service_user): 4}))
            main.synced()
            ru.synced()
            # Both account databases accept the same registration, but sessions and
            # model keys fail across origins even when numerical IDs coincide.
            for destination, access in ((main, ru_access), (ru, main_access)):
                assert destination.request("/api/user/self", token=access)[0] == 401
            for destination, key in ((main, ru_key), (ru, domestic_key)):
                assert destination.request("/v1/models", token=key)[0] == 401
            assert ru.api("/api/status")["default_language"] == "ru"
            assert ru.api("/api/status")["user_agreement_enabled"] is True
            assert ru.api("/api/status")["privacy_policy_enabled"] is True
            assert ru.api("/api/user-agreement") == "ru fixture terms"
            assert main.api("/api/user-agreement") == "main fixture terms"
            assert set(json.loads(ru.request("/api/pricing")[2])["usable_group"]) == {"default"}
            assert "domestic" in json.loads(main.request("/api/pricing")[2])["usable_group"]
            outcomes.append("Independent registrations, sessions, keys and public single-group pricing")
            print("Passed account/key isolation and group pricing", flush=True)

            def assert_charge(path, body, expected_ru, expected_main, headers=None):
                before_ru, before_main = len(ru.consumption(ru_user)), len(main.consumption(service_user))
                balance_ru = ru.db("SELECT quota FROM users WHERE id=?", (ru_user,))[0]["quota"]
                balance_main = main.db("SELECT quota FROM users WHERE id=?", (service_user,))[0]["quota"]
                token_before = ru.db("SELECT remain_quota FROM tokens WHERE id=?", (ru_key_id,))[0]["remain_quota"]
                status, _, content = ru.request(path, body, ru_key, headers=headers)
                if status != 200:
                    error = json.loads(content).get("error", {})
                    raise AssertionError(path + " relay HTTP " + str(status) + ", error code " + str(error.get("code")))
                assert b"fixture" in content or b"aW1hZ2U=" in content
                logs_ru = wait_for(lambda: (logs if len(logs := ru.consumption(ru_user)) == before_ru + 1 else None), "RU settled log")
                logs_main = wait_for(lambda: (logs if len(logs := main.consumption(service_user)) == before_main + 1 else None), "main settled log")
                assert logs_ru[-1]["quota"] == expected_ru, f"RU quota expected {expected_ru}, got {logs_ru[-1]['quota']} ({path})"
                assert logs_main[-1]["quota"] == expected_main, f"Main quota expected {expected_main}, got {logs_main[-1]['quota']} ({path})"
                assert ru.db("SELECT quota FROM users WHERE id=?", (ru_user,))[0]["quota"] == balance_ru - expected_ru
                assert main.db("SELECT quota FROM users WHERE id=?", (service_user,))[0]["quota"] == balance_main - expected_main
                assert ru.db("SELECT remain_quota FROM tokens WHERE id=?", (ru_key_id,))[0]["remain_quota"] == token_before - expected_ru
                assert logs_ru[-1].get("upstream_request_id") == logs_main[-1].get("request_id") and logs_main[-1].get("request_id"), "Dual-hop request IDs do not correlate"
                return content

            chat = {"model": "gpt-fixture", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 100}
            assert_charge("/v1/chat/completions", chat, 1050, 525)
            assert_charge("/v1/chat/completions", {**chat, "model": "gpt-fixture-long"}, 6100, 3050)
            streaming = assert_charge("/v1/chat/completions", {**chat, "stream": True, "stream_options": {"include_usage": True}}, 1050, 525)
            assert b"[DONE]" in streaming and b'"usage"' in streaming
            for stream in (False, True):
                assert_charge("/v1/messages", {"model": "claude-fixture", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 100, "stream": stream}, 1050, 525,
                              {"anthropic-version": "2023-06-01"})
                assert_charge("/v1beta/models/gemini-fixture:" + ("streamGenerateContent?alt=sse" if stream else "generateContent"),
                              {"contents": [{"role": "user", "parts": [{"text": "hello"}]}], "generationConfig": {"maxOutputTokens": 100}}, 1050, 525)
                assert_charge("/v1/responses", {"model": "responses-fixture", "input": "hello", "stream": stream, "max_output_tokens": 100}, 1050, 525)
            assert_charge("/v1/images/generations", {"model": "image-fixture", "prompt": "fixture image", "n": 2, "response_format": "b64_json"}, 20000, 10000)
            outcomes.append("Chat/cache/context tiers, streaming, native Anthropic/Gemini, Responses and image settlement: exact integer quotas at both hops")
            print("Passed core protocol and exact dual-hop billing matrix", flush=True)
            retry_before = provider.counts["gpt-fixture-retry"]
            assert_charge("/v1/chat/completions", {**chat, "model": "gpt-fixture-retry"}, 1050, 525)
            assert provider.counts["gpt-fixture-retry"] - retry_before == 2
            outcomes.append("Main-site retry succeeds once, RU retries disabled, each wallet charged once")
            before = ru.db("SELECT quota FROM users WHERE id=?", (ru_user,))[0]["quota"]
            logs_before = len(ru.consumption(ru_user))
            assert ru.request("/v1/chat/completions", {**chat, "model": "gpt-fixture-fail"}, ru_key)[0] >= 400
            wait_for(lambda: ru.db("SELECT quota FROM users WHERE id=?", (ru_user,))[0]["quota"] == before, "failure reservation refund")
            assert len(ru.consumption(ru_user)) == logs_before
            assert provider.counts["gpt-fixture-fail"] == 2, "Retries multiplied across the two hops"
            service_balance = main.db("SELECT quota FROM users WHERE id=?", (service_user,))[0]["quota"]
            main.set_quota(service_user, 0)
            upstream_count = provider.counts["gpt-fixture"]
            assert ru.request("/v1/chat/completions", chat, ru_key)[0] >= 400
            wait_for(lambda: ru.db("SELECT quota FROM users WHERE id=?", (ru_user,))[0]["quota"] == before, "upstream-account failure refund")
            assert provider.counts["gpt-fixture"] == upstream_count
            main.set_quota(service_user, service_balance)
            outcomes.append("Upstream failure and depleted internal account refund RU reservations without provider call or retail credit")
            limited_key, _ = ru.key(ru_access, "too-small", remain=1)
            assert ru.request("/v1/chat/completions", {**chat, "messages": [{"role": "user", "content": "budget " * 20}]}, limited_key)[0] >= 400
            outcomes.append("Limited customer key rejects insufficient reservation")
            print("Passed failure refunds, retry ownership and key budget", flush=True)

            # Held requests expose admission without timing guesses. Distinct RU
            # users share a main service account while their individual key
            # budgets remain scoped to each customer.
            with ThreadPoolExecutor(max_workers=4) as executor:
                held = [executor.submit(ru.request, "/v1/chat/completions", {**chat, "model": "gpt-fixture-hold"}, key) for key in (ru_key, ru_key, ru_key2, ru_key2)]
                wait_for(lambda: provider.counts["gpt-fixture-hold"] == 4, "four admitted internal-account requests")
                assert ru.request("/v1/chat/completions", chat, ru_key)[0] == 429
                assert main.request("/v1/chat/completions", chat, internal_key)[0] == 429
                provider.release.set()
                assert all(future.result()[0] == 200 for future in held)
            wait_for(lambda: len(ru.consumption(ru_user2)) == 2, "second customer's own consumption")
            assert all(row["model_name"] == "gpt-fixture-hold" for row in ru.api("/api/log/self?p=1&size=100", token=ru_access2)["items"] if row["type"] == 2)
            outcomes.append("Per-customer concurrency, shared internal-account override, admission rejection and isolated logs")
            print("Passed shared service-account concurrency and log isolation", flush=True)

            # Disconnect a real streaming client after the first content event.
            # Validate cancellation propagates and reservations settle/refund,
            # never asserting that already generated output is automatically free.
            connection = http.client.HTTPConnection("127.0.0.1", ru.port, timeout=20)
            connection.request("POST", "/v1/chat/completions", json.dumps({**chat, "model": "gpt-fixture-cancel", "stream": True}),
                               {"Authorization": "Bearer " + ru_key, "Content-Type": "application/json"})
            response = connection.getresponse()
            assert response.status == 200
            wait_for(lambda: provider.cancel.is_set(), "upstream stream start")
            assert response.readline().startswith(b"data:")
            response.close()
            connection.close()
            wait_for(lambda: provider.closed.is_set(), "cancel propagation through both hops", 25)
            wait_for(lambda: provider.counts["gpt-fixture-cancel"] == 1, "cancel not retried")
            outcomes.append("Streaming disconnect propagates through both instances; no post-disconnect retry")
            print("Passed dual-hop stream cancellation", flush=True)

            spec = importlib.util.spec_from_file_location("ru_readiness", Path(__file__).resolve().parents[1] / "readiness.py")
            readiness = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(readiness)
            environment = {"SHINY_RU_ADMIN_ACCESS_TOKEN": ru.admin, "SHINY_MAIN_ADMIN_ACCESS_TOKEN": main.admin}
            previous = {key: os.environ.get(key) for key in environment}
            os.environ.update(environment)
            try:
                result = readiness.inspect_configuration(argparse.Namespace(ru_url=ru.origin, main_url=main.origin, ru_env=None, main_env=None,
                    service_user=[service_user], target_concurrency=4, domestic_headroom=4, min_internal_usd=0))
                assert result["configuration_passed"], "Readiness rejected: " + ", ".join(item["check"] for item in result["checks"] if item["status"] == "fail")
                ru.option("ServerAddress", "https://ru.fixture.test")
                result = readiness.inspect_configuration(argparse.Namespace(ru_url=ru.origin, ru_public_url="https://ru.fixture.test", main_url=main.origin,
                    ru_env=None, main_env=None, service_user=[service_user], target_concurrency=4, domestic_headroom=4, min_internal_usd=0))
                assert result["configuration_passed"], "Readiness confused the internal management address with the public RU origin"
                ru.option("ServerAddress", main.origin)
                result = readiness.inspect_configuration(argparse.Namespace(ru_url=ru.origin, main_url=main.origin, ru_env=None, main_env=None,
                    service_user=[service_user], target_concurrency=4, domestic_headroom=4, min_internal_usd=0))
                assert any(item["check"] == "ru_public_address" and item["status"] == "fail" for item in result["checks"]), "Readiness missed a main-site email/payment return address"
                ru.option("ServerAddress", ru.origin)
                ru.option("legal.privacy_policy", "")
                result = readiness.inspect_configuration(argparse.Namespace(ru_url=ru.origin, main_url=main.origin, ru_env=None, main_env=None,
                    service_user=[service_user], target_concurrency=4, domestic_headroom=4, min_internal_usd=0))
                assert any(item["check"] == "legal_documents" and item["status"] == "fail" for item in result["checks"]), "Readiness missed an empty privacy policy that disables consent"
                assert main.api("/api/privacy-policy") == "main fixture privacy", "RU legal settings changed the main site"
                ru.option("legal.privacy_policy", "ru fixture privacy")
                ru.option("GroupRatio", '{"default":1,"unexpected":2}')
                result = readiness.inspect_configuration(argparse.Namespace(ru_url=ru.origin, main_url=main.origin, ru_env=None, main_env=None,
                    service_user=[service_user], target_concurrency=4, domestic_headroom=4, min_internal_usd=0))
                assert not result["configuration_passed"], "Readiness missed an alternate RU group"
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
            assert not provider.invalid_key, "A customer credential leaked into the provider hop"
            outcomes.append("Independent legal documents; readiness rejects wrong-site return addresses, empty policies and hidden alternate groups; provider sees only its synthetic secret")
        except Exception:
            for instance in instances:
                if instance.process.poll() is not None:
                    print(instance.label + " process exited: " + str(instance.process.returncode), file=sys.stderr)
                    lines = (instance.directory / "process.log").read_text(encoding="utf-8", errors="replace").splitlines()
                    start = next((index for index, line in enumerate(lines) if line.startswith(("panic:", "fatal error:"))), len(lines))
                    # Go stack traces contain code/line names, not HTTP headers.
                    for line in lines[start:]:
                        print(line, file=sys.stderr)
            raise
        finally:
            provider.release.set()
            for instance in reversed(instances):
                instance.stop()
            provider.shutdown()
            provider.server_close()
    return outcomes


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    args = parser.parse_args()
    if not args.binary.is_file():
        parser.error("Build the candidate binary first")
    try:
        outcomes = run(args.binary.resolve())
        print(json.dumps({"result": "passed", "checks": outcomes, "live_provider_tested": False}, indent=2))
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
