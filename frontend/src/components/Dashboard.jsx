import React, { useState, useEffect } from 'react';
import html2pdf from 'html2pdf.js';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ExternalHyperlink,
} from 'docx';
import { triggerAgent, createCheckoutSession, analyzePaid, fetchPrices } from '../api/apiService';

const verdictColor = (confidence, verdict) => {
  const v = (verdict || '').toLowerCase();
  if (v.includes('unavailable') || v.includes('insufficient')) return 'var(--text-muted)';
  if (confidence >= 70) return 'var(--success)';
  if (confidence >= 40) return 'var(--accent-dark)';
  return 'var(--danger)';
};

const tiers = [
  { id: 'quick', label: 'Quick', desc: '3 evidence, 3 risks, 3 steps' },
  { id: 'standard', label: 'Standard', desc: '5 evidence, 5 risks, 5 steps' },
  { id: 'pro', label: 'Pro', desc: '8 evidence, 8 risks, 8 steps' },
  { id: 'promax', label: 'Pro Max', desc: 'Full Depth' },
];

// Decode any existing HTML entities (e.g. text that already went through an
// HTML-escaping step upstream), then re-escape it safely for embedding in an
// HTML string. Works for ANY language/script since it only touches &, <, >, " '
// and never assumes a particular alphabet or byte width.
const decodeEntities = (text) => {
  if (!text) return '';
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
};

const escapeHtml = (text) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const prepareText = (text) => escapeHtml(decodeEntities(text || ''));

// Builds the report body as real HTML. `dir="auto"` lets the browser apply the
// Unicode bidi algorithm per element, so Arabic/Hebrew/English/anything else
// gets correct direction and shaping automatically - no manual font/RTL work.
// Each block below is explicit display:block + clear:both + its own bottom
// margin, so blocks can never visually overlap regardless of RTL/LTR content
// mixing inside them.
// Hardcoded hex colors (not CSS var()) - the export renders in an isolated
// overlay outside the app's normal styling context, and some browsers report
// custom-property colors in formats html2canvas can't parse, so plain hex is
// the safe choice here.
const badgeColors = (confidence, verdict) => {
  const v = (verdict || '').toLowerCase();
  if (v.includes('unavailable') || v.includes('insufficient')) return { bg: '#6b7280', fg: '#ffffff' };
  if (confidence >= 70) return { bg: '#16a34a', fg: '#ffffff' };
  if (confidence >= 40) return { bg: '#d97706', fg: '#ffffff' };
  return { bg: '#dc2626', fg: '#ffffff' };
};

const TITLE_ACCENT = '#4338ca';
const HEADING_STYLE =
  `display:block;font-size:14px;font-weight:700;margin:22px 0 10px;` +
  `padding-bottom:5px;border-bottom:2px solid ${TITLE_ACCENT};color:#1e1b4b;`;
const PARA_STYLE = 'display:block;margin:0 0 14px;';

// dir="auto" only reorders bidi runs - it doesn't reliably force text-align,
// so a right-to-left bullet marker could still end up paired with left-
// aligned text. Detecting the script ourselves and setting dir + text-align
// explicitly keeps the marker and the text on the same side every time.
const RTL_REGEX = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const dirAttrs = (text) => {
  const rtl = RTL_REGEX.test(text || '');
  return { dir: rtl ? 'rtl' : 'ltr', align: rtl ? 'right' : 'left' };
};

// Fixed UI labels (headings, title) aren't run through per-string detection -
// they're app text, not user content - so they need their own translation and
// their own overall direction, based on the report's dominant language rather
// than any single string.
const LABELS = {
  ar: {
    title: 'تقرير الحكم',
    query: 'السؤال:',
    answer: 'الإجابة',
    explanation: 'الشرح',
    evidence: 'الأدلة',
    risks: 'المخاطر',
    nextSteps: 'الخطوات التالية',
    sources: 'المصادر',
  },
  en: {
    title: 'Verdict Report',
    query: 'Query:',
    answer: 'Answer',
    explanation: 'Explanation',
    evidence: 'Evidence',
    risks: 'Risks',
    nextSteps: 'Next steps',
    sources: 'Sources',
  },
};

