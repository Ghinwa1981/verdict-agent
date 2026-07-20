import React, { useState } from 'react';
import axios from 'axios';

const AGENT_URL = 'http://localhost:8000';

const SettingsView = () => {
  const [status, setStatus] = useState(null);

  const checkConnection = async () => {
    setStatus('Checking...');
    try {
      const res = await axios.get(`${AGENT_URL}/health`);
      setStatus(res.data.ok ? 'Connected (OK)' : 'Unexpected response');
    } catch (err) {
      setStatus('Could not reach the backend at ' + AGENT_URL);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Settings</h1>
        <p>Basic info about this instance. No account system yet - everything runs locally per session.</p>
      </div>

      <div className="card">
        <h2>Backend connection</h2>
        <span className="sub">The frontend talks to this address for every analysis.</span>
        <p style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, marginBottom: 14 }}>{AGENT_URL}</p>
        <button className="run" onClick={checkConnection} style={{ marginBottom: 10 }}>
          Test connection
        </button>
        {status && <p className="status-note">{status}</p>}
      </div>

      <div className="card">
        <h2>About</h2>
        <p className="summary">
          Verdict analyzes any claim, question, or decision you submit and returns a
          verdict backed by evidence, risks, and next steps. Analyses are not stored -
          each session starts fresh.
        </p>
      </div>
    </>
  );
};

export default SettingsView;
