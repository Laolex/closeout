import type { Timeline, TimelineStep } from "./timeline.ts";

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MARK = { done: "●", pending: "○", skipped: "—" } as const;

function step(s: TimelineStep): string {
  const meta = [
    s.actor ? `<span class="actor">${escape(s.actor)}</span>` : "",
    s.detail ? `<span>${escape(s.detail)}</span>` : "",
    s.commitment ? `<code title="commitment">${escape(s.commitment)}</code>` : "",
    s.txId ? `<code class="tx" title="transaction id">${escape(s.txId)}</code>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `<li class="${s.state}">
      <span class="mark" aria-hidden="true">${MARK[s.state]}</span>
      <div><p class="label">${escape(s.label)}</p><div class="meta">${meta}</div></div>
    </li>`;
}

/**
 * The job timeline as a page.
 *
 * Self-contained and static: it renders a settlement record, so it must
 * be readable from an archived copy years later, with no script and no
 * network. Everything shown is a commitment or a transaction id — enough
 * for a reader to go and check, never enough to disclose the work itself.
 */
export function renderTimeline(timeline: Timeline): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Closeout · ${escape(timeline.jobId)}</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#e3e3e3; --bg:#fff; --accent:#0b6; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --dim:#999; --line:#2a2a2a; --bg:#111; --accent:#3d9; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:3rem 1.25rem; background:var(--bg); color:var(--fg);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size:1.05rem; font-weight:600; margin:0; letter-spacing:-.01em; }
  .job { color:var(--dim); font-size:.85rem; margin:.15rem 0 2rem; }
  ol { list-style:none; margin:0; padding:0; }
  li { display:flex; gap:.9rem; padding:.85rem 0; border-bottom:1px solid var(--line); }
  li:last-child { border-bottom:0; }
  .mark { color:var(--accent); font-size:.7rem; line-height:1.9; width:1rem; flex:none; text-align:center; }
  li.pending .mark, li.skipped .mark { color:var(--dim); }
  li.pending .label, li.skipped .label { color:var(--dim); }
  .label { margin:0; font-weight:500; }
  .meta { display:flex; flex-wrap:wrap; gap:.4rem .9rem; margin-top:.3rem;
    color:var(--dim); font-size:.8rem; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.75rem;
    word-break:break-all; }
  .tx { color:var(--fg); opacity:.75; }
  .actor { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.72rem; }
  .next { margin-top:2rem; padding:.85rem 1rem; border:1px solid var(--line); border-radius:.5rem;
    font-size:.85rem; }
  .next b { font-weight:600; }
  footer { margin-top:2rem; color:var(--dim); font-size:.75rem; }
</style></head>
<body><main>
  <h1>${escape(timeline.headline)}</h1>
  <p class="job">Job ${escape(timeline.jobId)}</p>
  <ol>${timeline.steps.map(step).join("")}</ol>
  <p class="next"><b>Next:</b> ${escape(timeline.nextAction)}</p>
  <footer>Hashes are commitments; the work itself is not published here.
  A settlement record proves what was agreed, delivered, accepted and paid —
  not that the delivery was any good.</footer>
</main></body></html>`;
}
