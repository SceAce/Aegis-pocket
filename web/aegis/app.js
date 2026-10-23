// Aegis Web Console — the app.
//
// The browser is a VIEW: every task fact it shows comes from the committed
// EventLog (through the Host's own projection) or from the Host's derived
// status. It sends prompts and control requests, and it never decides success,
// never clears a hold and never fabricates progress.

import { h, render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";
import { api, ApiError, requestId as makeRequestId } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { appendTo, rowKey, summaryOf } from "./timeline.js";
import { loadCursor, openStream, saveCursor } from "./stream.js";

const html = htm.bind(h);

/** htm has no fragment shorthand; a component returning its children is one. */
function Fragment({ children }) {
    return children;
}

const RAILS = [
    { id: "workbench", glyph: "◧", label: "Workbench" },
    { id: "board", glyph: "◇", label: "Board" },
    { id: "knowledge", glyph: "❖", label: "Knowledge" },
    { id: "history", glyph: "◷", label: "History" },
    { id: "settings", glyph: "⚙", label: "Settings" },
];

const PANELS = [
    { id: "progress", label: "Progress" },
    { id: "board", label: "Board" },
    { id: "knowledge", label: "Knowledge" },
    { id: "session", label: "Session" },
    { id: "actions", label: "Actions" },
    { id: "files", label: "Files" },
];

function when(value) {
    if (!value) {
        return "";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function toneForStatus(status) {
    if (!status) {
        return null;
    }

    if (["running", "settling", "idle"].includes(status)) {
        return "ok";
    }

    if (["handoff_pending", "paused", "blocked"].includes(status)) {
        return "warn";
    }

    if (["stopped", "unavailable"].includes(status)) {
        return "bad";
    }

    return null;
}

function toneForHost(state) {
    if (state === "ready") {
        return "ok";
    }

    if (state === "starting") {
        return "warn";
    }

    if (state === "conflict" || state === "unavailable") {
        return "bad";
    }

    return null;
}

function badgeToneForReview(required, usable) {
    if (!required) {
        return "ok";
    }

    return usable ? "warn" : "bad";
}

function shortSession(id) {
    if (typeof id !== "string" || id.length < 12) {
        return id ?? "none";
    }

    return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

// ── generic bits ────────────────────────────────────────────

function Chip({ children, tone }) {
    return html`<span class="aw-chip" data-tone=${tone ?? undefined}>${children}</span>`;
}

function Badge({ children, tone }) {
    return html`<span class="aw-badge" data-tone=${tone ?? undefined}>${children}</span>`;
}

function Facts({ rows }) {
    return html`<dl class="aw-kv">
        ${rows
            .filter((row) => row && row[1] !== undefined)
            .map(
                ([key, value]) => html`<${Fragment} key=${key}>
                    <dt>${key}</dt>
                    <dd>${value === null ? html`<span class="aw-faint">null</span>` : value}</dd>
                <//>`,
            )}
    </dl>`;
}

function Section({ title, children, actions }) {
    return html`<section class="aw-section">
        ${title ? html`<h2>${title}${actions ?? null}</h2>` : null}
        ${children}
    </section>`;
}

function Details({ children }) {
    return html`<div class="aw-details-inline">${children}</div>`;
}

// ── transcript rows ─────────────────────────────────────────

function Collapsible({ summary, children, when: at }) {
    const [open, setOpen] = useState(false);

    return html`<div class="aw-card">
        <div class="aw-card-head">
            <button class="aw-icon" aria-expanded=${open} onClick=${() => setOpen(!open)} title="toggle details">
                ${open ? "▾" : "▸"}
            </button>
            <strong>${summary}</strong>
            <span class="aw-when">${when(at)}</span>
        </div>
        ${open ? html`<${Details}>${children}<//>` : null}
    </div>`;
}

function TranscriptRow({ row }) {
    if (row.kind === "rotation") {
        return html`<${RotationRow} row=${row} />`;
    }

    if (row.kind === "episode") {
        return html`<div class="aw-row" data-kind="episode">
            <div class="aw-card">
                <div class="aw-card-head"><strong>Task started</strong><span class="aw-when">${when(row.recorded_at)}</span></div>
                ${
                    row.goal
                        ? html`<div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(row.goal) }}></div>`
                        : html`<div class="aw-muted">the opening prompt is the message below</div>`
                }
                ${
                    row.authorization
                        ? html`<div class="aw-faint">authorization: ${row.authorization}</div>`
                        : null
                }
            </div>
        </div>`;
    }

    if (row.kind === "prompt") {
        return html`<div class="aw-row" data-kind="prompt-record">
            <div class="aw-muted" style="text-align:center">
                follow-up prompt accepted · ${row.prompt_chars ?? "?"} chars ·
                digest ${(row.prompt_digest ?? "").slice(0, 22)} · ${when(row.recorded_at)}
            </div>
        </div>`;
    }

    if (row.kind === "message" && row.role === "user") {
        return html`<div class="aw-row aw-user" data-kind="prompt">
            <div class="aw-card">
                <div class="aw-card-head">
                    <strong>You</strong>
                    <span class="aw-when">${when(row.recorded_at)}</span>
                    ${
                        row.text_chars && row.text_chars > (row.text ?? "").length
                            ? html`<${Badge} tone="warn">excerpt<//>`
                            : null
                    }
                </div>
                <div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(row.text ?? "") }}></div>
            </div>
        </div>`;
    }

    if (row.kind === "message" && row.role === "assistant") {
        return html`<div class="aw-row" data-kind="message">
            <div class="aw-card">
                <div class="aw-card-head">
                    <strong>Assistant</strong>
                    <span class="aw-when">${when(row.recorded_at)}</span>
                    ${
                        row.text_chars && row.text_chars > (row.text ?? "").length
                            ? html`<${Badge} tone="warn">truncated<//>`
                            : null
                    }
                </div>
                ${
                    row.text
                        ? html`<div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(row.text) }}></div>`
                        : html`<div class="aw-muted">No text in this message (the provider produced none or only tool calls).</div>`
                }
                ${row.session_id ? html`<div class="aw-faint">session ${shortSession(row.session_id)}</div>` : null}
            </div>
        </div>`;
    }

    if (row.kind === "message") {
        return html`<div class="aw-row" data-kind="tool">
            <${Collapsible} summary=${row.role === "toolResult" ? "tool result (committed excerpt)" : `${row.role ?? "message"} · ${row.content_types?.join(", ") || "content"}`} when=${row.recorded_at}>
                <div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(row.text ?? "") }}></div>
            <//>
        </div>`;
    }

    if (row.kind === "action-requested") {
        return html`<div class="aw-row" data-kind="tool">
            <${Collapsible} summary=${`${row.tool_name ?? "tool"} · requested`} when=${row.recorded_at}>
                <div>action ${row.action_id ?? "unknown"}</div>
                ${row.arguments_digest ? html`<div>arguments digest ${row.arguments_digest}</div>` : null}
                ${row.input?.summary ? html`<div>${JSON.stringify(row.input.summary)}</div>` : null}
            <//>
        </div>`;
    }

    if (row.kind === "action-completed") {
        const tone = row.status === "rejected" ? "bad" : row.status === "unknown" ? "warn" : "ok";
        const label =
            row.status === "unknown" && row.tool_ok
                ? "completed (transport ok)"
                : (row.status ?? "unknown");

        return html`<div class="aw-row" data-kind="tool">
            <${Collapsible} summary=${`${row.tool_name ?? "tool"} · ${label}`} when=${row.recorded_at}>
                <div><${Badge} tone=${tone}>${row.status ?? "unknown"}<//> ${row.action_id ?? ""}${row.tool_ok ? " · transport ok" : ""}</div>
                ${row.rejection_reason ? html`<div>rejection: ${row.rejection_reason}</div>` : null}
                ${row.transport ? html`<div>transport ${JSON.stringify(row.transport)}</div>` : null}
                ${row.observed ? html`<pre class="aw-file-text">${JSON.stringify(row.observed, null, 2)}</pre>` : null}
                ${row.content_excerpt ? html`<pre class="aw-file-text">${row.content_excerpt}</pre>` : null}
                ${row.content_digest ? html`<div>content digest ${row.content_digest}</div>` : null}
            <//>
        </div>`;
    }

    if (row.kind === "review") {
        return html`<div class="aw-row" data-kind="review">
            <div class="aw-card">
                <div class="aw-card-head">
                    <strong>Work review${row.bootstrap ? " (bootstrap)" : ""}</strong>
                    <${Badge} tone=${row.retrieval_status === "ready" ? "ok" : row.retrieval_status ? "warn" : "bad"}>
                        ${row.retrieval_status ?? "unknown"}
                    <//>
                    <span class="aw-when">${when(row.recorded_at)}</span>
                </div>
                ${row.blocker ? html`<div class="aw-body">${row.blocker}</div>` : null}
                ${row.next_step ? html`<div class="aw-muted">next: ${row.next_step}</div>` : null}
                <div class="aw-faint">unverified model summary · trigger ${row.trigger_id ?? "unknown"}</div>
            </div>
        </div>`;
    }

    if (row.kind === "checkpoint") {
        return html`<div class="aw-row" data-kind="checkpoint">
            <${Collapsible} summary=${"round checkpoint"} when=${row.recorded_at}>
                <div class="aw-body">${row.text ?? ""}</div>
                <div>unverified model summary</div>
            <//>
        </div>`;
    }

    if (row.kind === "knowledge") {
        return html`<div class="aw-row" data-kind="knowledge">
            <${Collapsible} summary=${`knowledge · ${row.status ?? "unknown"}`} when=${row.recorded_at}>
                <div>query ${row.query ?? ""}</div>
                <div>mode ${row.mode ?? "unknown"}</div>
                ${
                    row.selected?.length
                        ? html`<div>${row.selected.map((item) => html`<div key=${item.knowledge_id}>${item.knowledge_id} · ${item.source_uri ?? ""}</div>`)}</div>`
                        : html`<div>no selected references</div>`
                }
            <//>
        </div>`;
    }

    if (row.kind === "settled") {
        return html`<div class="aw-row" data-kind="settled">
            <div class="aw-muted" style="text-align:center">
                settled ${row.context_usage?.known ? `· context ${Math.round(row.context_usage.percent)}%` : ""} ${when(row.recorded_at)}
            </div>
        </div>`;
    }

    if (row.kind === "session") {
        return html`<div class="aw-row" data-kind="session">
            <div class="aw-muted" style="text-align:center">
                ${row.event_type === "session.started" ? "session started" : "session shut down"} ·
                ${shortSession(row.session_id)} · ${when(row.recorded_at)}
            </div>
        </div>`;
    }

    if (row.kind === "request") {
        return html`<div class="aw-row" data-kind="request">
            <${Collapsible} summary=${row.provider_bound ? "provider request" : `request refused (${row.refusal_reason ?? "unknown"})`} when=${row.recorded_at}>
                <div>RAM digest ${row.ram_digest ?? "unknown"}</div>
                <div>estimated chars ${row.ram_estimated_chars ?? "unknown"}</div>
            <//>
        </div>`;
    }

    if (row.kind === "outcome") {
        return html`<div class="aw-row" data-kind="outcome">
            <div class="aw-card">
                <div class="aw-card-head">
                    <strong>Outcome</strong>
                    <${Badge} tone=${row.status === "success" ? "ok" : row.status === "failure" ? "bad" : "warn"}>
                        ${row.status}
                    <//>
                    <span class="aw-when">${when(row.recorded_at)}</span>
                </div>
                <div class="aw-muted">criterion ${row.criterion ?? "unknown"} · source ${row.source_kind ?? "unknown"}</div>
            </div>
        </div>`;
    }

    return html`<div class="aw-row">
        <${Collapsible} summary=${summaryOf(row)} when=${row.recorded_at}>
            <pre class="aw-file-text">${JSON.stringify(row, null, 2)}</pre>
        <//>
    </div>`;
}

function RotationRow({ row }) {
    const [open, setOpen] = useState(false);

    return html`<div>
        <div class="aw-rot">
            <button aria-expanded=${open} onClick=${() => setOpen(!open)}>
                ↻ Session rotated · same task/episode ${open ? "▾" : "▸"}
            </button>
        </div>
        ${
            open
                ? html`<div class="aw-row">
                  <${Details}>
                      <div>from ${row.from_session ?? "unknown"}</div>
                      <div>to ${row.to_session ?? "unknown"}</div>
                      <div>identity ${row.identity ?? "unknown"}</div>
                      <div>request ${row.request_id ?? "unknown"}</div>
                  <//>
              </div>`
                : null
        }
    </div>`;
}

// ── panels ──────────────────────────────────────────────────

function ProgressPanel({ view, status, host }) {
    const progress = view?.progress ?? {};
    const identity = view?.identity ?? {};
    const reviewBadge = badgeToneForReview(progress.review_required, Boolean(progress.review));

    return html`<${Fragment}>
        <${Section} title="Host">
            <${Facts}
                rows=${[
                    ["console", status?.console_status ?? host?.state ?? "unknown"],
                    ["host", host?.state ?? "unknown"],
                    ["blocked", status?.block_reason ?? null],
                    [
                        "model",
                        status?.model
                            ? `${status.model.provider ?? "?"}/${status.model.id ?? "?"}`
                            : null,
                    ],
                    ["session", status?.session_id ? shortSession(status.session_id) : null],
                    [
                        "rotations",
                        `${status?.auto_rotations ?? 0} applied / ${status?.rotations_completed ?? 0} committed`,
                    ],
                    ["continuations", status?.continuations ?? null],
                ]}
            />
            ${host?.reason ? html`<div class="aw-banner" data-tone="warn">${host.reason}</div>` : null}
        <//>
        <${Section} title=${`Work cycle · ${progress.work_unit_state ?? "unknown"}`}>
            <div class="aw-item-head">
                <${Badge} tone=${reviewBadge}>${progress.review_required ? "review hold" : "no hold"}<//>
                ${progress.bootstrap_review ? html`<${Badge} tone="warn">bootstrap<//>` : null}
                ${progress.complete_candidate ? html`<${Badge} tone="info">complete candidate<//>` : null}
            </div>
            ${
                progress.intent
                    ? html`<${Facts} rows=${[
                          [
                              "intent",
                              `${progress.intent.scope ?? "?"} · ${progress.intent.event_id}`,
                          ],
                          ["text", progress.intent.text ?? null],
                      ]} />`
                    : html`<div class="aw-muted">No accepted scoped Intent yet. Every side effect stays blocked until one is committed.</div>`
            }
            ${progress.reasons?.length ? html`<div class="aw-muted">reasons: ${progress.reasons.join(", ")}</div>` : null}
            ${progress.next_step ? html`<div class="aw-body">Next: ${progress.next_step}</div>` : null}
        <//>
        <${Section} title="Counters">
            <${Facts}
                rows=${[
                    [
                        "cumulative",
                        `${progress.counters?.cumulative_action_count ?? 0} effect attempts since trusted progress`,
                    ],
                    [
                        "this review round",
                        `${progress.counters?.review_round_action_count ?? 0} effect attempts`,
                    ],
                    ["routes", progress.counters?.unique_routes ?? 0],
                    ["repeats", progress.counters?.repeat_count ?? 0],
                    ["trusted progress", progress.trusted_progress_event_id ?? null],
                ]}
            />
            <div class="aw-faint">the two counts are different: rotation and review do not reset the cumulative one</div>
        <//>
        <${Section} title="Latest review / checkpoint">
            ${
                progress.review
                    ? html`<${Facts} rows=${[
                          ["review", progress.review.event_id],
                          ["retrieval", progress.review.retrieval_status],
                          ["blocker", progress.review.blocker ?? null],
                          ["next", progress.review.next_step ?? null],
                          ["trust", progress.review.trust],
                      ]} />`
                    : html`<div class="aw-muted">no review value for the current trigger</div>`
            }
            ${
                progress.checkpoint
                    ? html`<${Facts} rows=${[
                          ["checkpoint", progress.checkpoint.event_id],
                          ["status", progress.checkpoint.unit_status],
                          ["summary", progress.checkpoint.summary ?? null],
                      ]} />`
                    : html`<div class="aw-muted">no checkpoint for the current unit</div>`
            }
            ${
                progress.consumptions?.length
                    ? html`<div class="aw-faint">consumed: ${progress.consumptions.map((item) => item.review_event_id).join(", ")}</div>`
                    : null
            }
        <//>
        <${Section} title="Responsibility">
            <${Facts}
                rows=${[
                    ["pending actions", progress.pending_actions ?? 0],
                    ["unknown effects", progress.unknown_actions ?? 0],
                ]}
            />
            ${
                (progress.unknown_actions ?? 0) > 0
                    ? html`<div class="aw-banner" data-tone="warn">An effect has an unknown result. The Host will not resume or rotate until it is reconciled.</div>`
                    : null
            }
        <//>
    <//>`;
}

