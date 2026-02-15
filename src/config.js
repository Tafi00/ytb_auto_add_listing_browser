// Configuration
export const CONFIG = {
  sessionsDir: process.env.SESSIONS_DIR || './sessions',
  headless: process.env.HEADLESS === 'true' || (!process.env.DISPLAY && process.platform === 'linux'),
  defaultProfile: 'default',
};

export default CONFIG;
