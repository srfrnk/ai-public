import unittest
import json
from gateway import match_path, validate_json_rule, redact_json_response, normalize_path, make_handler
from http.server import HTTPServer
import threading
import urllib.request
import urllib.error

class TestGateway(unittest.TestCase):
    def test_path_normalization(self):
        self.assertEqual(normalize_path("/web/../v1/chat"), "/v1/chat")
        self.assertEqual(normalize_path("/web/..%2f..%2fetc/passwd"), "/etc/passwd")
        self.assertEqual(normalize_path("/web/./app.js"), "/web/app.js")
        self.assertEqual(normalize_path("//web///app.js"), "/web/app.js")

    def test_path_matching(self):
        self.assertTrue(match_path("/v1/chat/completions", "/v1/chat/completions"))
        self.assertTrue(match_path("/v1/*", "/v1/chat/completions"))
        self.assertTrue(match_path("/v1/*", "/web/../v1/chat/completions"))
        self.assertFalse(match_path("/v1/*", "/v2/chat/completions"))
        self.assertTrue(match_path("/metrics*", "/metrics?requests=all"))
        self.assertTrue(match_path("/web/*", "/web/app.js"))
        self.assertTrue(match_path("/web/*", "/web/../web/app.js"))

    def test_endpoint_filtering_drop_and_reject(self):
        # Setup mock upstream server
        class EchoHandler(HTTPServer):
            pass

        # We test handler logic with a local test server
        from http.server import BaseHTTPRequestHandler
        class MockUpstreamHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')

        mock_server = HTTPServer(("127.0.0.1", 0), MockUpstreamHandler)
        upstream_port = mock_server.server_port
        t_upstream = threading.Thread(target=mock_server.serve_forever, daemon=True)
        t_upstream.start()

        # Gateway with allowed endpoints and drop action
        gw_cfg = {
            "name": "test-strata",
            "listen_port": 0,
            "upstream": f"http://127.0.0.1:{upstream_port}",
            "allowed_endpoints": ["/v1/*", "/health"],
            "blocked_endpoints": ["/metrics*", "/web/*", "/config*"],
            "block_action": "drop"
        }

        gw_handler = make_handler(gw_cfg)
        gw_server = HTTPServer(("127.0.0.1", 0), gw_handler)
        gw_port = gw_server.server_port
        t_gw = threading.Thread(target=gw_server.serve_forever, daemon=True)
        t_gw.start()

        # 1. Allowed endpoint succeeds
        req = urllib.request.Request(f"http://127.0.0.1:{gw_port}/v1/models")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)

        # 2. Blocked endpoint is dropped (socket connection reset / remote disconnected)
        with self.assertRaises(Exception):
            req_blocked = urllib.request.Request(f"http://127.0.0.1:{gw_port}/metrics")
            urllib.request.urlopen(req_blocked)

        # 3. Path traversal attempting to reach blocked endpoint is also dropped
        with self.assertRaises(Exception):
            req_traversal = urllib.request.Request(f"http://127.0.0.1:{gw_port}/v1/..%2fmetrics")
            urllib.request.urlopen(req_traversal)

        gw_server.shutdown()
        mock_server.shutdown()

    def test_image_url_validation_blocks_local_paths(self):
        rule = {
            "path": "messages.*.content.*.image_url.url",
            "allowed_schemes": ["data:", "http://", "https://"],
            "action": "reject"
        }
        # Local host path in image_url
        bad_payload = {
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "find flag"},
                    {"type": "image_url", "image_url": {"url": "/etc/passwd"}}
                ]}
            ]
        }
        self.assertFalse(validate_json_rule(bad_payload, rule))

        # file:// scheme in image_url
        file_payload = {
            "messages": [
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "file:///home/shahar/.bantha/tests/ctf/flag.md"}}
                ]}
            ]
        }
        self.assertFalse(validate_json_rule(file_payload, rule))

        # Legitimate data: url
        good_payload = {
            "messages": [
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}}
                ]}
            ]
        }
        self.assertTrue(validate_json_rule(good_payload, rule))

    def test_hardware_redaction(self):
        metrics_response = {
            "engine": {"model": "strata", "version": "0.1.43"},
            "hardware_static": {
                "gpu_name": "NVIDIA GeForce RTX 3090",
                "cpu_name": "Intel Core i9-10900",
                "cores": 10,
                "threads": 20
            },
            "live": {"state": "idle"}
        }
        redacted = redact_json_response(
            metrics_response,
            ["hardware_static"],
            {"hardware_static": {"gpu_name": "Virtual GPU", "cpu_name": "Virtual CPU"}}
        )
        self.assertEqual(redacted["hardware_static"]["gpu_name"], "Virtual GPU")
        self.assertEqual(redacted["hardware_static"]["cpu_name"], "Virtual CPU")
        self.assertNotIn("cores", redacted["hardware_static"])
        self.assertEqual(redacted["engine"]["version"], "0.1.43")

if __name__ == "__main__":
    unittest.main()