function BoardPanel({ view }) {
    const board = view?.board ?? { nodes: [], counts: {} };
    const [type, setType] = useState("all");
    const [selected, setSelected] = useState(null);
    const nodes = useMemo(
        () => (board.nodes ?? []).filter((node) => type === "all" || node.type === type),
        [board.nodes, type],
    );

    return html`<${Fragment}>
        <${Section} title="Board (committed projection)">
            <div class="aw-chips">
                ${["all", "Intent", "Hint", "Fact", "Refuted", "Artifact", "Origin"].map(
                    (id) => html`<button
                        key=${id}
                        class="aw-tab"
                        aria-selected=${type === id}
                        onClick=${() => setType(id)}
                    >
                        ${id === "all" ? "all" : `${id} ${board.counts?.[id]?.effective ?? 0}/${board.counts?.[id]?.total ?? 0}`}
                    </button>`,
                )}
            </div>
            ${
                board.truncated
                    ? html`<div class="aw-banner" data-tone="warn">
                      Showing ${board.nodes.length} of ${board.total_nodes} nodes. Older nodes stay in the EventLog.
                  </div>`
                    : null
            }
            ${
                nodes.length === 0
                    ? html`<div class="aw-empty">No board nodes yet.</div>`
                    : html`<ul class="aw-list-flat">
                      ${nodes.map(
                          (node) => html`<li class="aw-item" key=${node.node_id}>
                              <div class="aw-item-head">
                                  <${Badge} tone=${node.effective ? "ok" : null}>${node.type}<//>
                                  ${node.effective ? html`<span class="aw-faint">effective</span>` : html`<span class="aw-faint">superseded</span>`}
                                  ${node.scope ? html`<span class="aw-faint">${node.scope}</span>` : null}
                              </div>
                              <p>${node.text}</p>
                              <div class="aw-item-head">
                                  <button class="aw-tab" onClick=${() => setSelected(node)}>evidence</button>
                                  <span class="aw-faint">${node.origin_event_id?.slice(0, 12) ?? ""}</span>
                              </div>
                          </li>`,
                      )}
                  </ul>`
            }
        <//>
        ${
            selected
                ? html`<${Section} title="Node details" actions=${html`<button class="aw-tab" onClick=${() => setSelected(null)}>close</button>`}>
                  <${Facts} rows=${[
                      ["node", selected.node_id],
                      ["type", selected.type],
                      ["status", selected.status],
                      ["scope", selected.scope],
                      ["criterion", selected.criterion],
                      ["origin", selected.origin_event_id],
                      ["action", selected.action_id],
                      ["tool", selected.tool_name],
                      ["outcome", selected.outcome_id],
                      ["superseded by", selected.superseded_by],
                  ]} />
                  ${
                      selected.observation_summary
                          ? html`<pre class="aw-file-text">${JSON.stringify(selected.observation_summary, null, 2)}</pre>`
                          : null
                  }
                  ${
                      selected.evidence_refs?.length
                          ? html`<div class="aw-faint">evidence: ${selected.evidence_refs.join(", ")}</div>`
                          : html`<div class="aw-muted">no evidence refs</div>`
                  }
                  ${
                      selected.source_refs?.length
                          ? html`<div class="aw-faint">sources: ${selected.source_refs.join(", ")}</div>`
                          : null
                  }
              <//>`
                : null
        }
    <//>`;
}

