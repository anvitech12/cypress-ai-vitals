import { readFileSync, writeFileSync } from 'node:fs';
import { Marked } from 'marked';

// Renders README.md into a standalone page for reviewing it outside GitHub or npm: npm run docs:preview
const root = new URL('..', import.meta.url).pathname;
const README = `${root}README.md`;
// --no-badges leaves out the badge row (for viewers that block outside images); --out <file> writes elsewhere.
const args = process.argv.slice(2);
const withBadges = !args.includes('--no-badges');
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : `${root}docs/readme-preview.html`;

const slug = (text) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const toc = [];
const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = slug(text);
      if (depth === 2) toc.push({ id, text });
      if (depth === 3) toc.push({ id, text, sub: true });
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>\n`;
    },
    code({ text, lang }) {
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const language = lang ? ` class="language-${lang === 'ini' ? 'ini' : lang}"` : ' class="nohighlight"';
      return `<div class="code"><button type="button" class="copy" aria-label="Copy code">Copy</button><pre><code${language}>${safe}</code></pre></div>\n`;
    },
  },
});

let md = readFileSync(README, 'utf8');
// Embed every local screenshot, so the page works as a single file.
md = md.replace(/docs\/images\/([\w.-]+\.png)/g, (_, name) => `data:image/png;base64,${readFileSync(`${root}docs/images/${name}`).toString('base64')}`);
// The title and lede become the page header; render the rest as the body.
const [, titleLine, ...rest] = md.split('\n');
const ledeEnd = rest.findIndex((l, i) => i > 0 && l.startsWith('!['));
// Badge lines (only image links) get their own row; the rest of the intro is the lede.
const isBadgeLine = (l) => /^\s*(\[?!\[[^\]]*\]\([^)]*\)\]?(\([^)]*\))?\s*)+$/.test(l);
const introLines = rest.slice(0, ledeEnd);
const badgesMd = introLines.filter(isBadgeLine).join(' ').trim();
const lede = introLines.filter((l) => !isBadgeLine(l)).join('\n').trim();
const body = rest.slice(ledeEnd).join('\n');
const ledeHtml = marked.parseInline(lede);
const badgesHtml = withBadges && badgesMd ? `<div class="badges">${marked.parseInline(badgesMd)}</div>` : '';
const bodyHtml = marked.parse(body).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');

const tocHtml = toc
  .map((t) => `<li${t.sub ? ' class="sub"' : ''}><a href="#${t.id}">${t.text.replace(/<[^>]+>/g, '')}</a></li>`)
  .join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cypress-ai-vitals</title>
<meta name="description" content="README for cypress-ai-vitals, a Cypress plugin for testing AI features.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>
/* Layout: sticky contents rail on the left, one readable README column, wide tables and code scroll in place. */
:root {
  --ink: #161827;
  --muted: #5a5f74;
  --paper: #f7f8fb;
  --sheet: #ffffff;
  --rule: #e2e5ee;
  --code-bg: #f1f3f8;
  --vital: #0f8a63;
  --link: #3f4bd6;
  --warn-bg: #fff6e5;
  --warn-ink: #7a4b00;
  --tok-key: #7b3fb8;
  --tok-str: #0f7a58;
  --tok-num: #a2560a;
  --tok-com: #7d8299;
  --font-display: 'IBM Plex Sans Condensed', 'Arial Narrow', system-ui, sans-serif;
  --font-body: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ink: #e7e9f2; --muted: #a2a7bd; --paper: #12141f; --sheet: #191c2b; --rule: #2b2f45; --code-bg: #10121c;
    --vital: #3cc48f; --link: #9aa2ff; --warn-bg: #2d2412; --warn-ink: #f2c46b;
    --tok-key: #c4a1ff; --tok-str: #6fd9a8; --tok-num: #f0b46a; --tok-com: #7e849e;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --ink: #e7e9f2; --muted: #a2a7bd; --paper: #12141f; --sheet: #191c2b; --rule: #2b2f45; --code-bg: #10121c;
  --vital: #3cc48f; --link: #9aa2ff; --warn-bg: #2d2412; --warn-ink: #f2c46b;
  --tok-key: #c4a1ff; --tok-str: #6fd9a8; --tok-num: #f0b46a; --tok-com: #7e849e;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 16px; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.65 var(--font-body); padding-inline: 16px; }
a { color: var(--link); text-underline-offset: 2px; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--vital); outline-offset: 2px; border-radius: 4px; }

.page { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 48px; padding-block: 40px 96px; }
@media (max-width: 860px) { .page { grid-template-columns: minmax(0, 1fr); gap: 24px; padding-block: 24px 64px; } }

.rail { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 24px); align-self: start; max-height: calc(100vh - 48px); overflow: auto; }
.rail h2 { font: 600 12px/1 var(--font-body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
.rail ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.rail a { display: block; color: var(--muted); text-decoration: none; padding: 3px 0 3px 10px; border-left: 2px solid transparent; font-size: 14px; }
.rail a:hover { color: var(--ink); border-left-color: var(--rule); }
.rail .sub a { padding-left: 22px; font-size: 13px; font-family: var(--font-mono); }
@media (max-width: 860px) { .rail { position: static; max-height: none; border-bottom: 1px solid var(--rule); padding-bottom: 16px; } .rail ol { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); } .rail .sub { display: none; } }

main { min-width: 0; }
.masthead { display: grid; gap: 14px; padding-bottom: 28px; border-bottom: 1px solid var(--rule); margin-bottom: 8px; }
.pkg { font: 700 clamp(34px, 5vw, 48px)/1.05 var(--font-display); margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
.pkg .dot { color: var(--vital); }
.lede { margin: 0; max-width: 65ch; font-size: 18px; color: var(--ink); }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.badges img { height: 20px; display: block; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; font: 500 13px/1 var(--font-mono); }
.meta span { border: 1px solid var(--rule); background: var(--sheet); border-radius: 999px; padding: 6px 10px; color: var(--muted); }
.meta .status { border-color: transparent; background: var(--warn-bg); color: var(--warn-ink); }
.install { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; background: var(--code-bg); border: 1px solid var(--rule); border-radius: 10px; padding: 12px 14px; font-family: var(--font-mono); font-size: 14px; max-width: 640px; }
.install code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; background: none; border: 0; padding: 0; font-size: inherit; }
.install .prompt { color: var(--vital); user-select: none; }

article { max-width: 72ch; }
article h2 { font: 700 28px/1.2 var(--font-display); margin: 48px 0 12px; text-wrap: balance; }
article h3 { font: 600 20px/1.3 var(--font-body); margin: 32px 0 8px; text-wrap: balance; }
article h3 code { font-size: 0.92em; }
article p, article li { max-width: 68ch; }
article ul { padding-left: 1.2em; display: grid; gap: 6px; }
.anchor { float: left; margin-left: -1em; padding-right: 0.25em; color: var(--rule); text-decoration: none; opacity: 0; }
h2:hover .anchor, h3:hover .anchor { opacity: 1; }
article img { max-width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--rule); display: block; margin: 8px 0 16px; }
blockquote { margin: 20px 0; padding: 14px 16px; background: var(--warn-bg); color: var(--warn-ink); border-radius: 10px; }
blockquote p { margin: 0; }

:not(pre) > code { font-family: var(--font-mono); font-size: 0.88em; background: var(--code-bg); border: 1px solid var(--rule); border-radius: 5px; padding: 1px 5px; }
.code { position: relative; margin: 14px 0 18px; }
.code pre { margin: 0; background: var(--code-bg); border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; overflow-x: auto; font: 13.5px/1.6 var(--font-mono); }
.code code { font-family: inherit; }
.copy { position: absolute; top: 8px; right: 8px; font: 500 12px/1 var(--font-body); color: var(--muted); background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 5px 8px; cursor: pointer; opacity: 0; transition: opacity 0.15s; }
.code:hover .copy, .copy:focus-visible { opacity: 1; }
@media (hover: none) { .copy { opacity: 1; } }

.table-wrap { overflow-x: auto; margin: 14px 0 20px; border: 1px solid var(--rule); border-radius: 10px; background: var(--sheet); }
table { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--rule); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
th { font-weight: 600; color: var(--muted); font-size: 12.5px; letter-spacing: 0.02em; background: var(--code-bg); }
td code { white-space: nowrap; }

.hljs-keyword, .hljs-built_in, .hljs-attr, .hljs-section { color: var(--tok-key); }
.hljs-string, .hljs-regexp { color: var(--tok-str); }
.hljs-number, .hljs-literal { color: var(--tok-num); }
.hljs-comment { color: var(--tok-com); font-style: italic; }
.hljs-title, .hljs-property { color: var(--link); }

.foot { margin-top: 56px; padding-top: 16px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<div class="page">
  <nav class="rail" aria-label="Contents">
    <h2>Contents</h2>
    <ol>${tocHtml}</ol>
  </nav>
  <main>
    <header class="masthead">
      <h1 class="pkg">cypress<span class="dot">-</span>ai<span class="dot">-</span>vitals</h1>
      <p class="lede">${ledeHtml}</p>
      ${badgesHtml}
      <div class="meta">
        <span>v0.1.0</span><span>MIT</span><span>Cypress ≥ 16</span><span>Node 22+</span><span class="status">Preview: not yet on npm</span>
      </div>
      <div class="install"><span class="prompt" aria-hidden="true">$</span><code>npm i -D cypress-ai-vitals</code><button type="button" class="copy" style="position:static;opacity:1" data-copy="npm i -D cypress-ai-vitals">Copy</button></div>
    </header>
    <article>
${bodyHtml}
    </article>
    <p class="foot">Rendered from <code>README.md</code> in the cypress-ai-vitals repository. Numbers in the examples come from real runs in October 2026.</p>
  </main>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
<script>
  if (window.hljs) document.querySelectorAll('pre code:not(.nohighlight)').forEach((el) => window.hljs.highlightElement(el));
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('.copy');
    if (!button) return;
    const text = button.dataset.copy ?? button.parentElement.querySelector('code').innerText;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => (button.textContent = 'Copy'), 1600);
  });
</script>
</body>
</html>
`;
writeFileSync(OUT, html);
console.log('wrote', OUT, Math.round(html.length / 1024), 'KB', toc.length, 'toc entries');
