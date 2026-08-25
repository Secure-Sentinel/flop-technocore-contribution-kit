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

## Using the kit safely

If you are using this repository to make your own Technocore contribution,
create your own encrypted identity and use your own public contribution URL.
Never copy a DID, private identity file, seed, or passphrase from another
contributor. Keep `.flop/` local and confirm it is ignored before committing:

```bash
git status --short
git check-ignore -v .flop/identity.json
```

Public DID values, Technocore record URLs, and `proof-kit/public-proof.json`
are safe to publish. Private identity material is not.

## Pull requests

- Explain the user problem and the smallest useful change.
- Do not include an identity file, seed, passphrase, or live personal proof.
- Keep examples clearly marked as examples.
- Prefer Node.js built-ins over adding a dependency for a narrow helper.
