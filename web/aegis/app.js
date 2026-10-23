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
import {
    actionStatusLabel,
    apiErrorMessage,
    getLang,
    LANGS,
    locale,
    retrievalLabel,
    setLang,
    statusLabel,
    subscribeLang,
    t,
} from "./i18n.js";
import { appendTo, rowKey, summaryOf } from "./timeline.js";
import { loadCursor, openStream, saveCursor } from "./stream.js";

const html = htm.bind(h);

/** htm has no fragment shorthand; a component returning its children is one. */
function Fragment({ children }) {
    return children;
}

const RAILS = [
    { id: "workbench", glyph: "◧", key: "rail.workbench" },
    { id: "board", glyph: "◇", key: "rail.board" },
    { id: "knowledge", glyph: "❖", key: "rail.knowledge" },
    { id: "history", glyph: "◷", key: "rail.history" },
    { id: "settings", glyph: "⚙", key: "rail.settings" },
];

const PANELS = [
    { id: "progress", key: "tabs.progress" },
    { id: "board", key: "tabs.board" },
    { id: "knowledge", key: "tabs.knowledge" },
    { id: "session", key: "tabs.session" },
    { id: "actions", key: "tabs.actions" },
    { id: "files", key: "tabs.files" },
];

/** Re-render the calling component when the operator switches language. */
function useLang() {
    const [, bump] = useState(0);

    useEffect(() => subscribeLang(() => bump((n) => n + 1)), []);

    return getLang();
}