function KnowledgePanel({ view }) {
    const knowledge = view?.knowledge ?? { selections: [], usage: [] };

    return html`<${Fragment}>
        <${Section} title="Retrieval records">
            <div class="aw-faint">
                ready = a real search found references · no_match = search ran, nothing relevant · unavailable = the corpus
                could not be read · disabled = the trusted policy turned retrieval off.
            </div>
            ${
                knowledge.selections.length === 0
                    ? html`<div class="aw-empty">No knowledge selection in this episode.</div>`
                    : html`<ul class="aw-list-flat aw-scroll-y">
                      ${knowledge.selections
                          .slice()
                          .reverse()
                          .map(
                              (item) => html`<li class="aw-item" key=${item.event_id}>
                                  <div class="aw-item-head">
                                      <${Badge} tone=${item.status === "ready" ? "ok" : item.status === "no_match" ? null : "bad"}>
                                          ${item.status}
                                      <//>
                                      <span class="aw-faint">${item.mode ?? "mode"} · ${when(item.recorded_at)}</span>
                                  </div>
                                  <p>${item.query ?? "(no query)"}</p>
                                  ${
                                      item.selected?.length
                                          ? html`<div class="aw-faint">${item.selected.map((ref) => ref.knowledge_id).join(", ")}</div>`
                                          : html`<div class="aw-muted">selected: none</div>`
                                  }
                                  ${item.reason ? html`<div class="aw-muted">${item.reason}</div>` : null}
                              </li>`,
                          )}
                  </ul>`
            }
            ${knowledge.truncated ? html`<div class="aw-banner" data-tone="warn">Older selections are omitted.</div>` : null}
        <//>
        <${Section} title="Reference use">
            <div class="aw-faint">
                "used" is only shown with an independent Fact that references the action result; a selection or a model
                claim is never use.
            </div>
            ${
                knowledge.usage?.length
                    ? html`<ul class="aw-list-flat">
                      ${knowledge.usage.map(
                          (entry) => html`<li class="aw-item" key=${entry.selection_event_id}>
                              <div class="aw-item-head">
                                  <${Badge} tone=${entry.status === "used" ? "ok" : entry.status === "adopted" ? "warn" : null}>
                                      ${entry.status}
                                  <//>
                                  <span class="aw-faint">${entry.knowledge_ids?.join(", ")}</span>
                              </div>
                              <div class="aw-faint">selection ${entry.selection_event_id ?? "none"}</div>
                              <div class="aw-faint">intent ${entry.intent_event_id ?? "none"}</div>
                              <div class="aw-faint">outcome ${entry.outcome_event_id ?? "none"}</div>
                          </li>`,
                      )}
                  </ul>`
                    : html`<div class="aw-empty">No adopted reference yet.</div>`
            }
        <//>
        <${Section} title="Experience">
            <div class="aw-muted">
                Active Experience is not editable from this UI. Only the existing compiler/router authority can mark a
                condition active, so this view shows none rather than inventing a status.
            </div>
        <//>
    <//>`;
}

