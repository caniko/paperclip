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
      deployments = lib.mkOption {
        type = lib.types.attrsOf (pkgs.formats.json { }).type;
        default = { };
        description = ''
          Nonsecret native deployment manifests owned by this person. Written to
          XDG configuration for inspection; never applied by Home Manager activation.
          The optional NixOS Home Manager bridge selects a declaration for a system
          controller. Native validation and resource ownership checks still apply.
          Credential references name system-provisioned credentials, not their values.
        '';
      };
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
    xdg.configFile = lib.mapAttrs' (
      name: manifest:
      assert lib.assertMsg (
        builtins.match "[a-z][a-z0-9_-]{0,62}" name != null
      ) "Paperclip deployment names must be native resource keys";
      lib.nameValuePair "paperclip/deployments/${name}.json" {
        source = (pkgs.formats.json { }).generate "paperclip-${name}-manifest.json" manifest;
      }
    ) client.deployments;
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
