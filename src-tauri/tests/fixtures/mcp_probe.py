import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "tools/list" and len(sys.argv) > 1:
        with open(sys.argv[1], "w", encoding="utf-8") as report:
            report.write("tools/list")
    if "id" not in request:
        continue
    if method == "initialize":
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "ataraxia-probe", "version": "1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "probe",
                    "description": "Return a fixed test string.",
                    "inputSchema": {"type": "object"},
                }
            ]
        }
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "ataraxia-mcp-ok"}]}
    elif method == "resources/list":
        result = {"resources": []}
    elif method == "resources/templates/list":
        result = {"resourceTemplates": []}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
