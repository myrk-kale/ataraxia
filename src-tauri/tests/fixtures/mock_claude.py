#!/usr/bin/env python3
"""Stand-in for `claude -p --input-format stream-json --output-format stream-json`.

Frames follow Claude Code's real stream-json output (partial `stream_event`s followed by the
full `assistant` frame, `control_request`/`control_response` for tool permissions). The first
word of the user prompt selects the scenario: tool | hang | crash | anything else.
"""
import json
import sys

SESSION = "mock-session"
MSG = "msg_mock_1"


def send(frame):
    frame.setdefault("session_id", SESSION)
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def stream_event(event):
    send({"type": "stream_event", "event": event, "parent_tool_use_id": None})


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
        if frame.get("type") == "control_request":
            ack(frame)


def ack(frame):
    send({"type": "control_response",
          "response": {"subtype": "success", "request_id": frame["request_id"], "response": {}}})


def stream_text(text_parts, message_id=MSG):
    stream_event({"type": "message_start", "message": {"id": message_id, "role": "assistant", "content": []}})
    stream_event({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
    for part in text_parts:
        stream_event({"type": "content_block_delta", "index": 0,
                      "delta": {"type": "text_delta", "text": part}})
    stream_event({"type": "content_block_stop", "index": 0})


def result(subtype="success", is_error=False, text=""):
    send({"type": "result", "subtype": subtype, "is_error": is_error, "result": text,
          "stop_reason": "end_turn"})


def run_plain():
    stream_text(["Hello", " world"])
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": MSG, "role": "assistant",
                      "content": [{"type": "text", "text": "Hello world"}]}})
    result(text="Hello world")


def run_tool():
    stream_event({"type": "message_start", "message": {"id": MSG, "role": "assistant", "content": []}})
    stream_event({"type": "content_block_start", "index": 0,
                  "content_block": {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {}}})
    stream_event({"type": "content_block_stop", "index": 0})
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": MSG, "role": "assistant", "content": [
              {"type": "tool_use", "id": "toolu_1", "name": "Bash",
               "input": {"command": "touch probe.txt", "description": "Create probe"}}]}})
    send({"type": "control_request", "request_id": "perm-1", "request": {
        "subtype": "can_use_tool", "tool_name": "Bash", "display_name": "Bash",
        "input": {"command": "touch probe.txt", "description": "Create probe"},
        "description": "Create probe", "tool_use_id": "toolu_1"}})
    answer = wait_for(lambda f: f.get("type") == "control_response"
                      and f["response"].get("request_id") == "perm-1")
    behavior = answer["response"]["response"]["behavior"]
    if behavior == "allow":
        send({"type": "user", "parent_tool_use_id": None, "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "created", "is_error": False}]}})
        stream_text(["All done."], "msg_mock_2")
        send({"type": "assistant", "parent_tool_use_id": None,
              "message": {"id": "msg_mock_2", "role": "assistant",
                          "content": [{"type": "text", "text": "All done."}]}})
        result(text="All done.")
    else:
        send({"type": "user", "parent_tool_use_id": None, "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1",
             "content": "The user denied permission for this tool call.", "is_error": True}]}})
        result(text="stopped")


def run_hang():
    stream_text(["Working"])
    wait_for(lambda f: f.get("type") == "control_request"
             and f["request"].get("subtype") == "interrupt")
    result(subtype="error_during_execution", is_error=True, text="interrupted")


def main():
    while True:
        frame = read_frame()
        kind = frame.get("type")
        if kind == "control_request":
            ack(frame)
        elif kind == "user":
            content = frame["message"]["content"]
            text = content if isinstance(content, str) else content[0]["text"]
            if text.startswith("tool"):
                run_tool()
            elif text.startswith("hang"):
                run_hang()
            elif text.startswith("crash"):
                sys.stderr.write("claude exploded\n")
                sys.stderr.flush()
                sys.exit(2)
            else:
                run_plain()


if __name__ == "__main__":
    main()