function SessionPanel({ view, status }) {
    const session = view?.session ?? {};
    const ram = session.ram ?? {};

    return html`<${Fragment}>
        <${Section} title="Current Session">
            <${Facts} rows=${[
                ["session", status?.session_id ?? session.current],
                ["file", status?.session_file ?? session.session_file],
                ["creations", status?.session_creations ?? null],
                ["episode", view?.identity?.episode_id],
                ["task", view?.identity?.task_id],
            ]} />
        <//>
        <${Section} title="Rotations (same Task/Episode)">
            ${
                session.rotations?.length
                    ? html`<ul class="aw-list-flat">
                      ${session.rotations
                          .slice()
                          .reverse()
                          .map(
                              (row) => html`<li class="aw-item" key=${row.event_id}>
                                  <div class="aw-item-head">
                                      <${Badge} tone="info">rotation<//>
                                      <span class="aw-faint">${when(row.recorded_at)}</span>
                                  </div>
                                  <div class="aw-faint">${row.from_session ?? "?"} → ${row.to_session ?? "?"}</div>
                                  <div class="aw-faint">identity ${row.identity ?? "unknown"}</div>
                              </li>`,
                          )}
                  </ul>`
                    : html`<div class="aw-empty">No Session rotation in this Episode.</div>`
            }
            ${
                session.rotations_truncated
                    ? html`<div class="aw-banner" data-tone="warn">Older rotations are omitted.</div>`
                    : null
            }
        <//>
        <${Section} title="Context">
            ${
                session.context?.known
                    ? html`<${Facts} rows=${[
                          ["used tokens", session.context.used_tokens],
                          ["limit tokens", session.context.limit_tokens],
                          ["used", `${Math.round(session.context.percent)}%`],
                          ["at", session.context.recorded_at],
                      ]} />`
                    : html`<div class="aw-muted">Context usage is unknown (the SDK did not report it).</div>`
            }
        <//>
        <${Section} title="RAM">
            <h3>Last provider-bound RAM (audit)</h3>
            ${
                ram.provider_bound?.available
                    ? html`<${Facts} rows=${[
                          ["digest", ram.provider_bound.digest],
                          ["estimated chars", ram.provider_bound.estimated_chars],
                          ["budget chars", ram.provider_bound.budget_chars],
                          ["overflow", ram.provider_bound.overflow ? "yes" : "no"],
                          ["core overflow", ram.provider_bound.core_overflow ? "yes" : "no"],
                          ["at", ram.provider_bound.recorded_at],
                      ]} />`
                    : html`<div class="aw-muted">${ram.provider_bound?.reason ?? "not available"}</div>`
            }
            ${
                ram.provider_bound?.available && ram.provider_bound.text_available === false
                    ? html`<div class="aw-faint">text is not persisted: only the digest and section counts were committed</div>`
                    : null
            }
            ${
                ram.provider_bound?.sections
                    ? html`<pre class="aw-file-text">${JSON.stringify(ram.provider_bound.sections, null, 2)}</pre>`
                    : null
            }
            <h3>Rebuilt now from the committed prefix</h3>
            ${
                ram.rebuilt?.available
                    ? html`<div>
                      <div class="aw-faint">${ram.rebuilt.note ?? ""}</div>
                      <details>
                          <summary class="aw-tab">show rebuilt RAM</summary>
                          <pre class="aw-file-text">${ram.rebuilt.text}</pre>
                      </details>
                      ${
                          ram.rebuilt.overflow
                              ? html`<div class="aw-banner" data-tone="warn">optional content was omitted to fit the budget</div>`
                              : null
                      }
                      ${
                          ram.rebuilt.core_overflow
                              ? html`<div class="aw-banner">core overflow: a provider request would be refused</div>`
                              : null
                      }
                  </div>`
                    : html`<div class="aw-muted">${ram.rebuilt?.reason ?? "unavailable"}</div>`
            }
            <div class="aw-faint">rotation counters are process-scoped, not a cross-restart budget</div>
        <//>
    <//>`;
}

