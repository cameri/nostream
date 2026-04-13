import React from 'react';
import type { DashboardMetrics } from '../types';
import { Tag } from 'lucide-react';

export const EventsByKind: React.FC<{ metrics: DashboardMetrics }> = ({ metrics }) => {
  const { eventsByKind } = metrics;

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title">
        <Tag size={20} className="text-purple-500" />
        Events By Kind
      </div>
      
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Kind ID</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {eventsByKind.length === 0 ? (
              <tr><td colSpan={2}>No data</td></tr>
            ) : (
              eventsByKind.map(k => (
                <tr key={k.kind}>
                  <td><span className="status-badge" style={{ fontFamily: 'monospace' }}>Kind {k.kind}</span></td>
                  <td>{k.count.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
