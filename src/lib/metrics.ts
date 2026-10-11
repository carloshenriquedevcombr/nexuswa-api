import client from 'prom-client';

/**
 * Métricas Prometheus (observabilidade).
 * Por quê: logs dizem "o que aconteceu"; métricas dizem "quanto e com que frequência" —
 * base para alertas de taxa de erro, fila acumulando e sessões caindo.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'nexuswa_' });

export const httpDuration = new client.Histogram({
  name: 'nexuswa_http_request_duration_seconds',
  help: 'Duração das requisições HTTP',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10],
  registers: [registry],
});

export const messagesSent = new client.Counter({
  name: 'nexuswa_messages_sent_total',
  help: 'Mensagens enviadas',
  labelNames: ['type', 'result'] as const,
  registers: [registry],
});

export const webhookDeliveries = new client.Counter({
  name: 'nexuswa_webhook_deliveries_total',
  help: 'Entregas de webhook',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const sessionsGauge = new client.Gauge({
  name: 'nexuswa_sessions',
  help: 'Sessões por estado neste nó',
  labelNames: ['state'] as const,
  registers: [registry],
});
