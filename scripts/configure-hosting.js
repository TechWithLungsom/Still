import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function origin(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /localhost|example\.(com|org)|your-|\.invalid$/.test(url.hostname)) {
    throw new Error(`${label} must be an actual HTTPS deployment origin, with no path or credentials.`);
  }
  return url.origin;
}
export function configuration(backend, frontend) {
  backend = origin(backend, 'Render URL'); frontend = origin(frontend, 'Vercel URL');
  if (backend === frontend) throw new Error('Provide distinct frontend and backend origins.');
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: 'vite',
    installCommand: 'npm ci --include=dev',
    buildCommand: 'npm run build:vercel',
    outputDirectory: 'dist',
    rewrites: [{ source: '/api/:path*', destination: `${backend}/api/:path*` }],
    headers: [{ source: '/api/:path*', headers: [
      { key: 'Cache-Control', value: 'no-store' },
      { key: 'CDN-Cache-Control', value: 'no-store' },
      { key: 'Vercel-CDN-Cache-Control', value: 'no-store' },
      { key: 'x-vercel-enable-rewrite-caching', value: '0' }
    ] }]
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const backend = args[args.indexOf('--backend') + 1];
  const frontend = args[args.indexOf('--frontend') + 1];
  if (!args.includes('--backend') || !args.includes('--frontend')) throw new Error('Usage: npm run configure:hosting -- --backend https://ACTUAL-RENDER-ORIGIN --frontend https://ACTUAL-VERCEL-ORIGIN');
  const config = configuration(backend, frontend);
  writeFileSync('vercel.json', JSON.stringify(config, null, 2) + '\n');
  writeFileSync('.env.production.local', `VITE_REALTIME_ORIGIN=${origin(backend, 'Render URL')}\n`);
  const deployment = {
    frontendOrigin: origin(frontend, 'Vercel URL'),
    backendOrigin: origin(backend, 'Render URL'),
    vercelEnvironment: { VITE_REALTIME_ORIGIN: origin(backend, 'Render URL') },
    renderEnvironment: { NODE_ENV: 'production', HOST: '0.0.0.0', COOKIE_SECURE: 'true', APP_ORIGIN: origin(frontend, 'Vercel URL'), DATABASE_PATH: '/var/data/still.sqlite', UPLOAD_DIR: '/var/data/uploads', SERVE_FRONTEND: 'false' }
  };
  mkdirSync('deployment', { recursive: true });
  writeFileSync('deployment/urls.json', JSON.stringify(deployment, null, 2) + '\n');
  console.log('Configured vercel.json, local production build URL, and deployment/urls.json. Apply the listed environment values to their respective services.');
}