// Majority-vote across the report's own content decides the overall language/
// direction used for the fixed labels and page-level mirroring (title,
// accent bar, heading alignment) - not just the query alone, in case the
// query is short/ambiguous but the answer body is clearly one script.
const reportLang = (report, queryText) => {
  const sample = [
    queryText,
    report.answer,
    report.verdict,
    report.explanation,
    ...(report.evidence || []),
    ...(report.risks || []),
    ...(report.next_steps || []),
  ]
    .filter(Boolean)
    .join(' ');
  return RTL_REGEX.test(sample) ? 'ar' : 'en';
};

const buildReportHtml = (report, queryText) => {
  const lang = reportLang(report, queryText);
  const L = LABELS[lang];
  const rtl = lang === 'ar';
  const pageDir = rtl ? 'rtl' : 'ltr';
  const pageAlign = rtl ? 'right' : 'left';

  let html = `<h1 dir="${pageDir}" style="display:block;text-align:${pageAlign};font-size:22px;font-weight:800;margin:0 0 4px;color:#1e1b4b;">${L.title}</h1>`;
  html +=
    `<div style="display:flex;justify-content:${rtl ? 'flex-end' : 'flex-start'};margin:0 0 20px;">` +
    `<div style="height:3px;width:56px;background:${TITLE_ACCENT};"></div></div>`;

  const q = dirAttrs(queryText);
  html +=
    `<div dir="${q.dir}" style="display:block;text-align:${q.align};background:#f4f4f8;border-inline-start:4px solid ${TITLE_ACCENT};` +
    `padding:10px 14px;margin:0 0 20px;border-radius:4px;"><b>${L.query}</b> ${prepareText(queryText)}</div>`;

  // Section headings follow the overall report language/direction, not each
  // individual body string, since the heading text itself is fixed app copy.
  const heading = (text) =>
    `<h2 dir="${pageDir}" style="${HEADING_STYLE}text-align:${pageAlign};">${text}</h2>`;

  // Built by hand instead of native <ul>/list-style bullets: html2canvas
  // doesn't reliably reposition list markers for RTL direction, so a real
  // browser would show the dot on the correct side but the rendered PDF
  // wouldn't. A flex row (reversed for RTL) gives full manual control over
  // which side the dot sits on regardless of html2canvas's list support.
  const bulletRow = (contentHtml, itemRtl) =>
    `<div style="display:flex;flex-direction:${itemRtl ? 'row-reverse' : 'row'};align-items:flex-start;gap:8px;margin:0 0 10px;">` +
    `<span style="flex:0 0 auto;width:6px;height:6px;margin-top:7px;border-radius:50%;background:${TITLE_ACCENT};"></span>` +
    `<div style="flex:1 1 auto;min-width:0;">${contentHtml}</div>` +
    `</div>`;

  if (report.mode === 'answer') {
    html += heading(L.answer);
    const a = dirAttrs(report.answer);
    html += `<p dir="${a.dir}" style="${PARA_STYLE}text-align:${a.align};">${prepareText(report.answer)}</p>`;
  } else {
    const { bg, fg } = badgeColors(report.confidence, report.verdict);
    const v = dirAttrs(report.verdict);
    html +=
      `<div dir="${v.dir}" style="display:inline-block;padding:7px 16px;border-radius:6px;` +
      `font-weight:700;background:${bg};color:${fg};margin:0 0 16px;">` +
      `${prepareText(report.verdict)} \u2014 ${report.confidence}%</div>`;

    if (report.explanation) {
      html += heading(L.explanation);
      const e = dirAttrs(report.explanation);
      html += `<p dir="${e.dir}" style="${PARA_STYLE}text-align:${e.align};">${prepareText(report.explanation)}</p>`;
    }

    const section = (title, items) => {
      if (!items || !items.length) return '';
      const rows = items
        .map((i) => {
          const d = dirAttrs(i);
          const text = `<span dir="${d.dir}" style="display:block;text-align:${d.align};">${prepareText(i)}</span>`;
          return bulletRow(text, rtl);
        })
        .join('');
      return `${heading(title)}<div style="margin:0 0 14px;">${rows}</div>`;
    };

    html += section(L.evidence, report.evidence);
    html += section(L.risks, report.risks);
    html += section(L.nextSteps, report.next_steps);
  }

  if (report.sources && report.sources.length) {
    const rows = report.sources
      .map((s) => {
        const t = dirAttrs(s.title);
        const content =
          `<div dir="${t.dir}" style="text-align:${t.align};"><a href="${s.url}" style="color:${TITLE_ACCENT};text-decoration:underline;">${prepareText(
            s.title
          )}</a></div>` +
          // Force dir="ltr" on the URL itself: URLs are always left-to-right,
          // and keeping it in its own block (not sharing a bidi run with the
          // Arabic title) stops the browser from visually interleaving the
          // two scripts on one row.
          `<div dir="ltr" style="text-align:left;font-size:11px;color:#6b7280;margin-top:2px;">${s.url}</div>`;
        return bulletRow(content, rtl);
      })
      .join('');
    html += `${heading(L.sources)}<div style="margin:0 0 14px;">${rows}</div>`;
  }

  return html;
};

