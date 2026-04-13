import React from 'react';
import type { DashboardMetrics } from '../types';
import { Activity } from 'lucide-react';

export const TopTalkers: React.FC<{ metrics: DashboardMetrics }> = ({ metrics }) => {
  const { recent, allTime } = metrics.topTalkers;

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title">
        <Activity size={20} />
        Top Talkers
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '2rem' }}>
        <div>
          <h3 style={{ marginBottom: '1rem', color: 'var(--text-muted)' }}>Recent</h3>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Pubkey</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr><td colSpan={2}>No data</td></tr>
                ) : (
                  recent.map(t => (
                    <tr key={t.pubkey}>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>{t.pubkey.substring(0, 16)}...</td>
                      <td>{t.count.toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 style={{ marginBottom: '1rem', color: 'var(--text-muted)' }}>All Time</h3>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Pubkey</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {allTime.length === 0 ? (
                  <tr><td colSpan={2}>No data</td></tr>
                ) : (
                  allTime.map(t => (
                    <tr key={t.pubkey}>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>{t.pubkey.substring(0, 16)}...</td>
                      <td>{t.count.toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
