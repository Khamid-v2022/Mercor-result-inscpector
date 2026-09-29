// Injected into the Mercor Studio task page via chrome.scripting.executeScript.
// Defines window.__mercorExtract(options) -> Promise<string>.
//
// The page is a React/Tailwind app with no stable semantic ids for most content,
// so extraction relies on the few stable hooks that exist:
//   - [data-module-instance-id] wrappers  -> one per Studio module (section)
//   - section > details > summary h2       -> module title
//   - [role="group"] > label               -> custom field (Harbor results)
//   - textarea / [data-lexical-editor] / pre code / [role="combobox"] -> field values
//   - span.text-base.font-semibold          -> QC group header (Major issues / Passed / Neutral ...)
//   - div.rounded-xl.border                 -> QC card
//   - h4 "Other findings"                   -> open-world findings list
// Everything else falls back to cleaned innerText so unknown sections are still captured.
(function () {
  if (window.__mercorExtract) return;

  const DEFAULTS = {
    includeQc: true,
    includeHarbor: true,
    includeRawJson: true,
    includeDescriptions: false,
    includeOther: true,
    expandCollapsed: true,
    rawJsonLimit: 2000,
  };

  const NOISE_LINE =
    /^(Agree|Dispute|Comment|Add to rerun|Neutral|Expand findings|Collapse findings|Show comments|Hide output|Show output|Show less|Show more)$/i;
  const JOIN_LABELS = /^(Root cause|Reachability|Suggested fix):$/;
  const SEVERITY_WORD = /^(Blocker|Critical|Major|Minor|Info|Warning|Neutral)$/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function norm(s) {
    return (s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function text(el) {
    if (!el) return '';
    // innerText is layout-aware (block -> newline, hidden -> omitted); textContent is the fallback
    return norm(el.innerText != null ? el.innerText : el.textContent);
  }

  function oneLine(s) {
    return norm(s).replace(/\s*\n\s*/g, ' ');
  }

  function indent(lines, prefix = '  ') {
    return lines.map((l) => (l === '' ? '' : prefix + l));
  }

  // Cleans innerText of a QC card / finding: removes action buttons, joins
  // "Finding #N" headers with their title+severity, joins dt/dd pairs.
  function cleanLines(raw) {
    const lines = norm(raw)
      .split('\n')
      .map((l) => l.replace(/\s*Show (less|more)\s*$/i, '').trim());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      if (!l) continue; // block structure is already expressed by the line breaks
      if (NOISE_LINE.test(l)) continue;
      if (/^[^\p{L}\p{N}]{1,2}$/u.test(l)) continue; // stray icon/toggle glyphs
      if (/^Finding #\d+$/i.test(l)) {
        const title = lines[i + 1] || '';
        i++;
        let sev = '';
        if (SEVERITY_WORD.test(lines[i + 1] || '')) {
          sev = lines[i + 1];
          i++;
        }
        l = `${l} - ${title}${sev ? ` [${sev}]` : ''}`;
      } else if (JOIN_LABELS.test(l) && lines[i + 1] && !JOIN_LABELS.test(lines[i + 1])) {
        l = `${l} ${lines[i + 1]}`;
        i++;
      }
      out.push(l);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  // ---------- expansion helpers ----------

  async function expandAll(root) {
    let clicked = 0;
    root.querySelectorAll('details:not([open])').forEach((d) => {
      d.open = true;
    });
    const clickIf = (el) => {
      if (el && typeof el.click === 'function') {
        el.click();
        clicked++;
      }
    };
    // Radix collapsibles: "Show output" (Harbor results), "Other findings" severity groups
    root
      .querySelectorAll('[data-slot="collapsible-trigger"][aria-expanded="false"]')
      .forEach((b) => {
        const t = text(b);
        if (/show output/i.test(t) || /severity/i.test(t)) clickIf(b);
      });
    // QC cards: nested findings and collapsed non-passed cards
    root.querySelectorAll('button[aria-label="Expand findings"]').forEach(clickIf);
    root.querySelectorAll('span.text-base.font-semibold').forEach((h) => {
      if (/^passed$/i.test(text(h))) return;
      const group = h.parentElement;
      if (!group) return;
      group
        .querySelectorAll('button[aria-expanded="false"]')
        .forEach((b) => {
          // only header toggles (they contain the chevron svg), not action buttons
          if (b.querySelector('svg.lucide-chevron-right, svg.lucide-chevron-down')) clickIf(b);
        });
    });
    // truncated descriptions
    root.querySelectorAll('button').forEach((b) => {
      if (/^show more$/i.test(text(b))) clickIf(b);
    });
    if (clicked) await sleep(450);
    return clicked;
  }

  // ---------- module helpers ----------

  function moduleTitle(mod) {
    const h2 =
      mod.querySelector(':scope > section > details > summary h2') ||
      mod.querySelector(':scope > div > section > details > summary h2') ||
      mod.querySelector('summary h2');
    return h2 ? oneLine(h2.textContent) : '';
  }

  function moduleSubtitle(mod) {
    const summary = mod.querySelector('summary');
    if (!summary) return '';
    const p = summary.querySelector('p.whitespace-pre-wrap, .text-xs.text-muted-foreground');
    return p ? norm(p.textContent) : '';
  }

  function childModules(mod) {
    return [...mod.querySelectorAll('[data-module-instance-id]')].filter(
      (m) => m.parentElement && m.parentElement.closest('[data-module-instance-id]') === mod
    );
  }

  function topLevelModules(root) {
    return [...root.querySelectorAll('[data-module-instance-id]')].filter(
      (m) => !m.parentElement.closest('[data-module-instance-id]')
    );
  }

  function heading(level, s) {
    return `${'#'.repeat(Math.min(level, 6))} ${s}`;
  }

  // ---------- custom fields (Harbor results, Review Feedback, Metadata ...) ----------

  function mdFromEditor(root) {
    const out = [];
    for (const el of root.children) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        [...el.children].forEach((li, i) => {
          out.push((tag === 'ol' ? `${i + 1}. ` : '- ') + oneLine(li.innerText));
        });
      } else {
        out.push(norm(el.innerText));
      }
    }
    return out.join('\n');
  }

  function fenced(body, lang) {
    const b = norm(body);
    // pick a fence longer than any backtick run inside the body
    const runs = b.match(/`+/g) || [];
    const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return [`${fence}${lang || ''}`, b, fence];
  }

  function extractFieldValue(group, opts) {
    const ta = group.querySelector('textarea');
    if (ta) {
      const v = norm(ta.value);
      if (!v) return ['(empty)'];
      const looksJson = /^[\[{]/.test(v);
      if (looksJson && !opts.includeRawJson && v.length > opts.rawJsonLimit) {
        return [`(raw JSON omitted, ${v.length.toLocaleString()} chars)`];
      }
      return fenced(v, looksJson ? 'json' : '');
    }
    const editor = group.querySelector('[data-lexical-editor="true"], [role="textbox"]');
    if (editor) {
      const v = mdFromEditor(editor);
      return v ? v.split('\n') : ['(empty)'];
    }
    const code = group.querySelector('pre code, pre');
    if (code) {
      const v = norm(code.textContent);
      return v ? fenced(v, 'text') : ['(empty)'];
    }
    const combo = group.querySelector('button[role="combobox"]');
    if (combo) {
      const val = combo.querySelector('[data-slot="select-value"]');
      const v = oneLine(val ? val.textContent : combo.textContent);
      return [!v || /^select\.\.\.$/i.test(v) ? '(empty)' : v];
    }
    const input = group.querySelector('input:not([type="file"]):not([type="hidden"])');
    if (input) {
      const v = norm(input.value);
      return [v || '(empty)'];
    }
    const inlineCode = group.querySelector('code');
    if (inlineCode) {
      const v = norm(inlineCode.textContent);
      return [v || '(empty)'];
    }
    const relative = group.querySelector(':scope > .relative, :scope > div:not(.prose)');
    if (relative) {
      const v = text(relative);
      return v ? v.split('\n') : ['(empty)'];
    }
    return ['(empty)'];
  }

  function extractFieldsModule(mod, opts, level) {
    const lines = [];
    const groups = [...mod.querySelectorAll('[role="group"]')].filter(
      (g) => g.querySelector('label') && !g.querySelector('[role="group"]')
    );
    groups.forEach((g, i) => {
      const label = oneLine(g.querySelector('label').textContent).replace(/\*$/, '').trim();
      lines.push(heading(level, `${i + 1}. ${label}`));
      if (opts.includeDescriptions) {
        const desc = g.querySelector('.prose.text-xs, .prose.mb-2');
        if (desc) {
          const d = norm(desc.textContent);
          if (d) lines.push(`> ${d.replace(/\n+/g, ' ')}`);
        }
      }
      lines.push(...extractFieldValue(g, opts));
      lines.push('');
    });
    return lines;
  }

  // ---------- QC modules (Rubric QC / Auto QC) ----------

  function cardTitle(card) {
    const t =
      card.querySelector('span.text-sm.font-semibold') ||
      card.querySelector('span.font-semibold') ||
      card.querySelector('button');
    return oneLine(t ? t.innerText : '');
  }

  function cardTag(card) {
    // e.g. the small "Neutral" label at the right side of the header
    const tag = card.querySelector('span.text-\\[11px\\]');
    return tag ? oneLine(tag.textContent) : '';
  }

  function cardBody(card, title) {
    // text of icon toggle buttons (normally svg-only, but be safe)
    const toggles = new Set(
      [...card.querySelectorAll('button[aria-label]')].map((b) => oneLine(b.innerText)).filter(Boolean)
    );
    return cleanLines(card.innerText).filter((l) => l !== title && !toggles.has(l));
  }

  function extractOtherFindings(container, level) {
    const lines = [];
    const collapsibles = [...container.querySelectorAll('[data-slot="collapsible"]')];
    const handleList = (ul, sevLabel) => {
      [...ul.children].forEach((li) => {
        if (li.tagName !== 'LI') return;
        const titleEl = li.querySelector('span.font-medium');
        const title = oneLine(titleEl ? titleEl.textContent : '');
        const sevEl = li.querySelector('span.capitalize');
        const sev = oneLine(sevEl ? sevEl.textContent : '') || sevLabel;
        lines.push(`- ${sev ? `[${sev}] ` : ''}${title}`);
        const body = cleanLines(li.innerText).filter((l) => l !== title && !SEVERITY_WORD.test(l));
        lines.push(...indent(body));
        lines.push('');
      });
    };
    if (collapsibles.length) {
      collapsibles.forEach((col) => {
        const trig = col.querySelector(':scope > [data-slot="collapsible-trigger"]');
        const sevLabel = trig ? oneLine(trig.innerText).replace(/\s*\(\d+\)\s*$/, '') : '';
        lines.push(heading(level + 1, sevLabel || 'Findings'));
        const ul = col.querySelector('[data-slot="collapsible-content"] > ul') || col.querySelector('ul');
        if (ul) handleList(ul, sevLabel.replace(/\s*severity$/i, ''));
        else lines.push('(collapsed / no findings visible)', '');
      });
    } else {
      const ul = container.querySelector('ul');
      if (ul) handleList(ul, '');
    }
    return lines;
  }

  function extractQcModule(mod, opts, level) {
    const lines = [];
    const latest = [...mod.querySelectorAll('[data-slot="dropdown-menu-trigger"]')].find((b) =>
      /latest run/i.test(b.innerText)
    );
    if (latest) lines.push(oneLine(latest.innerText), '');

    const headers = [...mod.querySelectorAll('span.text-base.font-semibold')];
    headers.forEach((h) => {
      const group = h.parentElement;
      const title = oneLine(h.innerText);
      const cards = [...group.children].filter((c) => c !== h && c.tagName === 'DIV');
      lines.push(heading(level, title));
      const isPassed = /^passed$/i.test(title);
      if (!cards.length) lines.push('(none)');
      cards.forEach((c) => {
        const t = cardTitle(c);
        if (isPassed) {
          lines.push(`- ${t}`);
          return;
        }
        const tag = cardTag(c);
        lines.push(`- ${t}${tag && tag !== title ? ` [${tag}]` : ''}`);
        lines.push(...indent(cardBody(c, t)));
        lines.push('');
      });
      lines.push('');
    });

    const otherH4 = [...mod.querySelectorAll('h4')].find((h) => /other findings/i.test(h.textContent));
    if (otherH4) {
      lines.push(heading(level, 'Other findings'));
      lines.push(...extractOtherFindings(otherH4.parentElement, level));
    }
    if (!headers.length && !otherH4) {
      const t = text(mod);
      lines.push(...(t ? cleanLines(t) : ['(no QC results)']));
    }
    return lines;
  }

  // ---------- Harbor QA runner (Lint / Check / Golden / Run ...) ----------

  function extractRunnerModule(mod) {
    const lines = [];
    mod.querySelectorAll('span.text-sm.font-medium.truncate').forEach((s) => {
      const row = s.closest('.space-y-2');
      const pre = row ? row.querySelector('pre') : null;
      lines.push(`- ${oneLine(s.innerText)}: ${pre ? oneLine(pre.innerText) : '(not run)'}`);
    });
    return lines;
  }

  // ---------- generic ----------

  function extractGeneric(mod) {
    const content = mod.querySelector('details > div') || mod;
    const t = text(content).replace(/\t/g, ' | ');
    return t ? cleanLines(t) : [];
  }

  function detectKind(mod) {
    if (mod.querySelector('input[type="file"]')) return 'package';
    if (mod.querySelector('span.text-base.font-semibold') || [...mod.querySelectorAll('h4')].some((h) => /other findings/i.test(h.textContent)))
      return 'qc';
    if (mod.querySelector('[role="group"] > label')) return 'fields';
    if (mod.querySelector('span.text-sm.font-medium.truncate') && mod.querySelector('pre')) return 'runner';
    return 'generic';
  }

  function extractModule(mod, opts, level, out) {
    const title = moduleTitle(mod);
    if (/^actions$/i.test(title)) return;
    const kids = childModules(mod);
    if (kids.length) {
      if (title) out.push(heading(level, title));
      const sub = moduleSubtitle(mod);
      if (sub && opts.includeDescriptions) out.push(`> ${sub.replace(/\n+/g, ' ')}`);
      out.push('');
      kids.forEach((k) => extractModule(k, opts, level + 1, out));
      return;
    }
    const kind = detectKind(mod);
    let body = [];
    if (kind === 'package') {
      const zip = mod.querySelector('span[title$=".zip"], span.truncate[title]');
      body = [`Package: ${zip ? oneLine(zip.textContent) : '(no upload)'}`];
    } else if (kind === 'qc') body = extractQcModule(mod, opts, level + 1);
    else if (kind === 'fields') body = extractFieldsModule(mod, opts, level + 1);
    else if (kind === 'runner') body = extractRunnerModule(mod);
    else body = extractGeneric(mod);

    if (!body.length || body.every((l) => !l)) return;
    if (title) out.push(heading(level, title));
    const sub = moduleSubtitle(mod);
    if (sub && opts.includeDescriptions && kind !== 'fields') out.push(`> ${sub.replace(/\n+/g, ' ')}`);
    out.push(...body, '');
  }

  // ---------- page header ----------

  function pageHeader() {
    const lines = [];
    const crumbs = [...document.querySelectorAll('nav[aria-label="breadcrumb"] li span[title]')];
    const taskName = crumbs.length ? oneLine(crumbs[crumbs.length - 1].textContent) : document.title;
    let status = '';
    const nav = document.querySelector('nav[aria-label="breadcrumb"]');
    if (nav && nav.parentElement) {
      const badge = nav.parentElement.querySelector('[data-slot="badge"]');
      if (badge) status = oneLine(badge.textContent);
    }
    const proj = document.querySelector('header [data-slot="popover-trigger"] span.font-medium');
    lines.push(`# Mercor Studio QA Result: ${taskName}`);
    if (proj) lines.push(`Project: ${oneLine(proj.textContent)}`);
    if (status) lines.push(`Status: ${status}`);
    lines.push(`URL: ${location.href}`);
    lines.push(`Captured: ${new Date().toISOString()}`);
    lines.push('');
    return lines;
  }

  // ---------- main ----------

  window.__mercorExtract = async function (options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const mainEl = document.querySelector('main') || document.body;
    const leftPanel = document.querySelector('[data-panel-id="main"]') || mainEl;
    const rightPanel = document.querySelector('[data-panel-id="right-sidebar"]');

    // Hidden tab panes (Jobs and Feedback / Metadata) render with display:none, which makes
    // innerText return "". Temporarily reveal them so they can be read, then restore.
    const revealed = [];
    document.querySelectorAll('div.hidden > [data-module-instance-id]').forEach((m) => {
      const p = m.parentElement;
      if (!revealed.includes(p)) revealed.push(p);
    });

    try {
      if (opts.expandCollapsed) await expandAll(mainEl);
      revealed.forEach((p) => p.classList.remove('hidden'));

      const out = [...pageHeader()];
      const qc = [];
      const harbor = [];
      const other = [];

      topLevelModules(mainEl).forEach((mod) => {
        const isRight = !!(rightPanel && rightPanel.contains(mod));
        const isHiddenTab = revealed.includes(mod.parentElement);
        const title = moduleTitle(mod);
        let bucket;
        if (isHiddenTab || /history/i.test(title)) bucket = other;
        else if (isRight) bucket = qc;
        else bucket = harbor;
        extractModule(mod, opts, 2, bucket);
      });

      if (opts.includeQc && qc.length) out.push(...qc);
      if (opts.includeHarbor && harbor.length) out.push(...harbor);
      if (opts.includeOther && other.length) out.push(...other);

      if (out.length <= 6) {
        out.push('(No Studio modules found on this page. Open a task detail page with results.)');
      }
      return norm(out.join('\n')) + '\n';
    } finally {
      revealed.forEach((p) => p.classList.add('hidden'));
    }
  };
})();
