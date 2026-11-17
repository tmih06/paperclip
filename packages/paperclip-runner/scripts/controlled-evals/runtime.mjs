// Bun imports the TypeScript cost runtime directly, so the controller carries
// no loader dependency. The built runtime rewrites this file (see
// build-runtime.mjs) to re-export the bundled module instead.
export const costRuntime = await import('./shared-cost-runtime.ts');
