// Simple logger
export function log(...args) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[${ts}]`, ...args);
}

export default log;
