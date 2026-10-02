// The studio's modules import each other the way the bundler lets them: with
// the `@/` alias and without file extensions. Node resolves neither, so this
// hook does, for the tests only. It finds files; it compiles nothing — Node
// strips the types itself, which is why only plain `.ts` modules are tested
// here and components are not.
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

export function resolve(specifier, context, next) {
  let target = null;
  if (specifier.startsWith('@/')) target = join(src, specifier.slice(2));
  else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    target = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (target !== null) {
    for (const candidate of [target, `${target}.ts`, join(target, 'index.ts')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return next(pathToFileURL(candidate).href, context);
    }
  }
  return next(specifier, context);
}
