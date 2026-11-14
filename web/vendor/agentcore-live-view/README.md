# AgentCore Live View (vendored)

`BrowserLiveView.js` and `scaling.js` are copied unchanged from the AWS SDK `bedrock-agentcore@0.4.6`
(`dist/src/tools/browser/live-view`, Apache-2.0, see `LICENSE-bedrock-agentcore`).
`nice-dcv-web-client-sdk/` is the NICE DCV Web Client SDK that ships inside that package (see the `EULA.txt` files in it).

Why vendored: the full package pulls in server-side frameworks and optional peers that this project does not use.
How it is used: `scripts/build.mjs` aliases the bare imports `dcv` and `dcv-ui` to the files here and copies
`nice-dcv-web-client-sdk/dcvjs-esm` into `dist/web/` (the DCV client loads its decoder workers from that path).
To update: `npm pack bedrock-agentcore@<version>` in a scratch folder and copy the same files again.
