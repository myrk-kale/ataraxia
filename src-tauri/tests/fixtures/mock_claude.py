#!/usr/bin/env python3
"""Stand-in for `claude -p --input-format stream-json --output-format stream-json`.

Frames follow Claude Code's real stream-json output (partial `stream_event`s followed by the
full `assistant` frame, `control_request`/`control_response` for tool permissions). The first
word of the user prompt selects the scenario: tool | subagent | background | hang | crash | anything else.
"""
import json
import os
import sys
import tempfile
import time

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


def run_subagent():
    """The main agent delegates to a subagent; its frames carry parent_tool_use_id."""
    agent_id = "toolu_agent"
    # The stream announces the tool before its input is known, like the real CLI.
    stream_event({"type": "message_start", "message": {"id": MSG, "role": "assistant", "content": []}})
    stream_event({"type": "content_block_start", "index": 0,
                  "content_block": {"type": "tool_use", "id": agent_id, "name": "Agent", "input": {}}})
    stream_event({"type": "content_block_stop", "index": 0})
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": MSG, "role": "assistant", "content": [
              {"type": "tool_use", "id": agent_id, "name": "Agent",
               "input": {"description": "Explore the repo", "subagent_type": "explorer",
                         "prompt": "Find the entry points"}}]}})
    send({"type": "user", "parent_tool_use_id": agent_id,
          "message": {"role": "user", "content": [{"type": "text", "text": "Find the entry points"}]}})
    send({"type": "assistant", "parent_tool_use_id": agent_id,
          "message": {"id": "msg_child_1", "role": "assistant", "content": [
              {"type": "tool_use", "id": "toolu_child", "name": "Grep", "input": {"pattern": "fn main"}}]}})
    send({"type": "user", "parent_tool_use_id": agent_id, "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_child", "content": "src/main.rs", "is_error": False}]}})
    send({"type": "assistant", "parent_tool_use_id": agent_id,
          "message": {"id": "msg_child_2", "role": "assistant",
                      "content": [{"type": "text", "text": "Found 1 entry point."}]}})
    send({"type": "user", "parent_tool_use_id": None, "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": agent_id, "content": "Done.\nagentId: a1b2c3", "is_error": False}]}})
    stream_text(["Summary done."], "msg_mock_2")
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": "msg_mock_2", "role": "assistant",
                      "content": [{"type": "text", "text": "Summary done."}]}})
    result(text="Summary done.")


def run_background():
    """A background subagent: the call returns at once, the work shows up in its transcript
    file, and the main agent speaks again by itself when it is done (as the real CLI does)."""
    agent_id = "toolu_bg"
    path = os.path.join(tempfile.gettempdir(), "mock_claude_agent_%d.output" % os.getpid())
    stream_event({"type": "message_start", "message": {"id": MSG, "role": "assistant", "content": []}})
    stream_event({"type": "content_block_start", "index": 0,
                  "content_block": {"type": "tool_use", "id": agent_id, "name": "Agent", "input": {}}})
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": MSG, "role": "assistant", "content": [
              {"type": "tool_use", "id": agent_id, "name": "Agent",
               "input": {"description": "Explorar a codebase", "subagent_type": "Explore",
                         "prompt": "Explore the repo"}}]}})
    open(path, "w").close()
    send({"type": "user", "parent_tool_use_id": None, "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": agent_id, "is_error": False, "content":
         "Async agent launched successfully. (This tool result is internal metadata.)\n"
         "agentId: a241b83d (internal ID - do not mention to user. Use SendMessage with to: 'a241b83d')\n"
         "The agent is working in the background. You will be notified automatically when it completes.\n"
         "output_file: " + path + "\n"}]}})
    stream_text(["Launched in the background."], "msg_mock_2")
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": "msg_mock_2", "role": "assistant",
                      "content": [{"type": "text", "text": "Launched in the background."}]}})
    result(text="Launched in the background.")

    def entry(kind, content, **extra):
        with open(path, "a") as out:
            out.write(json.dumps({"type": kind, "isSidechain": True,
                                  "message": {"role": kind, "content": content, **extra}}) + "\n")
        time.sleep(0.05)

    entry("user", "Explore the repo")
    entry("assistant", [{"type": "tool_use", "id": "tb1", "name": "Grep", "input": {"pattern": "main"}}])
    entry("user", [{"type": "tool_result", "tool_use_id": "tb1", "content": "src/main.rs"}])
    entry("assistant", [{"type": "text", "text": "Found 1 entry point."}], stop_reason="end_turn")
    time.sleep(0.2)
    # The notification wakes the main agent: a turn nobody asked for.
    stream_text(["The subagent finished."], "msg_late")
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": "msg_late", "role": "assistant",
                      "content": [{"type": "text", "text": "The subagent finished."}]}})
    result(text="The subagent finished.")


def run_relay(text):
    """The main agent passes a message on to the subagent (SendMessage) and reports back."""
    agent_id = "toolu_agent"
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": "msg_relay", "role": "assistant", "content": [
              {"type": "tool_use", "id": "toolu_send", "name": "SendMessage",
               "input": {"to": "a1b2c3", "message": text}}]}})
    send({"type": "assistant", "parent_tool_use_id": agent_id,
          "message": {"id": "msg_child_3", "role": "assistant",
                      "content": [{"type": "text", "text": "Resumed and replying."}]}})
    send({"type": "user", "parent_tool_use_id": None, "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_send", "content": "delivered", "is_error": False}]}})
    result(text="Relayed.")


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
            elif text.startswith("subagent"):
                run_subagent()
            elif text.startswith("background"):
                run_background()
            elif text.startswith("Use the SendMessage tool"):
                run_relay(text)
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
