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

/**
 * One-line summary for the collapsed row, as a translation key plus variables.
 *
 * Status/tool/digest VALUES stay raw (they are protocol data); only the sentence
 * around them is localized.
 */
export function summaryOf(row) {
    switch (row.kind) {
        case "episode":
            return { key: "summary.taskStarted" };
        case "prompt":
            return row.prompt_chars === null
                ? { key: "summary.prompt" }
                : { key: "summary.promptChars", vars: { chars: row.prompt_chars } };
        case "message":
            return row.role === "assistant"
                ? { key: "summary.assistant" }
                : { key: "row.kindMessage", vars: { types: row.role ?? "message" } };
        case "action-requested":
            return { key: "summary.actionRequested", vars: { tool: actionLabel(row) } };
        case "action-completed":
            return {
                key: "summary.actionCompleted",
                vars: { tool: actionLabel(row), status: row.status ?? "unknown" },
            };
        case "settled":
            return row.context_usage?.known
                ? {
                      key: "summary.settledContext",
                      vars: { percent: Math.round(row.context_usage.percent) },
                  }
                : { key: "summary.settled" };
        case "rotation":
            return { key: "summary.rotation" };
        case "review":
            return { key: "summary.review", vars: { status: row.retrieval_status ?? "unknown" } };
        case "checkpoint":
            return { key: "summary.checkpoint" };
        case "knowledge":
            return { key: "summary.knowledge", vars: { status: row.status ?? "unknown" } };
        case "outcome":
            return { key: "summary.outcome", vars: { status: row.status ?? "unknown" } };
        case "request":
            return row.provider_bound
                ? { key: "summary.request" }
                : {
                      key: "summary.requestRefused",
                      vars: { reason: row.refusal_reason ?? "unknown" },
                  };
        case "session":
            return {
                key:
                    row.event_type === "session.started"
                        ? "summary.sessionStarted"
                        : "summary.sessionShutdown",
            };
        default:
            return { key: "summary.event", vars: { type: row.event_type ?? "event" } };
    }
}
