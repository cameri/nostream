import React from 'react';
import { Users, Banknote } from 'lucide-react';
import type { DashboardMetrics } from '../types';

export const AdmittedUsersTile: React.FC<{ metrics: DashboardMetrics }> = ({ metrics }) => {
  return (
    <div className="card">
      <div className="card-title">
        <Users size={20} className="text-blue-500" />
        Admitted Users
      </div>
      <div className="metric-value">{metrics.admittedUsers.toLocaleString()}</div>
    </div>
  );
};

export const SatsPaidTile: React.FC<{ metrics: DashboardMetrics }> = ({ metrics }) => {
  return (
    <div className="card">
      <div className="card-title">
        <Banknote size={20} className="text-green-500" />
        Sats Paid
      </div>
      <div className="metric-value">{metrics.satsPaid.toLocaleString()}</div>
    </div>
  );
};
