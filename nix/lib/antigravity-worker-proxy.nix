# Antigravity CLI file-storage stub and bind-mount contract for confined
# Paperclip worker sandboxes whose outbound Google traffic terminates at a
# host-owned OAuth proxy socket.
#
# The consumer owns the worker user, network namespace, proxy socket relay,
# and host policy. This helper owns only the Antigravity CLI placeholder
# credential/settings contract so it stays in the Paperclip fork rather than
# consumer host modules.
{
  lib,
  pkgs,
}: {
  home,
  runtimeDir,
  uid,
  proxyAddress,
}: let
  runtimePath = path:
    builtins.isString path
    && lib.hasPrefix "/" path
    && path != "/"
    && !(lib.hasSuffix "/" path)
    && !(lib.hasInfix "//" path)
    && lib.all (segment: segment != "." && segment != "..") (lib.splitString "/" path)
    && !(lib.hasPrefix "/nix/store/" path)
    && builtins.match ".*[[:space:]].*" path == null;

  validProxyAddress =
    builtins.isString proxyAddress
    && builtins.match "(\\[[0-9a-fA-F:]+]|[A-Za-z0-9._-]+):[0-9]+" proxyAddress != null;

  stat = lib.getExe' pkgs.coreutils "stat";
  install = lib.getExe' pkgs.coreutils "install";
  chown = lib.getExe' pkgs.coreutils "chown";
  chmod = lib.getExe' pkgs.coreutils "chmod";

  settingsFile = pkgs.writeText "paperclip-exec-agy-settings.json" (builtins.toJSON {
    auth.type = "oauth-personal";
  });

  # Required for agy file-storage boot only, never a real credential; the host
  # Google worker listener discards it and injects a host-side OAuth token.
  placeholderTokenFile = pkgs.writeText "paperclip-exec-agy-placeholder-token.json" (builtins.toJSON {
    auth_method = "consumer";
    token = {
      token_type = "Bearer";
      access_token = "worker-stub";
      refresh_token = "worker-stub";
      expiry = "2099-01-01T00:00:00Z";
    };
  });

  geminiMount = "${home}/.gemini";
  cliDir = "${geminiMount}/antigravity-cli";
  runtimeCliDir = "${runtimeDir}/antigravity-cli";
in
  assert lib.assertMsg (runtimePath home)
  "Antigravity worker home must be a safe runtime path outside the Nix store";
  assert lib.assertMsg (runtimePath runtimeDir)
  "Antigravity worker runtimeDir must be a safe runtime path outside the Nix store";
  assert lib.assertMsg (builtins.isInt uid && uid > 0)
  "Antigravity worker uid must be a positive integer";
  assert lib.assertMsg validProxyAddress
  "Antigravity worker proxyAddress must be a safe host:port address"; {
    inherit settingsFile placeholderTokenFile;

    # Environment fragment appended to sshd SetEnv when the Google worker proxy is enabled.
    sshSetEnv = "CLOUD_CODE_URL=http://${proxyAddress} AGY_ACP_FORCE_FILE_STORAGE=1 AGY_CLI_DISABLE_AUTO_UPDATE=1";

    # Environment attrset form for systemd units or wrappers that consume key/value maps.
    environment = {
      CLOUD_CODE_URL = "http://${proxyAddress}";
      AGY_ACP_FORCE_FILE_STORAGE = "1";
      AGY_CLI_DISABLE_AUTO_UPDATE = "1";
    };

    tmpfilesRule = "d ${geminiMount} 0755 root root -";

    prepareScript = ''
      if test -L ${lib.escapeShellArg geminiMount} || ! test -d ${lib.escapeShellArg geminiMount} ||
        ! test "$(${stat} -c '%u:%g:%a' -- ${lib.escapeShellArg geminiMount})" = "0:0:755"; then
        echo 'Paperclip worker .gemini mount point must be a root-owned 0755 directory' >&2
        exit 1
      fi
      ${install} -d -m 0755 -o root -g root ${lib.escapeShellArg runtimeDir} ${lib.escapeShellArg runtimeCliDir}
      ${install} -m 0444 -o root -g root /dev/null ${lib.escapeShellArg "${runtimeCliDir}/settings.json"}
      ${install} -m 0444 -o root -g root /dev/null ${lib.escapeShellArg "${runtimeCliDir}/antigravity-oauth-token"}
      ${chown} ${toString uid}:${toString uid} ${lib.escapeShellArg runtimeCliDir}
      ${chmod} 0700 ${lib.escapeShellArg runtimeCliDir}
      ${install} -d -m 0700 -o ${toString uid} -g ${toString uid} \
        ${lib.escapeShellArg "${runtimeDir}/antigravity"} \
        ${lib.escapeShellArg "${runtimeDir}/config"}
    '';

    bindPaths = [
      "${runtimeDir}:${geminiMount}:norbind"
    ];

    readWritePaths = [
      "+${geminiMount}"
    ];

    bindReadOnlyPaths = [
      "${settingsFile}:${cliDir}/settings.json"
      "${placeholderTokenFile}:${cliDir}/antigravity-oauth-token"
    ];
  }
