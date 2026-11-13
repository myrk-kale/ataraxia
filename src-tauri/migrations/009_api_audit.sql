-- The audit trail belongs to the local HTTP API now; the MCP server it came from is gone.
ALTER TABLE mcp_audit RENAME TO api_audit;
