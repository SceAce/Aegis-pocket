// The committed conversation timeline.
//
// Rows are transcript entries produced by the server from committed EventLog
// records (`console-web/view.mjs#transcriptEntry`). Live token text is NOT a
// row: it is shown as an ephemeral bubble and replaced by the committed
// `message.completed` excerpt on reconnect.

export function mergeRows(existing, incoming) {
    const byId = new Map();

    for (const row of existing) {
        byId.set(row.event_id, row);
    }

    for (const row of incoming) {
        if (row?.event_id) {
            byId.set(row.event_id, row);
        }
    }

    // Keep committed order stable: the server sends rows in log order.
    return [...byId.values()];
}

export function appendTo(existing, incoming) {
    const seen = new Set(existing.map((row) => row.event_id));
    const merged = existing.slice();

    for (const row of incoming) {
        if (!row?.event_id || seen.has(row.event_id)) {
            continue;
        }

        seen.add(row.event_id);
        merged.push(row);
    }

    return merged;
}

/** Stable React-ish key: the event id is the committed identity. */
export function rowKey(row) {
    return row.event_id ?? `${row.event_type}:${row.recorded_at}:${row.kind}`;
}

/** Human label for a tool action row. */
export function actionLabel(row) {
    return row.tool_name || row.action_id || "action";
}

/** One-line summary for the collapsed row. */
export function summaryOf(row) {
    switch (row.kind) {
        case "episode":
            return "task started";
        case "prompt":
            return row.prompt_chars === null ? "prompt" : `prompt · ${row.prompt_chars} chars`;
        case "message":
            return row.role === "assistant" ? "assistant" : `${row.role ?? "message"}`;
        case "action-requested":
            return `${actionLabel(row)} requested`;
        case "action-completed":
            return `${actionLabel(row)} · ${row.status ?? "unknown"}`;
        case "settled":
            return row.context_usage?.known
                ? `settled · ${Math.round(row.context_usage.percent)}% context`
                : "settled";
        case "rotation":
            return "Session rotated (same Episode)";
        case "review":
            return `work review · ${row.retrieval_status ?? "unknown"}`;
        case "checkpoint":
            return "round checkpoint";
        case "knowledge":
            return `knowledge · ${row.status ?? "unknown"}`;
        case "outcome":
            return `outcome · ${row.status ?? "unknown"}`;
        case "request":
            return row.provider_bound ? "provider request" : "request refused";
        case "session":
            return `session ${row.event_type === "session.started" ? "started" : "shutdown"}`;
        default:
            return row.event_type ?? "event";
    }
}