function when(value) {
    if (!value) {
        return "";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
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
        return id ?? t("common.none");
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
                    <dd>${value === null ? html`<span class="aw-faint">${t("common.null")}</span>` : value}</dd>
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

/** Translate the `summaryOf(row)` key/vars pair. */
function translatedSummary(row) {
    const summary = summaryOf(row);

    return t(summary.key, summary.vars);
}

// ── transcript rows ─────────────────────────────────────────

function Collapsible({ summary, children, when: at }) {
    const [open, setOpen] = useState(false);

    return html`<div class="aw-card">
        <div class="aw-card-head">
            <button
                class="aw-icon"
                aria-expanded=${open}
                onClick=${() => setOpen(!open)}
                title=${t("common.toggleDetails")}
            >
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
                <div class="aw-card-head">
                    <strong>${t("row.taskStarted")}</strong>
                    <span class="aw-when">${when(row.recorded_at)}</span>
                </div>
                ${
                    row.goal
                        ? html`<div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(row.goal) }}></div>`
                        : html`<div class="aw-muted">${t("row.openingPromptBelow")}</div>`
                }
                ${
                    row.authorization
                        ? html`<div class="aw-faint">${t("row.authorization", { value: row.authorization })}</div>`
                        : null
                }
            </div>
        </div>`;
    }

    if (row.kind === "prompt") {
        return html`<div class="aw-row" data-kind="prompt-record">
            <div class="aw-muted" style="text-align:center">
                ${t("row.followUp", {
                    chars: row.prompt_chars ?? "?",
                    digest: (row.prompt_digest ?? "").slice(0, 22),
                    at: when(row.recorded_at),
                })}
            </div>
        </div>`;
    }

    if (row.kind === "message" && row.role === "user") {
        return html`<div class="aw-row aw-user" data-kind="prompt">
            <div class="aw-card">
                <div class="aw-card-head">
                    <strong>${t("row.you")}</strong>
                    <span class="aw-when">${when(row.recorded_at)}</span>
                    ${
                        row.text_chars && row.text_chars > (row.text ?? "").length
                            ? html`<${Badge} tone="warn">${t("common.excerpt")}<//>`
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
                    <strong>${t("row.assistant")}</strong>
                    <span class="aw-when">${when(row.recorded_at)}</span>
                    ${
                        row.text_chars && row.text_chars > (row.text ?? "").length
                            ? html`<${Badge} tone="warn">${t("common.truncated")}<//>`
                            : null
                    }
                </div>
                ${
                    row.text
                        ? html`<div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(row.text) }}></div>`
                        : html`<div class="aw-muted">${t("row.noText")}</div>`
                }
                ${
                    row.session_id
                        ? html`<div class="aw-faint">${t("row.sessionLine", { id: shortSession(row.session_id) })}</div>`
                        : null
                }
            </div>
        </div>`;
    }

    if (row.kind === "message") {
        return html`<div class="aw-row" data-kind="tool">
            <${Collapsible}
                summary=${
                    row.role === "toolResult"
                        ? t("row.toolResult")
                        : t("row.kindMessage", {
                              types: row.content_types?.join(", ") || t("row.content"),
                          })
                }
                when=${row.recorded_at}
            >
                <div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(row.text ?? "") }}></div>
            <//>
        </div>`;
    }

    if (row.kind === "action-requested") {
        return html`<div class="aw-row" data-kind="tool">
            <${Collapsible}
                summary=${t("row.requested", { tool: row.tool_name ?? t("board.tool") })}
                when=${row.recorded_at}
            >
                <div>${t("row.action", { id: row.action_id ?? t("common.unknown") })}</div>
                ${
                    row.arguments_digest
                        ? html`<div>${t("row.argumentsDigest", { digest: row.arguments_digest })}</div>`
                        : null
                }
                ${row.input?.summary ? html`<div>${JSON.stringify(row.input.summary)}</div>` : null}
            <//>
        </div>`;
    }

    if (row.kind === "action-completed") {
        const tone = row.status === "rejected" ? "bad" : row.status === "unknown" ? "warn" : "ok";
        const label =
            row.status === "unknown" && row.tool_ok
                ? t("row.completedTransportOk")
                : (row.status ?? t("common.unknown"));

        return html`<div class="aw-row" data-kind="tool">
            <${Collapsible} summary=${`${row.tool_name ?? "tool"} · ${label}`} when=${row.recorded_at}>
                <div>
                    <span title=${row.status ?? ""}
                        ><${Badge} tone=${tone}
                            >${actionStatusLabel(row.status ?? "unknown")}<//
                        ></span
                    >
                    ${row.action_id ?? ""}${row.tool_ok ? t("row.transportOk") : ""}
                </div>
                ${
                    row.rejection_reason
                        ? html`<div>${t("row.rejection", { reason: row.rejection_reason })}</div>`
                        : null
                }
                ${
                    row.transport
                        ? html`<div>${t("row.transport", { value: JSON.stringify(row.transport) })}</div>`
                        : null
                }
                ${row.observed ? html`<pre class="aw-file-text">${JSON.stringify(row.observed, null, 2)}</pre>` : null}
                ${row.content_excerpt ? html`<pre class="aw-file-text">${row.content_excerpt}</pre>` : null}
                ${
                    row.content_digest
                        ? html`<div>${t("row.contentDigest", { digest: row.content_digest })}</div>`
                        : null
                }
            <//>
        </div>`;
    }

    if (row.kind === "review") {
        return html`<div class="aw-row" data-kind="review">
            <div class="aw-card">
                <div class="aw-card-head">
                    <strong>${row.bootstrap ? t("row.workReviewBootstrap") : t("row.workReview")}</strong>
                    <${Badge} tone=${row.retrieval_status === "ready" ? "ok" : row.retrieval_status ? "warn" : "bad"}>
                        ${retrievalLabel(row.retrieval_status ?? "unknown")}
                    <//>
                    <span class="aw-when">${when(row.recorded_at)}</span>
                </div>
                ${row.blocker ? html`<div class="aw-body">${row.blocker}</div>` : null}
                ${
                    row.next_step
                        ? html`<div class="aw-muted">${t("row.next", { value: row.next_step })}</div>`
                        : null
                }
                <div class="aw-faint">
                    ${t("row.unverifiedSummary", { trigger: row.trigger_id ?? t("common.unknown") })}
                </div>
            </div>
        </div>`;
    }

    if (row.kind === "checkpoint") {
        return html`<div class="aw-row" data-kind="checkpoint">
            <${Collapsible} summary=${t("row.roundCheckpoint")} when=${row.recorded_at}>
                <div class="aw-body">${row.text ?? ""}</div>
                <div>${t("row.unverifiedSummary", { trigger: "-" })}</div>
            <//>
        </div>`;
    }

    if (row.kind === "knowledge") {
        return html`<div class="aw-row" data-kind="knowledge">
            <${Collapsible}
                summary=${t("row.knowledge", { status: retrievalLabel(row.status ?? "unknown") })}
                when=${row.recorded_at}
            >
                <div>${t("row.query", { value: row.query ?? "" })}</div>
                <div>${t("row.mode", { value: row.mode ?? t("common.unknown") })}</div>
                ${
                    row.selected?.length
                        ? html`<div>${row.selected.map((item) => html`<div key=${item.knowledge_id}>${item.knowledge_id} · ${item.source_uri ?? ""}</div>`)}</div>`
                        : html`<div>${t("row.noSelectedRefs")}</div>`
                }
            <//>
        </div>`;
    }

    if (row.kind === "settled") {
        return html`<div class="aw-row" data-kind="settled">
            <div class="aw-muted" style="text-align:center">
                ${
                    row.context_usage?.known
                        ? t("row.settledWithContext", {
                              percent: Math.round(row.context_usage.percent),
                          })
                        : t("row.settled")
                }
                ${" "}${when(row.recorded_at)}
            </div>
        </div>`;
    }

    if (row.kind === "session") {
        return html`<div class="aw-row" data-kind="session">
            <div class="aw-muted" style="text-align:center">
                ${
                    row.event_type === "session.started"
                        ? t("row.sessionStarted")
                        : t("row.sessionShutDown")
                }
                ${" · "}${shortSession(row.session_id)}${" · "}${when(row.recorded_at)}
            </div>
        </div>`;
    }

    if (row.kind === "request") {
        return html`<div class="aw-row" data-kind="request">
            <${Collapsible}
                summary=${
                    row.provider_bound
                        ? t("row.providerRequest")
                        : t("row.requestRefused", {
                              reason: row.refusal_reason ?? t("common.unknown"),
                          })
                }
                when=${row.recorded_at}
            >
                <div>${t("row.ramDigest", { digest: row.ram_digest ?? t("common.unknown") })}</div>
                <div>${t("row.estimatedChars", { value: row.ram_estimated_chars ?? t("common.unknown") })}</div>
            <//>
        </div>`;
    }

    if (row.kind === "outcome") {
        return html`<div class="aw-row" data-kind="outcome">
            <div class="aw-card">
                <div class="aw-card-head">
                    <strong>${t("row.outcome")}</strong>
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
        <${Collapsible} summary=${translatedSummary(row)} when=${row.recorded_at}>
            <pre class="aw-file-text">${JSON.stringify(row, null, 2)}</pre>
        <//>
    </div>`;
}

function RotationRow({ row }) {
    const [open, setOpen] = useState(false);

    return html`<div>
        <div class="aw-rot">
            <button aria-expanded=${open} onClick=${() => setOpen(!open)}>
                ↻ ${t("row.rotated")} ${open ? "▾" : "▸"}
            </button>
        </div>
        ${
            open
                ? html`<div class="aw-row">
                  <${Details}>
                      <div>${t("row.from", { id: row.from_session ?? t("common.unknown") })}</div>
                      <div>${t("row.to", { id: row.to_session ?? t("common.unknown") })}</div>
                      <div>${t("row.identity", { value: row.identity ?? t("common.unknown") })}</div>
                      <div>${t("row.request", { id: row.request_id ?? t("common.unknown") })}</div>
                  <//>
              </div>`
                : null
        }
    </div>`;
}

// ── panels ──────────────────────────────────────────────────

function ProgressPanel({ view, status, host }) {
    const progress = view?.progress ?? {};
    const reviewBadge = badgeToneForReview(progress.review_required, Boolean(progress.review));

    return html`<${Fragment}>
        <${Section} title=${t("progress.host")}>
            <${Facts}
                rows=${[
                    [
                        t("progress.console"),
                        statusLabel(status?.console_status ?? host?.state ?? "unknown"),
                    ],
                    [t("progress.hostState"), statusLabel(host?.state ?? "unknown")],
                    [t("progress.blocked"), status?.block_reason ?? null],
                    [
                        t("progress.model"),
                        status?.model
                            ? `${status.model.provider ?? "?"}/${status.model.id ?? "?"}`
                            : null,
                    ],
                    [
                        t("progress.session"),
                        status?.session_id ? shortSession(status.session_id) : null,
                    ],
                    [
                        t("progress.rotations"),
                        t("progress.rotationsValue", {
                            applied: status?.auto_rotations ?? 0,
                            committed: status?.rotations_completed ?? 0,
                        }),
                    ],
                    [t("progress.continuations"), status?.continuations ?? null],
                ]}
            />
            ${host?.reason ? html`<div class="aw-banner" data-tone="warn">${host.reason}</div>` : null}
        <//>
        <${Section}
            title=${t("progress.workCycle", {
                state: statusLabel(progress.work_unit_state ?? "unknown"),
            })}
        >
            <div class="aw-item-head">
                <${Badge} tone=${reviewBadge}
                    >${progress.review_required ? t("progress.reviewHold") : t("progress.noHold")}<//
                >
                ${
                    progress.bootstrap_review
                        ? html`<${Badge} tone="warn">${t("progress.bootstrap")}<//>`
                        : null
                }
                ${
                    progress.complete_candidate
                        ? html`<${Badge} tone="info">${t("progress.completeCandidate")}<//>`
                        : null
                }
            </div>
            ${
                progress.intent
                    ? html`<${Facts} rows=${[
                          [
                              t("progress.intent"),
                              `${progress.intent.scope ?? "?"} · ${progress.intent.event_id}`,
                          ],
                          [t("progress.intentText"), progress.intent.text ?? null],
                      ]} />`
                    : html`<div class="aw-muted">${t("progress.noIntent")}</div>`
            }
            ${
                progress.reasons?.length
                    ? html`<div class="aw-muted">${t("progress.reasons", { value: progress.reasons.join(", ") })}</div>`
                    : null
            }
            ${
                progress.next_step
                    ? html`<div class="aw-body">${t("progress.next", { value: progress.next_step })}</div>`
                    : null
            }
        <//>
        <${Section} title=${t("progress.counters")}>
            <${Facts}
                rows=${[
                    [
                        t("progress.cumulative"),
                        t("progress.cumulativeValue", {
                            n: progress.counters?.cumulative_action_count ?? 0,
                        }),
                    ],
                    [
                        t("progress.round"),
                        t("progress.roundValue", {
                            n: progress.counters?.review_round_action_count ?? 0,
                        }),
                    ],
                    [t("progress.routes"), progress.counters?.unique_routes ?? 0],
                    [t("progress.repeats"), progress.counters?.repeat_count ?? 0],
                    [t("progress.trustedProgress"), progress.trusted_progress_event_id ?? null],
                ]}
            />
            <div class="aw-faint">${t("progress.countersNote")}</div>
        <//>
        <${Section} title=${t("progress.reviewTitle")}>
            ${
                progress.review
                    ? html`<${Facts} rows=${[
                          [t("progress.review"), progress.review.event_id],
                          [
                              t("progress.retrieval"),
                              retrievalLabel(progress.review.retrieval_status),
                          ],
                          [t("progress.blocker"), progress.review.blocker ?? null],
                          [t("progress.next"), progress.review.next_step ?? null],
                          [t("progress.trust"), progress.review.trust],
                      ]} />`
                    : html`<div class="aw-muted">${t("progress.noReview")}</div>`
            }
            ${
                progress.checkpoint
                    ? html`<${Facts} rows=${[
                          [t("progress.checkpoint"), progress.checkpoint.event_id],
                          [t("progress.status"), progress.checkpoint.unit_status],
                          [t("progress.summary"), progress.checkpoint.summary ?? null],
                      ]} />`
                    : html`<div class="aw-muted">${t("progress.noCheckpoint")}</div>`
            }
            ${
                progress.consumptions?.length
                    ? html`<div class="aw-faint">
                          ${t("progress.consumed", {
                              value: progress.consumptions
                                  .map((item) => item.review_event_id)
                                  .join(", "),
                          })}
                      </div>`
                    : null
            }
        <//>
        <${Section} title=${t("progress.responsibility")}>
            <${Facts}
                rows=${[
                    [t("progress.pending"), progress.pending_actions ?? 0],
                    [t("progress.unknown"), progress.unknown_actions ?? 0],
                ]}
            />
            ${
                (progress.unknown_actions ?? 0) > 0
                    ? html`<div class="aw-banner" data-tone="warn">${t("progress.unknownWarning")}</div>`
                    : null
            }
        <//>
    <//>`;
}

