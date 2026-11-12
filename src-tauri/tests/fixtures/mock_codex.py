#!/usr/bin/env python3
"""Stand-in for `codex app-server` (JSON-RPC lines without the `jsonrpc` member).

Frame shapes follow Codex's app-server protocol: thread/start, turn/start, `item/*` and
`turn/*` notifications, and string-id server requests for approvals. The first word of the
prompt selects the scenario: tool | spawn | spawnquiet | hang | crash | anything else.
"""
import json
import sys

THREAD = "thr_mock"
CHILD = "thr_child"
TURN = "turn_mock"


def send(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def notify(method, **params):
    send({"method": method, "params": {"threadId": THREAD, **params}})


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


def start_turn():
    notify("turn/started", turn={"id": TURN, "status": "inProgress"})


def complete(status="completed"):
    notify("turn/completed", turn={"id": TURN, "status": status})


def run_plain():
    start_turn()
    notify("item/started", turnId=TURN, item={"type": "agentMessage", "id": "msg1", "text": ""})
    for part in ("Hello", " world"):
        notify("item/agentMessage/delta", turnId=TURN, itemId="msg1", delta=part)
    notify("item/completed", turnId=TURN,
           item={"type": "agentMessage", "id": "msg1", "text": "Hello world"})
    complete()


def run_tool():
    start_turn()
    item = {"type": "commandExecution", "id": "cmd1", "command": "touch probe.txt",
            "cwd": "/work", "status": "inProgress", "aggregatedOutput": None}
    notify("item/started", turnId=TURN, item=item)
    send({"id": "appr-1", "method": "item/commandExecution/requestApproval", "params": {
        "threadId": THREAD, "turnId": TURN, "itemId": "cmd1", "command": "touch probe.txt",
        "reason": "needs to write", "availableDecisions": ["accept", "decline", "cancel"]}})
    answer = wait_for(lambda f: f.get("id") == "appr-1" and "method" not in f)
    if answer["result"]["decision"] == "accept":
        notify("item/completed", turnId=TURN,
               item={**item, "status": "completed", "aggregatedOutput": "created", "exitCode": 0})
        notify("item/agentMessage/delta", turnId=TURN, itemId="msg1", delta="All done.")
    else:
        notify("item/completed", turnId=TURN, item={**item, "status": "declined"})
    complete()


def child_notify(method, **params):
    send({"method": method, "params": {"threadId": CHILD, **params}})


def collab_item(status, agent_status):
    return {"type": "collabAgentToolCall", "id": "collab1", "tool": "spawnAgent",
            "status": status, "senderThreadId": THREAD, "receiverThreadIds": [CHILD],
            "prompt": "Review the diff\nlook closely", "model": None, "reasoningEffort": None,
            "agentsStates": {CHILD: {"status": agent_status, "message": None}}}


def run_spawn():
    """The subagent's thread streams on the same connection."""
    start_turn()
    notify("item/started", turnId=TURN, item=collab_item("inProgress", "pendingInit"))
    notify("item/completed", turnId=TURN, item=collab_item("completed", "running"))
    child_notify("turn/started", turn={"id": "child_turn", "status": "inProgress"})
    child_notify("item/agentMessage/delta", turnId="child_turn", itemId="cm1", delta="Looks ")
    child_notify("item/agentMessage/delta", turnId="child_turn", itemId="cm1", delta="fine.")
    cmd = {"type": "commandExecution", "id": "ccmd1", "command": "git diff", "cwd": "/work",
           "status": "inProgress", "aggregatedOutput": None}
    child_notify("item/started", turnId="child_turn", item=cmd)
    child_notify("item/completed", turnId="child_turn",
                 item={**cmd, "status": "completed", "aggregatedOutput": "diff --git", "exitCode": 0})
    child_notify("turn/completed", turn={"id": "child_turn", "status": "completed"})
    notify("item/agentMessage/delta", turnId=TURN, itemId="msg1", delta="Reviewed.")
    complete()


def run_spawnquiet():
    """No child events stream; the subagent has to be read back with thread/read."""
    start_turn()
    notify("item/completed", turnId=TURN, item=collab_item("completed", "completed"))
    notify("item/agentMessage/delta", turnId=TURN, itemId="msg1", delta="Delegated.")
    complete()


def run_hang():
    start_turn()
    notify("item/agentMessage/delta", turnId=TURN, itemId="msg1", delta="Working")
    interrupt = wait_for(lambda f: f.get("method") == "turn/interrupt")
    assert interrupt["params"]["turnId"] == TURN
    send({"id": interrupt["id"], "result": {}})
    complete("interrupted")


def main():
    while True:
        frame = read_frame()
        method = frame.get("method")
        if method is None:
            continue
        if method == "initialize":
            send({"id": frame["id"], "result": {"userAgent": "mock-codex"}})
        elif method == "thread/start":
            send({"id": frame["id"], "result": {"thread": {"id": THREAD}, "model": "mock"}})
        elif method == "model/list":
            effort = lambda name: {"reasoningEffort": name, "description": name}
            send({"id": frame["id"], "result": {"nextCursor": None, "data": [
                {"id": "m1", "model": "gpt-mock", "displayName": "GPT Mock", "description": "",
                 "hidden": False, "isDefault": True, "defaultReasoningEffort": "medium",
                 "supportedReasoningEfforts": [effort("low"), effort("medium"), effort("high")]},
                {"id": "m2", "model": "gpt-mini", "displayName": "GPT Mini", "description": "",
                 "hidden": False, "isDefault": False, "defaultReasoningEffort": "low",
                 "supportedReasoningEfforts": [effort("low")]},
                {"id": "m3", "model": "gpt-hidden", "displayName": "Hidden", "description": "",
                 "hidden": True, "isDefault": False, "defaultReasoningEffort": "low",
                 "supportedReasoningEfforts": []}]}})
        elif method == "thread/read":
            assert frame["params"]["threadId"] == CHILD
            assert frame["params"].get("includeTurns") is True
            send({"id": frame["id"], "result": {"thread": {
                "id": CHILD, "agentNickname": "Reviewer", "turns": [{"id": "ct", "items": [
                    {"type": "commandExecution", "id": "rc1", "command": "git diff", "cwd": "/work",
                     "status": "completed", "aggregatedOutput": "diff --git", "exitCode": 0},
                    {"type": "agentMessage", "id": "rm1", "text": "All good."}]}]}}})
        elif method == "thread/resume":
            send({"id": frame["id"], "result": {"thread": {"id": frame["params"]["threadId"]}}})
        elif method == "turn/start" and frame["params"]["threadId"] == CHILD:
            text = frame["params"]["input"][0]["text"]
            send({"id": frame["id"], "result": {"turn": {"id": "child_turn_2", "status": "inProgress"}}})
            child_notify("turn/started", turn={"id": "child_turn_2", "status": "inProgress"})
            child_notify("item/agentMessage/delta", turnId="child_turn_2", itemId="cm2",
                         delta="Reply to: ")
            child_notify("item/agentMessage/delta", turnId="child_turn_2", itemId="cm2", delta=text)
            child_notify("turn/completed", turn={"id": "child_turn_2", "status": "completed"})
        elif method == "turn/start":
            send({"id": frame["id"], "result": {"turn": {"id": TURN, "status": "inProgress"}}})
            text = frame["params"]["input"][0]["text"]
            if text.startswith("tool"):
                run_tool()
            elif text.startswith("spawnquiet"):
                run_spawnquiet()
            elif text.startswith("spawn"):
                run_spawn()
            elif text.startswith("hang"):
                run_hang()
            elif text.startswith("crash"):
                sys.stderr.write("codex exploded\n")
                sys.stderr.flush()
                sys.exit(4)
            else:
                run_plain()


if __name__ == "__main__":
    main()
