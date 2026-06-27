#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    // Clean one-line error for a CLI; full stack only when BUS_DEBUG is set.
    const detail = process.env.BUS_DEBUG ? err?.stack || err : err?.message || err;
    process.stderr.write(`bus: ${detail}\n`);
    process.exit(1);
  });
