# Optional companion to an existing services.hermes-agent.instances.<name>.
# The caller owns the Hermes package, worker settings, source files, and policy.
{ lib, pkgs }:
{
  name,
  gatewayFile,
  researchFile ? null,
  restartTriggers ? [ ],
}:
let
  runtimePath = path:
    builtins.isString path
    && lib.hasPrefix "/" path
    && path != "/"
    && !(lib.hasSuffix "/" path)
    && !(lib.hasInfix "//" path)
    && lib.all (segment: segment != "." && segment != "..") (lib.splitString "/" path)
    && !(lib.hasPrefix "/nix/store/" path)
    && builtins.match ".*[[:space:]].*" path == null;
  runtimeDir = "${name}-worker";
  envFile = "/run/${runtimeDir}/env";
  render = pkgs.writeShellScript "paperclip-hermes-worker-env" (builtins.readFile ./render-hermes-worker-env.sh);
in
assert lib.assertMsg (builtins.match "[a-z][a-z0-9-]{0,30}" name != null)
  "Hermes worker name must be a safe systemd instance name";
assert lib.assertMsg (runtimePath gatewayFile && (researchFile == null || runtimePath researchFile))
  "Hermes worker credential files must be runtime paths outside the Nix store";
{
  "${runtimeDir}-env" = {
    description = "Render Paperclip Hermes worker credentials";
    before = [ "hermes-agent-${name}.service" ];
    requiredBy = [ "hermes-agent-${name}.service" ];
    path = [ pkgs.coreutils ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      RuntimeDirectory = runtimeDir;
      RuntimeDirectoryMode = "0700";
      UMask = "0077";
    };
    inherit restartTriggers;
    script = ''
      ${render} ${lib.escapeShellArg envFile} ${lib.escapeShellArg gatewayFile}${lib.optionalString (researchFile != null) " ${lib.escapeShellArg researchFile}"}
    '';
  };
  "hermes-agent-${name}" = {
    after = [ "${runtimeDir}-env.service" ];
    requires = [ "${runtimeDir}-env.service" ];
    inherit restartTriggers;
    serviceConfig.EnvironmentFile = [ envFile ];
  };
}
