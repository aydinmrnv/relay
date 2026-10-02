import * as nodeModule from 'node:module';
import { resolve } from './resolve.mjs';

// `registerHooks` runs the hook in this thread and is what current Node wants;
// `register` is the older way, kept for the Node 22 releases before it existed.
if (typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks({ resolve });
else nodeModule.register('./resolve.mjs', import.meta.url);
