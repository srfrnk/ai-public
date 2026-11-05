#!/usr/bin/env python3
"""
Bantha Generic Service Gateway.
Multi-service reverse proxy with declarative request validation
and response transformation (e.g. image path oracle protection and telemetry redaction).
"""

import sys
import os
import json
import posixpath
import socket
import threading
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, urlunsplit, unquote

def normalize_path(path):
    # Unquote repeatedly until stable to catch double encoding (%252e%252e)
    prev = None
    curr = path
    for _ in range(3):
        curr = unquote(curr)
        if curr == prev:
            break
        prev = curr
    # Strip query or fragment if present without interpreting leading '//' as netloc
    if "?" in curr:
        curr = curr.split("?", 1)[0]
    if "#" in curr:
        curr = curr.split("#", 1)[0]
    # Posix normalization (resolves /.. and /.)
    norm = posixpath.normpath(curr)
    # POSIX standard treats leading double slashes '//' specially; collapse multiple leading slashes
    if norm.startswith("//") and not norm.startswith("///"):
        norm = "/" + norm.lstrip("/")
    # Ensure leading slash is preserved
    if not norm.startswith("/"):
        norm = "/" + norm
    # Preserve trailing slash if original had it (unless root)
    if curr.endswith("/") and not norm.endswith("/"):
        norm += "/"
    return norm

def match_path(pattern, path):
    norm_path = normalize_path(path)
    norm_pattern = normalize_path(pattern) if not pattern.endswith("*") else pattern
    if norm_pattern == norm_path:
        return True
    if pattern.endswith("/*"):
        prefix = pattern[:-2]
        return norm_path == prefix or norm_path.startswith(prefix + "/")
    if pattern.endswith("*"):
        prefix = pattern[:-1]
        return norm_path.startswith(prefix)
    return False

def validate_json_rule(data, rule):
    # Rule example:
    # {"path": "messages.*.content.*.image_url.url", "allowed_schemes": ["data:", "http://", "https://"], "action": "reject"}
    path_tokens = rule.get("path", "").split(".")
    allowed_schemes = tuple(rule.get("allowed_schemes", []))

    def walk(obj, tokens):
        if not tokens:
            if isinstance(obj, str):
                if allowed_schemes and not obj.startswith(allowed_schemes):
                    return False
            return True

        tok = tokens[0]
        rest = tokens[1:]

        if tok == "*":
            if isinstance(obj, list):
                for item in obj:
                    if not walk(item, rest):
                        return False
            elif isinstance(obj, dict):
                for item in obj.values():
                    if not walk(item, rest):
                        return False
        elif isinstance(obj, dict) and tok in obj:
            return walk(obj[tok], rest)
        return True

    return walk(data, path_tokens)

def redact_json_response(data, redact_keys, replacement):
    if isinstance(data, dict):
        new_dict = {}
        for k, v in data.items():
            if k in redact_keys:
                if replacement and k in replacement:
                    new_dict[k] = replacement[k]
                # else drop key
            else:
                new_dict[k] = redact_json_response(v, redact_keys, replacement)
        return new_dict
    elif isinstance(data, list):
        return [redact_json_response(x, redact_keys, replacement) for x in data]
    return data

