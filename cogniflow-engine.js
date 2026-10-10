/* =====================================================================
   CogniFlow Engine v2
   Document scanning + extractive summarizer for the Visual Reviewer.

   What it does:
   1. Reads PDFs by line position and font size (not one flat string),
      so it can find headings, paragraphs, and running headers/footers.
      Also reads .docx (headings preserved), .txt and .md.
   2. Splits the text into sections, drops front matter / index / junk,
      and optionally focuses on the chapter or topic the user typed.
   3. Segments the text into slides, ranks sentences by importance
      (TF-IDF centrality, key terms, position, cue phrases, MMR for
      non-redundancy), and writes lead + bullets for each slide.
   4. Builds diagrams from the real key terms of each slide.

   Install: add <script src="cogniflow-engine.js"></script> right before
   </body> in index.html, after the existing <script> block.
   ===================================================================== */
(function (root) {
'use strict';

/* ---------- constants & small helpers ---------- */
var STOP = new Set(('a about above after again against all almost also although always am among an and another any anyone are around as at be because been before being below between both but by can cannot could did do does doing done down during each either else enough even ever every few for from further get gets had has have having he her here hers herself him himself his how however i if in into is it its itself just let may me might more most much must my myself no nor not now of off often on once only onto or other others our ours ourselves out over own per perhaps quite rather same shall she should since so some something sometimes such than that the their theirs them themselves then there therefore these they this those though through thus to too toward towards under unless until up upon us use used uses using very via was we well were what whatever when whenever where whether which while who whom whose why will with within without would yet you your yours yourself one two three first second third new like said says say many etc fig figure thing things way ways make makes made given takes take took place places occur occurs occurring called performs perform serves serve include includes including become becomes provide provides allow allows help helps known across part parts result results different several various important main common large small high low long short good great real able chapter chapters section sections unit lesson module cont').split(' '));

var SKIP_HEADING = /^(table of contents|contents|index|references|bibliography|acknowledg(?:e)?ments?|about the authors?|copyright|foreword|preface|works cited|further reading|list of (?:figures|tables))\b/i;
var CH_RE = /^(chapter|part|unit|lesson|module|section|book|canto|act)\s+([0-9]+|[ivxlcdm]+)\b/i;
var CUE = /\b(in summary|in conclusion|overall|therefore|as a result|consequently|key|main|important|significant|essential|critical|fundamental|primary|defined as|refers to|is called|are called|known as|means that|consists of|results in|leads to|because)\b/i;
var DEF = /^[A-Z][^,.;:()]{2,40}\s(is|are|refers to|means|denotes)\s/;
var PRON = /^(This|These|That|Those|It|They|He|She|Such|Its|Their)\b/;
var SEQ = /\b(first|second|third|then|next|finally|step|stage|phase|after|before|subsequently|begins?|followed by)\b/gi;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function titleCase(s) { return s.toLowerCase().replace(/(^|\s)(\p{L})/gu, function (m, a, b) { return a + b.toUpperCase(); }); }
function clip(s, max) { return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '\u2026' : s; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function romanToInt(r) {
  var map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }, t = 0, p = 0, s = String(r).toUpperCase();
  for (var i = s.length - 1; i >= 0; i--) {
    var v = map[s[i]]; if (!v) return 0;
    if (v < p) t -= v; else { t += v; p = v; }
  }
  return t;
}
function intToRoman(n) {
  var l = [['M', 1000], ['CM', 900], ['D', 500], ['CD', 400], ['C', 100], ['XC', 90], ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]], r = '';
  l.forEach(function (x) { while (n >= x[1]) { r += x[0]; n -= x[1]; } });
  return r;
}

function words(s) {
  return (s.toLowerCase().match(/[\p{L}][\p{L}'\u2019\-]*/gu) || []).map(function (w) { return w.replace(/['\u2019\-]+$/, ''); });
}
function stem(w) {
  if (w.length < 5 || /ss$/.test(w)) return w;
  var r = w.replace(/(ations|ation|ments|ment|ities|ity|ings|ing|edly|ed|ies|es|ly|s)$/, function (m) { return m === 'ies' ? 'y' : ''; });
  return r.length < 3 ? w : r;
}
function isContent(w) { return w.length >= 3 && !STOP.has(w); }

function cosine(a, b) {
  var dot = 0, na = 0, nb = 0, k;
  for (k in a) { na += a[k] * a[k]; if (b[k]) dot += a[k] * b[k]; }
  for (k in b) nb += b[k] * b[k];
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/* ---------- sentence handling ---------- */
var ABBR = /\b(?:e\.g|i\.e|etc|vs|fig|figs|eq|dr|mr|mrs|ms|prof|st|inc|ltd|cf|al|approx|ca|vol|pp|ch|sec)\.$/i;
function splitSentences(text) {
  var raw = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?]["'\u201D\u2019)\]]*)\s+(?=["'\u201C\u2018(\[]*[\p{Lu}0-9])/u);
  var out = [];
  raw.forEach(function (s) {
    var p = out[out.length - 1];
    if (p && (ABBR.test(p) || /(^|\s)\p{Lu}\.$/u.test(p))) out[out.length - 1] = p + ' ' + s; else out.push(s);
  });
  return out;
}
function isJunk(s) {
  var t = s.trim();
  if (t.length < 25) return true;
  if (/\.{4,}|(\.\s){4,}/.test(t)) return true;
  if ((t.match(/\d/g) || []).length / t.length > 0.2) return true;
  if (/(all rights reserved|\bisbn\b|copyright|\u00A9|library of congress|table of contents|printed in|published by)/i.test(t)) return true;
  if (/(https?:\/\/|www\.)/i.test(t) && t.length < 120) return true;
  if ((t.match(/\p{L}/gu) || []).length / t.length < 0.6) return true;
  if (words(t).length < 6) return true;
  return false;
}

/* ---------- heading detection ---------- */
function strongHeadingLevel(t) {
  if (CH_RE.test(t)) return 1;
  var m = t.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+\p{Lu}/u);
  if (m) return Math.min(4, m[1].split('.').length);
  var letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 3 && letters === letters.toUpperCase() && t.split(/\s+/).length <= 10) return 2;
  return 0;
}
function weakHeadingLevel(t) {
  var w = t.split(/\s+/);
  if (w.length > 9 || !/^\p{Lu}/u.test(t)) return 0;
  var long = w.filter(function (x) { return x.length > 3; });
  var caps = long.filter(function (x) { return /^\p{Lu}/u.test(x); }).length;
  return (!long.length || caps / long.length >= 0.6) ? 3 : 0;
}
function headingLevelOf(t) {
  t = t.trim();
  if (t.length < 3 || t.length > 90 || /[.!?,;]$/.test(t) || /^[-*\u2022\u25AA\u25E6]\s/.test(t)) return 0;
  return strongHeadingLevel(t) || weakHeadingLevel(t);
}

