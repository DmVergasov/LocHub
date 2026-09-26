#!/usr/bin/env node
// The bundle's actual entry point (scripts/bundle.mjs builds this file, not cli.ts). cli.ts only exports its
// pieces (parseCliArgs, main, ...) and never starts a server on import, so test/cli.test.ts can import it
// freely; this is the one place that calls main() unconditionally, with no realpath/argv[1] guard to get
// wrong. See cli.ts's comment on `main` (I-1) for why the old guard never worked through a junction/symlink.
import { main } from './cli.js';

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
