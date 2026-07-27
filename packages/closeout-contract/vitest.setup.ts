import { beforeAll, expect } from 'vitest'
import { addEqualityTesters } from '@algorandfoundation/algorand-typescript-testing'

// AVM values (Uint64, Bytes, Account) do not compare equal to plain JS
// values under a stock deep-equal, so assertions would otherwise need a
// cast at every call site.
beforeAll(() => {
  addEqualityTesters({ expect })
})
