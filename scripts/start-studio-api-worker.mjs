process.env.USE_STUDIO_INTERNAL_API = '1';
process.env.STUDIO_API_USE_LOCAL_URLS = '1';
await import('../src/worker.js');
