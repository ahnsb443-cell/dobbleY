import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { services } from './store.mjs';
import { createFirebaseApi } from './api.mjs';
const setupToken = defineSecret('SETUP_TOKEN');
let handler;
export const api = onRequest(
  {
    region: 'asia-northeast3',
    memory: '512MiB',
    timeoutSeconds: 120,
    maxInstances: 3,
    concurrency: 20,
    secrets: [setupToken],
    invoker: 'public',
  },
  (req, res) => {
    if (!handler) {
      const projectId = process.env.GCLOUD_PROJECT;
      if (!projectId) throw Error('Missing Firebase project.');
      handler = createFirebaseApi(services(projectId), {
        secureCookies: !process.env.FUNCTIONS_EMULATOR,
        publicOrigin:
          process.env.PUBLIC_ORIGIN ||
          (process.env.FUNCTIONS_EMULATOR
            ? 'http://127.0.0.1:5000'
            : 'https://' + projectId + '.web.app'),
        setupToken: setupToken.value(),
      });
    }
    return handler(req, res);
  },
);
