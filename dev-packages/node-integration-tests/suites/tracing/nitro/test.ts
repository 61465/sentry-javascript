import { afterAll, describe, expect, vi } from 'vitest';
import { supports } from '../../../utils';
import { cleanupChildProcesses, createEsmTests } from '../../../utils/runner';

// h3 v2 and srvx are ESM-only and require Node >= 20.
describe.runIf(supports({ min: 20 }))('nitro integrations', () => {
  afterAll(() => {
    cleanupChildProcesses();
  });

  createEsmTests(__dirname, 'scenario.mjs', 'instrument.mjs', (createRunner, test) => {
    test('creates a single http.server span with a request handler span and sets Server-Timing headers', async () => {
      let traceId: string | undefined;

      const runner = createRunner()
        .expect({
          span: container => {
            const segment = container.items.find(span => span.is_segment);
            const children = container.items.filter(span => !span.is_segment);
            const handlerSpan = children.find(span => span.attributes['sentry.origin']?.value === 'auto.http.nitro.h3');

            traceId = segment?.trace_id;

            // On Node the runtime's http instrumentation creates the segment. Bun publishes no
            // `http.server.request.start`, so there srvx creates it instead.
            expect(segment).toMatchObject({
              name: 'GET /hello/:name',
              status: 'ok',
              attributes: expect.objectContaining({
                'sentry.op': { type: 'string', value: 'http.server' },
                'http.route': { type: 'string', value: '/hello/:name' },
                'http.response.status_code': { type: 'integer', value: 200 },
                'url.path.parameter.name': { type: 'string', value: 'world' },
              }),
            });

            expect(children.filter(span => span.attributes['sentry.op']?.value === 'http.server')).toEqual([]);

            expect(handlerSpan).toMatchObject({
              name: 'GET /hello/:name',
              parent_span_id: segment?.span_id,
              status: 'ok',
              attributes: expect.objectContaining({
                'sentry.op': { type: 'string', value: 'handler' },
              }),
            });
          },
        })
        .start();

      const port = await vi.waitFor(() => runner.getPort() ?? Promise.reject(new Error('port not ready')), {
        timeout: 30_000,
      });
      const response = await fetch(`http://localhost:${port}/hello/world`);
      expect(await response.text()).toBe('Hello, world!');

      await runner.completed();

      const serverTiming = response.headers.get('server-timing');
      expect(serverTiming).toContain(`sentry-trace;desc="${traceId}-`);
      expect(serverTiming).toContain('baggage;desc="');
    });

    test('creates cache spans for unstorage operations', async () => {
      const runner = createRunner()
        .expect({
          span: container => {
            const segment = container.items.find(span => span.is_segment);
            const cacheSpans = container.items.filter(
              span => span.attributes['sentry.origin']?.value === 'auto.cache.nitro',
            );

            expect(segment?.name).toBe('GET /cache');
            expect(cacheSpans).toEqual([
              expect.objectContaining({
                name: 'cache.put',
                status: 'ok',
                attributes: expect.objectContaining({
                  'sentry.op': { type: 'string', value: 'cache.put' },
                  'cache.key': { type: 'string', value: 'cache:key' },
                  'db.operation.name': { type: 'string', value: 'setItem' },
                  'db.system.name': { type: 'string', value: 'memory' },
                }),
              }),
              expect.objectContaining({
                name: 'cache.get',
                status: 'ok',
                attributes: expect.objectContaining({
                  'sentry.op': { type: 'string', value: 'cache.get' },
                  'cache.key': { type: 'string', value: 'cache:key' },
                  'cache.hit': { type: 'boolean', value: true },
                  'db.operation.name': { type: 'string', value: 'getItem' },
                }),
              }),
            ]);
          },
        })
        .start();

      expect(await runner.makeRequest('get', '/cache')).toBe('value');
      await runner.completed();
    });
  });
});
