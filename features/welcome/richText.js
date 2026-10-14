// Rich text for the welcome card: a small, safe subset of Discord markdown
// (**bold**, *italic*/_italic_, __underline__, ~~strike~~, `code`, # heading,
// > quote, - bullet), Unicode/emoji, Discord custom emoji (<:name:id>),
// explicit line breaks, word wrapping and adaptive font sizing.

const MAX_CHARS = 600;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{17,20})>/;

/** Remove control, bidi and zero-width characters (keeping line breaks); cap length. */
export function sanitizeMessage(text, max = MAX_CHARS) {
  let s = String(text ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const g = [...segmenter.segment(s)].map((x) => x.segment);
  if (g.length > max) s = `${g.slice(0, max - 1).join('')}…`;
  return s;
}

/** Escape user-supplied values so their characters are drawn literally. */
export function escapeRich(s) {
  return String(s ?? '').replace(/([\\*_~`])/g, '\\$1');
}

const MARKERS = [
  ['**', 'bold'],
  ['__', 'underline'],
  ['~~', 'strike'],
  ['*', 'italic'],
  ['_', 'italic'],
];

/**
 * Parse one line into styled runs. A marker only toggles when it has a
 * matching closing marker later on the line; otherwise it is literal text.
 * @returns {{text:string, bold?:boolean, italic?:boolean, underline?:boolean, strike?:boolean, code?:boolean, emoji?:{id:string,name:string,animated:boolean}}[]}
 */
export function parseInline(line) {
  const runs = [];
  const style = { bold: false, italic: false, underline: false, strike: false, code: false };
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ text: buf, ...style });
    buf = '';
  };
  for (let i = 0; i < line.length; ) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      buf += line[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      if (style.code || line.indexOf('`', i + 1) !== -1) {
        flush();
        style.code = !style.code;
        i += 1;
        continue;
      }
    }
    if (!style.code) {
      const emoji = CUSTOM_EMOJI.exec(line.slice(i));
      if (emoji) {
        flush();
        runs.push({ text: `:${emoji[2]}:`, ...style, emoji: { animated: emoji[1] === 'a', name: emoji[2], id: emoji[3] } });
        i += emoji[0].length;
        continue;
      }
      const m = MARKERS.find(([mk]) => line.startsWith(mk, i));
      if (m) {
        const [mk, prop] = m;
        if (style[prop] || line.indexOf(mk, i + mk.length) !== -1) {
          flush();
          style[prop] = !style[prop];
          i += mk.length;
          continue;
        }
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return runs;
}

/** Split into lines, handling heading / quote / bullet prefixes. */
export function parseMessage(text) {
  return sanitizeMessage(text)
    .split('\n')
    .map((raw) => {
      let line = raw;
      let heading = false;
      const h = /^(#{1,3})\s+/.exec(line);
      if (h) {
        heading = true;
        line = line.slice(h[0].length);
      }
      line = line.replace(/^>\s?/, '').replace(/^[-*]\s+(?=\S)/, '• ');
      const runs = parseInline(line);
      if (heading) for (const r of runs) r.bold = true;
      return { runs, heading };
    });
}

export const plainText = (lines) => lines.map((l) => l.runs.map((r) => r.text).join('')).join('\n');

/**
 * Wrap parsed lines to `maxWidth` at the largest font size that fits in
 * `maxLines`; the last line is ellipsised if the text still does not fit.
 * @param {CanvasRenderingContext2D} ctx used for measuring only
 * @param {(style:object, px:number)=>string} fontFor
 */
export function layoutMessage(ctx, text, { maxWidth, maxLines = 6, sizes = [32, 30, 28, 26, 24, 22, 20, 18], fontFor, lineHeightFactor = 1.3 }) {
  const parsed = typeof text === 'string' ? parseMessage(text) : text;
  if (!parsed.some((l) => l.runs.length)) return null;
  // Also report text cut by the character cap in sanitizeMessage.
  const capped = typeof text === 'string' && [...segmenter.segment(text)].length > MAX_CHARS;
  let result = null;
  for (const px of sizes) {
    const lines = wrap(ctx, parsed, { maxWidth, px, fontFor });
    result = { lines, fontSize: px, lineHeight: Math.round(px * lineHeightFactor), truncated: capped };
    if (lines.length <= maxLines) return finalize(result);
  }
  // Still too long at the smallest size: keep maxLines and ellipsise.
  result.lines = result.lines.slice(0, maxLines);
  const last = result.lines.at(-1);
  if (last?.length) {
    const tail = last.at(-1);
    tail.text = `${tail.text.replace(/\s+$/, '')}…`;
    ctx.font = fontFor(tail, result.fontSize);
    tail.width = tail.emoji ? tail.width : ctx.measureText(tail.text).width;
    // Remove characters until the line fits again.
    while (lineWidth(last) > maxWidth && [...segmenter.segment(tail.text)].length > 1) {
      const g = [...segmenter.segment(tail.text)].map((x) => x.segment);
      tail.text = `${g.slice(0, -2).join('')}…`;
      tail.width = ctx.measureText(tail.text).width;
    }
  }
  result.truncated = true;
  return finalize(result);
}

function finalize(r) {
  r.height = r.lines.length * r.lineHeight;
  r.plain = r.lines.map((l) => l.map((t) => t.text).join('').trim());
  return r;
}

const lineWidth = (line) => line.reduce((a, t) => a + t.width, 0);

function wrap(ctx, parsed, { maxWidth, px, fontFor }) {
  const out = [];
  for (const { runs } of parsed) {
    let line = [];
    let width = 0;
    const push = () => {
      // Drop trailing spaces from the measured line.
      while (line.length && /^\s+$/.test(line.at(-1).text)) width -= line.pop().width;
      out.push(line);
      line = [];
      width = 0;
    };
    if (!runs.length) {
      out.push([]);
      continue;
    }
    for (const run of runs) {
      const tokens = run.emoji ? [run.text] : run.text.split(/(\s+)/).filter(Boolean);
      for (const tok of tokens) {
        const piece = { ...run, text: tok };
        ctx.font = fontFor(piece, px);
        piece.width = run.emoji ? px * 1.1 : ctx.measureText(tok).width;
        if (/^\s+$/.test(tok) && !line.length) continue; // no leading spaces after a wrap
        if (width + piece.width <= maxWidth || !line.length) {
          if (piece.width > maxWidth && !run.emoji) {
            // A single very long word: break it by grapheme.
            for (const part of breakWord(ctx, tok, maxWidth - width, maxWidth)) {
              const p = { ...run, text: part.text, width: part.width };
              if (width + p.width > maxWidth && line.length) push();
              line.push(p);
              width += p.width;
            }
            continue;
          }
          line.push(piece);
          width += piece.width;
        } else {
          push();
          if (/^\s+$/.test(tok)) continue;
          line.push(piece);
          width += piece.width;
        }
      }
    }
    push();
  }
  return out;
}

function breakWord(ctx, word, firstAvail, maxWidth) {
  const parts = [];
  let cur = '';
  let avail = firstAvail > 0 ? firstAvail : maxWidth;
  for (const { segment } of segmenter.segment(word)) {
    const next = cur + segment;
    if (ctx.measureText(next).width > avail && cur) {
      parts.push({ text: cur, width: ctx.measureText(cur).width });
      cur = segment;
      avail = maxWidth;
    } else cur = next;
  }
  if (cur) parts.push({ text: cur, width: ctx.measureText(cur).width });
  return parts;
}

/**
 * Draw a laid-out message centred in a box.
 * @param {{x:number, y:number, width:number}} box top-left and width of the text area
 * @param {Map<string, any>} [emojiImages] custom emoji id -> loaded image
 */
export function drawMessage(ctx, layout, box, { fontFor, colors, emojiImages = new Map(), scale = 1 }) {
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  layout.lines.forEach((line, li) => {
    const total = lineWidth(line);
    let x = box.x + (box.width - total) / 2;
    const baseline = box.y + li * layout.lineHeight + layout.fontSize;
    for (const t of line) {
      if (t.emoji) {
        const img = emojiImages.get(t.emoji.id);
        const size = layout.fontSize * 1.05;
        if (img) ctx.drawImage(img, x + (t.width - size) / 2, baseline - size * 0.85, size, size);
        else {
          ctx.font = fontFor(t, layout.fontSize);
          ctx.fillStyle = colors.text;
          ctx.fillText(t.text, x, baseline);
        }
        x += t.width;
        continue;
      }
      ctx.font = fontFor(t, layout.fontSize);
      ctx.fillStyle = t.bold ? colors.bold : t.code ? colors.code : colors.text;
      ctx.shadowColor = t.bold ? colors.glow : 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = (t.bold ? 12 : 4) * scale;
      ctx.fillText(t.text, x, baseline);
      ctx.shadowBlur = 0;
      if (t.underline || t.strike) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = Math.max(1, layout.fontSize / 14);
        const yLine = t.underline ? baseline + layout.fontSize * 0.12 : baseline - layout.fontSize * 0.3;
        ctx.beginPath();
        ctx.moveTo(x, yLine);
        ctx.lineTo(x + t.width, yLine);
        ctx.stroke();
      }
      x += t.width;
    }
  });
  ctx.restore();
}
