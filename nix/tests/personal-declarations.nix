{
  nixpkgsPath,
  homeManagerPath,
  system ? builtins.currentSystem,
  # Bound each evaluator independently on resource-constrained development hosts.
  selection ? null,
}: let
  pkgs = import nixpkgsPath {inherit system;};
  inherit (pkgs) lib;
  hm = import (homeManagerPath + "/lib") {inherit lib;};
  manifest = {
    version = 1;
    owner = "personal";
    companies.example.fields = {
      name = "Example company";
      description = null;
      budgetMonthlyCents = 1000;
    };
    agents.hermes = {
      company = "example";
      fields = {
        name = "Hermes";
        adapterType = "hermes_gateway";
      };
      credentials.apiKey = "gateway";
    };
  };
  home = extra:
    hm.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        ../modules/home-manager/paperclip.nix
        {
          home.username = "operator";
          home.homeDirectory = "/home/operator";
          home.stateVersion = "26.05";
          programs.paperclip.deployments.work = manifest;
        }
        extra
      ];
    };
  machine = extra:
    import (nixpkgsPath + "/nixos/lib/eval-config.nix") {
      inherit system;
      modules = [
        (homeManagerPath + "/nixos")
        ../modules/nixos/home-manager.nix
        # Model the consumer-owned system service schema; this fixture checks
        # declaration selection, not the external service's runtime behavior.
        {
          options.services.paperclip.instances = lib.mkOption {
            default = {};
            type = lib.types.attrsOf (lib.types.submodule {
              options = {
                enable = lib.mkEnableOption "fixture controller";
                manifest = lib.mkOption {
                  type = lib.types.attrs;
                  default = {};
                };
              };
            });
          };
        }
        {
          system.stateVersion = "26.05";
          boot.isContainer = true;
          users.users.operator.isNormalUser = true;
          home-manager.users.operator = {
            home.stateVersion = "26.05";
            programs.paperclip.deployments.work = manifest;
          };
          services.paperclip.homeManager.deployments.work = {
            user = "operator";
            deployment = "work";
          };
        }
        extra
      ];
    };
  assertionsPass = c: lib.all (a: a.assertion) c.assertions;
  evaluates = value: (builtins.tryEval (builtins.deepSeq value true)).success;
  # Synthetic packages exercise metadata only; none proves CLI runtime support.
  clientPackage = pkgs.runCommand "paperclip-client-evaluation-fixture" {} ''
    mkdir -p "$out"
  '';
  clientPackages = {
    supported = clientPackage // {supportsPaperclipApiKeyFile = true;};
    unsupported = clientPackage // {supportsPaperclipApiKeyFile = false;};
    absent = clientPackage;
    stringMarker = clientPackage // {supportsPaperclipApiKeyFile = "true";};
    pathString = builtins.toString clientPackage;
  };
  credentialClient = package:
    home {
      programs.paperclip = {
        enable = true;
        inherit package;
        apiUrl = "https://paperclip.example.org";
        companyId = "example-company";
        apiKeyFile = "/run/credentials/paperclip/api-key";
      };
    };
  personal = (home {}).config;
  controller =
    (home {
      programs.paperclip.package = clientPackages.supported;
      services.paperclip = {
        enable = true;
        instance = "work";
        operator.email = "operator@example.test";
        afterUnits = ["opencode.service"];
        credentialFiles.gateway = "/run/user/1000/paperclip/gateway";
      };
    }).config;
  oidcController =
    (home {
      programs.paperclip.package = clientPackages.supported;
      services.paperclip = {
        enable = true;
        instance = "work";
        operator.email = "operator@example.test";
        oidc = {
          discoveryUrl = "https://idm.example.test/oauth2/openid/paperclip/.well-known/openid-configuration";
          clientId = "paperclip";
        };
        operatorKeys.cli = "/run/user/1000/paperclip/operator-cli";
      };
    }).config;
  integrated = (machine {}).config;
  composed =
    (machine {
      home-manager.users.operator.programs.paperclip.deployments.work.companies.extra.fields.name = "Other";
    }).config;
  extended =
    (machine {
      services.paperclip.instances.work.manifest.companies.extra.fields.name = "Other";
    }).config;
  overridden =
    (machine {
      services.paperclip.instances.work.manifest = lib.mkForce (manifest // {owner = "other";});
    }).config;
  missing =
    (machine {
      services.paperclip.homeManager.deployments.work.deployment = lib.mkForce "missing";
    }).config;
  missingUser =
    (machine {
      services.paperclip.homeManager.deployments.work.user = lib.mkForce "missing";
    }).config;
  independent =
    (machine {
      services.paperclip.homeManager.deployments = lib.mkForce {};
      services.paperclip.instances.system.manifest = manifest;
    }).config;
  results = {
    standaloneHome = assertionsPass personal;
    standaloneActivation = evaluates (home {}).activationPackage.drvPath;
    enabledClient =
      evaluates (credentialClient clientPackages.supported).activationPackage.drvPath;
    unsupportedClientRejected =
      !(evaluates (credentialClient clientPackages.unsupported).activationPackage.drvPath);
    absentCapabilityRejected =
      !(evaluates (credentialClient clientPackages.absent).activationPackage.drvPath);
    stringCapabilityRejected =
      !(evaluates (credentialClient clientPackages.stringMarker).activationPackage.drvPath);
    pathStringClientRejected =
      !(evaluates (credentialClient clientPackages.pathString).activationPackage.drvPath);
    enabledWithoutCredentialAccepted =
      evaluates
      (home {
        programs.paperclip = {
          enable = true;
          package = clientPackages.absent;
        };
      }).activationPackage.drvPath;
    disabledWithCredentialAccepted =
      evaluates
      (home {
        programs.paperclip = {
          enable = false;
          package = clientPackages.absent;
          apiKeyFile = "/run/credentials/paperclip/api-key";
        };
      }).activationPackage.drvPath;
    manifestRoundTrip =
      builtins.fromJSON personal.xdg.configFile."paperclip/deployments/work.json".text == manifest;
    noPersonalService = !(personal.systemd.user.services ? paperclip-work);
    userController =
      assertionsPass controller
      && lib.any (lib.hasInfix "/bin/paperclip-deployment ") (lib.toList controller.systemd.user.services.paperclip-work.Service.ExecStart)
      && controller.systemd.user.services.paperclip-work.Service.UMask == "0077"
      && controller.systemd.user.services.paperclip-work.Service.KillMode == "mixed"
      && builtins.elem "opencode.service" controller.systemd.user.services.paperclip-work.Unit.After
      && builtins.elem "XDG_CONFIG_HOME=/home/operator/.config" controller.systemd.user.services.paperclip-work.Service.Environment
      && controller.services.paperclip.manifest == manifest
      && controller.services.paperclip.credentialFiles == {gateway = "/run/user/1000/paperclip/gateway";}
      && controller.services.paperclip.authSecretFile == "/home/operator/.local/share/paperclip/credentials/auth";
    oidcAndOperatorKeys =
      assertionsPass oidcController
      && evaluates oidcController.xdg.configFile."paperclip/work/deployment.json".source.drvPath;
    storeOperatorKeyRejected =
      !(evaluates
        (home {
          programs.paperclip.package = clientPackages.supported;
          services.paperclip = {
            enable = true;
            operator.email = "operator@example.test";
            operatorKeys.cli = "${builtins.storeDir}/public-key";
          };
        }).activationPackage.drvPath);
    storeControllerCredentialRejected =
      !(evaluates
        (home {
          programs.paperclip.package = clientPackages.supported;
          services.paperclip = {
            enable = true;
            operator.email = "operator@example.test";
            authSecretFile = "${builtins.storeDir}/public-auth";
          };
        }).activationPackage.drvPath);
    storeControllerCredentialFileRejected =
      !(evaluates
        (home {
          programs.paperclip.package = clientPackages.supported;
          services.paperclip = {
            enable = true;
            operator.email = "operator@example.test";
            credentialFiles.gateway = "${builtins.storeDir}/public-gateway";
          };
        }).activationPackage.drvPath);
    invalidKeyRejected =
      !(
        evaluates
        (home {
          programs.paperclip.deployments."../escape" = manifest;
        }).activationPackage.drvPath
      );
    storeCredentialRejected =
      !(
        evaluates
        (home {
          programs.paperclip.apiKeyFile = "${builtins.storeDir}/not-a-runtime-key";
        }).activationPackage.drvPath
      );
    runtimeCredentialAccepted =
      assertionsPass
      (home {
        programs.paperclip.apiKeyFile = "/run/credentials/paperclip/api-key";
      }).config;
    integratedHome = assertionsPass integrated;
    exactSelection = integrated.services.paperclip.instances.work.manifest == manifest;
    composedSelection =
      assertionsPass composed
      && composed.services.paperclip.instances.work.manifest
      == (manifest // {companies = manifest.companies // {extra.fields.name = "Other";};});
    controllerRemainsDisabled = !integrated.services.paperclip.instances.work.enable;
    extensionRejected = !(assertionsPass extended);
    overrideRejected = !(assertionsPass overridden);
    missingDeclarationRejected = !(evaluates missing.services.paperclip.instances.work.manifest);
    missingUserRejected = !(evaluates missingUser.services.paperclip.instances.work.manifest);
    directSystemDeclaration =
      assertionsPass independent && independent.services.paperclip.instances.system.manifest == manifest;
  };
  selected =
    if selection == null
    then results
    else lib.getAttrs selection results;
in
  builtins.mapAttrs (
    name: value:
      assert lib.assertMsg value "Paperclip personal declaration fixture failed: ${name}"; value
  )
  selected
