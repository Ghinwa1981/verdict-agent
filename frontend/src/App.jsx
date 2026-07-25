import React, { useState } from 'react';
import Dashboard from './components/Dashboard'; // تأكد أن المسار صحيح حسب مجلداتك

export default function App() {
  const [history, setHistory] = useState([]);

  const addToHistory = (entry) => {
    setHistory((prev) => [entry, ...prev]);
  };

  return (
    <Dashboard history={history} addToHistory={addToHistory} />
  );
}
