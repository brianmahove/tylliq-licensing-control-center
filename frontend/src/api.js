import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

export const firebaseApp = initializeApp({
  apiKey: 'AIzaSyDL9-IU5W8vLbNl9Ayulenbz7tvz0jhEFY',
  authDomain: 'tylliq-licensing.firebaseapp.com',
  projectId: 'tylliq-licensing',
  storageBucket: 'tylliq-licensing.firebasestorage.app',
  messagingSenderId: '810494450736',
  appId: '1:810494450736:web:72ddc335818624cdd6e1f5',
});

export const auth = getAuth(firebaseApp);

const FUNCTION_BASE = 'https://us-central1-tylliq-licensing.cloudfunctions.net';

export async function apiCall(functionName, body = {}) {
  if (!auth.currentUser) throw new Error('Your session has expired. Please sign in again.');
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(`${FUNCTION_BASE}/${functionName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) throw new Error(payload.error?.message || `Request failed (${response.status})`);
  return payload;
}