function BoardNode({ node, rowsById, onOpenDetails }) {
    const [openText, setOpenText] = useState(false);
    const [openRefs, setOpenRefs] = useState(false);
    const text = node.text ?? "";
    const long = text.length > 220;
    const refs = [...new Set([...(node.evidence_refs ?? []), ...(node.source_refs ?? [])])];

    return html`<li class="aw-item" key=${node.node_id}>
        <div class="aw-item-head">
            <${Badge} tone=${node.effective ? "ok" : null}>${node.type}<//>
            <span class="aw-faint"
                >${node.effective ? t("common.effective") : t("common.superseded")}</span
            >
            ${node.scope ? html`<span class="aw-faint">${node.scope}</span>` : null}
            <button class="aw-tab aw-node-details" onClick=${() => onOpenDetails(node)}>
                ${t("board.openDetails")}
            </button>
        </div>
        <p class=${long && !openText ? "aw-clamp" : ""}>${text}</p>
        ${
            long
                ? html`<button class="aw-tab aw-inline-toggle" onClick=${() => setOpenText(!openText)}>
                      ${openText ? t("board.showLess") : t("board.showMore")}
                  </button>`
                : null
        }
        ${
            refs.length > 0
                ? html`<button
                      class="aw-tab aw-inline-toggle"
                      aria-expanded=${openRefs}
                      onClick=${() => setOpenRefs(!openRefs)}
                  >
                      ${
                          openRefs
                              ? t("board.evidenceHide")
                              : t("board.evidenceCount", { n: refs.length })
                      }
                  </button>`
                : null
        }
        ${
            openRefs
                ? html`<ul class="aw-refs">
                      ${refs.map((id) => {
                          const row = rowsById.get(id) ?? null;

                          return html`<li key=${id}>
                              <code>${id.slice(0, 18)}</code>
                              <span class="aw-faint"
                                  >${
                                      row
                                          ? t(summaryOf(row).key, summaryOf(row).vars)
                                          : t("board.refOutside")
                                  }</span
                              >
                          </li>`;
                      })}
                  </ul>`
                : null
        }
    </li>`;
}

