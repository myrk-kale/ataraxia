#!/usr/bin/env python3
"""Stand-in for `codex app-server` (JSON-RPC lines without the `jsonrpc` member).

Frame shapes follow Codex's app-server protocol: thread/start, turn/start, `item/*` and
`turn/*` notifications, and string-id server requests for approvals. The first word of the
prompt selects the scenario: tool | hang | crash | anything else.
"""
import json
import sys

THREAD = "thr_mock"
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
        elif method == "turn/start":
            send({"id": frame["id"], "result": {"turn": {"id": TURN, "status": "inProgress"}}})
            text = frame["params"]["input"][0]["text"]
            if text.startswith("tool"):
                run_tool()
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