// Web fonts loaded in index.html (Noto Sans family) come first so Chinese,
// Hindi, and Arabic glyphs are guaranteed regardless of the user's OS.
// System fonts stay as a fallback for the rare case fonts.googleapis.com is
// unreachable (offline/blocked network).
const REPORT_FONT_STACK =
  '"Noto Sans","Noto Naskh Arabic","Noto Sans SC","Noto Sans Devanagari",' +
  '"Segoe UI",Tahoma,Arial,system-ui,sans-serif';

// Renders the report to an off-screen HTML element and lets html2pdf.js
// (html2canvas + jsPDF under the hood) rasterize exactly what the browser
// draws. Since the browser itself does the text shaping, this supports
// Arabic, Hebrew, CJK, or anything else without extra font embedding.
const downloadPdf = (report, queryText) => {
  // html2canvas renders the whole page and crops to the target element's
  // on-screen rect - so if anything else in the page visually occupies that
  // same rect on top of it (sidebar, page background, etc.), html2canvas can
  // capture THAT instead of our content, producing a blank/wrong result.
  // A full-viewport, max-z-index overlay guarantees nothing else can ever be
  // stacked above it, so the capture always matches our content exactly.
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:#fff;overflow:auto;';

  const container = document.createElement('div');
  container.style.cssText =
    `max-width:700px;margin:0 auto;padding:24px;` +
    `font-family:${REPORT_FONT_STACK};font-size:13px;line-height:1.7;color:#111;background:#fff;`;
  container.innerHTML = buildReportHtml(report, queryText);

  overlay.appendChild(container);
  document.body.appendChild(overlay);

  const cleanup = () => {
    // Wait an extra beat before removing the node: some html2pdf.js/jsPDF
    // versions resolve save()'s promise slightly before the browser has
    // actually finished the html2canvas capture, and removing the source
    // element too early makes the capture come out blank.
    setTimeout(() => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 1500);
  };

  const runExport = () => {
    html2pdf()
      .set({
        margin: 12,
        filename: 'verdict-report.pdf',
        html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
        jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' },
      })
      .from(container)
      .save()
      .then(cleanup)
      .catch((err) => {
        console.error('PDF export failed:', err);
        cleanup();
      });
  };

  // Make sure the Noto web fonts (Arabic/Chinese/Devanagari) are fully loaded
  // before capturing - otherwise the browser may still be showing fallback
  // glyphs (or blank tofu boxes) the instant html2canvas takes its snapshot.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(runExport).catch(runExport);
  } else {
    runExport();
  }
};

// Detects Arabic/Hebrew (RTL script) text so each paragraph can get correct
// right-to-left layout in Word - Word shapes the Arabic glyphs itself, but
// paragraph direction/alignment still needs to be set explicitly per-paragraph
// since content can mix RTL and LTR text in the same report.
const isRTL = (text) => RTL_REGEX.test(text || '');

const rtlParagraphProps = (text) => ({
  bidirectional: isRTL(text),
  alignment: isRTL(text) ? AlignmentType.RIGHT : AlignmentType.LEFT,
});

