{ pkgs }:
let
  inherit (pkgs) lib;
  mkWorker = import ../lib/hermes-worker-env.nix { inherit lib pkgs; };
  operations = mkWorker {
    name = "operations";
    gatewayFile = "/run/credentials/paperclip/gateway";
    researchFile = "/run/credentials/hermes/research";
    restartTriggers = [ "/nix/store/example-encrypted-source" ];
  };
  staging = mkWorker {
    name = "staging";
    gatewayFile = "/run/credentials/paperclip/staging-gateway";
  };
  workerPath = operations."operations-worker-env".path;
  invalid = builtins.tryEval (builtins.deepSeq (mkWorker {
    name = "bad/name";
    gatewayFile = "/run/credentials/paperclip/gateway";
  }) true);
  storeCredential = builtins.tryEval (builtins.deepSeq (mkWorker {
    name = "operations";
    gatewayFile = "/nix/store/unencrypted-key";
  }) true);
  traversingCredential = builtins.tryEval (builtins.deepSeq (mkWorker {
    name = "operations";
    gatewayFile = "/run/credentials/../../nix/store/unencrypted-key";
  }) true);
in
assert lib.assertMsg (!invalid.success && !storeCredential.success && !traversingCredential.success) "unsafe worker declaration accepted";
assert lib.assertMsg (
  operations."operations-worker-env".serviceConfig.RuntimeDirectoryMode == "0700"
  && lib.elem pkgs.diffutils workerPath
  && operations."hermes-agent-operations".serviceConfig.EnvironmentFile == [ "/run/operations-worker/env" ]
  && operations."operations-worker-env".restartTriggers == operations."hermes-agent-operations".restartTriggers
  && staging."hermes-agent-staging".serviceConfig.EnvironmentFile == [ "/run/staging-worker/env" ]
  && !(lib.hasInfix "TAVILY_API_KEY" staging."staging-worker-env".script)
) "worker environment graph differs from the selected instance";
pkgs.runCommand "paperclip-hermes-worker-env-check" { nativeBuildInputs = [ pkgs.bash ]; } ''
  render=${pkgs.writeShellScript "paperclip-hermes-worker-env-test" (builtins.readFile ../lib/render-hermes-worker-env.sh)}
  # Keep the test PATH aligned with the declared service path. A broader build
  # environment must not hide a missing renderer dependency.
  export PATH=${lib.makeBinPath ([ pkgs.bash ] ++ workerPath)}
  bash ${./hermes-worker-env.sh} "$render" ${pkgs.writeText "hermes-worker-store-credential-fixture" "tvly-valid"}
  touch "$out"
''
