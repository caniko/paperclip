#!/usr/bin/env node
import { revokeInstallationToken } from './get-bot-token.mjs';

revokeInstallationToken(process.env.GH_TOKEN).catch(error => {
  console.error(`Review token revocation failed: ${error.message}`);
  process.exitCode = 1;
});