function BoardPanel({ view, rows = [] }) {
    const board = view?.board ?? { nodes: [], counts: {} };
    const [type, setType] = useState("all");
    const [selected, setSelected] = useState(null);
    const detailsRef = useRef(null);
    const rowsById = useMemo(() => new Map(rows.map((row) => [row.event_id, row])), [rows]);
    const nodes = useMemo(
        () => (board.nodes ?? []).filter((node) => type === "all" || node.type === type),
        [board.nodes, type],
    );

    useEffect(() => {
        if (selected) {
            detailsRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }, [selected]);

    return html`<${Fragment}>
        <${Section} title=${t("board.title")}>
            <div class="aw-chips">
                ${["all", "Intent", "Hint", "Fact", "Refuted", "Artifact", "Origin"].map(
                    (id) => html`<button
                        key=${id}
                        class="aw-tab"
                        aria-selected=${type === id}
                        onClick=${() => setType(id)}
                    >
                        ${
                            id === "all"
                                ? t("board.all")
                                : t("board.typeCount", {
                                      type: id,
                                      effective: board.counts?.[id]?.effective ?? 0,
                                      total: board.counts?.[id]?.total ?? 0,
                                  })
                        }
                    </button>`,
                )}
            </div>
            ${
                board.truncated
                    ? html`<div class="aw-banner" data-tone="warn">
                          ${t("board.truncated", {
                              shown: board.nodes.length,
                              total: board.total_nodes,
                          })}
                      </div>`
                    : null
            }
            ${
                nodes.length === 0
                    ? html`<div class="aw-empty">${t("board.empty")}</div>`
                    : html`<ul class="aw-list-flat">
                          ${nodes.map(
                              (node) => html`<${BoardNode}
                                  key=${node.node_id}
                                  node=${node}
                                  rowsById=${rowsById}
                                  onOpenDetails=${setSelected}
                              />`,
                          )}
                      </ul>`
            }
        <//>
        ${
            selected
                ? html`<div ref=${detailsRef}>
                      <${Section}
                          title=${t("board.nodeDetails")}
                          actions=${html`<button class="aw-tab" onClick=${() => setSelected(null)}>
                              ${t("common.close")}
                          </button>`}
                      >
                          <${Facts} rows=${[
                              [t("board.node"), selected.node_id],
                              [t("board.type"), selected.type],
                              [t("progress.status"), selected.status],
                              [t("board.scope"), selected.scope],
                              [t("board.criterion"), selected.criterion],
                              [t("board.origin"), selected.origin_event_id],
                              [t("board.action"), selected.action_id],
                              [t("board.tool"), selected.tool_name],
                              [t("board.outcome"), selected.outcome_id],
                              [t("board.supersededBy"), selected.superseded_by],
                          ]} />
                          <div class="aw-body aw-pre-wrap">${selected.text ?? ""}</div>
                          ${
                              selected.observation_summary
                                  ? html`<pre class="aw-file-text">${JSON.stringify(
                                        selected.observation_summary,
                                        null,
                                        2,
                                    )}</pre>`
                                  : null
                          }
                          ${
                              [...(selected.evidence_refs ?? [])].length > 0
                                  ? html`<ul class="aw-refs">
                                        ${[...selected.evidence_refs].map((id) => {
                                            const row = rowsById.get(id) ?? null;

                                            return html`<li key=${id}>
                                                <code>${id}</code>
                                                <span class="aw-faint"
                                                    >${
                                                        row
                                                            ? t(
                                                                  summaryOf(row).key,
                                                                  summaryOf(row).vars,
                                                              )
                                                            : t("board.refOutside")
                                                    }</span
                                                >
                                            </li>`;
                                        })}
                                    </ul>`
                                  : html`<div class="aw-muted">${t("board.noEvidence")}</div>`
                          }
                          ${
                              selected.source_refs?.length
                                  ? html`<div class="aw-faint">
                                        ${t("board.sources", {
                                            value: selected.source_refs.join(", "),
                                        })}
                                    </div>`
                                  : null
                          }
                      <//>
                  </div>`
                : null
        }
    <//>`;
}

function KnowledgePanel({ view }) {
    const knowledge = view?.knowledge ?? { selections: [], usage: [] };

    return html`<${Fragment}>
        <${Section} title=${t("knowledge.title")}>
            <div class="aw-faint">${t("knowledge.legend")}</div>
            ${
                knowledge.selections.length === 0
                    ? html`<div class="aw-empty">${t("knowledge.empty")}</div>`
                    : html`<ul class="aw-list-flat aw-scroll-y">
                          ${knowledge.selections
                              .slice()
                              .reverse()
                              .map(
                                  (item) => html`<li class="aw-item" key=${item.event_id}>
                                      <div class="aw-item-head">
                                          <${Badge}
                                              tone=${
                                                  item.status === "ready"
                                                      ? "ok"
                                                      : item.status === "no_match"
                                                        ? null
                                                        : "bad"
                                              }
                                              >${retrievalLabel(item.status)}<//
                                          >
                                          <span class="aw-faint"
                                              >${item.mode ?? t("row.mode", { value: "" })} ·
                                              ${when(item.recorded_at)}</span
                                          >
                                      </div>
                                      <p>${item.query ?? ""}</p>
                                      ${
                                          item.selected?.length
                                              ? html`<div class="aw-faint">
                                                    ${t("knowledge.selected", {
                                                        value: item.selected
                                                            .map((ref) => ref.knowledge_id)
                                                            .join(", "),
                                                    })}
                                                </div>`
                                              : html`<div class="aw-muted">
                                                    ${t("knowledge.selectedNone")}
                                                </div>`
                                      }
                                      ${
                                          item.reason
                                              ? html`<div class="aw-muted">${item.reason}</div>`
                                              : null
                                      }
                                  </li>`,
                              )}
                      </ul>`
            }
            ${
                knowledge.truncated
                    ? html`<div class="aw-banner" data-tone="warn">${t("knowledge.olderOmitted")}</div>`
                    : null
            }
        <//>
        <${Section} title=${t("knowledge.useTitle")}>
            <div class="aw-faint">${t("knowledge.useLegend")}</div>
            ${
                knowledge.usage?.length
                    ? html`<ul class="aw-list-flat">
                          ${knowledge.usage.map(
                              (entry) => html`<li class="aw-item" key=${entry.selection_event_id}>
                                  <div class="aw-item-head">
                                      <${Badge}
                                          tone=${
                                              entry.status === "used"
                                                  ? "ok"
                                                  : entry.status === "adopted"
                                                    ? "warn"
                                                    : null
                                          }
                                          >${entry.status}<//
                                      >
                                      <span class="aw-faint"
                                          >${entry.knowledge_ids?.join(", ")}</span
                                      >
                                  </div>
                                  <div class="aw-faint">
                                      ${t("knowledge.selection", {
                                          id: entry.selection_event_id ?? t("common.none"),
                                      })}
                                  </div>
                                  <div class="aw-faint">
                                      ${t("knowledge.intent", {
                                          id: entry.intent_event_id ?? t("common.none"),
                                      })}
                                  </div>
                                  <div class="aw-faint">
                                      ${t("knowledge.outcome", {
                                          id: entry.outcome_event_id ?? t("common.none"),
                                      })}
                                  </div>
                              </li>`,
                          )}
                      </ul>`
                    : html`<div class="aw-empty">${t("knowledge.useEmpty")}</div>`
            }
        <//>
        <${Section} title=${t("knowledge.experience")}>
            <div class="aw-muted">${t("knowledge.experienceNote")}</div>
        <//>
    <//>`;
}

function SessionPanel({ view, status }) {
    const session = view?.session ?? {};
    const ram = session.ram ?? {};

    return html`<${Fragment}>
        <${Section} title=${t("session.title")}>
            <${Facts} rows=${[
                [t("progress.session"), status?.session_id ?? session.current],
                [t("session.file"), status?.session_file ?? session.session_file],
                [t("session.creations"), status?.session_creations ?? null],
                [t("session.episode"), view?.identity?.episode_id],
                [t("session.task"), view?.identity?.task_id],
            ]} />
        <//>
        <${Section} title=${t("session.rotations")}>
            ${
                session.rotations?.length
                    ? html`<ul class="aw-list-flat">
                          ${session.rotations
                              .slice()
                              .reverse()
                              .map(
                                  (row) => html`<li class="aw-item" key=${row.event_id}>
                                      <div class="aw-item-head">
                                          <${Badge} tone="info">${t("session.rotation")}<//>
                                          <span class="aw-faint">${when(row.recorded_at)}</span>
                                      </div>
                                      <div class="aw-faint">
                                          ${row.from_session ?? "?"} → ${row.to_session ?? "?"}
                                      </div>
                                      <div class="aw-faint">
                                          ${t("row.identity", {
                                              value: row.identity ?? t("common.unknown"),
                                          })}
                                      </div>
                                  </li>`,
                              )}
                      </ul>`
                    : html`<div class="aw-empty">${t("session.noRotations")}</div>`
            }
            ${
                session.rotations_truncated
                    ? html`<div class="aw-banner" data-tone="warn">
                          ${t("session.rotationsOmitted")}
                      </div>`
                    : null
            }
        <//>
        <${Section} title=${t("session.context")}>
            ${
                session.context?.known
                    ? html`<${Facts} rows=${[
                          [t("session.usedTokens"), session.context.used_tokens],
                          [t("session.limitTokens"), session.context.limit_tokens],
                          [t("session.used"), `${Math.round(session.context.percent)}%`],
                          [t("session.at"), session.context.recorded_at],
                      ]} />`
                    : html`<div class="aw-muted">${t("session.contextUnknown")}</div>`
            }
        <//>
        <${Section} title=${t("session.ram")}>
            <h3>${t("session.providerBound")}</h3>
            ${
                ram.provider_bound?.available
                    ? html`<${Facts} rows=${[
                          [t("session.digest"), ram.provider_bound.digest],
                          [t("session.estimatedChars"), ram.provider_bound.estimated_chars],
                          [t("session.budgetChars"), ram.provider_bound.budget_chars],
                          [
                              t("session.overflow"),
                              ram.provider_bound.overflow ? t("session.yes") : t("session.no"),
                          ],
                          [
                              t("session.coreOverflow"),
                              ram.provider_bound.core_overflow ? t("session.yes") : t("session.no"),
                          ],
                          [t("session.at"), ram.provider_bound.recorded_at],
                      ]} />`
                    : html`<div class="aw-muted">
                          ${ram.provider_bound?.reason ?? t("common.unknown")}
                      </div>`
            }
            ${
                ram.provider_bound?.available && ram.provider_bound.text_available === false
                    ? html`<div class="aw-faint">${t("session.ramTextMissing")}</div>`
                    : null
            }
            ${
                ram.provider_bound?.sections
                    ? html`<pre class="aw-file-text">${JSON.stringify(
                          ram.provider_bound.sections,
                          null,
                          2,
                      )}</pre>`
                    : null
            }
            <h3>${t("session.rebuilt")}</h3>
            ${
                ram.rebuilt?.available
                    ? html`<div>
                          <div class="aw-faint">${ram.rebuilt.note ?? ""}</div>
                          <details>
                              <summary class="aw-tab">${t("session.showRebuilt")}</summary>
                              <pre class="aw-file-text">${ram.rebuilt.text}</pre>
                          </details>
                          ${
                              ram.rebuilt.overflow
                                  ? html`<div class="aw-banner" data-tone="warn">
                                        ${t("session.optionalOmitted")}
                                    </div>`
                                  : null
                          }
                          ${
                              ram.rebuilt.core_overflow
                                  ? html`<div class="aw-banner">
                                        ${t("session.coreOverflowNote")}
                                    </div>`
                                  : null
                          }
                      </div>`
                    : html`<div class="aw-muted">${ram.rebuilt?.reason ?? t("common.unknown")}</div>`
            }
            <div class="aw-faint">${t("session.rotationNote")}</div>
        <//>
    <//>`;
}

function ActionsPanel({ view }) {
    const actions = view?.actions ?? {};

    return html`<${Fragment}>
        <${Section} title=${t("actions.openResponsibility")}>
            ${
                actions.pending?.length
                    ? html`<ul class="aw-list-flat">
                          ${actions.pending.map(
                              (row) => html`<li class="aw-item" key=${row.action_id}>
                                  <div class="aw-item-head">
                                      <span title=${row.status ?? ""}
                                          ><${Badge} tone="warn"
                                              >${actionStatusLabel(row.status)}<//
                                          ></span
                                      >
                                      <strong>${row.tool_name ?? t("board.tool")}</strong>
                                  </div>
                                  <div class="aw-faint">${row.action_id}</div>
                              </li>`,
                          )}
                      </ul>`
                    : html`<div class="aw-empty">${t("actions.nothingPending")}</div>`
            }
            ${
                actions.unknown?.length
                    ? html`<div class="aw-banner" data-tone="warn">
                          ${t("actions.unknownWarning", { n: actions.unknown.length })}
                      </div>`
                    : null
            }
        <//>
        <${Section} title=${t("actions.recent")}>
            ${
                actions.recent?.length
                    ? html`<ul class="aw-list-flat aw-scroll-y">
                          ${actions.recent.map(
                              (row) => html`<li class="aw-item" key=${row.action_id}>
                                  <div class="aw-item-head">
                                      <span title=${row.status ?? ""}
                                          ><${Badge}
                                              tone=${row.rejected ? "bad" : row.unknown ? "warn" : "ok"}
                                              >${actionStatusLabel(row.status)}<//
                                          ></span
                                      >
                                      <strong>${row.tool_name ?? t("board.tool")}</strong>
                                      <span class="aw-faint">${when(row.requested_at)}</span>
                                  </div>
                                  ${
                                      row.rejection_reason
                                          ? html`<p>${row.rejection_reason}</p>`
                                          : null
                                  }
                                  <details>
                                      <summary class="aw-tab">${t("common.details")}</summary>
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
                    : html`<div class="aw-empty">${t("actions.empty")}</div>`
            }
            ${
                actions.truncated
                    ? html`<div class="aw-banner" data-tone="warn">${t("actions.olderOmitted")}</div>`
                    : null
            }
        <//>
        <${Section} title=${t("actions.outcomes")}>
            ${
                actions.outcomes?.length
                    ? html`<ul class="aw-list-flat">
                          ${actions.outcomes.map(
                              (row) => html`<li class="aw-item" key=${row.event_id}>
                                  <div class="aw-item-head">
                                      <${Badge}
                                          tone=${
                                              row.status === "success"
                                                  ? "ok"
                                                  : row.status === "failure"
                                                    ? "bad"
                                                    : "warn"
                                          }
                                          >${row.status}<//
                                      >
                                      <span class="aw-faint">
                                          ${t("actions.outcomeSource", {
                                              value: row.source_kind ?? t("common.unknown"),
                                          })}
                                      </span>
                                  </div>
                                  <div class="aw-faint">
                                      ${t("board.criterion")} ${row.criterion ?? "-"}
                                  </div>
                                  ${
                                      row.value
                                          ? html`<pre class="aw-file-text">${JSON.stringify(
                                                row.value,
                                                null,
                                                2,
                                            )}</pre>`
                                          : null
                                  }
                              </li>`,
                          )}
                      </ul>`
                    : html`<div class="aw-empty">${t("actions.outcomeEmpty")}</div>`
            }
        <//>
        <${Section} title=${t("actions.requests")}>
            ${
                actions.model_requests?.length
                    ? html`<ul class="aw-list-flat aw-scroll-y">
                          ${actions.model_requests
                              .slice()
                              .reverse()
                              .map(
                                  (row) => html`<li class="aw-item" key=${row.event_id}>
                                      <div class="aw-item-head">
                                          <${Badge} tone=${row.provider_bound ? "ok" : "bad"}
                                              >${
                                                  row.provider_bound
                                                      ? t("actions.providerBound")
                                                      : t("actions.refused")
                                              }<//
                                          >
                                          <span class="aw-faint">${when(row.recorded_at)}</span>
                                      </div>
                                      <div class="aw-faint">
                                          ${t("row.ramDigest", {
                                              digest: row.ram_digest ?? "-",
                                          })}
                                          · ${t("row.estimatedChars", {
                                              value: row.ram_estimated_chars ?? "?",
                                          })}
                                      </div>
                                  </li>`,
                              )}
                      </ul>`
                    : html`<div class="aw-empty">${t("actions.requestEmpty")}</div>`
            }
        <//>
    <//>`;
}

function FilesPanel({ label, enabled, version = 0 }) {
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
                setError(apiErrorMessage(err));
            }
        },
        [label],
    );

    useEffect(() => {
        if (enabled) {
            load("");
        }
    }, [enabled, load, version]);

    const openFile = async (name) => {
        setError(null);

        try {
            setFile(await api.file(label, path ? `${path}/${name}` : name));
        } catch (err) {
            setError(apiErrorMessage(err));
        }
    };

    return html`<${Fragment}>
        <${Section} title=${t("files.title")}>
            ${!enabled ? html`<div class="aw-muted">${t("files.openTask")}</div>` : null}
            ${
                enabled
                    ? html`<div class="aw-item-head">
                          <button class="aw-tab" onClick=${() => load("")}>
                              ${t("common.root")}
                          </button>
                          ${
                              path
                                  ? html`<button
                                        class="aw-tab"
                                        onClick=${() =>
                                            load(path.split("/").slice(0, -1).join("/"))}
                                    >
                                        ${t("files.up")}
                                    </button>`
                                  : null
                          }
                          <span class="aw-faint">/${path}</span>
                      </div>`
                    : null
            }
            ${error ? html`<div class="aw-banner">${error}</div>` : null}
            ${
                listing?.truncated
                    ? html`<div class="aw-banner" data-tone="warn">
                          ${t("files.truncated", { limit: listing.limit })}
                      </div>`
                    : null
            }
            ${
                listing
                    ? html`<div class="aw-tree">
                          ${listing.entries.map(
                              (entry) => html`<button
                                  key=${entry.name}
                                  data-dir=${entry.kind === "directory"}
                                  onClick=${() =>
                                      entry.kind === "directory"
                                          ? load(path ? `${path}/${entry.name}` : entry.name)
                                          : openFile(entry.name)}
                              >
                                  <span>${entry.kind === "directory" ? "▸" : "•"}</span>
                                  <span>${entry.name}</span>
                                  <span class="aw-faint"
                                      >${
                                          entry.kind === "outside"
                                              ? t("files.outside")
                                              : (entry.size ?? "")
                                      }</span
                                  >
                              </button>`,
                          )}
                      </div>`
                    : null
            }
        <//>
        ${
            file
                ? html`<${Section}
                      title=${file.path}
                      actions=${html`<button class="aw-tab" onClick=${() => setFile(null)}>
                          ${t("common.close")}
                      </button>`}
                  >
                      <div class="aw-faint">
                          ${t("files.meta", {
                              size: file.size,
                              shown: file.bytes_shown,
                              truncated: file.truncated ? ` (${t("common.truncated")})` : "",
                              kind: file.binary ? t("files.kindBinary") : t("files.kindText"),
                          })}
                      </div>
                      ${
                          file.binary
                              ? html`<div class="aw-muted">${t("files.binary")}</div>`
                              : html`<pre class="aw-file-text">${file.text}</pre>`
                      }
                  <//>`
                : null
        }
    <//>`;
}