def make_handler(service_cfg):
    upstream_url = service_cfg.get("upstream", "http://172.17.0.1:8080").rstrip("/")
    allowed_endpoints = service_cfg.get("allowed_endpoints")
    blocked_endpoints = service_cfg.get("blocked_endpoints", [])
    block_action = service_cfg.get("block_action", "drop").lower()
    request_rules = service_cfg.get("request_rules", [])
    response_rules = service_cfg.get("response_rules", [])

    class ServiceHandler(BaseHTTPRequestHandler):
        server_version = "BanthaGateway/1.0"

        def log_message(self, format, *args):
            # Print to stdout in unbuffered mode
            sys.stdout.write(f"[{service_cfg.get('name', 'service')}] %s - - [%s] %s\n" %
                             (self.client_address[0], self.log_date_time_string(), format % args))
            sys.stdout.flush()

        def do_request(self, method):
            norm_path = normalize_path(self.path)

            # 1. Endpoint Access Control (allowed_endpoints & blocked_endpoints)
            is_blocked = False
            for b_pattern in blocked_endpoints:
                if match_path(b_pattern, norm_path):
                    is_blocked = True
                    break

            if not is_blocked and allowed_endpoints is not None:
                # If whitelist is defined, must match at least one allowed pattern
                matched_allowed = False
                for a_pattern in allowed_endpoints:
                    if match_path(a_pattern, norm_path):
                        matched_allowed = True
                        break
                if not matched_allowed:
                    is_blocked = True

            if is_blocked:
                if block_action == "drop":
                    # Abruptly drop the socket connection with no response
                    try:
                        self.close_connection = True
                        if hasattr(self.connection, "shutdown"):
                            self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                    except Exception:
                        pass
                    return
                else:
                    self.send_response(403)
                    self.send_header("Content-Type", "application/json")
                    resp = json.dumps({"error": {"message": "Access denied by gateway policy", "type": "forbidden"}}).encode("utf-8")
                    self.send_header("Content-Length", str(len(resp)))
                    self.end_headers()
                    self.wfile.write(resp)
                    return

            parsed_path = urlsplit(self.path)
            path_only = parsed_path.path

            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else b""

            # 2. Apply Request Rules
            for rule in request_rules:
                if method in rule.get("methods", [method]) and match_path(rule.get("endpoint", ""), path_only):
                    for validator in rule.get("json_validators", []):
                        try:
                            json_body = json.loads(body.decode("utf-8"))
                            if not validate_json_rule(json_body, validator):
                                err_msg = validator.get("error_message", "Request rejected by sandbox security policy")
                                self.send_response(400)
                                self.send_header("Content-Type", "application/json")
                                resp_bytes = json.dumps({"error": {"message": err_msg, "type": "policy_violation"}}).encode("utf-8")
                                self.send_header("Content-Length", str(len(resp_bytes)))
                                self.end_headers()
                                self.wfile.write(resp_bytes)
                                return
                        except Exception:
                            pass

            # 2. Forward to Upstream
            target_url = f"{upstream_url}{self.path}"
            headers = dict(self.headers)
            headers.pop("Host", None)
            headers["Host"] = urlsplit(upstream_url).netloc

            req = urllib.request.Request(target_url, data=body if body else None, headers=headers, method=method)

            try:
                with urllib.request.urlopen(req, timeout=300) as upstream_resp:
                    status_code = upstream_resp.status
                    resp_headers = upstream_resp.headers
                    resp_body = upstream_resp.read()

                    # 3. Apply Response Redaction Rules
                    for r_rule in response_rules:
                        if method in r_rule.get("methods", [method]) and match_path(r_rule.get("endpoint", ""), path_only):
                            redact_keys = r_rule.get("redact_keys", [])
                            replacement = r_rule.get("replacement", {})
                            try:
                                resp_json = json.loads(resp_body.decode("utf-8"))
                                resp_json = redact_json_response(resp_json, redact_keys, replacement)
                                resp_body = json.dumps(resp_json).encode("utf-8")
                            except Exception:
                                pass

                    self.send_response(status_code)
                    for k, v in resp_headers.items():
                        if k.lower() not in ("content-length", "transfer-encoding", "connection"):
                            self.send_header(k, v)
                    self.send_header("Content-Length", str(len(resp_body)))
                    self.end_headers()
                    self.wfile.write(resp_body)

            except urllib.error.HTTPError as e:
                resp_body = e.read()
                self.send_response(e.code)
                for k, v in e.headers.items():
                    if k.lower() not in ("content-length", "transfer-encoding", "connection"):
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
            except Exception as e:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                err_resp = json.dumps({"error": {"message": f"Gateway upstream connection error: {str(e)}", "type": "bad_gateway"}}).encode("utf-8")
                self.send_header("Content-Length", str(len(err_resp)))
                self.end_headers()
                self.wfile.write(err_resp)

        def do_GET(self):
            self.do_request("GET")

        def do_POST(self):
            self.do_request("POST")

        def do_PUT(self):
            self.do_request("PUT")

        def do_DELETE(self):
            self.do_request("DELETE")

        def do_PATCH(self):
            self.do_request("PATCH")

        def do_OPTIONS(self):
            self.do_request("OPTIONS")

        def do_HEAD(self):
            self.do_request("HEAD")

    return ServiceHandler

def start_service(service_cfg):
    port = int(service_cfg.get("listen_port", 8080))
    handler = make_handler(service_cfg)
    server = HTTPServer(("0.0.0.0", port), handler)
    print(f"[Bantha Gateway] Listening on 0.0.0.0:{port} -> {service_cfg.get('upstream')} (Service: {service_cfg.get('name', 'unnamed')})")
    server.serve_forever()

def main():
    config_file = sys.argv[1] if len(sys.argv) > 1 else "/etc/bantha-gateway/services.json"
    if not os.path.exists(config_file):
        print(f"[Bantha Gateway] Config file {config_file} not found. Running in idle mode.")
        while True:
            threading.Event().wait(3600)

    with open(config_file, "r") as f:
        services = json.load(f)

    if not services:
        print("[Bantha Gateway] No services configured.")
        return

    threads = []
    for s_cfg in services:
        t = threading.Thread(target=start_service, args=(s_cfg,), daemon=True)
        t.start()
        threads.append(t)

    for t in threads:
        t.join()

if __name__ == "__main__":
    main()
