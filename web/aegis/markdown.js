// Markdown and code rendering, sanitized.
//
// Assistant/tool text from the EventLog is untrusted data. It is rendered with
// marked and then sanitized with DOMPurify before it reaches the DOM; raw HTML
// in a model message is not trusted.

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text) {
    if (typeof text !== "string" || text.length === 0) {
        return "";
    }

    const html = marked.parse(text, { async: false });

    return DOMPurify.sanitize(html, {
        FORBID_TAGS: ["style", "iframe", "form", "object", "embed", "script"],
        FORBID_ATTR: ["onerror", "onload", "onclick", "style"],
        ALLOW_DATA_ATTR: false,
    });
}

/** Inline code/plain text safe for attributes-free rendering. */
export function plain(text, limit = 4000) {
    if (typeof text !== "string") {
        return "";
    }

    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
