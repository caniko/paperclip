# Owned review app qualification

The owned review workflow checks out the immutable pull-request base SHA with
checkout credentials disabled. That base must contain compatible
`get-bot-token.mjs`, `revoke-bot-token.mjs`, and `run-quality-gates.mjs` helpers.
The workflow checks those files and the token/revocation exports before it
exposes the private key or mints a token. Refresh a qualification branch's
trusted base whenever the default-branch review workflow requires new helpers.

Secret-manager owns enrollment, encrypted PEM adoption, installation verification,
and publication. Configure the issued key in `COMMITPERCLIP_KEY` and the public
identity in `COMMITPERCLIP_APP_ID` and `COMMITPERCLIP_APP_SLUG`. Registration and
initial installation require authenticated operator consent. The app must match
the declared owner and repository policy.

After promoting the compatible workflow and publishing credentials, trigger two
fresh reviews on the same PR. Each event base must include the reviewed helpers.
Retain authentication, comment, and revocation receipts for both runs. Verify:

- The checkout and receipt use the event's immutable base SHA.
- The app identity and public-key fingerprint match secret-manager's receipt.
- The installation token targets exactly the declared repository.
- Both runs update the same app-owned marked comment ID.
- Token revocation succeeds in both runs.

Review publication is serialized per repository/PR with active-run cancellation
disabled. Failed verification still attempts token revocation; a cleanup failure
is reported alongside the verification failure. Receipts exclude credentials.
Keep `actionsSlotQualified` false until both trusted hosted reviews prove use
and cleanup. A passing code CI run alone does not establish slot qualification.