/* ---------- 1. text -> sections ---------- */
function parseSections(text) {
  var blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
  var cur = { heading: '', level: 0, paras: [] }, secs = [cur];
  function open(h, l) { cur = { heading: h.trim(), level: l, paras: [] }; secs.push(cur); }
  blocks.forEach(function (b) {
    var lines = b.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return;
    var m = lines[0].match(/^\u00A7H([1-4])\u00A7\s*(.+)$/) || lines[0].match(/^(#{1,4})\s+(.+)$/);
    if (m) {
      open(m[2], m[1][0] === '#' ? m[1].length : parseInt(m[1], 10));
      var rest = lines.slice(1).join(' ').trim();
      if (rest) cur.paras.push(rest);
      return;
    }
    if (lines.length === 1) {
      var lv = headingLevelOf(lines[0]);
      if (lv) { open(lines[0], lv); return; }
    }
    var bul = /^([-*\u2022\u25AA\u25E6]|\d+[.)])\s+/;
    var bulletCount = lines.filter(function (l) { return bul.test(l); }).length;
    var para = bulletCount >= 2
      ? lines.map(function (l) { l = l.replace(bul, ''); return /[.!?:;]$/.test(l) ? l : l + '.'; }).join(' ')
      : lines.join(' ');
    cur.paras.push(para.replace(/\s+/g, ' '));
  });
  return secs.filter(function (s) { return s.paras.length || s.heading; });
}

function secWords(s) { return s.paras.reduce(function (n, p) { return n + p.split(/\s+/).length; }, 0); }
function extent(secs, i) {
  var base = secs[i], out = [base];
  for (var j = i + 1; j < secs.length; j++) {
    var s = secs[j];
    if (s.level > 0 && base.level > 0 && s.level <= base.level) break;
    out.push(s);
  }
  return out;
}
function extentWords(ex) { return ex.reduce(function (n, s) { return n + secWords(s); }, 0); }

function applyFocus(secs, focus) {
  focus = (focus || '').trim();
  if (!focus) return { secs: secs, note: '', focused: false, title: '' };
  var idx = -1, m = focus.match(/\b(chapter|part|unit|lesson|module|section|book|canto|act)\s*([0-9]+|[ivxlcdm]+)\b/i);
  if (m) {
    var n = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : romanToInt(m[2]);
    if (n) {
      var re = new RegExp('^(?:' + m[1] + '\\s*)?(?:' + n + '|' + intToRoman(n) + ')(?=[\\s.:)\\-\u2013\u2014]|$)(?!\\.\\d)', 'i');
      var bestW = -1;
      secs.forEach(function (s, i) {
        if (s.heading && re.test(s.heading)) {
          var w = extentWords(extent(secs, i));
          if (w > bestW) { bestW = w; idx = i; }
        }
      });
    }
  }
  if (idx < 0) {
    var fs = words(focus).filter(isContent).map(stem);
    if (fs.length) {
      var bs = 0;
      secs.forEach(function (s, i) {
        var hs = words(s.heading).map(stem), hit = 0;
        fs.forEach(function (k) { if (hs.indexOf(k) >= 0) hit++; });
        var score = hit * 3;
        if (!hit && s.paras.length) {
          var bw = words(s.paras.join(' ')).map(stem), c = 0;
          bw.forEach(function (k) { if (fs.indexOf(k) >= 0) c++; });
          score = bw.length > 40 && c >= 3 ? (c / bw.length) * 20 : 0;
        }
        if (score > bs) { bs = score; idx = i; }
      });
    }
  }
  if (idx < 0) return { secs: secs, note: 'No section matched \u201C' + focus + '\u201D, so the whole document was summarized.', focused: false, title: '' };
  var h = secs[idx].heading || focus;
  return { secs: extent(secs, idx), note: 'Focused on \u201C' + clip(h, 60) + '\u201D.', focused: true, title: h };
}

/* ---------- 2. segments ---------- */
function mkSeg(heading, level, sents) {
  var w = 0; sents.forEach(function (s) { w += s.wc; });
  return { heading: heading, level: level, sents: sents, words: w };
}
function cleanHeading(h) {
  h = (h || '').replace(/\s+/g, ' ').replace(/[\s.\u00B7]+\d+$/, '').trim();
  var letters = h.replace(/[^\p{L}]/gu, '');
  if (letters.length > 4 && letters === letters.toUpperCase()) h = titleCase(h);
  if (h.length > 70) h = h.slice(0, 70).replace(/\s+\S*$/, '') + '\u2026';
  return h;
}
function sectionSentences(sec, si, seen) {
  var out = [];
  sec.paras.forEach(function (p, pi) {
    splitSentences(p).filter(function (s) { return !isJunk(s); }).forEach(function (s, k) {
      var key = s.toLowerCase().replace(/\W+/g, ' ').trim();
      if (seen[key]) return;
      seen[key] = 1;
      var ws = words(s), tf = {}, n = 0;
      ws.forEach(function (w) { if (isContent(w)) { var st = stem(w); tf[st] = (tf[st] || 0) + 1; n++; } });
      out.push({ text: s, para: si + ':' + pi, pfirst: k === 0, sfirst: pi === 0 && k === 0, tf: tf, n: n, wc: ws.length });
    });
  });
  if (out.length) out[0].sfirst = true;
  return out;
}
function mergeTiny(segs, min) {
  var out = [];
  segs.forEach(function (s) {
    var p = out[out.length - 1];
    if (p && s.words < min) out[out.length - 1] = mkSeg(p.heading, p.level, p.sents.concat(s.sents));
    else out.push(s);
  });
  if (out.length > 1 && out[0].words < min) {
    var a = out.shift();
    out[0] = mkSeg(out[0].heading, out[0].level, a.sents.concat(out[0].sents));
  }
  return out;
}
function unitsOf(seg) {
  var by = {}, order = [];
  seg.sents.forEach(function (s) {
    if (!by[s.para]) { by[s.para] = []; order.push(s.para); }
    by[s.para].push(s);
  });
  var u = order.map(function (k) { return by[k]; });
  if (u.length < 4) { u = []; for (var i = 0; i < seg.sents.length; i += 3) u.push(seg.sents.slice(i, i + 3)); }
  return u;
}
function unitVec(us) {
  var v = {};
  us.forEach(function (u) { u.forEach(function (s) { for (var k in s.tf) v[k] = (v[k] || 0) + s.tf[k]; }); });
  return v;
}
function bestSplit(seg) {
  var u = unitsOf(seg), n = u.length;
  if (n < 4) return null;
  var best = null;
  for (var i = 1; i < n; i++) {
    if (n >= 6 && (i < 2 || n - i < 2)) continue;
    var sc = cosine(unitVec(u.slice(Math.max(0, i - 2), i)), unitVec(u.slice(i, Math.min(n, i + 2)))) + 0.2 * Math.abs(i - n / 2) / n;
    if (!best || sc < best.sc) best = { i: i, sc: sc };
  }
  if (!best) return null;
  var a = [], b = [];
  u.forEach(function (x, j) { x.forEach(function (s) { (j < best.i ? a : b).push(s); }); });
  return [mkSeg(seg.heading, seg.level, a), mkSeg(seg.heading ? seg.heading + ' (cont.)' : '', seg.level, b)];
}
function rebalance(segs, lo, hi) {
  while (segs.length > hi) {
    var bi = 0, bw = Infinity;
    for (var i = 0; i < segs.length - 1; i++) {
      var w = segs[i].words + segs[i + 1].words;
      if (w < bw) { bw = w; bi = i; }
    }
    var a = segs[bi], b = segs[bi + 1];
    segs.splice(bi, 2, mkSeg(a.words >= b.words ? a.heading : b.heading, Math.min(a.level, b.level), a.sents.concat(b.sents)));
  }
  var guard = 0;
  while (segs.length < lo && guard++ < 24) {
    var li = 0;
    segs.forEach(function (s, i) { if (s.words > segs[li].words) li = i; });
    var sp = bestSplit(segs[li]);
    if (!sp) break;
    segs.splice(li, 1, sp[0], sp[1]);
  }
  return segs;
}

/* ---------- 3. key terms + sentence ranking ---------- */
function topTerms(texts, n, idf, heading) {
  var uni = {}, bi = {}, surf = {};
  function addSurf(k, w) { var o = surf[k] = surf[k] || {}; o[w] = (o[w] || 0) + 1; }
  var src = heading ? texts.concat([heading, heading, heading]) : texts;
  src.forEach(function (t) {
    var toks = t.match(/[\p{L}][\p{L}'\u2019\-]*|[^\p{L}\s]/gu) || [], prev = null;
    toks.forEach(function (tok) {
      if (!/^\p{L}/u.test(tok)) { prev = null; return; }
      var w = tok.replace(/['\u2019\-]+$/, ''), lw = w.toLowerCase();
      if (lw.length < 3 || STOP.has(lw)) { prev = null; return; }
      var k = stem(lw);
      uni[k] = (uni[k] || 0) + 1; addSurf(k, w);
      if (prev) { var bk = prev.k + ' ' + k; bi[bk] = (bi[bk] || 0) + 1; addSurf(bk, prev.w + ' ' + w); }
      prev = { k: k, w: w };
    });
  });
  function display(k) {
    var v = surf[k], best = null, bc = 0, bestLower = null, lc = 0;
    for (var s in v) {
      if (v[s] > bc) { bc = v[s]; best = s; }
      if (s === s.toLowerCase() && v[s] > lc) { lc = v[s]; bestLower = s; }
    }
    return bestLower || best;
  }
  var minC = texts.length > 8 ? 2 : 1, cands = [], k;
  for (k in uni) {
    if (uni[k] >= minC) cands.push({ k: k, c: uni[k], score: uni[k] * (idf[k] || 1) });
  }
  for (k in bi) {
    if (bi[k] >= 2) {
      var p = k.split(' ');
      cands.push({ k: k, c: bi[k], score: bi[k] * (((idf[p[0]] || 1) + (idf[p[1]] || 1)) / 2) * 1.8 });
    }
  }
  cands.sort(function (a, b) { return b.score - a.score; });
  var picked = cands.slice(0, n + 6);
  var phrases = picked.filter(function (c) { return c.k.indexOf(' ') > 0; });
  picked = picked.filter(function (c) {
    if (c.k.indexOf(' ') > 0) return true;
    return !phrases.some(function (ph) { return ph.k.split(' ').indexOf(c.k) >= 0 && c.c < ph.c * 1.5; });
  }).slice(0, n);
  return picked.map(function (c) { return { term: display(c.k), k: c.k, score: c.score }; });
}
function termStemSet(terms) {
  var o = {};
  terms.forEach(function (t) { t.k.split(' ').forEach(function (p) { o[p] = 1; }); });
  return o;
}
function scoreSegment(sents, idf, termStems) {
  var centroid = {};
  sents.forEach(function (s) {
    s.v = {};
    for (var k in s.tf) { var w = s.tf[k] * (idf[k] || 1); s.v[k] = w; centroid[k] = (centroid[k] || 0) + w; }
  });
  sents.forEach(function (s) {
    var key = 0;
    for (var k in s.tf) if (termStems[k]) key += s.tf[k];
    var dens = s.n ? key / s.n : 0;
    var sc = 0.55 * cosine(s.v, centroid) + 0.3 * Math.min(1, dens * 1.5);
    if (s.sfirst) sc += 0.12; else if (s.pfirst) sc += 0.06;
    if (CUE.test(s.text)) sc += 0.1;
    if (DEF.test(s.text)) sc += 0.08;
    if (/\?\s*$/.test(s.text)) sc -= 0.25;
    if (s.wc > 55) sc -= 0.15;
    if (s.wc < 9) sc -= 0.1;
    if (PRON.test(s.text)) sc -= 0.08;
    s.score = sc;
  });
}
function pickMMR(sents, k, lambda) {
  var pool = sents.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 60), chosen = [];
  while (chosen.length < k && pool.length) {
    var best = -Infinity, bi = 0;
    for (var i = 0; i < pool.length; i++) {
      var red = 0;
      for (var j = 0; j < chosen.length; j++) red = Math.max(red, cosine(pool[i].v, chosen[j].v));
      var val = lambda * pool[i].score - (1 - lambda) * red;
      if (val > best) { best = val; bi = i; }
    }
    chosen.push(pool.splice(bi, 1)[0]);
  }
  return chosen;
}

/* ---------- 4. wording ---------- */
var LEAD_WORDS = /^(however|moreover|furthermore|additionally|in addition|also|then|thus|therefore|consequently|meanwhile|nevertheless|nonetheless|similarly|likewise|finally|indeed|for example|for instance|in fact|as a result|of course),?\s+/i;
function compress(s, max) {
  var t = s.replace(/\s+/g, ' ').trim().replace(LEAD_WORDS, '');
  t = cap(t);
  if (t.length <= max) return t;
  var cut = t.slice(0, max), at = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' \u2014 '));
  if (at > max * 0.6) return cut.slice(0, at).replace(/[,;\u2014\s]+$/, '') + '.';
  return cut.replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '\u2026';
}
function boldTerms(text, terms) {
  var html = esc(text), ranges = [], done = 0;
  for (var i = 0; i < terms.length && done < 2; i++) {
    var t = esc(terms[i].term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var m = new RegExp('(^|[^\\p{L}])(' + t + ')(?![\\p{L}])', 'iu').exec(html);
    if (!m) continue;
    var a = m.index + m[1].length, b = a + m[2].length;
    if (ranges.some(function (r) { return a < r[1] && b > r[0]; })) continue;
    ranges.push([a, b]); done++;
  }
  ranges.sort(function (x, y) { return y[0] - x[0]; });
  ranges.forEach(function (r) { html = html.slice(0, r[0]) + '<strong>' + html.slice(r[0], r[1]) + '</strong>' + html.slice(r[1]); });
  return html;
}
function formatBullet(s, terms) {
  var t = compress(s, 175);
  var d = t.match(/^([A-Z][^,.;:()]{2,40}?)\s+(is|are|refers to|means|denotes|can be defined as)\s+(.{12,})$/);
  if (d) { d = [d[0], d[1], d[3]].concat(d[2]); }
  var subjOK = d && terms.slice(0, 5).some(function (x) { return d[1].toLowerCase().indexOf(x.term.toLowerCase()) >= 0; }) &&
    (d[3] !== 'is' && d[3] !== 'are' || /^(a|an|the|one|any|used|called|known|defined|considered)\s/i.test(d[2]));
  if (d && subjOK && d[1].split(' ').length <= 5 && !PRON.test(d[1]) && !/^There\b/.test(d[1])) {
    return '<strong>' + esc(d[1]) + '</strong>: ' + esc(d[2]);
  }
  return boldTerms(t, terms);
}
function titleFromTerms(terms) {
  var t = terms.slice(0, 2).map(function (x) { return titleCase(x.term); });
  return t.length > 1 ? t.join(' & ') : (t[0] || 'Key Ideas');
}

/* ---------- 5. diagrams built from real content ---------- */
var FONT = 'system-ui, sans-serif';
function wrapLabel(label, max) {
  label = label.trim();
  if (label.length <= max) return [label];
  var parts = label.split(' ');
  if (parts.length > 1) return [clip(parts[0], max), clip(parts.slice(1).join(' '), max)];
  return [clip(label, max)];
}
function svgLabel(cx, cy, label, max, size, fill, weight) {
  var ls = wrapLabel(label, max), y = cy + (ls.length === 2 ? -size * 0.45 : size * 0.35);
  return '<text x="' + cx + '" y="' + y.toFixed(1) + '" fill="' + fill + '" font-size="' + size + '" font-weight="' + (weight || 600) + '" text-anchor="middle" font-family="' + FONT + '">' +
    ls.map(function (l, i) { return '<tspan x="' + cx + '" dy="' + (i ? (size * 1.15).toFixed(1) : 0) + '">' + esc(l) + '</tspan>'; }).join('') + '</text>';
}
function conceptMap(tag, terms) {
  var sat = terms.filter(function (t) { return t.term.toLowerCase() !== tag.toLowerCase(); }).slice(0, 5);
  var n = sat.length, svg = '<svg viewBox="0 0 280 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Concept map of ' + esc(tag) + '">';
  var pts = sat.map(function (t, i) {
    var a = (-90 + i * (360 / n)) * Math.PI / 180;
    return { x: 140 + 95 * Math.cos(a), y: 100 + 62 * Math.sin(a), t: t };
  });
  pts.forEach(function (p) { svg += '<line x1="140" y1="100" x2="' + p.x.toFixed(1) + '" y2="' + p.y.toFixed(1) + '" stroke="#D1D1CD" stroke-width="2"/>'; });
  pts.forEach(function (p) {
    svg += '<rect x="' + (p.x - 37).toFixed(1) + '" y="' + (p.y - 15).toFixed(1) + '" width="74" height="30" rx="7" fill="#FFFFFF" stroke="#050505" stroke-width="1.5"/>' +
      svgLabel(p.x.toFixed(1), p.y, p.t.term, 11, 10, '#050505', 600);
  });
  svg += '<rect x="92" y="82" width="96" height="36" rx="9" fill="#050505"/>' + svgLabel(140, 100, tag, 14, 11, '#FFFFFF', 800) + '</svg>';
  return svg;
}
function flowDiagram(labels) {
  var svg = '<svg viewBox="0 0 280 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sequence diagram">';
  labels.forEach(function (l, i) {
    var y = 8 + i * 48, last = i === labels.length - 1;
    svg += '<rect x="20" y="' + y + '" width="240" height="34" rx="8" fill="' + (last ? '#050505' : '#FFFFFF') + '" stroke="#050505" stroke-width="1.5"/>' +
      svgLabel(140, y + 17, (i + 1) + '  ' + clip(l, 28), 40, 11, last ? '#FFFFFF' : '#050505', 700);
    if (!last) svg += '<path d="M 140 ' + (y + 34) + ' L 140 ' + (y + 44) + '" stroke="#050505" stroke-width="2"/><polygon points="140,' + (y + 48) + ' 136,' + (y + 41) + ' 144,' + (y + 41) + '" fill="#050505"/>';
  });
  return svg + '</svg>';
}
function barDiagram(terms) {
  var t = terms.slice(0, 5), max = Math.max.apply(null, t.map(function (x) { return x.score; })) || 1;
  var svg = '<svg viewBox="0 0 280 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Key term weights">';
  t.forEach(function (x, i) {
    var y = 18 + i * 36, w = Math.max(14, Math.round(150 * x.score / max));
    svg += '<text x="10" y="' + (y + 14) + '" fill="#4A4A4A" font-size="10" font-weight="700" font-family="' + FONT + '">' + esc(clip(x.term, 15)) + '</text>' +
      '<rect x="105" y="' + y + '" width="165" height="20" rx="5" fill="#F1F1EF"/>' +
      '<rect x="105" y="' + y + '" width="' + w + '" height="20" rx="5" fill="' + (i === 0 ? '#050505' : '#737373') + '"/>';
  });
  return svg + '</svg>';
}

/* ---------- 6. build the deck ---------- */
function buildDeck(rawText, focus) {
  var secs = parseSections(rawText), f = applyFocus(secs, focus), seen = {}, segs = [];
  f.secs.forEach(function (sec, si) {
    if (SKIP_HEADING.test(sec.heading) && !f.focused) return;
    var sents = sectionSentences(sec, si, seen);
    if (sents.length) segs.push(mkSeg(cleanHeading(sec.heading), sec.level, sents));
  });
  if (!segs.length) return { slides: [], note: f.note, stats: { words: 0, sections: 0 } };

  var W = segs.reduce(function (n, s) { return n + s.words; }, 0);
  segs = mergeTiny(segs, 45);
  segs = rebalance(segs, clamp(Math.round(W / 350), 1, 8), clamp(Math.round(W / 90), 3, 12));

  /* corpus statistics for TF-IDF */
  var all = [], df = {}, N = 0;
  segs.forEach(function (s) { s.sents.forEach(function (x) { all.push(x); }); });
  all.forEach(function (s) { N++; for (var k in s.tf) df[k] = (df[k] || 0) + 1; });
  var idf = {}; for (var k in df) idf[k] = Math.log(1 + N / df[k]);

  var slides = [], leads = [];
  segs.forEach(function (seg) {
    var terms = topTerms(seg.sents.map(function (s) { return s.text; }), 8, idf, seg.heading.replace(/\s*\(cont\.\)/, ''));
    scoreSegment(seg.sents, idf, termStemSet(terms));
    var count = clamp(Math.round(seg.sents.length / 3.5) + 1, 2, 6);
    var chosen = pickMMR(seg.sents, count, 0.7);
    var lead = chosen.filter(function (s) { return !PRON.test(s.text); })[0] || chosen[0];
    var rest = chosen.filter(function (s) { return s !== lead; }).sort(function (a, b) { return seg.sents.indexOf(a) - seg.sents.indexOf(b); });
    var tag = terms.length ? clip(terms[0].term.toUpperCase(), 18) : 'KEY IDEA';
    var seqHits = (seg.sents.map(function (s) { return s.text; }).join(' ').match(SEQ) || []).length;
    var diagram, kind;
    if (seqHits >= 3 && rest.length >= 3) {
      var labels = rest.slice(0, 4).map(function (s) {
        var hit = terms.filter(function (t) { return s.text.toLowerCase().indexOf(t.term.toLowerCase()) >= 0; })[0];
        return cap(hit ? hit.term : s.text.split(/\s+/).slice(0, 4).join(' '));
      });
      diagram = flowDiagram(labels); kind = 'Sequence';
    } else if (slides.length % 2 === 0 && terms.length >= 3) {
      diagram = conceptMap(tag, terms); kind = 'Concept map';
    } else if (terms.length >= 2) {
      diagram = barDiagram(terms); kind = 'Key term weight';
    } else {
      diagram = conceptMap(tag, terms.length ? terms : [{ term: 'Idea', score: 1 }]); kind = 'Concept map';
    }
    leads.push(lead);
    slides.push({
      kind: 'section',
      title: seg.heading || titleFromTerms(terms),
      conceptTag: tag,
      lead: compress(lead.text, 230),
      bullets: rest.map(function (s) { return formatBullet(s.text, terms); }),
      keyTerms: terms.slice(0, 5).map(function (t) { return t.term; }),
      diagramHtml: diagram,
      diagramKind: kind
    });
  });

  /* overview + takeaways for longer material */
  if (W >= 350 && slides.length >= 3) {
    var gTerms = topTerms(all.map(function (s) { return s.text; }), 8, idf, '');
    var docTitle = f.focused && f.title ? cleanHeading(f.title) : titleFromTerms(gTerms);
    var gTag = gTerms.length ? clip(gTerms[0].term.toUpperCase(), 18) : 'OVERVIEW';
    var top = leads.slice().sort(function (a, b) { return b.score - a.score; });
    var overview = {
      kind: 'overview',
      title: 'Overview: ' + clip(docTitle, 52),
      conceptTag: gTag,
      lead: compress(top[0].text, 230),
      bullets: ['<strong>Key terms</strong>: ' + esc(gTerms.slice(0, 6).map(function (t) { return t.term; }).join(', '))]
        .concat(slides.slice(0, 6).map(function (s, i) { return '<strong>Slide ' + (i + 2) + '</strong>: ' + esc(clip(s.title, 60)); })),
      keyTerms: gTerms.slice(0, 5).map(function (t) { return t.term; }),
      diagramHtml: conceptMap(gTag, gTerms.length >= 3 ? gTerms : [{ term: 'Ideas', score: 1 }, { term: 'Concepts', score: 1 }, { term: 'Details', score: 1 }]),
      diagramKind: 'Concept map'
    };
    var pool = top.length > 2 ? top.slice(1, 6) : top.slice();
    var tkLead = pool[0];
    var tk = pool.slice(1).sort(function (a, b) { return leads.indexOf(a) - leads.indexOf(b); });
    var takeaways = {
      kind: 'takeaways',
      title: 'Key Takeaways',
      conceptTag: gTag,
      lead: compress(tkLead.text, 230),
      bullets: tk.map(function (s) { return formatBullet(s.text, gTerms); }),
      keyTerms: gTerms.slice(0, 5).map(function (t) { return t.term; }),
      diagramHtml: barDiagram(gTerms.length >= 2 ? gTerms : [{ term: 'Core', score: 1 }, { term: 'Ideas', score: 1 }]),
      diagramKind: 'Key term weight'
    };
    slides.unshift(overview);
    slides.push(takeaways);
  }

  slides.forEach(function (s, i) {
    s.slideNumber = i + 1;
    s.diagramCaption = 'Figure ' + (i + 1) + '.1: ' + s.diagramKind + ' \u2014 ' + titleCase(s.conceptTag.toLowerCase());
  });
  return { slides: slides, note: f.note, stats: { words: W, sections: segs.length } };
}

/* ---------- 7. PDF scanning (line geometry + font size) ---------- */
function joinRows(rows) {
  var s = '';
  rows.forEach(function (r) {
    var t = r.text.trim();
    if (!s) { s = t; return; }
    if (/[\p{L}]-$/u.test(s) && /^\p{Ll}/u.test(t)) s = s.slice(0, -1) + t; else s += ' ' + t;
  });
  return s.replace(/\s+/g, ' ');
}
function rowsToText(pages, outlineMap) {
  var hist = {}, np = pages.length;
  pages.forEach(function (rows) { rows.forEach(function (r) { var k = Math.round(r.size * 2) / 2; hist[k] = (hist[k] || 0) + r.text.length; }); });
  var body = 0, bw = 0;
  for (var k in hist) if (hist[k] > bw) { bw = hist[k]; body = +k; }
  body = body || 10;

  function norm(t) { return t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim(); }
  var counts = {};
  pages.forEach(function (rows) {
    var seen = {};
    rows.forEach(function (r, i) {
      if (i < 2 || i >= rows.length - 2) { var n = norm(r.text); if (n && !seen[n]) { seen[n] = 1; counts[n] = (counts[n] || 0) + 1; } }
    });
  });
  var repeatMin = Math.max(3, Math.ceil(np * 0.35));

  var out = [], para = [], curHead = null, prev = null;
  function flushPara() { if (para.length) out.push(joinRows(para)); para = []; }
  function flushHead() { if (curHead) { out.push('\u00A7H' + curHead.level + '\u00A7 ' + curHead.text); curHead = null; } }

  pages.forEach(function (rows) {
    rows.forEach(function (r, i) {
      var t = r.text.trim();
      if (!t) return;
      var edge = i < 2 || i >= rows.length - 2;
      if (edge && np >= 4 && counts[norm(t)] >= repeatMin) return;
      if (/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t)) return;
      if (edge && /^[ivxlcdm]{1,6}$/i.test(t)) return;
      if (r.size < body * 0.75) return;

      var gap = prev && prev.page === r.page ? prev.y - r.y : null;
      var ratio = r.size / body, level = 0, key = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (outlineMap && outlineMap[key]) level = outlineMap[key];
      else if (t.length <= 100 && ratio >= 1.12 && !/[.!?,;]$/.test(t)) level = ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : 3;
      else if (t.length <= 90 && ratio >= 0.95 && !/[.!?,;]$/.test(t)) level = strongHeadingLevel(t);

      if (level) {
        if (curHead && Math.abs(curHead.size - r.size) < 0.6 && gap !== null && gap < r.size * 2.2) curHead.text += ' ' + t;
        else { flushPara(); flushHead(); curHead = { level: level, text: t, size: r.size }; }
        prev = r; return;
      }
      flushHead();
      if (para.length) {
        var last = para[para.length - 1], ends = /[.!?:"\u201D)]$/.test(last.text.trim()), np2 = false;
        if (gap !== null && (gap > r.size * 1.55 || gap < -r.size * 2)) np2 = true;
        else if (gap === null && ends) np2 = true;
        else if (gap !== null && r.x - last.x > r.size * 1.2 && ends) np2 = true;
        if (np2) flushPara();
      }
      para.push(r); prev = r;
    });
  });
  flushPara(); flushHead();
  return out.join('\n\n');
}

async function extractPdf(pdf, onProgress) {
  var pages = [], np = pdf.numPages, outlineMap = null;
  try {
    var ol = await pdf.getOutline();
    if (ol && ol.length) {
      outlineMap = {};
      (function walk(items, d) {
        items.forEach(function (it) {
          var k = (it.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (k && !outlineMap[k]) outlineMap[k] = Math.min(4, d);
          if (it.items && it.items.length) walk(it.items, d + 1);
        });
      })(ol, 1);
    }
  } catch (e) { /* outline is optional */ }

  for (var p = 1; p <= np; p++) {
    var page = await pdf.getPage(p), tc = await page.getTextContent(), rows = [], cur = null;
    tc.items.forEach(function (it) {
      if (typeof it.str !== 'string') return;
      var x = it.transform[4], y = it.transform[5], size = it.height || Math.abs(it.transform[3]) || 10;
      if (!it.str.trim()) { if (cur) cur.parts.push({ s: ' ', x: x, w: it.width || 0 }); return; }
      if (!cur || Math.abs(cur.y - y) > Math.max(2, size * 0.45)) { cur = { y: y, x: x, page: p, size: size, maxLen: 0, parts: [] }; rows.push(cur); }
      if (it.str.length > cur.maxLen) { cur.maxLen = it.str.length; cur.size = size; }
      cur.parts.push({ s: it.str, x: x, w: it.width || 0 });
    });
    rows.forEach(function (r) {
      var text = '', endX = null;
      r.parts.forEach(function (pt) {
        if (endX !== null && pt.x - endX > r.size * 0.18 && !/\s$/.test(text) && !/^\s/.test(pt.s)) text += ' ';
        text += pt.s; endX = pt.x + pt.w;
      });
      r.text = text.replace(/\s+/g, ' ').trim();
    });
    pages.push(rows.filter(function (r) { return r.text; }));
    if (page.cleanup) page.cleanup();
    if (onProgress) onProgress(p, np);
    if (p % 8 === 0) await new Promise(function (r) { setTimeout(r, 0); });
  }
  var text = rowsToText(pages, outlineMap);
  return { text: text, pages: np, headings: (text.match(/\u00A7H\d\u00A7/g) || []).length };
}

/* ---------- exports for tests ---------- */
var Engine = { buildDeck: buildDeck, parseSections: parseSections, rowsToText: rowsToText, splitSentences: splitSentences };
if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
root.CogniFlowEngine = Engine;

/* =====================================================================
   BROWSER INTEGRATION: overrides the old functions on the page
   ===================================================================== */
/* =====================================================================
   ANALYTICS + FAVICON (so index.html needs no other edits)
   - Defines the shared trackEvent() helper the page already calls
   - Records email-campaign arrivals (UTM source "newsletter") once per session
   - Adds the "C" favicon if the page has none
   Requires the standard Google tag (gtag.js) snippet to stay in <head>.
   ===================================================================== */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  var ATTR_KEY = 'cogniflow_email_campaign_attr';
  var readAttr = function () { try { var r = sessionStorage.getItem(ATTR_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } };
  var send = function () { if (typeof window.gtag === 'function') window.gtag.apply(null, arguments); };

  window.trackEvent = function (name, params) {
    var payload = Object.assign({}, params || {}), a = readAttr();
    if (a) payload.email_campaign = a.campaign;
    send('event', name, payload);
  };

  (function () {
    var q = new URLSearchParams(window.location.search);
    if (q.get('utm_source') !== 'newsletter') return;
    var attr = { campaign: q.get('utm_campaign') || '(not set)', content: q.get('utm_content') || '(not set)' }, seen = false;
    try { seen = !!sessionStorage.getItem(ATTR_KEY); sessionStorage.setItem(ATTR_KEY, JSON.stringify(attr)); } catch (e) {}
    if (seen) return; /* already counted this session (refresh-safe) */
    send('event', /_(pref|unsub)$/.test(attr.content) ? 'email_campaign_footer' : 'email_campaign_cta', { campaign: attr.campaign, content: attr.content });
    send('set', 'user_properties', { acquired_via_email_campaign: 'yes' });
  })();

  if (document.querySelector && !document.querySelector('link[rel~="icon"]')) {
    var fav = document.createElement('link');
    fav.rel = 'icon'; fav.type = 'image/svg+xml';
    fav.href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23050505'/%3E%3Ctext x='16' y='23' font-family='Arial,Helvetica,sans-serif' font-size='19' font-weight='900' text-anchor='middle' fill='%23FFFFFF'%3EC%3C/text%3E%3C/svg%3E";
    document.head.appendChild(fav);
  }
}

if (typeof document === 'undefined' || typeof window === 'undefined' || !document.getElementById('studioWidget')) return;

var st = document.createElement('style');
st.textContent = '.cf-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}' +
  '.cf-chip{font-size:.72rem;font-weight:700;color:var(--text-primary);background:var(--bg-muted);border:1px solid var(--border-widget);border-radius:999px;padding:3px 10px}';
document.head.appendChild(st);

fileInput.setAttribute('accept', '.pdf,.docx,.txt,.md');
var dropHint = dropArea.querySelector('p');
if (dropHint) dropHint.textContent = 'Scans headings & key ideas \u2014 .pdf, .docx, .txt, .md (no size cap)';

function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Could not load the .docx reader. Check your connection.')); };
    document.head.appendChild(s);
  });
}
async function extractDocx(file) {
  if (!window.mammoth) await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js');
  var res = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  var doc = new DOMParser().parseFromString(res.value, 'text/html'), out = [];
  Array.prototype.forEach.call(doc.body.children, function (el) {
    var tag = el.tagName.toLowerCase(), t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (/^h[1-6]$/.test(tag)) out.push('\u00A7H' + Math.min(4, +tag[1]) + '\u00A7 ' + t);
    else if (tag === 'ul' || tag === 'ol') {
      out.push(Array.prototype.map.call(el.querySelectorAll('li'), function (li) {
        var x = li.textContent.trim(); return /[.!?:;]$/.test(x) ? x : x + '.';
      }).join(' '));
    } else out.push(t);
  });
  return out.join('\n\n');
}

window.processIncomingFile = async function (file) {
  var name = file.name.toLowerCase();
  clearError();
  trackEvent('upload_document', { file_extension: name.split('.').pop() });
  try {
    if (/\.(txt|md)$/.test(name)) {
      setUploadedContent(file.name, await file.text());
    } else if (name.endsWith('.pdf')) {
      if (!window.pdfjsLib) throw new Error('The PDF reader did not load. Refresh the page and try again.');
      showLoadingNotification('Opening PDF\u2026');
      var pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      var res = await extractPdf(pdf, function (n, total) { showLoadingNotification('Scanning page ' + n + ' of ' + total + '\u2026'); });
      hideLoadingNotification();
      if (res.text.replace(/\s/g, '').length < 80) {
        showError('No selectable text found. This looks like a scanned PDF (images of pages), which needs OCR first.');
        trackEvent('pdf_read_error', { reason: 'empty_or_scanned' });
        return;
      }
      setUploadedContent(file.name + ' \u00B7 ' + res.pages + ' pages', res.text);
      showLoadingNotification('Scanned ' + res.pages + ' pages and found ' + res.headings + ' headings. Ready to convert.');
    } else if (name.endsWith('.docx')) {
      showLoadingNotification('Reading Word document\u2026');
      var txt = await extractDocx(file);
      hideLoadingNotification();
      if (txt.replace(/\s/g, '').length < 80) { showError('This document appears to be empty.'); return; }
      setUploadedContent(file.name, txt);
    } else {
      showError('Supported formats: .pdf, .docx, .txt, and .md documents.');
    }
  } catch (err) {
    hideLoadingNotification();
    showError('Could not read this file: ' + err.message);
    trackEvent('pdf_read_error', { error_message: String(err.message).slice(0, 100) });
  }
};

window.synthesizeVisualDeck = async function (rawText, promptFilter) {
  loadingView.style.display = 'flex';
  loadingMsgText.textContent = 'Reading structure and ranking key ideas\u2026';
  progressBar.style.width = '60%';
  await new Promise(function (r) { setTimeout(r, 40); });
  var deck;
  try { deck = buildDeck(rawText, promptFilter); }
  catch (e) {
    loadingView.style.display = 'none';
    showError('Something went wrong while analyzing this text: ' + e.message);
    placeholderView.style.display = 'block';
    return;
  }
  progressBar.style.width = '100%';
  loadingView.style.display = 'none';
  if (!deck.slides.length) {
    showError('Could not find enough readable sentences. Try a broader focus, or paste more text.');
    placeholderView.style.display = 'block';
    return;
  }
  visualSlides = deck.slides;
  currentSlideIndex = 0;
  renderOutputView();
  exportMenuBtn.disabled = false;
  if (deck.note) showLoadingNotification(deck.note);
  trackEvent('deck_generated', { slide_count: deck.slides.length, source_words: deck.stats.words });
};

function chips(slide) {
  return slide.keyTerms && slide.keyTerms.length
    ? '<div class="cf-chips">' + slide.keyTerms.map(function (t) { return '<span class="cf-chip">' + esc(t) + '</span>'; }).join('') + '</div>' : '';
}
window.renderSlide = function (index) {
  var slide = visualSlides[index];
  activeRenderContainer.innerHTML = '';
  var label = slide.kind === 'overview' ? 'OVERVIEW' : slide.kind === 'takeaways' ? 'SUMMARY' : esc(slide.conceptTag) + ' SCHEMATIC';
  var deck = document.createElement('div');
  deck.className = 'true-slide-deck';
  deck.innerHTML =
    '<div class="slide-visual-column"><span class="slide-tag">' + label + '</span>' +
    '<div class="slide-diagram-canvas">' + slide.diagramHtml + '</div>' +
    '<div class="diagram-label">' + esc(slide.diagramCaption) + '</div></div>' +
    '<div class="slide-content-column"><span class="slide-tag">SLIDE ' + (index + 1) + ' OF ' + visualSlides.length + '</span>' +
    '<h3>' + esc(slide.title) + '</h3><p class="slide-lead-concept">' + esc(slide.lead) + '</p>' +
    '<ul class="slide-bullets">' + slide.bullets.map(function (b) { return '<li>' + b + '</li>'; }).join('') + '</ul>' + chips(slide) + '</div>';
  activeRenderContainer.appendChild(deck);
  slideCounter.textContent = 'Slide ' + (index + 1) + ' / ' + visualSlides.length;
  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === visualSlides.length - 1;
  renderPageJumpDots();
};
window.renderNotesSheet = function () {
  var sheet = document.createElement('div');
  sheet.className = 'notes-sheet';
  sheet.innerHTML =
    '<div class="notes-header-block"><span class="slide-tag">CONSOLIDATED VISUAL NOTES</span><h2>Condensed Study Notes</h2>' +
    '<p style="color:var(--text-muted);font-size:.88rem;margin-top:4px;">' + visualSlides.length + ' sections, ranked by importance.</p></div>' +
    visualSlides.map(function (s) {
      return '<div class="notes-item"><span class="slide-tag">[' + esc(s.conceptTag) + ']</span><h4>' + s.slideNumber + '. ' + esc(s.title) + '</h4>' +
        '<p><strong>Core idea:</strong> ' + esc(s.lead) + '</p>' +
        '<ul style="margin-top:8px;padding-left:18px;font-size:.88rem;color:var(--text-secondary);">' +
        s.bullets.map(function (b) { return '<li style="margin-bottom:4px;">' + b + '</li>'; }).join('') + '</ul>' + chips(s) + '</div>';
    }).join('');
  activeRenderContainer.appendChild(sheet);
};

})(typeof window !== 'undefined' ? window : globalThis);