const textParagraph = (text) =>
  new Paragraph({
    ...rtlParagraphProps(text),
    spacing: { after: 200 },
    children: [new TextRun({ text: text || '' })],
  });

const headingParagraph = (title, rtl) =>
  new Paragraph({
    bidirectional: rtl,
    alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text: title, bold: true, color: '4338CA' })],
  });

const bulletParagraph = (text) =>
  new Paragraph({
    ...rtlParagraphProps(text),
    bullet: { level: 0 },
    spacing: { after: 120 },
    children: [new TextRun({ text: text || '' })],
  });

const buildReportDocChildren = (report, queryText) => {
  const lang = reportLang(report, queryText);
  const L = LABELS[lang];
  const rtl = lang === 'ar';

  const children = [
    new Paragraph({
      bidirectional: rtl,
      alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
      children: [new TextRun({ text: L.title, bold: true, color: '1E1B4B' })],
    }),
    new Paragraph({
      ...rtlParagraphProps(queryText),
      spacing: { after: 300 },
      children: [
        new TextRun({ text: `${L.query} `, bold: true }),
        new TextRun({ text: queryText || '' }),
      ],
    }),
  ];

  if (report.mode === 'answer') {
    children.push(headingParagraph(L.answer, rtl));
    children.push(textParagraph(report.answer));
  } else {
    children.push(
      new Paragraph({
        ...rtlParagraphProps(report.verdict),
        spacing: { after: 200 },
        children: [
          new TextRun({ text: `${report.verdict || ''} \u2014 ${report.confidence}%`, bold: true, color: '16A34A' }),
        ],
      })
    );

    if (report.explanation) {
      children.push(headingParagraph(L.explanation, rtl));
      children.push(textParagraph(report.explanation));
    }

    const section = (title, items) => {
      if (!items || !items.length) return;
      children.push(headingParagraph(title, rtl));
      items.forEach((i) => children.push(bulletParagraph(i)));
    };

    section(L.evidence, report.evidence);
    section(L.risks, report.risks);
    section(L.nextSteps, report.next_steps);
  }

  if (report.sources && report.sources.length) {
    children.push(headingParagraph(L.sources, rtl));
    report.sources.forEach((s) => {
      children.push(
        new Paragraph({
          ...rtlParagraphProps(s.title),
          bullet: { level: 0 },
          spacing: { after: 40 },
          children: [
            new ExternalHyperlink({
              link: s.url,
              children: [new TextRun({ text: s.title || s.url, style: 'Hyperlink' })],
            }),
          ],
        })
      );
      children.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 160 },
          children: [new TextRun({ text: s.url, color: '6B7280', size: 18 })],
        })
      );
    });
  }

  return children;
};

const downloadWord = (report, queryText) => {
  // Builds a real .docx directly via the docx package - no HTML-to-Word
  // conversion step, so it works in Word, WordPad, LibreOffice, Google Docs,
  // and it's ESM-friendly (unlike html-docx-js, which breaks Vite's build).
  const doc = new Document({
    sections: [{ properties: {}, children: buildReportDocChildren(report, queryText) }],
  });

  Packer.toBlob(doc).then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'verdict-report.docx';
    a.click();
    URL.revokeObjectURL(url);
  });
};