function ActionsPanel({ view }) {
    const actions = view?.actions ?? {};

    return html`<${Fragment}>
        <${Section} title="Open responsibility">
            ${
                actions.pending?.length
                    ? html`<ul class="aw-list-flat">
                      ${actions.pending.map(
                          (row) => html`<li class="aw-item" key=${row.action_id}>
                              <div class="aw-item-head">
                                  <${Badge} tone="warn">${row.status}<//>
                                  <strong>${row.tool_name ?? "tool"}</strong>
                              </div>
                              <div class="aw-faint">${row.action_id}</div>
                          </li>`,
                      )}
                  </ul>`
                    : html`<div class="aw-empty">Nothing pending.</div>`
            }
            ${
                actions.unknown?.length
                    ? html`<div class="aw-banner" data-tone="warn">
                      ${actions.unknown.length} action(s) have an unknown result. They are NOT cleared by this UI and will not
                      be replayed automatically.
                  </div>`
                    : null
            }
        <//>
        <${Section} title="Recent actions">
            ${
                actions.recent?.length
                    ? html`<ul class="aw-list-flat aw-scroll-y">
                      ${actions.recent.map(
                          (row) => html`<li class="aw-item" key=${row.action_id}>
                              <div class="aw-item-head">
                                  <${Badge} tone=${row.rejected ? "bad" : row.unknown ? "warn" : "ok"}>
                                      ${row.status}
                                  <//>
                                  <strong>${row.tool_name ?? "tool"}</strong>
                                  <span class="aw-faint">${when(row.requested_at)}</span>
                              </div>
                              ${row.rejection_reason ? html`<p>${row.rejection_reason}</p>` : null}
                              <details>
                                  <summary class="aw-tab">details</summary>
                                  <pre class="aw-file-text">${JSON.stringify(
                                      {
                                          action_id: row.action_id,
                                          arguments_digest: row.arguments_digest,
                                          content_digest: row.content_digest,
                                          transport: row.transport,
                                          observed: row.observed,
                                          detail: row.detail,
                                      },
                                      null,
                                      2,
                                  )}</pre>
                              </details>
                          </li>`,
                      )}
                  </ul>`
                    : html`<div class="aw-empty">No action recorded yet.</div>`
            }
            ${actions.truncated ? html`<div class="aw-banner" data-tone="warn">Older actions are omitted.</div>` : null}
        <//>
        <${Section} title="Outcomes (independent)">
            ${
                actions.outcomes?.length
                    ? html`<ul class="aw-list-flat">
                      ${actions.outcomes.map(
                          (row) => html`<li class="aw-item" key=${row.event_id}>
                              <div class="aw-item-head">
                                  <${Badge} tone=${row.status === "success" ? "ok" : row.status === "failure" ? "bad" : "warn"}>
                                      ${row.status}
                                  <//>
                                  <span class="aw-faint">source ${row.source_kind ?? "unknown"}</span>
                              </div>
                              <div class="aw-faint">criterion ${row.criterion ?? "-"}</div>
                              ${row.value ? html`<pre class="aw-file-text">${JSON.stringify(row.value, null, 2)}</pre>` : null}
                          </li>`,
                      )}
                  </ul>`
                    : html`<div class="aw-empty">No Outcome recorded. A model message is not success.</div>`
            }
        <//>
        <${Section} title="Provider requests">
            ${
                actions.model_requests?.length
                    ? html`<ul class="aw-list-flat aw-scroll-y">
                      ${actions.model_requests
                          .slice()
                          .reverse()
                          .map(
                              (row) => html`<li class="aw-item" key=${row.event_id}>
                                  <div class="aw-item-head">
                                      <${Badge} tone=${row.provider_bound ? "ok" : "bad"}>
                                          ${row.provider_bound ? "provider-bound" : "refused"}
                                      <//>
                                      <span class="aw-faint">${when(row.recorded_at)}</span>
                                  </div>
                                  <div class="aw-faint">RAM ${row.ram_digest ?? "-"} · ${row.ram_estimated_chars ?? "?"} chars</div>
                              </li>`,
                          )}
                  </ul>`
                    : html`<div class="aw-empty">No request projected yet.</div>`
            }
        <//>
    <//>`;
}

function FilesPanel({ label, enabled }) {
    const [path, setPath] = useState("");
    const [listing, setListing] = useState(null);
    const [file, setFile] = useState(null);
    const [error, setError] = useState(null);
    const load = useCallback(
        async (next) => {
            setError(null);

            try {
                const result = await api.files(label, next);

                setListing(result);
                setPath(result.path ?? "");
            } catch (err) {
                setError(err.message);
            }
        },
        [label],
    );

    useEffect(() => {
        if (enabled) {
            load("");
        }
    }, [enabled, load]);

    const openFile = async (name) => {
        setError(null);

        try {
            setFile(await api.file(label, path ? `${path}/${name}` : name));
        } catch (err) {
            setError(err.message);
        }
    };

    return html`<${Fragment}>
        <${Section} title="Workspace files">
            ${!enabled ? html`<div class="aw-muted">Open a task to browse its workspace.</div>` : null}
            ${
                enabled
                    ? html`<div class="aw-item-head">
                      <button class="aw-tab" onClick=${() => load("")}>root</button>
                      ${
                          path
                              ? html`<button class="aw-tab" onClick=${() => load(path.split("/").slice(0, -1).join("/"))}>up</button>`
                              : null
                      }
                      <span class="aw-faint">/${path}</span>
                  </div>`
                    : null
            }
            ${error ? html`<div class="aw-banner">${error}</div>` : null}
            ${
                listing?.truncated
                    ? html`<div class="aw-banner" data-tone="warn">Listing truncated at ${listing.limit} entries.</div>`
                    : null
            }
            ${
                listing
                    ? html`<div class="aw-tree">
                      ${listing.entries.map(
                          (entry) => html`<button
                              key=${entry.name}
                              data-dir=${entry.kind === "directory"}
                              onClick=${() => (entry.kind === "directory" ? load(path ? `${path}/${entry.name}` : entry.name) : openFile(entry.name))}
                          >
                              <span>${entry.kind === "directory" ? "▸" : "•"}</span>
                              <span>${entry.name}</span>
                              <span class="aw-faint">${entry.kind === "outside" ? "outside workspace" : (entry.size ?? "")}</span>
                          </button>`,
                      )}
                  </div>`
                    : null
            }
        <//>
        ${
            file
                ? html`<${Section} title=${file.path} actions=${html`<button class="aw-tab" onClick=${() => setFile(null)}>close</button>`}>
                  <div class="aw-faint">
                      ${file.size} bytes · shown ${file.bytes_shown}${file.truncated ? " (truncated)" : ""} ·
                      ${file.binary ? "binary" : "text"}
                  </div>
                  ${
                      file.binary
                          ? html`<div class="aw-muted">Binary file: not rendered.</div>`
                          : html`<pre class="aw-file-text">${file.text}</pre>`
                  }
              <//>`
                : null
        }
    <//>`;
}

