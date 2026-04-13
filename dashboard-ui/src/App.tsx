import { useState, useEffect } from 'react';
import { useDashboardData } from './hooks/useDashboardData';
import { DynamicDashboard } from './components/DynamicDashboard';
import { Activity } from 'lucide-react';
import './index.css';

function App() {
  const { snapshot, status } = useDashboardData();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(t => t === 'light' ? 'dark' : 'light');
  };

  const getStatusBadge = () => {
    switch (status) {
      case 'connecting':
        return <span className="status-badge"><span style={{ color: '#f59e0b' }}>●</span> Connecting...</span>;
      case 'connected':
        return <span className="status-badge" style={{ borderColor: '#10b981', color: '#10b981' }}>● Live (WS)</span>;
      case 'fallback_polling':
        return <span className="status-badge" style={{ borderColor: '#3b82f6', color: '#3b82f6' }}>● Polling (HTTP)</span>;
      default:
        return <span className="status-badge" style={{ borderColor: '#ef4444', color: '#ef4444' }}>● Disconnected</span>;
    }
  };

  const snapshotStatusNode = snapshot?.status === 'stale' && (
     <span className="status-badge" style={{ marginLeft: '1rem', borderColor: '#f59e0b', color: '#f59e0b'}}>Data is Stale</span>
  );

  return (
    <div className="dashboard-container">
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Activity className="text-accent" />
            Nostream Dashboard
          </h1>
          {getStatusBadge()}
          {snapshotStatusNode}
        </div>
        <button className="theme-toggle" onClick={toggleTheme}>
          {theme === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode'}
        </button>
      </header>

      <main>
        {!snapshot || !snapshot.metrics ? (
          <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
            <p style={{ color: 'var(--text-muted)' }}>Waiting for telemetry data...</p>
          </div>
        ) : (
          <DynamicDashboard metrics={snapshot.metrics} />
        )}
      </main>

      <footer style={{ marginTop: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
        {snapshot?.generatedAt && (
          <p>Last updated: {new Date(snapshot.generatedAt).toLocaleString()}</p>
        )}
      </footer>
    </div>
  );
}

export default App;
