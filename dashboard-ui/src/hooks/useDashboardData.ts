import { useEffect, useState, useRef } from 'react';
import type { KPISnapshot, DashboardServerMessage } from '../types';
import { getApiConfig } from '../api/config';

export const useDashboardData = () => {
  const [snapshot, setSnapshot] = useState<KPISnapshot | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'fallback_polling' | 'disconnected'>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const pollingRef = useRef<number | null>(null);

  useEffect(() => {
    const { WS_URL: wsUrl, HTTP_URL: httpUrl } = getApiConfig();

    const fetchFallback = async () => {
      try {
        const res = await fetch(httpUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.data) {
            setSnapshot(data.data);
          }
        }
      } catch (err) {
        console.error('HTTP Fallback failed', err);
      }
    };

    const connectWS = () => {
      setStatus('connecting');
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setStatus('connected');
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as DashboardServerMessage;
          if (msg.type === 'kpi.snapshot') {
            setSnapshot(msg.payload);
          }
        } catch (e) {
          console.error('Failed to parse WS msg', e);
        }
      };

      ws.onclose = () => {
        setStatus('fallback_polling');
        // Start polling as fallback
        if (!pollingRef.current) {
          fetchFallback();
          pollingRef.current = setInterval(fetchFallback, 5000);
        }
        
        // Attempt reconnect after 10s
        setTimeout(connectWS, 10000);
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    };

    connectWS();

    return () => {
      if (wsRef.current) wsRef.current.close();
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  return { snapshot, status };
};
