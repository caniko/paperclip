{pkgs}: let
  inherit (pkgs) lib;
  mkProxy = import ../lib/antigravity-worker-proxy.nix {inherit lib pkgs;};
  worker = mkProxy {
    home = "/var/lib/paperclip-exec";
    runtimeDir = "/run/paperclip-exec-meta/gemini";
    uid = 812;
    proxyAddress = "127.0.0.2:18318";
  };

  storeHome = builtins.tryEval (builtins.deepSeq (mkProxy {
    home = "/nix/store/fake-home";
    runtimeDir = "/run/paperclip-exec-meta/gemini";
    uid = 812;
    proxyAddress = "127.0.0.2:18318";
  }) true);
  traversingRuntime = builtins.tryEval (builtins.deepSeq (mkProxy {
    home = "/var/lib/paperclip-exec";
    runtimeDir = "/run/../etc/gemini";
    uid = 812;
    proxyAddress = "127.0.0.2:18318";
  }) true);
  zeroUid = builtins.tryEval (builtins.deepSeq (mkProxy {
    home = "/var/lib/paperclip-exec";
    runtimeDir = "/run/paperclip-exec-meta/gemini";
    uid = 0;
    proxyAddress = "127.0.0.2:18318";
  }) true);
  badAddress = builtins.tryEval (builtins.deepSeq (mkProxy {
    home = "/var/lib/paperclip-exec";
    runtimeDir = "/run/paperclip-exec-meta/gemini";
    uid = 812;
    proxyAddress = "127.0.0.2:18318; evil";
  }) true);
in
  assert lib.assertMsg (!storeHome.success && !traversingRuntime.success && !zeroUid.success && !badAddress.success)
  "unsafe Antigravity worker proxy declaration accepted";
  assert lib.assertMsg (
    worker.sshSetEnv == "CLOUD_CODE_URL=http://127.0.0.2:18318 AGY_ACP_FORCE_FILE_STORAGE=1 AGY_CLI_DISABLE_AUTO_UPDATE=1"
    && worker.tmpfilesRule == "d /var/lib/paperclip-exec/.gemini 0755 root root -"
    && worker.bindPaths == ["/run/paperclip-exec-meta/gemini:/var/lib/paperclip-exec/.gemini:norbind"]
    && worker.readWritePaths == ["+/var/lib/paperclip-exec/.gemini"]
    && worker.bindReadOnlyPaths == [
      "${worker.settingsFile}:/var/lib/paperclip-exec/.gemini/antigravity-cli/settings.json"
      "${worker.placeholderTokenFile}:/var/lib/paperclip-exec/.gemini/antigravity-cli/antigravity-oauth-token"
    ]
  ) "Antigravity worker proxy contract drifted from expected mount/env layout";
    pkgs.runCommand "paperclip-antigravity-worker-proxy-check" {nativeBuildInputs = [pkgs.jq];} ''
      if grep -Eiq 'claude|anthropic' ${worker.settingsFile} ${worker.placeholderTokenFile}; then
        echo 'Legacy provider reference found in Antigravity worker proxy config' >&2
        exit 1
      fi
      jq -e '. == {auth: {type: "oauth-personal"}}' ${worker.settingsFile} >/dev/null
      jq -e '. == {auth_method: "consumer", token: {token_type: "Bearer", access_token: "worker-stub", refresh_token: "worker-stub", expiry: "2099-01-01T00:00:00Z"}}' ${worker.placeholderTokenFile} >/dev/null
      touch "$out"
    ''
