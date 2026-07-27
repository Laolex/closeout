import typescript from '@rollup/plugin-typescript'
import { defineConfig } from 'vitest/config'
import { puyaTsTransformer } from '@algorandfoundation/algorand-typescript-testing/vitest-transformer'

/**
 * Contract tests cannot run under `node --test`.
 *
 * `algorand-typescript-testing` swaps in stub implementations of the AVM
 * opcodes and captures TypeScript type information for the Node runtime,
 * and it does that through a TypeScript *transformer*. Without it the
 * contract source is just TypeScript that calls ops which do not exist
 * off-chain. The package also publishes only an `import` condition, so a
 * CJS resolver reports `No "exports" main defined` — which reads like a
 * broken dependency rather than the wrong harness.
 *
 * The transformer only processes files matching `includeExt`, which
 * defaults to `.algo.ts` / `.algo.spec.ts` / `.algo.test.ts`. A test named
 * `*.test.ts` is silently left untransformed, so tests must be named
 * `*.algo.test.ts`.
 */
export default defineConfig({
  test: {
    setupFiles: 'vitest.setup.ts',
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      transformers: {
        before: [puyaTsTransformer],
      },
    }),
  ],
})