function HistoryPanel({ experiments, selected, onOpen }) {
    return html`<${Section} title=${t("history.title")}>
        ${
            experiments.length === 0
                ? html`<div class="aw-empty">${t("history.empty")}</div>`
                : html`<ul class="aw-list-flat">
                      ${experiments.map(
                          (row) => html`<li class="aw-item" key=${row.label}>
                              <div class="aw-item-head">
                                  <strong>${row.label}</strong>
                                  <span title=${row.host_state ?? ""}
                                      ><${Badge} tone=${toneForHost(row.host_state)}
                                          >${statusLabel(row.host_state)}<//
                                      ></span
                                  >
                                  <span class="aw-faint"
                                      >${t("history.events", { n: row.rows })}</span
                                  >
                              </div>
                              <div class="aw-faint">
                                  ${t("history.task", { id: row.task_id, n: row.episodes })}
                              </div>
                              <div class="aw-item-head">
                                  <button class="aw-tab" onClick=${() => onOpen(row.label)}>
                                      ${
                                          row.label === selected
                                              ? t("history.open")
                                              : t("history.readonly")
                                      }
                                  </button>
                              </div>
                          </li>`,
                      )}
                  </ul>`
        }
        <div class="aw-faint">${t("history.note")}</div>
    <//>`;
}

/** Segmented language switch; the choice is a browser display preference. */
function LangSwitch({ current }) {
    return html`<div class="aw-chips">
        ${LANGS.map(
            (item) => html`<button
                class="aw-tab"
                aria-selected=${current === item.id}
                onClick=${() => setLang(item.id)}
            >
                ${item.label}
            </button>`,
        )}
    </div>`;
}

