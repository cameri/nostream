import React from 'react';
import type { DashboardMetrics } from '../types';
import { AdmittedUsersTile, SatsPaidTile } from './KPITiles';
import { TopTalkers } from './TopTalkers';
import { EventsByKind } from './EventsByKind';

export interface DashboardMetricProps {
  metrics: DashboardMetrics;
}

// Emulating a dynamic component registry where new endpoints/components can be added easily
export const componentRegistry: { id: string; Component: React.FC<DashboardMetricProps> }[] = [
  { id: 'admittedUsers', Component: AdmittedUsersTile },
  { id: 'satsPaid', Component: SatsPaidTile },
  { id: 'eventsByKind', Component: EventsByKind },
  { id: 'topTalkers', Component: TopTalkers },
];

export const DynamicDashboard: React.FC<DashboardMetricProps> = ({ metrics }) => {
  return (
    <div className="grid">
      {componentRegistry.map(({ id, Component }) => (
        <Component key={id} metrics={metrics} />
      ))}
    </div>
  );
};
