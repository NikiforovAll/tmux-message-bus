#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`bus: ${err?.stack || err}\n`);
    process.exit(1);
  });
