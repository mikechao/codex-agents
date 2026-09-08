# OpenCode OTel diagnostics

This is optional, repository-local dogfood tooling for diagnosing native OpenCode
runs. It is not Workflow MCP authority, an agent contract, or an installed-target
feature. It deliberately keeps raw local telemetry, which can contain prompts,
tool arguments, and tool results. Do not expose the ports outside loopback or use
this stack for sensitive data without understanding that risk.

## Start and stop

Prerequisites: Docker Desktop (or a compatible Docker Engine with Compose) and a
working `opencode` binary. From the repository root, start the pinned Collector
and Jaeger services with:

```sh
bun run otel:up
```

The direct equivalent is:

```sh
docker compose -f docker-compose.otel.yml up -d
```

Check container state and health endpoints:

```sh
bun run otel:status
curl -fsS http://127.0.0.1:13133/
curl -fsS http://127.0.0.1:14269/
```

Stop the services with `bun run otel:down`. A complete reset, including the
container-managed trace store, is:

```sh
docker compose -f docker-compose.otel.yml down -v
```

No trace or storage directory is written to this repository.

## Run OpenCode and find a trace

The project configuration enables OpenCode's native `experimental.openTelemetry`
spans. Use the repository launcher so the native OTLP exporter sends HTTP
protobuf to the Collector's loopback endpoint while preserving all normal
arguments:

```sh
bun run opencode:otel -- run "Read package.json and report its package name."
```

The launcher only sets `OTEL_EXPORTER_OTLP_ENDPOINT` to
`http://127.0.0.1:4318` and the HTTP/protobuf protocol before invoking the normal
`opencode` binary. You may also run `opencode` normally; the project config still
enables native instrumentation, but the launcher is the reliable explicit
endpoint path for this stack.

Open Jaeger at <http://127.0.0.1:16686>. Select service `opencode`, choose a
recent run, and open its waterfall. High-value span names include:

- `TaskTool.execute` for parent-to-subagent delegation;
- `Tool.execute` and concrete tool spans such as `ReadTool.execute`;
- `ai.streamText` and `ai.streamText.doStream` for model timing;
- `workflow_state_*` tool spans and error/exception events when emitted.

Native spans normally include provider/model, token and reasoning usage,
correlation/session IDs, and status/exception data. Span volume is intentionally
raw and can be high; the Collector applies no redaction, filtering, or custom
processor. Jaeger receives from the Collector over the explicit `otel` Docker
network using the service name `jaeger`; OpenCode never connects directly to
Jaeger.

## Retention and failure behavior

The stack pins `otel/opentelemetry-collector-contrib:0.160.0` and
`jaegertracing/all-in-one:1.76.0`. Jaeger uses its supported in-memory storage
with `MEMORY_MAX_TRACES=10000`. This is a finite trace-count cap, not a time
window: the oldest traces are evicted as new traces arrive, and the practical
postmortem window depends on local run volume. Restarting Jaeger loses its
in-memory traces; `down -v` is the documented full reset even though this stack
does not persist trace data in a named volume.

If the Collector or Jaeger is stopped, native export may be lost, but ordinary
OpenCode work and Workflow MCP authority remain independent and continue without
telemetry. Inspect startup and exporter errors with:

```sh
docker compose -f docker-compose.otel.yml logs --tail=100 otel-collector jaeger
```

If services fail to start, check that ports 4318, 13133, 14269, and 16686 are
free, validate the mounted Collector YAML through the container logs, and run
`docker compose -f docker-compose.otel.yml down -v` before retrying. If Jaeger
has reached its in-memory cap, older traces may no longer be searchable; rerun
the focused task and inspect it immediately. The stack intentionally introduces
no remote backend, dashboard, workflow field, validation-ID enrichment, or
installed-repository dependency.
