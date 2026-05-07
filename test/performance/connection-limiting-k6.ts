import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import ws from 'k6/ws';

const relayUrl = __ENV.RELAY_URL || 'ws://127.0.0.1:8008';
const connectionSuccess = new Counter('connection_success');
const connectionRateLimited = new Counter('connection_rate_limited');

export const options = {
  stages: [
    { duration: '10s', target: 3 },
    { duration: '10s', target: 6 },
    { duration: '10s', target: 12 },
    { duration: '10s', target: 18 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    'ws_connecting': ['p(95)<2000'],
  },
};

export default function () {
  
  const res = ws.connect(relayUrl, {}, function (socket) {
    let intentionalClose = false
    socket.on('close', () => {
      if(!intentionalClose) {
        connectionRateLimited.add(1);
      }
    });
    
    socket.on('open', () => {
      connectionSuccess.add(1);
    });
    
    socket.setTimeout(() => {
      intentionalClose = true;
      socket.close();
    }, 3000);
  });
  
  check(res, {
    'status is 101': (r) => r && r.status === 101,
  });
  
  sleep(0.5);
}

export function handleSummary(data: any) {
  const connSuccess = data.metrics?.connection_success?.values?.count || 0;
  const connRateLimited = data.metrics?.connection_rate_limited?.values?.count || 0;
  const iterations = data.metrics?.iterations?.values?.count || 0;
  const checks = data.metrics?.checks?.values?.passes || 0;
  const wsSessions = data.metrics?.ws_sessions?.values?.count || 0;

  const totalConnections = connSuccess + connRateLimited;
  const successRate = totalConnections > 0 ? ((connSuccess / totalConnections) * 100).toFixed(2) : 0;
  const rate = parseFloat(successRate as string);
  const successStatus = rate >= 80 ? '✓ GOOD' : rate >= 50 ? '⚠ MODERATE' : '✗ POOR';

  console.log(`
    ╔════════════════════════════════════════════════════════════════╗
    ║            CONNECTION RATE LIMITER TEST RESULTS                ║
    ╚════════════════════════════════════════════════════════════════╝

    EXECUTION:
      Iterations: ${iterations}
      WebSocket Sessions: ${wsSessions}
      Checks Passed: ${checks}

    CONNECTIONS:
      ✓ Success (stayed open): ${connSuccess}
      ✗ Rate Limited (closed): ${connRateLimited}
      ─────────────────────
      Total: ${totalConnections}

    PERFORMANCE:
      Success Rate: ${successStatus} ${successRate}%

    ═══════════════════════════════════════════════════════════════════
  `);
  return {};
}