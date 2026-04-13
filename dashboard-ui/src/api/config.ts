// Use Vite environment variables with hardcoded sensible defaults
export const getApiConfig = () => {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  
  // To avoid Vite's internal proxy throwing harmless but annoying EPIPE / ECONNRESET logs
  // when handling WebSockets during fast reloads, we hit the backend port directly for WS.
  // We extract the same default port (18013) that the user set.
  const backendPort = import.meta.env.VITE_DASHBOARD_PORT || '18013';
  const backendHost = import.meta.env.VITE_DASHBOARD_HOST || window.location.hostname;
  
  return {
    HTTP_URL: import.meta.env.VITE_HTTP_URL || `/api/v1/kpis/snapshot`,
    WS_URL: import.meta.env.VITE_WS_URL || `${wsProtocol}//${backendHost}:${backendPort}/api/v1/kpis/stream`
  };
};
