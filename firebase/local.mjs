import { createApp } from '../server.mjs';
import { services } from './store.mjs';
import { createFirebaseApi } from './api.mjs';
export async function createFirebaseApp({
  projectId = process.env.FIREBASE_PROJECT_ID || 'demo-double-y',
  setupToken = process.env.SETUP_TOKEN || '',
  publicOrigin = '',
  secureCookies = false,
} = {}) {
  if (
    !process.env.FIRESTORE_EMULATOR_HOST ||
    !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    !projectId.startsWith('demo-')
  )
    throw Error('Local server requires both emulators and a demo- project.');
  // Reuse static file server only; no SQLite database is created in Firebase mode.
  return createApp({
    apiHandler: createFirebaseApi(services(projectId), { setupToken, publicOrigin, secureCookies }),
  });
}
if (process.argv[1]?.endsWith('/firebase/local.mjs')) {
  const { server } = await createFirebaseApp();
  server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () =>
    console.log('Firebase emulator app on http://127.0.0.1:' + (process.env.PORT || 3000)),
  );
}