function SettingsPanel({ health, theme, setTheme }) {
    const lang = useLang();

    return html`<${Fragment}>
        <${Section} title=${t("settings.appearance")}>
            <span class="aw-faint">${t("settings.theme")}</span>
            <div class="aw-chips">
                ${[
                    { id: "dark", key: "settings.dark" },
                    { id: "light", key: "settings.light" },
                ].map(
                    (mode) => html`<button
                        class="aw-tab"
                        aria-selected=${theme === mode.id}
                        onClick=${() => setTheme(mode.id)}
                    >
                        ${t(mode.key)}
                    </button>`,
                )}
            </div>
            <div class="aw-faint">${t("settings.displayNote")}</div>
        <//>
        <${Section} title=${t("settings.server")}>
            <${Facts} rows=${[
                [t("settings.version"), health?.version ?? t("common.unknown")],
                [t("settings.home"), health?.home ?? t("common.unknown")],
                [t("settings.experiments"), health?.experiments ?? 0],
                [t("settings.mode"), t("settings.modeValue")],
            ]} />
        <//>
        <${Section}
            title=${t("settings.safety")}
            actions=${html`<${Badge}>${t("settings.safetyReadonly")}<//>`}
        >
            <div class="aw-muted">${t("settings.safetyNote")}</div>
            <div class="aw-faint">${t("settings.safetyReadonlyNote")}</div>
        <//>
        <${Section} title=${t("settings.language")}>
            <${LangSwitch} current=${lang} />
            <div class="aw-faint">${t("settings.languageNote")}</div>
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
    const [catalog, setCatalog] = useState(null);
    const [toolCatalog, setToolCatalog] = useState(null);
    const [tools, setTools] = useState(null);
    const [thinking, setThinking] = useState("");

    useEffect(() => {
        api.models()
            .then(setCatalog)
            .catch(() => setCatalog({ models: [], default: null }));
        api.tools()
            .then((result) => {
                setToolCatalog(result);
                setTools(result.defaults ?? []);
            })
            .catch(() => setToolCatalog(null));
    }, []);

    const grouped = useMemo(() => {
        const byProvider = new Map();

        for (const row of catalog?.models ?? []) {
            const list = byProvider.get(row.provider) ?? [];

            list.push(row);
            byProvider.set(row.provider, list);
        }

        return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
    }, [catalog]);

    const toggleTool = (id) => {
        setTools((current) => {
            const set = new Set(current ?? []);

            if (set.has(id)) {
                set.delete(id);
            } else {
                set.add(id);
            }

            return [...set];
        });
    };

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
                tools: Array.isArray(tools) && tools.length > 0 ? tools : undefined,
                thinking: thinking || undefined,
            });
            onCreated(label.trim());
        } catch (err) {
            setError(err instanceof ApiError ? apiErrorMessage(err) : String(err));
        } finally {
            setBusy(false);
        }
    };

    const hasCatalog = (catalog?.models?.length ?? 0) > 0;

    return html`<div class="aw-dialog-scrim" onClick=${(event) => event.target === event.currentTarget && onClose()}>
        <form class="aw-dialog" onSubmit=${submit}>
            <h2>${t("dialog.title")}</h2>
            <div class="aw-field">
                <label for="aw-label">${t("dialog.label")}</label>
                <input
                    id="aw-label"
                    value=${label}
                    onInput=${(event) => setLabel(event.currentTarget.value)}
                    placeholder=${t("dialog.labelPlaceholder")}
                    required
                />
            </div>
            <div class="aw-field">
                <label for="aw-workspace">${t("dialog.workspace")}</label>
                <input
                    id="aw-workspace"
                    value=${workspace}
                    onInput=${(event) => setWorkspace(event.currentTarget.value)}
                    placeholder=${t("dialog.workspacePlaceholder")}
                />
            </div>
            ${
                hasCatalog
                    ? html`<div class="aw-field">
                          <label for="aw-model-pick">${t("dialog.modelPick")}</label>
                          <select
                              id="aw-model-pick"
                              onChange=${(event) => {
                                  const value = event.currentTarget.value;

                                  if (!value) {
                                      setProvider("");
                                      setModel("");

                                      return;
                                  }

                                  const [nextProvider, nextModel] = value.split("\u0000");

                                  setProvider(nextProvider);
                                  setModel(nextModel);
                              }}
                          >
                              <option value="">
                                  ${t("dialog.modelDefault")}
                              </option>
                              ${grouped.map(
                                  ([
                                      providerId,
                                      rows,
                                  ]) => html`<optgroup key=${providerId} label=${providerId}>
                                      ${rows.map(
                                          (row) => html`<option
                                              key=${`${row.provider}\u0000${row.id}`}
                                              value=${`${row.provider}\u0000${row.id}`}
                                              selected=${provider === row.provider && model === row.id}
                                          >
                                              ${row.name}${
                                                  row.context_window
                                                      ? ` · ${Math.round(row.context_window / 1000)}k`
                                                      : ""
                                              }
                                          </option>`,
                                      )}
                                  </optgroup>`,
                              )}
                          </select>
                      </div>`
                    : html`<${Fragment}>
                          <div class="aw-field">
                              <label for="aw-provider">${t("dialog.provider")}</label>
                              <input
                                  id="aw-provider"
                                  value=${provider}
                                  onInput=${(event) => setProvider(event.currentTarget.value)}
                                  placeholder=${t("dialog.providerPlaceholder")}
                              />
                          </div>
                          <div class="aw-field">
                              <label for="aw-model">${t("dialog.model")}</label>
                              <input
                                  id="aw-model"
                                  value=${model}
                                  onInput=${(event) => setModel(event.currentTarget.value)}
                                  placeholder=${t("dialog.modelPlaceholder")}
                              />
                          </div>
                          <div class="aw-faint">${t("dialog.modelsUnavailable")}</div>
                      <//>`
            }
            <div class="aw-field">
                <label for="aw-thinking">${t("dialog.thinking")}</label>
                <select id="aw-thinking" onChange=${(event) => setThinking(event.currentTarget.value)}>
                    <option value="">${t("dialog.thinkingDefault")}</option>
                    ${["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
                        (level) => html`<option key=${level} value=${level}>
                            ${t(`thinking.${level}`)}
                        </option>`,
                    )}
                </select>
            </div>
            ${
                toolCatalog
                    ? html`<fieldset class="aw-field aw-tools">
                          <legend>${t("dialog.tools")}</legend>
                          <div class="aw-tools-grid">
                              ${toolCatalog.coding.map(
                                  (tool) => html`<label class="aw-tool" key=${tool.id}>
                                      <input
                                          type="checkbox"
                                          checked=${(tools ?? []).includes(tool.id)}
                                          onChange=${() => toggleTool(tool.id)}
                                      />
                                      <span>${t(tool.label_key)}</span>
                                      ${
                                          tool.effect
                                              ? html`<${Badge} tone="warn">${t("dialog.toolsEffect")}<//>`
                                              : null
                                      }
                                  </label>`,
                              )}
                          </div>
                          <div class="aw-faint">${t("dialog.toolsNote")}</div>
                      </fieldset>`
                    : null
            }
            ${error ? html`<div class="aw-banner">${error}</div>` : null}
            <div class="aw-actions">
                <button class="aw-btn" type="button" onClick=${onClose} disabled=${busy}>
                    ${t("common.cancel")}
                </button>
                <button class="aw-btn" data-tone="primary" type="submit" disabled=${busy || !label.trim()}>
                    ${busy ? t("dialog.creating") : t("dialog.create")}
                </button>
            </div>
            <div class="aw-faint">${t("dialog.note")}</div>
        </form>
    </div>`;
}

// ── app ─────────────────────────────────────────────────────

function App() {
    const lang = useLang();
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
    const fileRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [filesVersion, setFilesVersion] = useState(0);
    const [liveModels, setLiveModels] = useState(null);
    const [modelOpen, setModelOpen] = useState(false);
    const [thinkingOpen, setThinkingOpen] = useState(false);
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
            setBanner({
                tone: "warn",
                text: t("banner.experimentsLoad", { reason: apiErrorMessage(error) }),
            });
        }
    }, [lang]);

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
            setBanner({
                tone: "warn",
                text: t("banner.cannotLoad", { label, reason: apiErrorMessage(error) }),
            });

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
                    setBanner({ tone: "warn", text: t("banner.conflict") });
                } else if (initial.host?.state !== "ready") {
                    try {
                        const attached = await api.attach(label);

                        if (!attached.ok) {
                            setBanner({
                                tone: "warn",
                                text: t("banner.attachFailed", {
                                    reason: attached.reason ?? t("common.unknown"),
                                }),
                            });
                        }

                        await loadDetail(label);
                    } catch (error) {
                        setBanner({
                            tone: "warn",
                            text: t("banner.attachFailed", { reason: apiErrorMessage(error) }),
                        });
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

    // Deep links and browser back/forward: a changed `#/e/<label>` opens that run.
    // (The task list uses replaceState, which does not fire this event.)
    useEffect(() => {
        const onHashChange = () => {
            const match = /^#\/e\/(.+)$/.exec(location.hash);

            if (!match) {
                return;
            }

            const label = decodeURIComponent(match[1]);

            if (label !== selected) {
                open(label);
            }
        };

        globalThis.addEventListener("hashchange", onHashChange);

        return () => globalThis.removeEventListener("hashchange", onHashChange);
    }, [open, selected]);

    // Follow new committed rows only while the reader is at the bottom.
    useEffect(() => {
        const node = chatRef.current;

        if (!node || !stickRef.current) {
            return;
        }

        node.scrollTop = node.scrollHeight;
    }, [rows, liveText]);

    // The switchable models come from the LIVE run (the Host's own runtime), not
    // from the agent-config catalog: the catalog may list models this run was
    // never configured for.
    useEffect(() => {
        if (!selected) {
            setLiveModels(null);

            return;
        }

        let cancelled = false;

        api.liveModels(selected)
            .then((result) => {
                if (!cancelled) {
                    setLiveModels(result);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setLiveModels({ models: [] });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [selected, detail?.host?.state, detail?.status?.session_id]);

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
                setBanner({ tone: "warn", text: t("banner.duplicate") });
            }

            await loadDetail(selected);
        } catch (error) {
            // A retried request must keep its id; never silently re-run with a new one.
            const unknown =
                error instanceof ApiError && (error.status === 503 || error.status === 504);

            setRequestState({ id, state: unknown ? "unknown" : "rejected", error: error.message });
            setBanner({
                tone: unknown ? "warn" : "error",
                text: unknown ? t("banner.deliveryUnknown") : apiErrorMessage(error),
            });
            await loadDetail(selected);
        } finally {
            setBusy(false);
        }
    };

    const toBase64 = async (file) => {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = "";

        for (let index = 0; index < buffer.length; index += 0x8000) {
            binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
        }

        return globalThis.btoa(binary);
    };

    /** Upload one file INTO the selected experiment's workspace. */
    /** Switch the live Session's model (session configuration; not a task fact). */
    const switchModel = async (provider, id) => {
        setModelOpen(false);

        if (!selected) {
            return;
        }

        try {
            const result = await api.setModel(selected, { provider, model: id });

            if (!result.ok) {
                setBanner({
                    tone: "warn",
                    text: t("top.modelFailed", { reason: result.reason ?? t("common.unknown") }),
                });

                return;
            }

            setBanner({
                tone: "info",
                text: t("top.modelApplied", { model: `${provider}/${id}` }),
            });
            await loadDetail(selected);
        } catch (error) {
            setBanner({
                tone: "warn",
                text: t("top.modelFailed", { reason: apiErrorMessage(error) }),
            });
        }
    };

    /** Set the Session thinking level (session configuration; the SDK clamps it). */
    const switchThinking = async (level) => {
        setThinkingOpen(false);

        if (!selected) {
            return;
        }

        try {
            const result = await api.setThinking(selected, { level });

            if (!result.ok) {
                setBanner({
                    tone: "warn",
                    text: t("top.thinkingFailed", {
                        reason: result.reason ?? t("common.unknown"),
                    }),
                });

                return;
            }

            const effective = result.thinking?.level ?? level;

            setBanner({
                tone: "info",
                text:
                    effective === level
                        ? t("top.thinkingApplied", { level })
                        : t("top.thinkingApplied", { level: `${level} → ${effective}` }),
            });
            await loadDetail(selected);
        } catch (error) {
            setBanner({
                tone: "warn",
                text: t("top.thinkingFailed", { reason: apiErrorMessage(error) }),
            });
        }
    };

    const uploadAttachment = async (event) => {
        const file = event.currentTarget.files?.[0];

        event.currentTarget.value = "";

        if (!file || !selected) {
            return;
        }

        setUploading(true);

        try {
            const data = await toBase64(file);

            await api.upload(selected, { name: file.name, data_base64: data });
            setBanner({ tone: "info", text: t("composer.uploaded", { name: file.name }) });
            setFilesVersion((value) => value + 1);
        } catch (error) {
            setBanner({
                tone: "warn",
                text: t("composer.uploadFailed", { reason: apiErrorMessage(error) }),
            });
        } finally {
            setUploading(false);
        }
    };

    const control = async (action) => {
        if (!selected) {
            return;
        }

        if (action === "stop" && !globalThis.confirm(t("confirm.stop"))) {
            return;
        }

        setBusy(true);

        try {
            await api[action](selected);
            await loadDetail(selected);
        } catch (error) {
            setBanner({
                tone: "warn",
                text: t("banner.controlFailed", {
                    action: t(`control.${action}`),
                    reason: apiErrorMessage(error),
                }),
            });
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
                    title=${t(item.key)}
                    onClick=${() => {
                        setRail(item.id);

                        if (item.id === "history") {
                            setExperiments(experiments);
                        }

                        setPanel(panelForRail(item.id));
                    }}
                >
                    <span class="aw-glyph">${item.glyph}</span>
                    <span>${t(item.key)}</span>
                </button>`,
            )}
            <div class="aw-rail-fill"></div>
            <button
                class="aw-rail-button"
                title=${t("dialog.title")}
                onClick=${() => setDialog(true)}
            >
                <span class="aw-glyph">+</span>
                <span>${t("rail.new")}</span>
            </button>
        </nav>

        <aside class="aw-list" aria-label="experiments">
            <div class="aw-list-head">
                <h1>${t("list.title")}</h1>
                <button
                    class="aw-icon"
                    title=${t("common.closeList")}
                    onClick=${() => setDrawer(null)}
                >
                    ✕
                </button>
            </div>
            <div class="aw-list-body">
                <button class="aw-btn" data-tone="primary" onClick=${() => setDialog(true)}>
                    ${t("list.new")}
                </button>
                ${
                    experiments.length === 0
                        ? html`<div class="aw-empty">${t("list.empty")}</div>`
                        : experiments.map(
                              (row) => html`<button
                              key=${row.label}
                              class="aw-exp"
                              aria-current=${selected === row.label}
                              onClick=${() => open(row.label)}
                          >
                              <span class="aw-exp-label">${row.label}</span>
                              <span class="aw-exp-meta">
                                  <span title=${row.host_state ?? ""}
                                      ><${Badge} tone=${toneForHost(row.host_state)}
                                          >${statusLabel(row.host_state)}<//
                                      ></span
                                  >
                                  <span>${t("list.events", { n: row.rows })}</span>
                              </span>
                              <span class="aw-exp-meta"
                                  >${row.last_event_at ? when(row.last_event_at) : t("list.noEvents")}</span
                              >
                          </button>`,
                          )
                }
            </div>
        </aside>

        <main class="aw-main">
            <header class="aw-top">
                <button
                    class="aw-icon aw-mobile-only"
                    title=${t("common.tasks")}
                    onClick=${() => setDrawer(drawer === "list" ? null : "list")}
                >
                    ☰
                </button>
                <div class="aw-top-title">
                    <strong>${selected ?? t("app.title")}</strong>
                    <span>
                        ${
                            status?.episode_id || view?.identity?.episode_id
                                ? t("top.episode", {
                                      id: status?.episode_id ?? view?.identity?.episode_id,
                                  })
                                : t("top.noEpisode")
                        }
                        ·
                        ${t("top.task", {
                            id: status?.task_id ?? view?.identity?.task_id ?? "-",
                        })}
                    </span>
                </div>
                <div class="aw-chips">
                    <${Chip} tone=${toneForStatus(phase)}
                        >${phase ? statusLabel(phase) : t("top.noHost")}<//
                    >
                    ${
                        status?.work_unit_state
                            ? html`<${Chip} title=${status.work_unit_state}
                                  >${statusLabel(status.work_unit_state)}<//
                              >`
                            : null
                    }
                    <div class="aw-pop-host">
                        <button
                            class="aw-chip aw-chip-button"
                            title=${t("top.modelHint")}
                            aria-expanded=${modelOpen}
                            disabled=${!(liveModels?.models?.length ?? 0) || host.state !== "ready"}
                            onClick=${() => setModelOpen(!modelOpen)}
                        >
                            ${
                                status?.model
                                    ? `${status.model.provider ?? "?"}/${status.model.id ?? "?"}`
                                    : t("top.modelUnknown")
                            }
                        </button>
                        ${
                            modelOpen
                                ? html`<div class="aw-pop" role="menu" aria-label=${t("top.modelSwitch")}>
                                      <div class="aw-pop-head">${t("top.modelSwitch")}</div>
                                      ${
                                          (liveModels?.models ?? []).length === 0
                                              ? html`<div class="aw-pop-empty">
                                                    ${t("dialog.modelsUnavailable")}
                                                </div>`
                                              : (liveModels?.models ?? []).map(
                                                    (row) => html`<button
                                                        key=${`${row.provider}/${row.id}`}
                                                        class="aw-pop-item"
                                                        role="menuitem"
                                                        aria-current=${
                                                            status?.model?.provider ===
                                                                row.provider &&
                                                            status?.model?.id === row.id
                                                        }
                                                        onClick=${() => switchModel(row.provider, row.id)}
                                                    >
                                                        <span>${row.name}</span>
                                                        <span class="aw-faint"
                                                            >${row.provider}${
                                                                row.context_window
                                                                    ? ` · ${Math.round(row.context_window / 1000)}k`
                                                                    : ""
                                                            }</span
                                                        >
                                                    </button>`,
                                                )
                                      }
                                  </div>`
                                : null
                        }
                    </div>
                    ${
                        status?.thinking?.level
                            ? html`<div class="aw-pop-host">
                                  <button
                                      class="aw-chip aw-chip-button"
                                      title=${
                                          status.thinking.supported
                                              ? t("top.thinkingSwitch")
                                              : t("top.thinkingUnsupported")
                                      }
                                      aria-expanded=${thinkingOpen}
                                      disabled=${!status.thinking.supported || host.state !== "ready"}
                                      onClick=${() => setThinkingOpen(!thinkingOpen)}
                                  >
                                      ${t("top.thinking", { level: status.thinking.level })}
                                  </button>
                                  ${
                                      thinkingOpen
                                          ? html`<div
                                                class="aw-pop"
                                                role="menu"
                                                aria-label=${t("top.thinkingSwitch")}
                                            >
                                                <div class="aw-pop-head">
                                                    ${t("top.thinkingSwitch")}
                                                </div>
                                                ${(status.thinking.levels ?? []).map(
                                                    (level) => html`<button
                                                        key=${level}
                                                        class="aw-pop-item"
                                                        role="menuitem"
                                                        aria-current=${status.thinking.level === level}
                                                        onClick=${() => switchThinking(level)}
                                                    >
                                                        <span>${t(`thinking.${level}`)}</span>
                                                        <span class="aw-faint">${level}</span>
                                                    </button>`,
                                                )}
                                            </div>`
                                          : null
                                  }
                              </div>`
                            : null
                    }
                    ${
                        view?.session?.context?.known
                            ? html`<${Chip}
                                  tone=${view.session.context.percent >= 85 ? "warn" : null}
                                  >${t("top.ctx", {
                                      percent: Math.round(view.session.context.percent),
                                  })}<//
                              >`
                            : html`<${Chip}>${t("top.ctxUnknown")}<//>`
                    }
                    <${Chip} tone=${streamState.connected ? "ok" : "warn"}
                        >${streamState.connected ? t("top.live") : t("top.reconnecting")}<//
                    >
                    <button
                        class="aw-chip"
                        title=${t("rail.language")}
                        onClick=${() => setLang(lang === "zh" ? "en" : "zh")}
                        style="cursor:pointer"
                    >
                        ${lang === "zh" ? "EN" : "中文"}
                    </button>
                </div>
                <button
                    class="aw-icon aw-mobile-only"
                    title=${t("common.detailsButton")}
                    onClick=${() => setDrawer(drawer === "details" ? null : "details")}
                >
                    ⓘ
                </button>
            </header>

            ${
                banner
                    ? html`<div style="padding: 8px 12px 0">
                      <div class="aw-banner" data-tone=${banner.tone ?? "error"}>
                          <span>${banner.text}</span>
                          <button
                              aria-label=${t("banner.dismiss")}
                              onClick=${() => setBanner(null)}
                          >
                              ✕
                          </button>
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
                              ${t("empty.choose")}
                          </div>`
                        : null
                }
                ${
                    rows.length === 0 && selected
                        ? html`<div class="aw-empty">${t("empty.noConversation")}</div>`
                        : null
                }
                ${rows.map((row) => html`<${TranscriptRow} key=${rowKey(row)} row=${row} />`)}
                ${
                    liveText
                        ? html`<div class="aw-row aw-live">
                          <div class="aw-card">
                              <div class="aw-card-head">
                                  <strong>${t("row.assistantLive")}</strong>
                                  <${Badge} tone="warn">${t("common.uncommitted")}<//>
                              </div>
                              <div class="aw-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(liveText) }}></div>
                              <div class="aw-faint">${t("row.liveNote")}</div>
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
                              ${t("banner.unknownOutcome", {
                                  id: `${requestState.id.slice(0, 20)}…`,
                              })}
                          </span>
                      </div>`
                        : null
                }
                <div class="aw-compose-box">
                    <input
                        ref=${fileRef}
                        type="file"
                        hidden
                        multiple=${false}
                        onChange=${uploadAttachment}
                    />
                    <button
                        class="aw-plus"
                        type="button"
                        title=${t("composer.attach")}
                        aria-label=${t("composer.attach")}
                        disabled=${!selected || busy || uploading}
                        onClick=${() => fileRef.current?.click()}
                    >
                        ${uploading ? "…" : "+"}
                    </button>
                    <textarea
                        ref=${requestRef}
                        placeholder=${canSend ? t("composer.placeholder") : t("composer.disabled")}
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
                        ${busy ? t("composer.sending") : t("composer.send")}
                    </button>
                </div>
                <div class="aw-actions">
                    <button
                        class="aw-btn"
                        onClick=${() => control("pause")}
                        disabled=${!selected || host.state !== "ready" || phase === "paused"}
                        title=${t("control.pauseHint")}
                    >
                        ${t("control.pause")}
                    </button>
                    <button
                        class="aw-btn"
                        onClick=${() => control("resume")}
                        disabled=${!selected || host.state !== "ready"}
                        title=${t("control.resumeHint")}
                    >
                        ${t("control.resume")}
                    </button>
                    <button
                        class="aw-btn"
                        data-tone="danger"
                        onClick=${() => control("stop")}
                        disabled=${!selected}
                        title=${t("control.stopHint")}
                    >
                        ${t("control.stop")}
                    </button>
                    <span class="aw-faint">${t("control.note")}</span>
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
                        ${t(item.key)}
                    </button>`,
                )}
                <button class="aw-tab aw-mobile-only" onClick=${() => setDrawer(null)}>
                    ${t("tabs.close")}
                </button>
            </div>
            <div class="aw-panel" data-tone=${rail === "history" ? "session" : rail === "settings" ? "progress" : panel}>
                ${
                    !selected
                        ? html`<${Section} title=${t("empty.nothingOpen")}>
                              <div class="aw-muted">${t("empty.nothingOpenBody")}</div>
                          <//>`
                        : rail === "history"
                          ? html`<${HistoryPanel} experiments=${experiments} selected=${selected} onOpen=${(label) => open(label)} />`
                          : rail === "settings"
                            ? html`<${SettingsPanel} health=${health} theme=${theme} setTheme=${setThemeState} />`
                            : panel === "progress"
                              ? html`<${ProgressPanel} view=${view} status=${status} host=${host} />`
                              : panel === "board"
                                ? html`<${BoardPanel} view=${view} rows=${rows} />`
                                : panel === "knowledge"
                                  ? html`<${KnowledgePanel} view=${view} />`
                                  : panel === "session"
                                    ? html`<${SessionPanel} view=${view} status=${status} />`
                                    : panel === "actions"
                                      ? html`<${ActionsPanel} view=${view} />`
                                      : html`<${FilesPanel}
                              label=${selected}
                              enabled=${Boolean(selected)}
                              version=${filesVersion}
                          />`
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
