/**
 * OpenTelemetry Tracing Utility — Local Workspace
 *
 * Same API as the cloud telemetry module. Provides withSpan() for
 * distributed tracing in the local runtime. No-op when no
 * OTEL SDK is configured.
 */

import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

const TRACER_NAME = 'ohwow-workspace';
const TRACER_VERSION = '1.0.0';

let _tracer: Tracer | null = null;

function getTracer(): Tracer {
  if (!_tracer) {
    _tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  }
  return _tracer;
}

/**
 * Execute an async function within an OpenTelemetry span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();

  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }

      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}
