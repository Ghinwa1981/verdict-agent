import React, { useState, useEffect } from 'react';
import html2pdf from 'html2pdf.js';
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
const buildReportHtml = (report, queryText) => {
  let html = '<h1 style="font-size:20px;margin:0 0 14px;">Verdict Report</h1>';
  html += `<p dir="auto"><b>Query:</b> ${prepareText(queryText)}</p>`;

  if (report.mode === 'answer') {
    html += '<h2 style="font-size:15px;margin:16px 0 6px;">Answer</h2>';
    html += `<p dir="auto">${prepareText(report.answer)}</p>`;
  } else {
    html += `<p dir="auto"><b>Verdict:</b> ${prepareText(report.verdict)} (${report.confidence}% confidence)</p>`;

    if (report.explanation) {
      html += '<h2 style="font-size:15px;margin:16px 0 6px;">Explanation</h2>';
      html += `<p dir="auto">${prepareText(report.explanation)}</p>`;
    }

    const section = (title, items) => {
      if (!items || !items.length) return '';
      const lis = items.map((i) => `<li dir="auto">${prepareText(i)}</li>`).join('');
      return `<h2 style="font-size:15px;margin:16px 0 6px;">${title}</h2><ul style="margin:0;padding-inline-start:20px;">${lis}</ul>`;
    };

    html += section('Evidence', report.evidence);
    html += section('Risks', report.risks);
    html += section('Next steps', report.next_steps);
  }

  if (report.sources && report.sources.length) {
    const lis = report.sources
      .map((s) => `<li dir="auto"><a href="${s.url}">${prepareText(s.title)}</a> - ${s.url}</li>`)
      .join('');
    html += `<h2 style="font-size:15px;margin:16px 0 6px;">Sources</h2><ul style="margin:0;padding-inline-start:20px;">${lis}</ul>`;
  }

  return html;
};

// Font stack covers Latin, Arabic, and most other scripts via common
// OS fonts (Segoe UI / Tahoma on Windows, system-ui elsewhere).
const REPORT_FONT_STACK =
  '"Segoe UI","Noto Naskh Arabic","Noto Sans Arabic",Tahoma,Arial,system-ui,sans-serif';

// Renders the report to an off-screen HTML element and lets html2pdf.js
// (html2canvas + jsPDF under the hood) rasterize exactly what the browser
// draws. Since the browser itself does the text shaping, this supports
// Arabic, Hebrew, CJK, or anything else without extra font embedding.
const downloadPdf = (report, queryText) => {
  // Keep the node in normal document flow (top:0/left:0) instead of pushing it
  // off-screen with a negative offset - html2canvas can miscalculate the
  // capture rect for off-screen/scrolled content and produce a blank canvas.
  // A very negative z-index keeps it invisible to the user (tucked behind the
  // real page) without moving it out of the renderable viewport.
  const container = document.createElement('div');
  container.style.cssText =
    `position:absolute;top:0;left:0;width:700px;padding:24px;z-index:-1000;` +
    `font-family:${REPORT_FONT_STACK};font-size:13px;line-height:1.7;color:#111;background:#fff;`;
  container.innerHTML = buildReportHtml(report, queryText);
  document.body.insertBefore(container, document.body.firstChild);

  html2pdf()
    .set({
      margin: 12,
      filename: 'verdict-report.pdf',
      html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' },
    })
    .from(container)
    .save()
    .finally(() => document.body.removeChild(container));
};

const downloadWord = (report, queryText) => {
  const bodyHtml = buildReportHtml(report, queryText);
  const html =
    `<html dir="auto"><head><meta charset="utf-8"></head>` +
    `<body style="font-family:${REPORT_FONT_STACK};">${bodyHtml}</body></html>`;

  const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'verdict-report.doc';
  a.click();
  URL.revokeObjectURL(url);
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
