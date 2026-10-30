{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.paperclip;
  json = pkgs.formats.json {};
  runtimePath = lib.types.strMatching "^/[^[:space:]]+$";
  state = "${cfg.dataDir}/instances/${cfg.instance}";
  credentials = "${cfg.dataDir}/credentials";
  publicHost = let
    match = builtins.match "[a-z]+://([^/:?#[]+).*" cfg.publicBaseUrl;
  in
    if match == null
    then ""
    else builtins.head match;
  application = json.generate "paperclip-${cfg.instance}-config.json" {
    "$meta" = {
      version = 1;
      updatedAt = "1970-01-01T00:00:00.000Z";
      source = "configure";
    };
    database = {
      mode = "embedded-postgres";
      embeddedPostgresDataDir = "${state}/db";
      embeddedPostgresPort = cfg.databasePort;
      backup = {
        enabled = true;
        intervalMinutes = 60;
        retentionDays = 30;
        dir = "${state}/data/backups";
      };
    };
    logging = {
      mode = "file";
      logDir = "${state}/logs";
    };
    server = {
      deploymentMode = "authenticated";
      exposure = "private";
      bind = "loopback";
      host = "127.0.0.1";
      inherit (cfg) port;
      allowedHostnames = lib.unique (["127.0.0.1" "localhost"] ++ lib.optional (publicHost != "") publicHost ++ cfg.allowedHostnames);
      serveUi = true;
    };
    auth =
      {
        baseUrlMode = "explicit";
        inherit (cfg) publicBaseUrl;
        disableSignUp = true;
      }
      // lib.optionalAttrs (cfg.oidc != null) {
        oidc = {
          inherit (cfg.oidc) providerId displayName discoveryUrl clientId;
        };
      };
    storage = {
      provider = "local_disk";
      localDisk.baseDir = "${state}/data/storage";
    };
    secrets = {
      provider = "local_encrypted";
      localEncrypted.keyFilePath = cfg.encryptionKeyFile;
    };
  };
  descriptor = json.generate "paperclip-${cfg.instance}-deployment.json" {
    version = 1;
    home = cfg.dataDir;
    inherit (cfg) instance;
    executionProfile = "trusted-local";
    apiUrl = cfg.localApiUrl;
    configFile = application;
    manifestFile = json.generate "paperclip-${cfg.instance}-manifest.json" (cfg.manifest
      // lib.optionalAttrs (cfg.operatorKeys != {}) {
        operatorKeys = lib.mapAttrs (key: _: {credential = "operator-${key}";}) cfg.operatorKeys;
      });
    credentialFiles = cfg.credentialFiles // lib.mapAttrs' (key: file: lib.nameValuePair "operator-${key}" file) cfg.operatorKeys;
    serverCredentials =
      {
        auth = cfg.authSecretFile;
        encryption = cfg.encryptionKeyFile;
      }
      // lib.optionalAttrs (cfg.oidc != null) {oidc = cfg.oidc.secretFile;};
    embedded = {
      user = "paperclip";
      database = "paperclip";
      passwordFile = cfg.databasePasswordFile;
    };
    bootstrap = {
      inherit (cfg.operator) email name;
      passwordFile = cfg.operator.passwordFile;
    };
  };
