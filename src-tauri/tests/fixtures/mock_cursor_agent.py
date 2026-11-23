#!/usr/bin/env python3
"""Scripted `cursor-agent acp` used by the Cursor backend tests.

Frame shapes follow Cursor's ACP extensions: `cursor/ask_question` and `cursor/create_plan`
arrive as requests from the agent. The prompt text selects the scenario:
  caps  -> echoes the client capabilities the handshake carried
  ask   -> asks a question, then says what was answered
  plan  -> proposes a plan, then says what Cursor was told
  mode  -> says the mode the session runs in
  other -> short streamed reply
`--no-read-only` leaves the plan and ask modes out of the session's options.
"""
import json
import sys

SESSION = "cur_mock"
STATE = {"mode": "agent", "caps": None}
NO_READ_ONLY = "--no-read-only" in sys.argv


def send(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def config_options():
    modes = [{"value": "agent", "name": "Agent"}]
    if not NO_READ_ONLY:
        modes += [{"value": "plan", "name": "Plan"}, {"value": "ask", "name": "Ask"}]
    return [
        {"id": "model", "name": "Model", "category": "model", "type": "select",
         "currentValue": "auto",
         "options": [{"value": "auto", "name": "Auto"}, {"value": "gpt-5", "name": "GPT-5"}]},
        {"id": "mode", "name": "Mode", "category": "mode", "type": "select",
         "currentValue": STATE["mode"], "options": modes},
    ]


def say(text):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": SESSION,
        "update": {"sessionUpdate": "agent_message_chunk",
                   "content": {"type": "text", "text": text}}}})


def request(ident, method, params):
    send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params})
    while True:
        line = sys.stdin.readline()
        if not line:
            sys.exit(0)
        frame = json.loads(line)
        if frame.get("id") == ident and "method" not in frame:
            return frame.get("result")


def prompt(ident, text):
    if text == "caps":
        meta = (STATE["caps"] or {}).get("_meta", {})
        say("parameterizedModelPicker=%s" % str(meta.get("parameterizedModelPicker")).lower())
    elif text == "ask":
        result = request("q1", "cursor/ask_question", {"title": "Setup", "questions": [{
            "id": "db", "prompt": "Which database?",
            "options": [{"id": "pg", "label": "Postgres"}, {"id": "lite", "label": "SQLite"}]}]})
        answer = result["outcome"]
        if answer["outcome"] == "answered":
            picked = answer["answers"][0]
            say("answered:%s=%s" % (picked["questionId"], ",".join(picked["selectedOptionIds"])))
        else:
            say(answer["outcome"])
    elif text == "plan":
        result = request("p1", "cursor/create_plan", {"plan": "Ship the feature"})
        say("plan %s" % result["outcome"]["outcome"])
    elif text == "mode":
        say("mode=%s" % STATE["mode"])
    else:
        say("ok")
    send({"jsonrpc": "2.0", "id": ident, "result": {"stopReason": "end_turn"}})


for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    frame = json.loads(raw)
    method, ident, params = frame.get("method"), frame.get("id"), frame.get("params", {})
    if method == "initialize":
        STATE["caps"] = params.get("clientCapabilities")
        send({"jsonrpc": "2.0", "id": ident, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"mcpCapabilities": {"http": True, "sse": True}}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": ident, "result": {
            "sessionId": SESSION, "configOptions": config_options()}})
    elif method == "session/set_config_option":
        if params["configId"] == "mode":
            STATE["mode"] = params["value"]
        send({"jsonrpc": "2.0", "id": ident, "result": {"configOptions": config_options()}})
    elif method == "session/prompt":
        text = "".join(block.get("text", "") for block in params.get("prompt", []))
        prompt(ident, text)
    elif method == "session/cancel":
        pass
    elif ident is not None:
        send({"jsonrpc": "2.0", "id": ident, "result": {}})
