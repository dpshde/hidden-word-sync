// Browser errors, reported to this site so they show up in the Worker's logs. A report says what
// broke and where in the code, never what the person was doing: no sync key, no verse, no
// reference, no address beyond the page's path. The Worker scrubs every field again on arrival
// (src/observe.ts), so a report that slips through here still can't carry a key into a log.

const MAX_REPORTS = 5; // per page load
const FIELD = 300;

/**
 * Removes anything in an error's text that could be a person's data: sync keys and other long
 * tokens, quoted strings (where values usually appear), Bible references, emails, and the query
 * and fragment of any address. What's left is the shape of the error, like
 * "Cannot read properties of undefined (reading '…')".
 */
export function scrub(text, max = FIELD) {
  return String(text ?? "")
    .replace(/https?:\/\/[^\s"'`)]+/g, (url) => url.replace(/[?#].*$/, ""))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    // A sync key typed with spaces between its groups.
    .replace(/\b(?:[0-9A-Za-z]{4}[\s-]){3,}[0-9A-Za-z]{2,4}\b/g, (run) => (/\d/.test(run) ? "[redacted]" : run))
    // Sync keys (XXXX-XXXX-…), bearer tokens, library and slot ids, blobs: any long run with a digit.
    .replace(/[A-Za-z0-9_-]{16,}/g, (run) => (/\d/.test(run) ? "[redacted]" : run))
    .replace(/'[^']*'|"[^"]*"|`[^`]*`|“[^”]*”|‘[^’]*’/g, (q) => `${q[0]}…${q[q.length - 1]}`)
    // References: JHN.3.16, John 3:16, Ps 23:1-6, 1 Cor 13.
    .replace(/\b[1-3]?[A-Z]{2,3}\.\d+(\.\d+)?(-\d+)?\b/g, "[ref]")
    .replace(/\b(?:[1-3]\s?)?[A-Z][a-z]+\.?\s\d+(?::\d+(?:[-–]\d+)?)?\b/g, "[ref]")
    .replace(/\b\d+:\d+(?:[-–]\d+)?\b/g, "[ref]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A path on this site, or "external" for another origin's script. */
function sitePath(url, origin) {
  if (!url) return "";
  if (url === "external") return url;
  if (!/^(https?:\/\/|\/)/.test(url)) return "";
  try {
    const u = new URL(url, origin);
    return u.origin === origin ? u.pathname : "external";
  } catch {
    return "";
  }
}

/** Stack frames as path:line:col on this site, the top few only. */
function frames(stack, origin) {
  const out = [];
  for (const m of String(stack ?? "").matchAll(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/g)) {
    out.push(`${sitePath(m[1], origin)}:${m[2]}:${m[3]}`);
    if (out.length === 6) break;
  }
  return out.join(" ");
}

/** The report for one error event: only its kind, class, scrubbed message and code location. */
export function reportFor({ kind, error, message, filename, lineno, colno }, { origin, pathname }) {
  const name = error && typeof error === "object" && typeof error.name === "string" ? error.name : "";
  return {
    kind: kind === "unhandledrejection" ? "unhandledrejection" : "error",
    name: /^[A-Za-z]{1,40}$/.test(name) ? name : "",
    message: scrub(error?.message ?? message),
    source: sitePath(filename, origin),
    line: Number.isInteger(lineno) ? lineno : 0,
    col: Number.isInteger(colno) ? colno : 0,
    stack: frames(error?.stack, origin),
    page: pathname,
  };
}

export function installReporter(win = globalThis) {
  if (!win.addEventListener || !win.fetch) return;
  let sent = 0;
  const seen = new Set();
  const send = (report) => {
    const id = `${report.name}|${report.message}|${report.source}:${report.line}`;
    if (sent >= MAX_REPORTS || seen.has(id)) return;
    seen.add(id);
    sent += 1;
    win.fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  };
  win.addEventListener("error", (e) => {
    // A failed <img> or <script> also fires "error", with no message: not a code error.
    if (!e.message && !e.error) return;
    send(reportFor({ kind: "error", error: e.error, message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno }, win.location));
  });
  win.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    send(reportFor({ kind: "unhandledrejection", error: reason instanceof Error ? reason : null, message: reason instanceof Error ? "" : typeof reason }, win.location));
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") installReporter(window);
/* asset-rev 2 */