in {
  options.services.paperclip = {
    enable = lib.mkEnableOption "an authenticated, persistent Paperclip user service with embedded PostgreSQL";
    package = lib.mkOption {
      type = lib.types.package;
      default = config.programs.paperclip.package;
      description = "Package providing paperclip-deployment and the production UI.";
    };
    instance = lib.mkOption {
      type = lib.types.strMatching "[a-z][a-z0-9_-]{0,30}";
      default = "default";
      description = "Stable native instance identity.";
    };
    dataDir = lib.mkOption {
      type = runtimePath;
      default = "${config.xdg.dataHome}/paperclip";
      description = "Private persistent application home.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 3100;
      description = "Loopback API and UI port.";
    };
    databasePort = lib.mkOption {
      type = lib.types.port;
      default = 54329;
      description = "Dedicated embedded PostgreSQL loopback port.";
    };
    publicBaseUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:${toString cfg.port}";
      description = "Canonical browser and agent URL.";
    };
    allowedHostnames = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "Extra hostnames accepted in the Host header. Loopback names and the publicBaseUrl hostname are always allowed.";
    };
    localApiUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:${toString cfg.port}";
      description = "API URL that local agents and runners receive as PAPERCLIP_API_URL, independent of publicBaseUrl.";
    };
    manifest = lib.mkOption {
      inherit (json) type;
      default =
        config.programs.paperclip.deployments.${
          cfg.instance
        } or {
          version = 1;
          owner = cfg.instance;
          companies = {};
        };
      description = "Native resource declarations reconciled before the listener opens.";
    };
    credentialFiles = lib.mkOption {
      type = lib.types.attrsOf runtimePath;
      default = {};
      example = {gateway = "/run/user/1000/paperclip/gateway";};
      description = "Protected runtime files for credential aliases bound by the manifest's agents, environments, and task bridges.";
    };
    oidc = lib.mkOption {
      default = null;
      description = "OpenID Connect board login. Only a user with the same email can sign in; the callback is `<publicBaseUrl>/api/auth/callback/<providerId>`.";
      type = lib.types.nullOr (lib.types.submodule {
        options = {
          providerId = lib.mkOption {
            type = lib.types.strMatching "[a-z][a-z0-9-]{0,31}";
            default = "kanidm";
            description = "Provider identifier used in the callback path.";
          };
          displayName = lib.mkOption {
            type = lib.types.str;
            default = "Kanidm";
            description = "Name shown on the sign-in button.";
          };
          discoveryUrl = lib.mkOption {
            type = lib.types.str;
            description = "OpenID Connect discovery document URL.";
          };
          clientId = lib.mkOption {
            type = lib.types.str;
            description = "OAuth client identifier.";
          };
          secretFile = lib.mkOption {
            type = runtimePath;
            default = "${credentials}/oidc";
            description = "Protected runtime file holding the OAuth client secret.";
          };
        };
      });
    };
    operatorKeys = lib.mkOption {
      type = lib.types.attrsOf runtimePath;
      default = {};
      example = {cli = "/run/user/1000/paperclip/operator-cli";};
      description = "Board API keys for the initial operator, by declaration key. Each runtime file holds a token of at least 32 characters; removing an entry revokes its key and rotation needs a new entry.";
    };
    authSecretFile = lib.mkOption {
      type = runtimePath;
      default = "${credentials}/auth";
      description = "Protected runtime signing credential, at least 32 characters.";
    };
    encryptionKeyFile = lib.mkOption {
      type = runtimePath;
      default = "${credentials}/encryption";
      description = "Protected persistent local-encryption key.";
    };
    databasePasswordFile = lib.mkOption {
      type = runtimePath;
      default = "${credentials}/database";
      description = "Protected embedded PostgreSQL password, at least 16 characters.";
    };
    operator = {
      email = lib.mkOption {
        type = lib.types.str;
        description = "Initial administrator email; native bootstrap preserves an existing administrator.";
      };
      name = lib.mkOption {
        type = lib.types.str;
        default = "Operator";
        description = "Initial administrator display name.";
      };
      passwordFile = lib.mkOption {
        type = runtimePath;
        default = "${credentials}/bootstrap";
        description = "Protected initial password file; reconciliation does not rotate an existing account.";
      };
    };
    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [];
      description = "Additional executables available to local adapters.";
    };
    afterUnits = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "User units requested and ordered before the controller.";
    };
    deploymentFile = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = descriptor;
      description = "Generated native deployment descriptor, without credential values.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !lib.hasPrefix "/nix/store/" cfg.dataDir;
        message = "Paperclip persistent state must be outside the Nix store.";
      }
      {
        assertion = lib.all (file: !lib.hasPrefix "/nix/store/" file) ([cfg.authSecretFile cfg.encryptionKeyFile cfg.databasePasswordFile cfg.operator.passwordFile] ++ lib.attrValues cfg.credentialFiles ++ lib.attrValues cfg.operatorKeys ++ lib.optional (cfg.oidc != null) cfg.oidc.secretFile);
        message = "Paperclip credentials must be runtime files outside the Nix store.";
      }
      {
        assertion = lib.all (key: builtins.match "[a-z][a-z0-9_-]{0,53}" key != null && !(cfg.credentialFiles ? "operator-${key}")) (lib.attrNames cfg.operatorKeys);
        message = "Paperclip operator key names must be 1-54 characters and must not collide with a credentialFiles alias named operator-<name>.";
      }
      {
        assertion = cfg.port != cfg.databasePort;
        message = "Paperclip controller and embedded database need different ports.";
      }
    ];
    xdg.configFile."paperclip/${cfg.instance}/deployment.json".source = descriptor;
    systemd.user.tmpfiles.rules = ["d ${cfg.dataDir} 0700 - - -" "d ${credentials} 0700 - - -"];
    systemd.user.services."paperclip-${cfg.instance}" = {
      Unit = {
        Description = "Paperclip (${cfg.instance})";
        After = ["network.target"] ++ cfg.afterUnits;
        Wants = cfg.afterUnits;
      };
      Service = {
        Type = "exec";
        ExecStartPre = "${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg cfg.dataDir}";
        ExecStart = "${cfg.package}/bin/paperclip-deployment ${descriptor}";
        ExecStartPost = "${pkgs.curl}/bin/curl --fail --silent --output /dev/null --retry 30 --retry-delay 1 --retry-connrefused --max-time 2 http://127.0.0.1:${toString cfg.port}/api/health";
        WorkingDirectory = config.home.homeDirectory;
        Environment = lib.mapAttrsToList (name: value: "${name}=${value}") {
          HOME = config.home.homeDirectory;
          USER = config.home.username;
          LOGNAME = config.home.username;
          XDG_CONFIG_HOME = config.xdg.configHome;
          XDG_DATA_HOME = config.xdg.dataHome;
          XDG_STATE_HOME = config.xdg.stateHome;
          XDG_CACHE_HOME = config.xdg.cacheHome;
          XDG_RUNTIME_DIR = "%t";
          PATH = lib.makeBinPath ([cfg.package] ++ cfg.extraPackages) + ":${config.home.profileDirectory}/bin:/run/current-system/sw/bin";
        };
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 5;
        KillMode = "mixed";
        TimeoutStartSec = 120;
        TimeoutStopSec = 120;
        NoNewPrivileges = true;
        MemoryAccounting = true;
        MemoryMax = "2G";
        TasksMax = 256;
      };
      Install.WantedBy = ["default.target"];
    };
  };
}
