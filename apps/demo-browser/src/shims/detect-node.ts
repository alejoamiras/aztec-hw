/* Force detect-node to return false in the browser. Without this, the
 * node-polyfills `process` shim makes the real detect-node believe we're
 * running under Node, which sends @aztec/foundation's pino logger down
 * the worker-thread transport path — fails with "window is not defined".
 * Pattern lifted from nulo-2/packages/extension/src/shims/detect-node.ts. */
export default false;
