import { additionalPackages } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_gbtwhkaqtbeebaiwuppp",
  runtime: "node-24",
  logLevel: "log",
  // The max compute seconds a task is allowed to run. If the task run exceeds this duration, it will be stopped.
  // You can override this on an individual task.
  // See https://trigger.dev/docs/runs/max-duration
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["trigger"],
  build: {
    // Resolves "server-only" to its empty module, so tasks can import lib/ai
    conditions: ["react-server"],
    // @daytona/sdk loads these with a runtime require the bundler can't see,
    // form-data to upload files and busboy to download them, so install them
    // in the image. Marking the SDK external doesn't work: its cjs/package.json
    // has no name, so Trigger.dev bundles it anyway
    extensions: [additionalPackages({ packages: ["form-data", "busboy"] })],
  },
});
