{
  pkgs,
  self,
  home-manager,
  nixpkgs,
}:
let
  inherit (pkgs) lib;
  enabled = {
    one = {
      enable = true;
      port = 3101;
      database = {
        embeddedPort = 54331;
        embeddedPasswordFile = "/run/keys/one-db";
      };
      auth = {
        enable = false;
        secretFile = "/run/keys/one-auth";
      };
    };
    two = {
      enable = true;
      port = 3102;
      database = {
        embeddedPort = 54332;
        embeddedPasswordFile = "/run/keys/two-db";
      };
      auth = {
        enable = false;
        secretFile = "/run/keys/two-auth";
      };
    };
    disabled = {
      enable = false;
    };
  };
  system =
    extra:
    nixpkgs.lib.nixosSystem {
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        self.nixosModules.default
        {
          system.stateVersion = "26.05";
          boot.isContainer = true;
          services.paperclip.instances = enabled;
        }
        extra
      ];
    };
  machine = system { };
  home = home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      self.homeManagerModules.default
      {
        home.username = "operator";
        home.homeDirectory = "/home/operator";
        home.stateVersion = "26.05";
        services.paperclip.instances = enabled;
        programs.paperclip.enable = true;
      }
    ];
  };
  valid = c: lib.all (a: a.assertion) c.assertions;
  explain =
    c: lib.concatMapStringsSep "\n" (a: a.message) (lib.filter (a: !a.assertion) c.assertions);
  invalidPort = system { services.paperclip.instances.two.port = lib.mkForce 3101; };
  invalidPath = system {
    services.paperclip.instances.two.stateDir = "/var/lib/paperclip-one/child";
  };
  publicLoopback = system { services.paperclip.instances.one.publicExposure = true; };
  sharedCredential = system {
    services.paperclip.instances.two.auth.secretFile = lib.mkForce "/run/keys/one-auth";
  };
  sharedDatabase = system {
    services.paperclip.instances.two.database.dataDir = "/var/lib/paperclip-one/instances/one/db";
  };
  confined = system {
    services.paperclip.instances.one.inaccessiblePaths = [ "/srv/operator-workspaces" ];
  };
  splitController = system { imports = [ ../examples/split-controller.nix ]; };
  splitClient = home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      self.homeManagerModules.default
      ../examples/split-client.nix
      {
        home.username = "operator";
        home.homeDirectory = "/home/operator";
        home.stateVersion = "26.05";
      }
    ];
  };
in
assert lib.assertMsg (valid machine.config) (explain machine.config);
assert lib.assertMsg (valid home.config) (explain home.config);
assert lib.assertMsg (valid splitController.config) (explain splitController.config);
assert lib.assertMsg (valid splitClient.config) (explain splitClient.config);
assert splitClient.config.services.paperclip.instances == { };
assert
  splitController.config.services.paperclip.instances.control.executionProfile == "remote-only";
assert builtins.deepSeq splitClient.activationPackage.drvPath true;
assert !(valid invalidPort.config);
assert !(valid invalidPath.config);
assert !(valid publicLoopback.config);
assert !(valid sharedCredential.config);
assert !(valid sharedDatabase.config);
assert lib.elem "/srv/operator-workspaces"
  confined.config.systemd.services.paperclip-one.serviceConfig.InaccessiblePaths;
assert lib.elem "-/nix/var/nix/daemon-socket"
  confined.config.systemd.services.paperclip-one.serviceConfig.InaccessiblePaths;
assert !(machine.config.systemd.services ? paperclip-disabled);
assert !(home.config.systemd.user.services ? paperclip-disabled);
assert
  machine.config.systemd.services.paperclip-one.serviceConfig.User
  != machine.config.systemd.services.paperclip-two.serviceConfig.User;
assert builtins.deepSeq home.activationPackage.drvPath true;
pkgs.runCommand "paperclip-module-evaluation" { } ''
  test -n ${lib.escapeShellArg home.config.systemd.user.services.paperclip-one.Service.ExecStart}
  test -n ${lib.escapeShellArg machine.config.systemd.services.paperclip-one.serviceConfig.ExecStart}
  touch "$out"
''
