import { plugin } from 'bun';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../..', import.meta.url));
plugin({
  name: 'profile-built-workspaces',
  setup(build) {
    build.onLoad({ filter: /\/packages\/(?:db|shared)\/src\/.*\.ts$/ }, ({ path: source }) => {
      const relative = path.relative(root, source).replace('/src/', '/dist/').replace(/\.ts$/, '.js');
      const built = pathToFileURL(path.join(root, relative)).href;
      return { contents: `export * from ${JSON.stringify(built)};`, loader: 'js' };
    });
  },
});
