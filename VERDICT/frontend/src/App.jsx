import React, { useState } from 'react';
import Dashboard from './components/Dashboard';
import AnalysisLogs from './components/AnalysisLogs';
import SettingsView from './components/SettingsView';
import './App.css';

const navItems = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'logs', label: 'Analysis Logs' },
  { id: 'settings', label: 'Settings' },
];

function App() {
  const [view, setView] = useState('dashboard');
  const [history, setHistory] = useState([]);

  const addToHistory = (entry) => {
    setHistory((prev) => [entry, ...prev]);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">V</div>
          <div className="name">
            Verdict
            <small>Evidence-based analysis | live</small>
          </div>
        </div>

        <div>
          <p className="nav-label">Navigate</p>
          {navItems.map((item) => (
            <div
              key={item.id}
              className={'nav-item' + (view === item.id ? ' active' : '')}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          Every verdict is generated from what you submit this session. Treat it as a
          starting point for your own judgment, not a final answer.
        </div>
      </aside>

      <main className="main">
        {view === 'dashboard' && (
          <>
            <div className="topbar">
              <h1>Analyze anything before you decide</h1>
              <p>
                A claim, an investment, a legal question, gold, crypto, a rumor -
                paste what you're weighing and get a verdict backed by evidence,
                risks, and concrete next steps.
              </p>
            </div>
            <Dashboard history={history} addToHistory={addToHistory} />
          </>
        )}

        {view === 'logs' && <AnalysisLogs history={history} />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}

export default App;
