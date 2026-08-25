# Contributing

Thanks for improving the FLOP Technocore Contribution Kit.

## Local setup

This repository intentionally has no runtime npm dependencies:

```bash
npm test
npm start
```

Keep protocol behavior covered by tests in `test/`. When changing a signing
operation, update `docs/protocol.md` and add a regression test for the exact
canonical payload.

## Pull requests

- Explain the user problem and the smallest useful change.
- Do not include an identity file, seed, passphrase, or live personal proof.
- Keep examples clearly marked as examples.
- Prefer Node.js built-ins over adding a dependency for a narrow helper.

