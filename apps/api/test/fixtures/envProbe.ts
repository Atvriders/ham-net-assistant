/**
 * Probe for env.test.ts's "loadEnv production behavior" block.
 *
 * Importing src/env.ts validates process.env as a side effect and, in
 * production, kills the process. That consequence cannot be observed in-process
 * — this file exists to be run in a child so the exit code and stderr are
 * assertable. Printing BOOTED only happens when validation passed.
 */
import '../../src/env.js';

console.log('BOOTED');
