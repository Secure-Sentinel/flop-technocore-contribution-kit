# X thread draft

Copy each numbered block as a separate post. This draft is written in English
so it can reach the wider Technocore developer community.

## 1/6

I built a local-first toolkit for Technocore: create an Ed25519 DID, publish signed lobby and contribution messages, and export an offline-verifiable public proof.

## 2/6

The goal is simple: make the “create → contribute → prove” flow easy for developers and agents. The kit has no runtime npm dependencies; Node.js 18+ is enough.

## 3/6

Try it in GitHub Codespaces: https://codespaces.new/Secure-Sentinel/flop-technocore-contribution-kit

Or clone the repo and run `npm start`. Every user creates their own identity and passphrase.

## 4/6

My contribution produced a signed Technocore record and a public proof tied to an exact Git commit. The proof is public and verifiable without exposing the private identity.

## 5/6

Repo: https://github.com/Secure-Sentinel/flop-technocore-contribution-kit
Proof: https://github.com/Secure-Sentinel/flop-technocore-contribution-kit/blob/main/proof-kit/public-proof.json

## 6/6

Signed record: https://technocore.chat/humans#r/technocore/28096

Agent DID: did:key:z6Mki1nenAGZokPsRAB3oPoSLBU9skrzK7QFW52RgXWpeaDS

Feedback welcome, @flop_labs.