function HistoryPanel({ experiments, selected, onOpen }) {
    return html`<${Section} title="Experiments / runs">
        ${
            experiments.length === 0
                ? html`<div class="aw-empty">No experiment yet.</div>`
                : html`<ul class="aw-list-flat">
                  ${experiments.map(
                      (row) => html`<li class="aw-item" key=${row.label}>
                          <div class="aw-item-head">
                              <strong>${row.label}</strong>
                              <${Badge} tone=${toneForHost(row.host_state)}>${row.host_state}<//>
                              <span class="aw-faint">${row.rows} events</span>
                          </div>
                          <div class="aw-faint">task ${row.task_id} · ${row.episodes} episode(s)</div>
                          <div class="aw-item-head">
                              <button class="aw-tab" onClick=${() => onOpen(row.label)}>
                                  ${row.label === selected ? "open" : "open read-only view"}
                              </button>
                          </div>
                      </li>`,
                  )}
              </ul>`
        }
        <div class="aw-faint">Opening a stopped run shows its committed log; it never starts a new writer.</div>
    <//>`;
}

function SettingsPanel({ health, theme, setTheme }) {
    return html`<${Fragment}>
        <${Section} title="Appearance">
            <div class="aw-chips">
                ${["dark", "light"].map(
                    (
                        mode,
                    ) => html`<button class="aw-tab" aria-selected=${theme === mode} onClick=${() => setTheme(mode)}>
                        ${mode}
                    </button>`,
                )}
            </div>
            <div class="aw-faint">display preference only — stored in this browser, never task state</div>
        <//>
        <${Section} title="Server">
            <${Facts} rows=${[
                ["version", health?.version ?? "unknown"],
                ["home", health?.home ?? "unknown"],
                ["experiments", health?.experiments ?? 0],
                ["mode", "local loopback only"],
            ]} />
        <//>
        <${Section} title="Safety">
            <div class="aw-muted">
                This UI can send prompts and pause/resume/stop the Host. It cannot mark a task successful, clear an unknown
                effect, remove a review hold, or promote knowledge/experience.
            </div>
        <//>
    <//>`;
}

// ── new task dialog ─────────────────────────────────────────

