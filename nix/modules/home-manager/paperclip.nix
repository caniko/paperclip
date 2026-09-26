{
  config,
  lib,
  pkgs,
  ...
}:
let
  shared = import ../shared.nix { inherit lib pkgs; };
  instances = lib.filterAttrs (_: c: c.enable) config.services.paperclip.instances;
  client = config.programs.paperclip;
  clientPackage = pkgs.runCommand "paperclip-client" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    mkdir -p "$out/bin"
    makeWrapper ${client.package}/bin/paperclip "$out/bin/paperclip" \
      ${
        lib.optionalString (
          client.apiUrl != null
        ) "--set PAPERCLIP_API_URL ${lib.escapeShellArg client.apiUrl}"
      } \
      ${
        lib.optionalString (
          client.companyId != null
        ) "--set PAPERCLIP_COMPANY_ID ${lib.escapeShellArg client.companyId}"
      } \
      ${lib.optionalString (
        client.apiKeyFile != null
      ) "--set PAPERCLIP_API_KEY_FILE ${lib.escapeShellArg client.apiKeyFile}"}
  '';
in
{
  options = {
    services.paperclip.instances = lib.mkOption {
      default = { };
      description = "Paperclip Linux user services; instances share the user's filesystem authority.";
      type = lib.types.attrsOf (
        lib.types.submodule [
          shared.instanceOptions
          ({ name, ... }: {
            config.stateDir = lib.mkDefault "${config.xdg.stateHome}/paperclip/${name}";
          })
        ]
      );
    };
    programs.paperclip = {
      enable = lib.mkEnableOption "Paperclip CLI client (no local server required)";
      package = lib.mkOption {
        type = lib.types.package;
        default = pkgs.paperclip;
        description = "Paperclip CLI package.";
      };
      apiUrl = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Default remote API URL.";
      };
      companyId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Default company ID (for example an exported deployment binding).";
      };
      apiKeyFile = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "^/[^[:space:]]+$");
        default = null;
        description = "Runtime CLI credential file; read directly by the client, never exported into its environment.";
      };
    };
  };
  config = {
    assertions = shared.assertions instances ++ [
      {
        assertion = instances == { } || pkgs.stdenv.isLinux;
        message = "Paperclip user services currently support Linux only.";
      }
      {
        assertion = client.apiKeyFile == null || !(lib.hasPrefix "/nix/store" client.apiKeyFile);
        message = "Paperclip CLI credentials must be runtime files outside the Nix store.";
      }
    ];
    home.packages = lib.optional client.enable clientPackage;
    systemd.user.services = lib.mapAttrs' (
      name: c:
      let
        rendered = shared.render name c;
      in
      lib.nameValuePair "paperclip-${name}" {
        Unit = {
          Description = "Paperclip (${name})";
          After = [ "network.target" ];
        };
        Install.WantedBy = [ "default.target" ];
        Service = {
          Type = "simple";
          ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p ${lib.escapeShellArg c.stateDir}";
          ExecStart = "${c.package}/bin/paperclip-deployment ${rendered.descriptorFile}";
          RuntimeDirectory = "paperclip-${name}";
          RuntimeDirectoryMode = "0700";
          Environment = [
            "PATH=${lib.makeBinPath c.extraPackages}"
            "XDG_RUNTIME_DIR=%t/paperclip-${name}"
            "HOME=${config.home.homeDirectory}"
          ];
          UMask = "0077";
          Restart = "on-failure";
          RestartSec = 5;
          KillMode = "mixed";
          TimeoutStopSec = 120;
          NoNewPrivileges = true;
        };
      }
    ) instances;
  };
}
