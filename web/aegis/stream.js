// Aegis Web Console realtime transport.
//
// The server is the only writer of task facts; this client just follows the
// committed EventLog. `cursor` is the number of committed rows already applied,
// kept per experiment in sessionStorage so a refresh continues instead of
// replaying. A `reset` frame means the cursor was invalid (log replaced or
// truncated) and the client must reload the view from the server.

export function openStream(
    label,
    { cursor = 0, onEvents, onStatus, onDelta, onHost, onState } = {},
) {
    const params = new URLSearchParams({ cursor: String(cursor) });
    const source = new EventSource(
        `/api/experiments/${encodeURIComponent(label)}/stream?${params}`,
    );
    let closed = false;

    const handle = (type, fn) => (message) => {
        if (closed || !fn) {
            return;
        }

        let data = null;

        try {
            data = JSON.parse(message.data);
        } catch {
            return;
        }

        fn(data);
    };

    source.addEventListener("events", handle("events", onEvents));
    source.addEventListener("status", handle("status", onStatus));
    source.addEventListener("delta", handle("delta", onDelta));
    source.addEventListener("host", handle("host", onHost));
    source.addEventListener("ping", () => {});

    source.onerror = () => {
        if (!closed) {
            onState?.({ connected: false, retrying: true });
        }
    };

    source.onopen = () => onState?.({ connected: true, retrying: false });

    return {
        close() {
            closed = true;
            source.close();
        },
        get connected() {
            return source.readyState === EventSource.OPEN;
        },
    };
}

const KEY = (label) => `aegis.cursor.${label}`;

export function loadCursor(label) {
    try {
        const raw = sessionStorage.getItem(KEY(label));
        const value = raw === null ? 0 : Number(raw);

        return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
        return 0;
    }
}

export function saveCursor(label, cursor) {
    try {
        sessionStorage.setItem(KEY(label), String(cursor));
    } catch {
        // private mode: cursors are best effort
    }
}

/** Server-side status polling is not needed: the SSE stream carries status. */