function NewTaskDialog({ onClose, onCreated, defaults }) {
    const [label, setLabel] = useState("");
    const [workspace, setWorkspace] = useState("");
    const [provider, setProvider] = useState(defaults?.provider ?? "");
    const [model, setModel] = useState(defaults?.model ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const submit = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);

        try {
            await api.createExperiment({
                label: label.trim(),
                workspace: workspace.trim() || undefined,
                provider: provider.trim() || undefined,
                model: model.trim() || undefined,
            });
            onCreated(label.trim());
        } catch (err) {
            setError(err instanceof ApiError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="aw-dialog-scrim" onClick=${(event) => event.target === event.currentTarget && onClose()}>
        <form class="aw-dialog" onSubmit=${submit}>
            <h2>New task</h2>
            <div class="aw-field">
                <label for="aw-label">Experiment label (new, unique)</label>
                <input id="aw-label" value=${label} onInput=${(event) => setLabel(event.currentTarget.value)} placeholder="ctf-001" required />
            </div>
            <div class="aw-field">
                <label for="aw-workspace">Workspace (optional absolute path inside an allowed root)</label>
                <input id="aw-workspace" value=${workspace} onInput=${(event) => setWorkspace(event.currentTarget.value)} placeholder="(default: the experiment's own workspace)" />
            </div>
            <div class="aw-field">
                <label for="aw-provider">Provider (optional; default comes from your Pi config)</label>
                <input id="aw-provider" value=${provider} onInput=${(event) => setProvider(event.currentTarget.value)} placeholder="pi-config" />
            </div>
            <div class="aw-field">
                <label for="aw-model">Model id (optional)</label>
                <input id="aw-model" value=${model} onInput=${(event) => setModel(event.currentTarget.value)} placeholder="(default)" />
            </div>
            ${error ? html`<div class="aw-banner">${error}</div>` : null}
            <div class="aw-actions">
                <button class="aw-btn" type="button" onClick=${onClose} disabled=${busy}>Cancel</button>
                <button class="aw-btn" data-tone="primary" type="submit" disabled=${busy || !label.trim()}>
                    ${busy ? "creating…" : "Create and open"}
                </button>
            </div>
            <div class="aw-faint">
                The server validates the label and workspace, then starts ONE Host process for the experiment. A label must be
                new; use an existing run from the list instead.
            </div>
        </form>
    </div>`;
}

// ── app ─────────────────────────────────────────────────────

function App() {
    const [health, setHealth] = useState(null);
    const [experiments, setExperiments] = useState([]);
    const [selected, setSelected] = useState(null);
    const [detail, setDetail] = useState(null);
    const [rows, setRows] = useState([]);
    const [liveText, setLiveText] = useState("");
    const [panel, setPanel] = useState("progress");
    const [rail, setRail] = useState("workbench");
    const [drawer, setDrawer] = useState(null);
    const [dialog, setDialog] = useState(false);
    const [banner, setBanner] = useState(null);
    const [busy, setBusy] = useState(false);
    const [streamState, setStreamState] = useState({ connected: false });
    const [theme, setThemeState] = useState(() => localStorage.getItem("aegis.theme") ?? "dark");
    const [requestState, setRequestState] = useState(null);
    const streamRef = useRef(null);
    const requestRef = useRef(null);
    const chatRef = useRef(null);
    const stickRef = useRef(true);

    useEffect(() => {
        document.documentElement.dataset.mode = theme;

        try {
            localStorage.setItem("aegis.theme", theme);
        } catch {
            // storage is optional
        }
    }, [theme]);

    const refreshExperiments = useCallback(async () => {
        try {
            const result = await api.experiments();

            setExperiments(result.experiments ?? []);
        } catch (error) {
            setBanner({ tone: "warn", text: `cannot load experiments: ${error.message}` });
        }
    }, []);

    useEffect(() => {
        api.health()
            .then(setHealth)
            .catch(() => {});
        refreshExperiments();
        const timer = setInterval(refreshExperiments, 5000);

        return () => clearInterval(timer);
    }, [refreshExperiments]);

    const loadDetail = useCallback(async (label, { initial = false } = {}) => {
        try {
            const result = await api.view(label);

            setDetail(result);
            setRows(appendTo([], result.view?.transcript?.rows ?? []));

            if (initial) {
                saveCursor(label, result.cursor ?? result.view?.transcript?.cursor ?? 0);
            }

            return result;
        } catch (error) {
            setBanner({ tone: "warn", text: `cannot load ${label}: ${error.message}` });

            return null;
        }
    }, []);

    const open = useCallback(
        async (label, { attach = true } = {}) => {
            setSelected(label);
            setDrawer(null);
            setLiveText("");
            streamRef.current?.close();
            setBanner(null);
            const initial = await loadDetail(label, { initial: true });

            if (attach && initial) {
                if (initial.host?.state === "conflict") {
                    setBanner({
                        tone: "warn",
                        text: "This experiment is owned by another process (a CLI or another console). This view is read-only and will not start a second writer.",
                    });
                } else if (initial.host?.state !== "ready") {
                    try {
                        const attached = await api.attach(label);

                        if (!attached.ok) {
                            setBanner({
                                tone: attached.state === "conflict" ? "warn" : "warn",
                                text: attached.reason ?? "the Host could not be attached",
                            });
                        }

                        await loadDetail(label);
                    } catch (error) {
                        setBanner({ tone: "warn", text: `attach failed: ${error.message}` });
                    }
                }
            }

            const cursor = loadCursor(label);

            streamRef.current = openStream(label, {
                cursor,
                onEvents: (payload) => {
                    if (payload.reset) {
                        // The cursor was invalid (log replaced/truncated): reload the view.
                        loadDetail(label);
                        saveCursor(label, payload.cursor ?? 0);

                        return;
                    }

                    saveCursor(label, payload.cursor ?? cursor);
                    setRows((current) => appendTo(current, payload.rows ?? []));
                },
                onStatus: (payload) => {
                    setDetail((current) =>
                        current
                            ? {
                                  ...current,
                                  status: payload.status ?? current.status,
                                  host: { state: payload.state, reason: payload.reason },
                              }
                            : current,
                    );
                },
                onDelta: (payload) => {
                    setLiveText((current) => (current + (payload.text ?? "")).slice(-8000));
                },
                onHost: (payload) => {
                    setDetail((current) =>
                        current
                            ? {
                                  ...current,
                                  host: {
                                      ...current.host,
                                      state: payload.state,
                                      reason: payload.reason,
                                  },
                              }
                            : current,
                    );
                },
                onState: setStreamState,
            });
        },
        [loadDetail],
    );

    useEffect(() => {
        const match = /^#\/e\/(.+)$/.exec(location.hash);

        if (match) {
            open(decodeURIComponent(match[1]));
        }

        return () => streamRef.current?.close();
    }, [open]);

    useEffect(() => {
        if (selected) {
            history.replaceState(null, "", `#/e/${encodeURIComponent(selected)}`);
        }
    }, [selected]);

    // Follow new committed rows only while the reader is at the bottom.
    useEffect(() => {
        const node = chatRef.current;

        if (!node || !stickRef.current) {
            return;
        }

        node.scrollTop = node.scrollHeight;
    }, [rows, liveText]);

    const status = detail?.status ?? null;
    const view = detail?.view ?? null;
    const host = detail?.host ?? { state: "stopped" };
    const phase = status?.console_status ?? host.state;
    const canSend = host.state === "ready" && phase !== "paused" && phase !== "stopped";

    const send = async () => {
        const text = requestRef.current?.value ?? "";

        if (!text.trim() || !selected) {
            return;
        }

        const id = makeRequestId("msg");

        setBusy(true);
        setBanner(null);
        setRequestState({ id, state: "sending" });

        try {
            const result = await api.send(selected, { text: text.trim(), requestId: id });

            requestRef.current.value = "";
            setLiveText("");
            setRequestState({ id, state: result.duplicate ? "duplicate" : "accepted", result });

            if (result.duplicate) {
                setBanner({
                    tone: "warn",
                    text: "This exact request was already accepted. It was not sent again.",
                });
            }

            await loadDetail(selected);
        } catch (error) {
            // A retried request must keep its id; never silently re-run with a new one.
            const unknown =
                error instanceof ApiError && (error.status === 503 || error.status === 504);

            setRequestState({ id, state: unknown ? "unknown" : "rejected", error: error.message });
            setBanner({
                tone: unknown ? "warn" : "error",
                text: unknown
                    ? "Delivery could not be confirmed. It may or may not have run — the Host keeps it as unknown and this UI will not resend it automatically."
                    : error.message,
            });
            await loadDetail(selected);
        } finally {
            setBusy(false);
        }
    };

    const control = async (action) => {
        if (!selected) {
            return;
        }

        if (
            action === "stop" &&
            !globalThis.confirm(
                "Stop the Host for this experiment? An action with an unknown result keeps its responsibility.",
            )
        ) {
            return;
        }

        setBusy(true);

        try {
            await api[action](selected);
            await loadDetail(selected);
        } catch (error) {
            setBanner({ tone: "warn", text: `${action} failed: ${error.message}` });
        } finally {
            setBusy(false);
        }
    };

    const panelForRail = (id) => {
        if (id === "board") {
            return "board";
        }

        if (id === "knowledge") {
            return "knowledge";
        }

        if (id === "history") {
            return "session";
        }

        return "progress";
    };

    const showPanel = (id) => {
        setPanel(id);
        setDrawer("details");
    };

    return html`<div class="aw-app" data-drawer=${drawer ?? undefined}>
        <nav class="aw-rail" aria-label="workspaces">
            <div class="aw-rail-mark" aria-hidden="true">A</div>
            ${RAILS.map(
                (item) => html`<button
                    key=${item.id}
                    class="aw-rail-button"
                    aria-pressed=${rail === item.id}
                    title=${item.label}
                    onClick=${() => {
                        setRail(item.id);

                        if (item.id === "history") {
                            setExperiments(experiments);
                        }

                        setPanel(panelForRail(item.id));
                    }}
                >
                    <span class="aw-glyph">${item.glyph}</span>
                    <span>${item.label}</span>
                </button>`,
            )}
            <div class="aw-rail-fill"></div>
            <button class="aw-rail-button" title="New task" onClick=${() => setDialog(true)}>
                <span class="aw-glyph">+</span>
                <span>New</span>
            </button>
        </nav>

        <aside class="aw-list" aria-label="experiments">
            <div class="aw-list-head">
                <h1>Tasks</h1>
                <button class="aw-icon" title="close list" onClick=${() => setDrawer(null)}>✕</button>
            </div>
            <div class="aw-list-body">
                <button class="aw-btn" data-tone="primary" onClick=${() => setDialog(true)}>+ New task</button>
                ${
                    experiments.length === 0
                        ? html`<div class="aw-empty">No experiment yet. Create one to start a Host-managed task.</div>`
                        : experiments.map(
                              (row) => html`<button
                              key=${row.label}
                              class="aw-exp"
                              aria-current=${selected === row.label}
                              onClick=${() => open(row.label)}
                          >
                              <span class="aw-exp-label">${row.label}</span>
                              <span class="aw-exp-meta">
                                  <${Badge} tone=${toneForHost(row.host_state)}>${row.host_state}<//>
                                  <span>${row.rows} events</span>
                              </span>
                              <span class="aw-exp-meta">${row.last_event_at ? when(row.last_event_at) : "no events"}</span>
                          </button>`,
                          )
                }
            </div>
        </aside>

        <main class="aw-main">
            <header class="aw-top">
                <button class="aw-icon aw-mobile-only" title="tasks" onClick=${() => setDrawer(drawer === "list" ? null : "list")}>☰</button>
                <div class="aw-top-title">
                    <strong>${selected ?? "Aegis"}</strong>
                    <span>
                        ${status?.episode_id ? `episode ${status.episode_id}` : (view?.identity?.episode_id ?? "no episode")} ·
                        task ${status?.task_id ?? view?.identity?.task_id ?? "-"}
                    </span>
                </div>
                <div class="aw-chips">
                    <${Chip} tone=${toneForStatus(phase)}>${phase ?? "no host"}<//>
                    ${status?.work_unit_state ? html`<${Chip}>${status.work_unit_state}<//>` : null}
                    ${
                        status?.model
                            ? html`<${Chip}>${status.model.provider ?? "?"}/${status.model.id ?? "?"}<//>`
                            : null
                    }
                    ${
                        view?.session?.context?.known
                            ? html`<${Chip} tone=${view.session.context.percent >= 85 ? "warn" : null}>ctx ${Math.round(view.session.context.percent)}%<//>`
                            : html`<${Chip}>ctx unknown<//>`
                    }
                    <${Chip} tone=${streamState.connected ? "ok" : "warn"}>${streamState.connected ? "live" : "reconnecting"}<//>
                </div>
                <button class="aw-icon aw-mobile-only" title="details" onClick=${() => setDrawer(drawer === "details" ? null : "details")}>ⓘ</button>
            </header>

            ${
                banner
                    ? html`<div style="padding: 8px 12px 0">
                      <div class="aw-banner" data-tone=${banner.tone ?? "error"}>
                          <span>${banner.text}</span>
                          <button onClick=${() => setBanner(null)}>✕</button>
                      </div>
                  </div>`
                    : null
            }

            <section
                class="aw-chat"
                aria-live="polite"
                ref=${chatRef}
                onScroll=${(event) => {
                    const el = event.currentTarget;

                    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                }}
            >
                ${
                    !selected
                        ? html`<div class="aw-empty" style="margin:auto;max-width:420px">
                          Choose a task on the left, or create a new one. Every task runs in its own Aegis Host process.
                      </div>`
                        : null
                }
                ${rows.length === 0 && selected ? html`<div class="aw-empty">No committed conversation yet.</div>` : null}
                ${rows.map((row) => html`<${TranscriptRow} key=${rowKey(row)} row=${row} />`)}
                ${
                    liveText
                        ? html`<div class="aw-row aw-live">
                          <div class="aw-card">
                              <div class="aw-card-head"><strong>Assistant · live</strong><${Badge} tone="warn">uncommitted<//></div>
                              <div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(liveText) }}></div>
                              <div class="aw-faint">temporary tokens; the committed message replaces this after settle</div>
                          </div>
                      </div>`
                        : null
                }
            </section>

            <footer class="aw-composer">
                ${
                    requestState && requestState.state === "unknown"
                        ? html`<div class="aw-banner" data-tone="warn">
                          <span>
                              Request <code>${requestState.id.slice(0, 20)}…</code> has an UNKNOWN outcome. It keeps that
                              responsibility; this UI will not resend it.
                          </span>
                      </div>`
                        : null
                }
                <div class="aw-compose-box">
                    <textarea
                        ref=${requestRef}
                        placeholder=${canSend ? "Message the Host (Enter to send, Shift+Enter for a newline)" : "The Host is not accepting messages right now"}
                        rows="2"
                        disabled=${!canSend || busy}
                        onKeyDown=${(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                send();
                            }
                        }}
                    ></textarea>
                    <button class="aw-btn" data-tone="primary" onClick=${send} disabled=${!canSend || busy}>
                        ${busy ? "…" : "Send"}
                    </button>
                </div>
                <div class="aw-actions">
                    <button class="aw-btn" onClick=${() => control("pause")} disabled=${!selected || host.state !== "ready" || phase === "paused"} title="stop dispatching new work; a running tool is not aborted">
                        Pause dispatch
                    </button>
                    <button class="aw-btn" onClick=${() => control("resume")} disabled=${!selected || host.state !== "ready"} title="re-run recovery checks, then accept new work">
                        Resume
                    </button>
                    <button class="aw-btn" data-tone="danger" onClick=${() => control("stop")} disabled=${!selected} title="shut the Host down; unknown effects keep their responsibility">
                        Stop Host
                    </button>
                    <span class="aw-faint">
                        pause stops dispatching only · stop is a Host shutdown · neither rolls back an effect
                    </span>
                </div>
            </footer>
        </main>

        <aside class="aw-details" aria-label="details">
            <div class="aw-tabs" role="tablist">
                ${PANELS.map(
                    (item) => html`<button
                        key=${item.id}
                        class="aw-tab"
                        role="tab"
                        aria-selected=${panel === item.id}
                        onClick=${() => setPanel(item.id)}
                    >
                        ${item.label}
                    </button>`,
                )}
                <button class="aw-tab aw-mobile-only" onClick=${() => setDrawer(null)}>✕</button>
            </div>
            <div class="aw-panel">
                ${
                    !selected
                        ? html`<${Section} title="Nothing open">
                          <div class="aw-muted">Open a task to see its committed progress, board, knowledge, session and actions.</div>
                      <//>`
                        : rail === "history"
                          ? html`<${HistoryPanel} experiments=${experiments} selected=${selected} onOpen=${(label) => open(label)} />`
                          : rail === "settings"
                            ? html`<${SettingsPanel} health=${health} theme=${theme} setTheme=${setThemeState} />`
                            : panel === "progress"
                              ? html`<${ProgressPanel} view=${view} status=${status} host=${host} />`
                              : panel === "board"
                                ? html`<${BoardPanel} view=${view} />`
                                : panel === "knowledge"
                                  ? html`<${KnowledgePanel} view=${view} />`
                                  : panel === "session"
                                    ? html`<${SessionPanel} view=${view} status=${status} />`
                                    : panel === "actions"
                                      ? html`<${ActionsPanel} view=${view} />`
                                      : html`<${FilesPanel} label=${selected} enabled=${Boolean(selected)} />`
                }
            </div>
        </aside>

        ${
            dialog
                ? html`<${NewTaskDialog}
                  defaults=${null}
                  onClose=${() => setDialog(false)}
                  onCreated=${async (label) => {
                      setDialog(false);
                      await refreshExperiments();
                      await open(label);
                  }}
              />`
                : null
        }
    </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
