#!/usr/bin/env bun

import { resolve } from "node:path";
import { main } from "./runtime-supervisor.js";

// This mutable checkout entrypoint is intentionally only a launcher. Authority is always served by
// the immutable artifact selected by RuntimeSupervisor.
if (import.meta.main) {
  try {
    // The bootstrap itself is installed from the provider project. The target checkout remains
    // the workflow repository, while this provider checkout supplies committed runtime revisions.
    main({ providerRoot: resolve(import.meta.dir, "../..") });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "runtime bootstrap failed"}\n`,
    );
    process.exitCode = 1;
  }
}
