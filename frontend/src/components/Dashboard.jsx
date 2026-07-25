import React, { useState, useEffect } from 'react';
import html2pdf from 'html2pdf.js';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ExternalHyperlink } from 'docx';
import { triggerAgent, createCheckoutSession, analyzePaid, fetchPrices } from '../api/apiService';
import '../App.css'; // تأكد من وجود وتطابق مسار الـ CSS

const verdictColor = (confidence, verdict) => {
  const v = (verdict || '').toLowerCase();
  if (v.includes('unavailable') || v.includes('insufficient')) return 'var(--text-muted)';
  if (confidence >= 70) return '#10B981'; // Green
  if (confidence >= 40) return '#F59E0B'; // Orange
  return '#EF4444'; // Red
};

// ==========================================
// دوال التوليد والـ Export (نفسها الخاصة بك)
// ==========================================
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

// ==========================================
// المكون الأساسي
// ==========================================
const Dashboard = ({ history = [], addToHistory = () => {} }) => {
  const [inputText, setInputText] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [livePrices, setLivePrices] = useState({});
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [activeNav, setActiveNav] = useState('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  // الباقات الجديدة
  const tiers = [
    { id: 'quick', label: 'Quick', desc: '3 risks, 3 steps', icon: <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/> },
    { id: 'standard', label: 'Standard', desc: '5 risks, 5 steps', icon: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/> },
    { id: 'pro', label: 'Pro', desc: '8 risks, 8 steps', icon: <><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></> },
    { id: 'promax', label: 'Pro Max', desc: 'Full Depth', icon: <path d="M2 12l5.25 5 2.625-7.5L12.5 17 22 7l-7.5 11.5z"/> }
  ];
  
  const [activeTier, setActiveTier] = useState(tiers[1]); // Default Standard

  useEffect(() => { fetchPrices().then(setLivePrices).catch(() => setLivePrices({})); }, []);

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
      if (file.size > 15 * 1024 * 1024) { setError(`"${file.name}" > 15MB.`); continue; }
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(file);
      });
      newFiles.push({ name: file.name, type: file.type, data: base64 });
    }
    setAttachedFiles((prev) => [...prev, ...newFiles]);
  };

  const handleFileChange = async (e) => { await processFiles(e.target.files); e.target.value = ''; };
  const handleDragOver = (e) => { e.preventDefault(); setDragActive(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setDragActive(false); };
  const handleDrop = async (e) => { e.preventDefault(); setDragActive(false); await processFiles(e.dataTransfer.files); };
  const removeFile = (idx) => setAttachedFiles((prev) => prev.filter((_, i) => i !== idx));

  const handleFreeAnalysis = async () => {
    if (!inputText.trim() && !attachedFiles.length) return;
    setLoading(true); setError(null); setStatus('');
    try {
      const result = await triggerAgent(inputText, attachedFiles);
      setData(result);
      addToHistory({ ...result, query: inputText, id: Date.now(), tier: 'free' });
    } catch (err) { setError('Engine error. Please try again.'); } 
    finally { setLoading(false); }
  };

  const handlePaidAnalysis = async () => {
    if (!inputText.trim() && !attachedFiles.length) return;
    setStatus('Preparing checkout...');
    try {
      sessionStorage.setItem('pendingScan', JSON.stringify({ text: inputText, tier: activeTier.id, files: attachedFiles }));
      const res = await createCheckoutSession(activeTier.id, window.location.href);
      if (res.url) window.location.href = res.url;
      else setStatus(res.error || 'Checkout error.');
    } catch (err) { setStatus('Backend error.'); }
  };

  const scansRun = history.length;
  const scored = history.filter((h) => typeof h.confidence === 'number');
  const avgConfidence = scored.length ? Math.round(scored.reduce((s, h) => s + h.confidence, 0) / scored.length) : null;

  return (
    <div className="app-shell">

      {/* شريط علوي يظهر فقط عالموبايل، فيه زر فتح القائمة */}
      <div className="mobile-topbar">
        <button className="hamburger-btn" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="20"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <span className="brand-text-mobile">Verdict</span>
        <span style={{ width: 40 }} />
      </div>

      {/* طبقة سوداء خلف القائمة، تسكرها لما تنضغط */}
      <div className={`sidebar-backdrop ${mobileMenuOpen ? 'open' : ''}`} onClick={() => setMobileMenuOpen(false)} />

      {/* 1. القائمة الجانبية (الداكنة الفاخرة) */}
      <aside className={`sidebar ${mobileMenuOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <img src="/Verdict.png" alt="Verdict" className="sidebar-logo" />
          <div className="brand-text">
            <h1>Verdict</h1>
            <span>Evidence-based analysis</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/> },
            { id: 'logs', label: 'Analysis Logs', icon: <path d="M4 6h16M4 12h16M4 18h16"/> },
            { id: 'settings', label: 'Settings', icon: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c0 .72.5 1.35 1.2 1.51H21a2 2 0 110 4h-.09c-.7.16-1.2.79-1.2 1.51z"/></> }
          ].map(item => (
            <button key={item.id} className={`nav-item ${activeNav === item.id ? 'active' : ''}`} onClick={() => { setActiveNav(item.id); setMobileMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{item.icon}</svg>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="upgrade-card">
          <div className="upgrade-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
          <h4>Upgrade your plan</h4>
          <p>Unlock deeper analysis and advanced reports.</p>
          <button className="upgrade-btn">View Plans</button>
        </div>
      </aside>

      {/* 2. منطقة العمل الفاتحة */}
      <main className="main-area">
        <header className="top-header">
          <div className="header-titles">
            <h1>Analyze <span className="highlight">anything</span> before you <span className="highlight">decide</span></h1>
            <p>Get a verdict-backed by evidence, risks, and concrete next steps.</p>
          </div>
          <div className="user-dropdown">
            <div className="user-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
            Welcome back!
          </div>
        </header>

        <div className="metrics-hero-row">
          <div className="metrics-container">
            <div className="metric-card">
              <div className="m-icon m-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>
              <div className="m-info"><span className="label">Analyses run</span><span className="val">{scansRun}</span><span className="sub">Total this session</span></div>
            </div>
            <div className="metric-card">
              <div className="m-icon m-purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
              <div className="m-info"><span className="label">Average confidence</span><span className="val">{avgConfidence || '-'}</span><span className="sub">Not enough data yet</span></div>
            </div>
            <div className="metric-card">
              <div className="m-icon m-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/></svg></div>
              <div className="m-info"><span className="label">Current tier</span><span className="val" style={{color: 'var(--brand)'}}>{activeTier.label}</span><span className="sub">{activeTier.desc}</span></div>
            </div>
          </div>
          <div className="hero-graphic">
            <div className="orbit-ring"></div>
            <div className="center-shield"><img src="/Verdict.png" alt="Verdict Logo" /></div>
          </div>
        </div>

        <div className="main-grid">
          
          {/* العمود الأيسر: الإدخال */}
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>New analysis</div>
            </div>
            <p className="panel-desc">Ask a question, paste a claim, or attach a file — open-ended.</p>

            <span className="input-label">What do you want examined?</span>
            <textarea className="text-box" value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="e.g. Is this claim true?" />

            <span className="input-label">Or attach a file (PDF or image)</span>
            <div className={`upload-area ${dragActive ? 'drag-active' : ''}`} onClick={() => document.getElementById('fileInput').click()} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
              <div className="u-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg></div>
              <div className="upload-text"><strong>Click or drag files here</strong><span>PDF, JPG, PNG, TXT</span></div>
            </div>
            <input id="fileInput" type="file" accept=".pdf,.txt,image/png,image/jpeg,image/webp" multiple style={{ display: 'none' }} onChange={handleFileChange} />
            
            {attachedFiles.length > 0 && (
              <div className="file-list">
                {attachedFiles.map((f, i) => (
                  <div className="file-chip" key={i}><span>{f.name}</span><button onClick={() => removeFile(i)}>×</button></div>
                ))}
              </div>
            )}

            <span className="input-label">Analysis depth (for reports)</span>
            <div className="depth-grid">
              {tiers.slice(0,3).map(t => (
                <div key={t.id} className={`depth-card ${activeTier.id === t.id ? 'active' : ''}`} onClick={() => setActiveTier(t)}>
                  <svg className="d-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{t.icon}</svg>
                  <span className="d-title">{t.label}</span>
                  <span className="d-price">{formatPrice(t.id)}</span>
                  <span className="d-desc">{t.desc}</span>
                </div>
              ))}
              <div className={`depth-card depth-full ${activeTier.id === 'promax' ? 'active' : ''}`} onClick={() => setActiveTier(tiers[3])}>
                <svg className="d-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16">{tiers[3].icon}</svg>
                <div><span className="d-title">Pro Max </span><span className="d-price">{formatPrice('promax')} | Full Depth</span></div>
              </div>
            </div>

            <button className="btn-primary" onClick={handleFreeAnalysis} disabled={loading}>{loading ? 'Working...' : 'Ask / Run Free Preview'}</button>
            <button className="btn-secondary" onClick={handlePaidAnalysis} disabled={loading}>Pay & Run Full Report via Stripe</button>
            {error && <p style={{color: 'var(--danger)', fontSize: '0.8rem', marginTop: '10px'}}>{error}</p>}
            {status && <p style={{color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '10px'}}>{status}</p>}
          </div>

          {/* العمود الأيمن: النتائج */}
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Report</div>
            </div>

            {!data ? (
              <div className="empty-state">
                <svg className="empty-graphic" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 60C20 48.9543 28.9543 40 40 40H75.5528C81.6565 40 87.4116 42.7937 91.2111 47.5435L98.7889 56.9565C102.588 61.7063 108.343 64.5 114.447 64.5H160C171.046 64.5 180 73.4543 180 84.5V140C180 151.046 171.046 160 160 160H40C28.9543 160 20 151.046 20 140V60Z" fill="url(#paint0_linear)" opacity="0.15"/><path d="M30 75C30 63.9543 38.9543 55 50 55H80.5528C86.6565 55 92.4116 57.7937 96.2111 62.5435L103.789 71.9565C107.588 76.7063 113.343 79.5 119.447 79.5H170C181.046 79.5 190 88.4543 190 99.5V155C190 166.046 181.046 175 170 175H50C38.9543 175 30 166.046 30 155V75Z" fill="#A7F3D0"/><defs><linearGradient id="paint0_linear" x1="100" y1="40" x2="100" y2="160" gradientUnits="userSpaceOnUse"><stop stopColor="#00D4A0"/><stop offset="1" stopColor="#00A87F"/></linearGradient></defs></svg>
                <h3>No analyses yet</h3>
                <p>Your analyses will appear here.</p>
              </div>
            ) : (
              <div className="report-content">
                {data.mode === 'answer' ? (
                  <>
                    <div className="report-section" style={{ borderColor: '#A7F3D0', backgroundColor: '#ECFDF5' }}>
                      <h4 style={{ color: '#10B981' }}>Answer</h4>
                      <p className="summary" style={{ marginTop: 6 }}>{data.answer}</p>
                    </div>
                    {data.sources && data.sources.length > 0 && (
                      <div className="report-section">
                        <h4>Sources</h4>
                        <ul>
                          {data.sources.map((s, i) => (
                            <li key={i}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="verdict-row">
                      <div className="stamp" style={{ borderColor: verdictColor(data.confidence, data.verdict) }}>
                        <span className="num" style={{ color: verdictColor(data.confidence, data.verdict) }}>{data.confidence ?? '-'}</span>
                        <span className="of">conf</span>
                      </div>
                      <div>
                        <p className="verdict-text" style={{ color: verdictColor(data.confidence, data.verdict) }}>{data.verdict}</p>
                        {data.explanation && <p className="summary">{data.explanation}</p>}
                      </div>
                    </div>

                    {data.evidence && data.evidence.length > 0 && (
                      <div className="report-section" style={{ borderColor: '#A7F3D0', backgroundColor: '#ECFDF5' }}>
                        <h4 style={{ color: '#10B981' }}>✓ Evidence</h4>
                        <ul>{data.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
                      </div>
                    )}
                    {data.risks && data.risks.length > 0 && (
                      <div className="report-section" style={{ borderColor: '#FECACA', backgroundColor: '#FEF2F2' }}>
                        <h4 style={{ color: '#EF4444' }}>! Risks</h4>
                        <ul>{data.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
                      </div>
                    )}
                    {data.next_steps && data.next_steps.length > 0 && (
                      <div className="report-section" style={{ borderColor: '#BFDBFE', backgroundColor: '#EFF6FF' }}>
                        <h4 style={{ color: '#3B82F6' }}>→ Next Steps</h4>
                        <ul>{data.next_steps.map((n, i) => <li key={i}>{n}</li>)}</ul>
                      </div>
                    )}
                    {data.sources && data.sources.length > 0 && (
                      <div className="report-section">
                        <h4>Sources</h4>
                        <ul>
                          {data.sources.map((s, i) => (
                            <li key={i}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}

                <div className="report-actions">
                  <button className="btn-secondary" onClick={() => downloadPdf(data, inputText)}>Download PDF</button>
                  <button className="btn-secondary" onClick={() => downloadWord(data, inputText)}>Download Word</button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="features-row">
          <div className="feature-card">
            <div className="f-icon m-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg></div>
            <div className="f-text"><h4>Evidence First</h4><p>We prioritize verifiable evidence over opinions.</p></div>
          </div>
          <div className="feature-card">
            <div className="f-icon m-purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
            <div className="f-text"><h4>Risk Aware</h4><p>Identify potential risks before you act.</p></div>
          </div>
          <div className="feature-card">
            <div className="f-icon m-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></div>
            <div className="f-text"><h4>Clear Steps</h4><p>Get concrete next steps you can actually take.</p></div>
          </div>
          <div className="feature-card">
            <div className="f-icon m-purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
            <div className="f-text"><h4>Secure & Private</h4><p>Your data is encrypted and never shared.</p></div>
          </div>
        </div>

      </main>
    </div>
  );
};

export default Dashboard;
