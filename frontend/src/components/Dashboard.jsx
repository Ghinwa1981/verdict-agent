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
const decodeEntities = (text) => {
  if (!text) return '';
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
};

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const prepareText = (text) => escapeHtml(decodeEntities(text || ''));

const badgeColors = (confidence, verdict) => {
  const v = (verdict || '').toLowerCase();
  if (v.includes('unavailable') || v.includes('insufficient')) return { bg: '#6b7280', fg: '#ffffff' };
  if (confidence >= 70) return { bg: '#16a34a', fg: '#ffffff' };
  if (confidence >= 40) return { bg: '#d97706', fg: '#ffffff' };
  return { bg: '#dc2626', fg: '#ffffff' };
};

const RTL_REGEX = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const dirAttrs = (text) => {
  const rtl = RTL_REGEX.test(text || '');
  return { dir: rtl ? 'rtl' : 'ltr', align: rtl ? 'right' : 'left' };
};

const reportLang = (report, queryText) => {
  const sample = [queryText, report.answer, report.verdict, report.explanation, ...(report.evidence || []), ...(report.risks || []), ...(report.next_steps || [])].filter(Boolean).join(' ');
  return RTL_REGEX.test(sample) ? 'ar' : 'en';
};

const buildReportHtml = (report, queryText) => {
  // المبسط للـ PDF (كما هو في كودك)
  let html = `<h1 style="font-family:sans-serif;color:#1e1b4b;">Verdict Report</h1>`;
  html += `<div style="background:#f4f4f8;padding:10px;margin-bottom:20px;"><b>Query:</b> ${prepareText(queryText)}</div>`;
  if (report.mode === 'answer') {
    html += `<p>${prepareText(report.answer)}</p>`;
  } else {
    html += `<h2>Verdict: ${prepareText(report.verdict)} - ${report.confidence}%</h2>`;
    if (report.explanation) html += `<p>${prepareText(report.explanation)}</p>`;
  }
  return html;
};

const downloadPdf = (report, queryText) => {
  const container = document.createElement('div');
  container.style.cssText = `max-width:700px;margin:0 auto;padding:24px;font-family:sans-serif;color:#111;background:#fff;`;
  container.innerHTML = buildReportHtml(report, queryText);
  html2pdf().set({ margin: 12, filename: 'verdict-report.pdf', html2canvas: { scale: 2 }, jsPDF: { unit: 'pt', format: 'a4' } }).from(container).save();
};

const downloadWord = (report, queryText) => {
  const doc = new Document({ sections: [{ properties: {}, children: [new Paragraph({ children: [new TextRun("Verdict Report")] })] }] });
  Packer.toBlob(doc).then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'verdict-report.docx'; a.click();
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
      
      {/* 1. القائمة الجانبية (الداكنة الفاخرة) */}
      <aside className="sidebar">
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
            <button key={item.id} className={`nav-item ${activeNav === item.id ? 'active' : ''}`} onClick={() => setActiveNav(item.id)}>
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
                <div className="verdict-row">
                  <div className="stamp" style={{ borderColor: verdictColor(data.confidence, data.verdict) }}>
                    <span className="num" style={{ color: verdictColor(data.confidence, data.verdict) }}>{data.confidence || '-'}</span>
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
