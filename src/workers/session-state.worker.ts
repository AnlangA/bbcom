import { IndexedDbSessionStateDatabase } from '../lib/session-state-database';
import type {
  SessionStateWorkerRequest,
  SessionStateWorkerResponse,
} from '../lib/session-state-worker-protocol';

const database = new IndexedDbSessionStateDatabase();
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<SessionStateWorkerRequest>) => void) | null;
  postMessage(message: SessionStateWorkerResponse): void;
};

let operation = Promise.resolve();

workerScope.onmessage = (event) => {
  const request = event.data;
  operation = operation.then(async () => {
    try {
      if (request.kind === 'load') {
        const result = await database.load();
        workerScope.postMessage({ id: request.id, ok: true, result });
        return;
      }
      await database.save(request.file, request.includeFrames);
      workerScope.postMessage({ id: request.id, ok: true, result: null });
    } catch (error) {
      workerScope.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
