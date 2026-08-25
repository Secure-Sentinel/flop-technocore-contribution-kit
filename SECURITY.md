# Security

## Private key rule

The local identity file under `.flop/` is encrypted, but it is still sensitive.
Never commit, upload, or paste it. Never reuse a wallet seed, exchange key, API
key, or another identity secret as a Technocore identity.

The public `did:key:...`, signed message metadata, contribution URL, and proof
signature are intended to be shareable. A proof cannot be used to sign a new
message without the encrypted identity and its passphrase.

## Local-only web server

The web wizard binds to `127.0.0.1` by default. It accepts a passphrase so it
can unlock the local encrypted identity; it does not send that passphrase to
Technocore and does not persist it. Do not expose the wizard to the public
internet or run it behind a shared/public proxy.

## Reporting a problem

Please open a private security advisory on the GitHub repository if the report
could expose private key material or permit signing as another DID. For normal
documentation or usability issues, open a regular issue.

