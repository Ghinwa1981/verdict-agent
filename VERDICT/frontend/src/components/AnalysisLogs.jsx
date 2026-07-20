import React from 'react';

const AnalysisLogs = ({ history }) => {
  return (
    <>
      <div className="topbar">
        <h1>Analysis logs</h1>
        <p>Every analysis you've run this session, most recent first. Nothing here is saved on a server.</p>
      </div>

      <div className="card">
        {!history.length ? (
          <p className="history-empty">No analyses yet - run one from the Dashboard.</p>
        ) : (
          history.map((h) => {
            const hasScore = typeof h.confidence === 'number';
            const color = !hasScore
              ? 'var(--accent-dark)'
              : h.confidence >= 70
              ? 'var(--success)'
              : h.confidence >= 40
              ? 'var(--accent-dark)'
              : 'var(--danger)';
            return (
              <div className="history-row" key={h.id} style={{ alignItems: 'flex-start' }}>
                <div className="history-badge" style={{ borderColor: color, color }}>
                  {hasScore ? h.confidence : '?'}
                </div>
                <div className="history-info" style={{ minWidth: 0, flex: 1 }}>
                  <div className="q" style={{ whiteSpace: 'normal' }}>{h.query}</div>
                  <div className="meta">{h.verdict} | {h.tier} tier</div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
};

export default AnalysisLogs;
