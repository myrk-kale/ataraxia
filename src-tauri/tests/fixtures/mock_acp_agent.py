#!/usr/bin/env python3
"""Scripted ACP agent used by the OpenCode backend tests.

Frame shapes mirror real `opencode acp` traffic. The prompt text selects the scenario:
  tool  -> tool call that asks for permission, then completes or fails
  child -> a subagent (child session) works, then the main agent answers
  state -> replies with the current model, effort and mode
  hang  -> streams one chunk and waits for session/cancel
  crash -> writes to stderr and exits non-zero
  other -> short streamed reply
"""
import json
import sys

SESSION = "ses_mock"
CHILD = {"id": "ses_child", "parentID": SESSION, "depth": 1, "title": "Explore"}
CONFIG = {"model": "mock/smart", "effort": "default", "mode": "build"}


def config_options():
    options = [
        {"id": "model", "name": "Model", "category": "model", "type": "select",
         "currentValue": CONFIG["model"],
         "options": [{"value": "mock/smart", "name": "Mock Smart"},
                     {"value": "mock/fast", "name": "Mock Fast"}]},
    ]
    if CONFIG["model"] == "mock/smart":  # effort only exists for models with variants
        options.append({"id": "effort", "name": "Effort", "category": "thought_level",
                        "type": "select", "currentValue": CONFIG["effort"],
                        "options": [{"value": "default", "name": "default"},
                                    {"value": "low", "name": "low"},
                                    {"value": "high", "name": "high"}]})
    options.append({"id": "mode", "name": "Agent", "category": "mode", "type": "select",
                    "currentValue": CONFIG["mode"],
                    "options": [{"value": "build", "name": "build", "description": "Builds"},
                                {"value": "plan", "name": "plan"}]})
    return options


def send(frame):
    frame["jsonrpc"] = "2.0"
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def update(fields):
    send({"method": "session/update", "params": {"sessionId": SESSION, "update": fields}})


def chunk(text):
    update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})


def read_frame():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)


def wait_for(predicate):
    while True:
        frame = read_frame()
        if predicate(frame):
            return frame


def run_tool(prompt_id):
    chunk("Looking. ")
    update({"sessionUpdate": "tool_call", "toolCallId": "call_1", "title": "write",
            "kind": "edit", "status": "pending", "locations": [], "rawInput": {}})
    update({"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "in_progress",
            "kind": "edit", "title": "write",
            "locations": [{"path": "/work/a.txt"}],
            "rawInput": {"filePath": "/work/a.txt", "content": "hi"}})
    send({"id": 100, "method": "session/request_permission", "params": {
        "sessionId": SESSION,
        "toolCall": {"toolCallId": "call_1", "title": "/work/a.txt", "kind": "edit",
                     "status": "pending", "locations": [{"path": "/work/a.txt"}],
                     "rawInput": {"filepath": "/work/a.txt"}},
        "options": [
            {"optionId": "once", "kind": "allow_once", "name": "Allow once"},
            {"optionId": "always", "kind": "allow_always", "name": "Always allow"},
            {"optionId": "reject", "kind": "reject_once", "name": "Reject"},
        ]}})
    answer = wait_for(lambda f: f.get("id") == 100 and "method" not in f)
    outcome = answer["result"]["outcome"]
    if outcome.get("optionId") == "once":
        update({"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "completed",
                "content": [{"type": "content", "content": {"type": "text", "text": "written"}}]})
        chunk("Done.")
        send({"id": prompt_id, "result": {"stopReason": "end_turn"}})
    else:
        update({"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "failed",
                "content": [{"type": "content", "content": {"type": "text",
                             "text": "The user rejected permission to use this specific tool call."}}]})
        send({"id": prompt_id, "result": {"stopReason": "end_turn"}})


def child_update(fields):
    update({**fields, "_meta": {"opencode/child-session": CHILD}})


def run_child(prompt_id):
    chunk("Delegating. ")
    child_update({"sessionUpdate": "agent_message_chunk",
                  "content": {"type": "text", "text": "Scanning"}})
    child_update({"sessionUpdate": "tool_call", "toolCallId": "ses_child:call_9",
                  "title": "grep", "kind": "search", "status": "pending",
                  "rawInput": {"pattern": "main"}})
    child_update({"sessionUpdate": "tool_call_update", "toolCallId": "ses_child:call_9",
                  "status": "completed",
                  "content": [{"type": "content", "content": {"type": "text", "text": "3 hits"}}]})
    chunk("Back.")
    send({"id": prompt_id, "result": {"stopReason": "end_turn"}})


def run_hang(prompt_id):
    chunk("Working")
    wait_for(lambda f: f.get("method") == "session/cancel")
    send({"id": prompt_id, "result": {"stopReason": "cancelled"}})


def main():
    while True:
        frame = read_frame()
        method = frame.get("method")
        if method == "initialize":
            send({"id": frame["id"], "result": {"protocolVersion": 1, "agentCapabilities": {},
                                                "agentInfo": {"name": "MockAgent", "version": "0"}}})
        elif method == "session/new":
            send({"id": frame["id"], "result": {"sessionId": SESSION,
                                                "configOptions": config_options()}})
        elif method == "session/set_config_option":
            params = frame["params"]
            CONFIG[params["configId"]] = params["value"]
            if params["configId"] == "model":
                CONFIG["effort"] = "default"
            send({"id": frame["id"], "result": {"configOptions": config_options()}})
        elif method == "session/prompt":
            text = frame["params"]["prompt"][0]["text"]
            if text.startswith("tool"):
                run_tool(frame["id"])
            elif text.startswith("child"):
                run_child(frame["id"])
            elif text.startswith("state"):
                chunk("model=%s effort=%s mode=%s" % (CONFIG["model"], CONFIG["effort"], CONFIG["mode"]))
                send({"id": frame["id"], "result": {"stopReason": "end_turn"}})
            elif text.startswith("hang"):
                run_hang(frame["id"])
            elif text.startswith("crash"):
                sys.stderr.write("boom\n")
                sys.stderr.flush()
                sys.exit(3)
            else:
                chunk("Hello")
                chunk(" world")
                send({"id": frame["id"], "result": {"stopReason": "end_turn"}})


if __name__ == "__main__":
    main()
