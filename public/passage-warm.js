/**
 * Instant verse text. scripture-inline's <si-passage> reloads every time it is put in the page: it
 * shows its spinner at once, then waits on its fetch, stylesheets and fonts, even when it already
 * holds the text. Moving a prefetched passage under its row was enough to flash that spinner.
 */

/** A passage that already shows its text keeps it when it is moved, instead of reloading. */
export function keepLoadedOnMove(Passage) {
  const proto = Passage?.prototype;
  if (!proto || proto.__keepsLoaded) return;
  const connected = proto.connectedCallback;
  proto.connectedCallback = function () {
    if (this.loaded && this.loaded.passageId === this.getAttribute("passage-id")?.trim()) {
      this.systemDark?.addEventListener("change", this.onSystemTheme);
      this.applyTheme?.();
      return;
    }
    connected.call(this);
  };
  proto.__keepsLoaded = true;
}

/**
 * Loads passages in the background, a few at a time with a pause between starts so the site's
 * per-visitor rate limit is never near, and only when the page is idle. `start(ref)` resolves when
 * that passage has loaded (or failed). Adding a ref twice does nothing.
 */
export function createWarmer(start, { concurrency = 2, gapMs = 150, idle = globalThis.requestIdleCallback ?? ((f) => setTimeout(f, 50)), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const queue = [], seen = new Set();
  let running = 0, scheduled = false;
  const pump = () => {
    scheduled = false;
    while (running < concurrency && queue.length) {
      const ref = queue.shift();
      running++;
      let loading;
      try { loading = Promise.resolve(start(ref)); } catch (e) { loading = Promise.reject(e); }
      loading
        .catch(() => {})
        .then(() => sleep(gapMs))
        .then(() => {
          running--;
          schedule();
        });
    }
  };
  const schedule = () => {
    if (scheduled || !queue.length) return;
    scheduled = true;
    idle(pump);
  };
  return {
    add(ref) {
      if (seen.has(ref)) return;
      seen.add(ref);
      queue.push(ref);
      schedule();
    },
    /** Moves a ref to the front, e.g. when the pointer heads for its button. */
    first(ref) {
      const i = queue.indexOf(ref);
      if (i > 0) queue.unshift(...queue.splice(i, 1));
    },
    get active() { return running; },
    get waiting() { return queue.length; },
  };
}

/**
 * Defines <si-passage> with keepLoadedOnMove applied first. The browser reads a custom element's
 * callbacks once, when it is defined, so patching the class afterwards has no effect.
 */
export function defineKeepingLoaded(define, registry = globalThis.customElements) {
  const original = registry.define;
  registry.define = function (name, Passage, options) {
    if (name === "si-passage") keepLoadedOnMove(Passage);
    return original.call(this, name, Passage, options);
  };
  try {
    define();
  } finally {
    registry.define = original;
  }
}
/* asset-rev 2 */
