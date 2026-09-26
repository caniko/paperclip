{
  pkgs,
  package,
  runtimePath,
}:
let
  probe = pkgs.writeText "paperclip-runtime-tools.mjs" ''
    import assert from "node:assert/strict";
    import { createServer } from "node:net";
    import { once } from "node:events";
    import { generateRailwaySshKey } from "${package}/lib/paperclip/server/dist/services/railway-ssh.js";
    import { readLocalServicePortOwner } from "${package}/lib/paperclip/server/dist/services/local-service-supervisor.js";
    const key = await generateRailwaySshKey();
    assert.ok(key.publicKey.startsWith("ssh-ed25519 "));
    assert.ok(key.privateKey.includes("BEGIN OPENSSH PRIVATE KEY"));
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      assert.equal(await readLocalServicePortOwner(server.address().port), process.pid);
    } finally { server.close(); }
  '';
in
pkgs.runCommand "paperclip-native-runtime-tools" { } ''
  export HOME="$TMPDIR/home"
  mkdir -p "$HOME"
  export PATH=${runtimePath}
  ${pkgs.nodejs}/bin/node --import ${package}/lib/paperclip/server/node_modules/tsx/dist/loader.mjs ${probe}
  ${pkgs.coreutils}/bin/touch "$out"
''
