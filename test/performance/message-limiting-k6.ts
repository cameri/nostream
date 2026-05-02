import { check } from 'k6';
import { Counter } from 'k6/metrics';
import ws from 'k6/ws';

const relayUrl = __ENV.RELAY_URL || 'ws://127.0.0.1:8008';
const noticeCounter = new Counter('notice_messages');
const eoseCounter = new Counter('eose_messages');
const eventCounter = new Counter('event_messages');
const errorCounter = new Counter('error_messages');

export const options = {
  stages: [
    { duration: '10s', target: 1 },
    { duration: '10s', target: 2 },
    { duration: '10s', target: 4 },
    { duration: '5s', target: 0 },
  ],
};

export default function () {
  const res = ws.connect(relayUrl, {}, function (socket) {
    socket.on('open', function () {
      let msgCount = 0;
      socket.setInterval(function () {
        msgCount++;
        const text = JSON.stringify(['REQ', `sub-${Date.now()}-${msgCount}`, {limit: 10}]);
        socket.send(text);
      }, 1000);
    });

    socket.on('message', function (data) {
      try {
        const parsed = JSON.parse(data);
        const msgType = parsed[0];
        
        if (msgType === 'NOTICE') {
          noticeCounter.add(1);
        } else if (msgType === 'EOSE') {
          eoseCounter.add(1);
        } else if (msgType === 'EVENT') {
          eventCounter.add(1);
        }
      } catch (e: any) {
        errorCounter.add(1);
        console.error('Failed to parse message:', e.message);
      }
    });

    socket.setTimeout(function () {
      socket.close();
    }, 9000);
  });

  check(res, { 
    'status 101': (r) => r && r.status === 101,
  });
}

export function handleSummary(data: any) {
  const notices = data.metrics?.notice_messages?.values?.count || 0;
  const eoses = data.metrics?.eose_messages?.values?.count || 0;
  const events = data.metrics?.event_messages?.values?.count || 0;
  const iterations = data.metrics?.iterations?.values?.count || 0;
  const wsSessions = data.metrics?.ws_sessions?.values?.count || 0;
  const msgsSent = data.metrics?.ws_msgs_sent?.values?.count || 0;
  const msgsReceived = data.metrics?.ws_msgs_received?.values?.count || 0;
  const dataReceived = data.metrics?.data_received?.values?.count || 0;
  const checks = data.metrics?.checks?.values?.passes || 0;

  const totalMessages = notices + eoses + events;
  const successRate = totalMessages > 0 ? ((eoses + events) / totalMessages * 100).toFixed(2) : 0;
  
  const rate = parseFloat(successRate as string);
  const successStatus = rate >= 80 ? '✓ GOOD' : rate >= 50 ? '⚠ MODERATE' : '✗ POOR';
  const rateLimitStatus = notices > 0 ? '⚠ ACTIVE' : '✓ INACTIVE';

  console.log(`
╔════════════════════════════════════════════════════════════════╗
║              MESSAGE RATE LIMITER TEST RESULTS                 ║
╚════════════════════════════════════════════════════════════════╝

EXECUTION:
  Iterations: ${iterations}
  WebSocket Sessions: ${wsSessions}
  Checks Passed: ${checks}

MESSAGES:
  Sent: ${msgsSent}
  Received: ${msgsReceived}
  
MESSAGE TYPES:
  ✗ NOTICE (rate limited): ${notices}
  ✓ EOSE (query complete): ${eoses}
  ◆ EVENT (results): ${events}
  ─────────────────────
  Total: ${totalMessages}
  
PERFORMANCE:
  Success Rate: ${successStatus} ${successRate}%
  Data Received: ${dataReceived} bytes
  Rate Limiter: ${rateLimitStatus}

═══════════════════════════════════════════════════════════════════
  `);
  return {};
}