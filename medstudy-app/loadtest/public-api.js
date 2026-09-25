import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '60s', target: 25 },
        { duration: '60s', target: 50 },
        { duration: '60s', target: 100 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500', 'p(99)<3000'],
  },
};

const base = (__ENV.BASE_URL || 'https://medstudy-space-adaptive-production.up.railway.app').replace(/\/$/, '');

export default function () {
  const responses = http.batch([
    ['GET', base + '/health'],
    ['GET', base + '/api/config'],
    ['GET', base + '/api/topics'],
    ['GET', base + '/api/subjects'],
  ]);

  check(responses[0], { 'health 2xx': r => r.status >= 200 && r.status < 300 });
  check(responses[1], { 'config 2xx': r => r.status >= 200 && r.status < 300 });
  check(responses[2], { 'topics 2xx': r => r.status >= 200 && r.status < 300 });
  check(responses[3], { 'subjects 2xx': r => r.status >= 200 && r.status < 300 });

  sleep(1);
}
