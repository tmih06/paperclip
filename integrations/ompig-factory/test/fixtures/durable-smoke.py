"""Exercise the real Go harness against a loopback-only deterministic model, never a paid API."""
import base64
import http.server
import json
import os
import pathlib
import subprocess
import threading
import time

calls = 0


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        global calls
        self.rfile.read(int(self.headers["Content-Length"]))
        calls += 1
        if pathlib.Path("/state/fixture-slow").exists():
            time.sleep(5)
        if calls == 1:
            name, arguments = "write", {"path": "factory-result.txt", "content": "verified\n"}
        elif calls == 2:
            name, arguments = "bash", {"command": 'test "$(cat factory-result.txt)" = verified'}
            if os.environ.get("FACTORY_CALLBACK_CHECK") == "1":
                arguments["command"] += ' && curl -fsS -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/agents/me" > /tmp/factory-api.json'
        else:
            name = None
        delta = {"role": "assistant"}
        if name:
            delta["tool_calls"] = [{"index": 0, "id": f"call-{calls}", "type": "function",
                                    "function": {"name": name, "arguments": json.dumps(arguments)}}]
        else:
            delta["content"] = "Implemented the fixture and verified its contents."
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        frames = [{"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if name else "stop"}]},
                  {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}]
        for frame in frames:
            self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()
profile = pathlib.Path("/state/fixture-profile")
(profile / "agent").mkdir(parents=True, mode=0o700)
(profile / "agent" / "models.json").write_text(json.dumps({"providers": {"factory-fixture": {
    "api": "openai-completions", "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "apiKey": "synthetic",
    "models": [{"id": "fixture", "name": "fixture", "contextWindow": 128000, "maxTokens": 1024}]
}}}))
if os.environ.get("FACTORY_MODEL_DAEMON") == "1":
    (profile / "ready").write_text("ready")
    threading.Event().wait()

launcher = pathlib.Path("/workspace/factory-launcher.mjs")
launcher.write_bytes(base64.b64decode(os.environ["FACTORY_LAUNCHER_B64"]))
env = dict(os.environ, PIG_HOME=str(profile), PIG_CODING_AGENT_DIR=str(profile / "agent"),
           OMPIG_SLIM_CODING_AGENT_DIR=str(profile / "agent"), PI_OFFLINE="1")
assignment = {"runId": "real-durable-smoke", "cwd": "/workspace", "model": "factory-fixture/fixture", "maxTurns": 8,
              "prompt": "Write factory-result.txt, verify it, and report the result."}
result = subprocess.run(["node", str(launcher)], input=json.dumps(assignment), text=True, capture_output=True, env=env, timeout=30)
print(result.stdout, end="")
print(result.stderr, end="", file=__import__("sys").stderr)
assert result.returncode == 0, "real durable harness failed"
assert calls >= 3, "fixture did not exercise multiple tool rounds"
assert pathlib.Path("/workspace/factory-result.txt").read_text() == "verified\n"
server.shutdown()