const Dashboard = ({ history, addToHistory }) => {
  const [inputText, setInputText] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeTier, setActiveTier] = useState(tiers[1]);
  const [status, setStatus] = useState('');
  const [livePrices, setLivePrices] = useState({});
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    fetchPrices().then(setLivePrices).catch(() => setLivePrices({}));
  }, []);

  const formatPrice = (tierId) => {
    const p = livePrices[tierId];
    if (!p) return '...';
    if (p.error) return 'N/A';
    return `${p.currency} ${p.amount.toFixed(2)}`;
  };

  const processFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    const newFiles = [];
    for (const file of files) {
      if (file.size > 15 * 1024 * 1024) {
        setError(`"${file.name}" is larger than the 15MB limit.`);
        continue;
      }
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
      });
      newFiles.push({ name: file.name, type: file.type, data: base64 });
    }
    setAttachedFiles((prev) => [...prev, ...newFiles]);
  };

  const handleFileChange = async (e) => {
    await processFiles(e.target.files);
    e.target.value = '';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragActive(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragActive(false);
    await processFiles(e.dataTransfer.files);
  };

  const removeFile = (idx) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleFreeAnalysis = async () => {
    if (!inputText.trim() && !attachedFiles.length) return;
    setLoading(true);
    setError(null);
    setStatus('');
    try {
      const result = await triggerAgent(inputText, attachedFiles);
      setData(result);
      addToHistory({
        ...result,
        query: inputText || '(file only)',
        id: Date.now(),
        tier: result.mode === 'answer' ? 'answer (free)' : 'preview (free)',
      });
    } catch (err) {
      setError('Failed to reach the analysis engine. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handlePaidAnalysis = async () => {
    if (!inputText.trim() && !attachedFiles.length) return;
    setError(null);
    setStatus('Preparing checkout...');
    try {
      sessionStorage.setItem(
        'pendingScan',
        JSON.stringify({ text: inputText, tier: activeTier.id, files: attachedFiles })
      );
      const origin = window.location.origin + window.location.pathname;
      const res = await createCheckoutSession(activeTier.id, origin);
      if (res.url) {
        window.location.href = res.url;
      } else {
        setStatus(res.error || 'Could not create a checkout session.');
      }
    } catch (err) {
      setStatus('Could not reach the backend.');
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('canceled')) {
      setStatus('Payment canceled. You can try again.');
      return;
    }
    if (params.get('paid') && params.get('session_id')) {
      const sessionId = params.get('session_id');
      const pending = sessionStorage.getItem('pendingScan');
      if (!pending) {
        setStatus('Payment confirmed, but the original request was lost. Please submit it again.');
        return;
      }
      const { text, tier, files } = JSON.parse(pending);
      setStatus('Payment confirmed, running analysis...');
      setLoading(true);
      analyzePaid(sessionId, text, tier, files)
        .then((result) => {
          if (result.error) {
            setStatus(result.error);
            return;
          }
          setData(result);
          addToHistory({ ...result, query: text || '(file only)', id: Date.now(), tier });
          setStatus('');
          sessionStorage.removeItem('pendingScan');
        })
        .catch(() => setStatus('Something went wrong running the paid analysis.'))
        .finally(() => setLoading(false));
    }
  }, []);

  const scansRun = history.length;
  const scored = history.filter((h) => typeof h.confidence === 'number');
  const avgConfidence = scored.length
    ? Math.round(scored.reduce((s, h) => s + h.confidence, 0) / scored.length)
    : null;

  return (
    <>
      <div className="metrics">
        <div className="metric">
          <p className="label">Analyses run</p>
          <p className="value">{scansRun}</p>
        </div>
        <div className="metric">
          <p className="label">Average confidence</p>
          <p className="value">{avgConfidence !== null ? avgConfidence + '%' : '-'}</p>
        </div>
        <div className="metric">
          <p className="label">Current tier</p>
          <p className="value" style={{ fontSize: 16 }}>{activeTier.label}</p>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>New analysis</h2>
          <span className="sub">Ask a question, paste a claim, or attach a file - open-ended.</span>

          <label htmlFor="inputText">What do you want examined?</label>
          <textarea
            id="inputText"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="e.g. What's the current price of gold? Should I invest in this offer? Is this claim true?"
          />

          <label>Or attach a file (PDF or image)</label>
          <div
            className="upload-box"
            style={dragActive ? { borderColor: 'var(--accent)', background: 'var(--accent-bg)' } : undefined}
            onClick={() => document.getElementById('fileInput').click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <p>Click or drag files here <span className="link">(PDF, JPG, PNG, TXT)</span></p>
          </div>
          <input
            id="fileInput"
            type="file"
            accept=".pdf,.txt,image/png,image/jpeg,image/webp"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          {attachedFiles.length > 0 && (
            <div className="file-list">
              {attachedFiles.map((f, i) => (
                <div className="file-chip" key={i}>
                  <span>{f.name}</span>
                  <button onClick={() => removeFile(i)}>x</button>
                </div>
              ))}
            </div>
          )}

          <label>Analysis depth (for reports)</label>
          <div className="depth-row">
            {tiers.map((t) => (
              <div
                key={t.id}
                className={'depth' + (activeTier.id === t.id ? ' active' : '')}
                onClick={() => setActiveTier(t)}
              >
                <div className="name">{t.label}</div>
                <div className="desc">{formatPrice(t.id)} | {t.desc}</div>
              </div>
            ))}
          </div>

          <button className="run" onClick={handleFreeAnalysis} disabled={loading}>
            {loading ? 'Working...' : 'Ask / run free preview'}
          </button>
          <button className="pay" onClick={handlePaidAnalysis} disabled={loading}>
            Pay &amp; run full report via Stripe
          </button>

          {error && <p className="status-error">{error}</p>}
          {status && <p className="status-note">{status}</p>}
        </div>

        <div>
          <div className="card">
            <h2>Report</h2>
            <span className="sub">Your latest analysis appears here.</span>

            {!data ? (
              <div className="empty-report">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
                <p>Ask a question or run an analysis to see results here.</p>
              </div>
            ) : data.mode === 'answer' ? (
              <div>
                <p className="verdict-text" style={{ color: 'var(--ink)' }}>Direct answer</p>
                <p className="summary">{data.answer}</p>

                {data.sources && data.sources.length > 0 && (
                  <div className="recommendation" style={{ marginTop: 14 }}>
                    <b>Sources:</b>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {data.sources.map((s, i) => (
                        <li key={i}>
                          <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <button className="pay" style={{ marginTop: 4 }} onClick={() => downloadPdf(data, inputText)}>
                  Download answer (PDF)
                </button>
                <button className="pay" style={{ marginTop: 8 }} onClick={() => downloadWord(data, inputText)}>
                  Download answer (Word)
                </button>
              </div>
            ) : (
              <div>
                {data.free_sample && (
                  <div className="recommendation" style={{ background: 'var(--accent-bg)', borderStyle: 'solid', borderColor: 'var(--accent)' }}>
                    {data.upsell}
                  </div>
                )}
                <div className="verdict-row">
                  <div className="stamp" style={{ borderColor: verdictColor(data.confidence, data.verdict) }}>
                    <span className="num" style={{ color: verdictColor(data.confidence, data.verdict) }}>
                      {data.confidence}
                    </span>
                    <span className="of">confidence</span>
                  </div>
                  <div>
                    <p className="verdict-text" style={{ color: verdictColor(data.confidence, data.verdict) }}>
                      {data.verdict}
                    </p>
                    {data.explanation && <p className="summary">{data.explanation}</p>}
                  </div>
                </div>

                {data.evidence && data.evidence.length > 0 && (
                  <div className="col opp" style={{ marginBottom: 12 }}>
                    <h3 style={{ color: 'var(--success)' }}>Evidence</h3>
                    <ul style={{ color: '#1F4F38' }}>
                      {data.evidence.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}

                {data.risks && data.risks.length > 0 && (
                  <div className="col risk" style={{ marginBottom: 12 }}>
                    <h3>Risks</h3>
                    <ul>
                      {data.risks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}

                {data.next_steps && data.next_steps.length > 0 && (
                  <div className="recommendation">
                    <b>Next steps:</b>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {data.next_steps.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}

                {data.sources && data.sources.length > 0 && (
                  <div className="recommendation">
                    <b>Sources:</b>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {data.sources.map((s, i) => (
                        <li key={i}>
                          <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {data.free_sample && (
                  <button className="run" style={{ marginBottom: 8 }} onClick={handlePaidAnalysis} disabled={loading}>
                    Unlock more evidence, risks & steps via Stripe
                  </button>
                )}

                <button className="pay" style={{ marginTop: 4 }} onClick={() => downloadPdf(data, inputText)}>
                  Download report (PDF)
                </button>
                <button className="pay" style={{ marginTop: 8 }} onClick={() => downloadWord(data, inputText)}>
                  Download report (Word)
                </button>

                <span className="disclaimer" style={{ display: 'block', marginTop: 14 }}>
                  This is an AI-generated read based only on what you submitted. It is not
                  financial, legal, or professional advice - verify independently before acting.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default Dashboard;
