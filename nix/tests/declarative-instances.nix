{
  pkgs,
  self,
  home-manager,
}:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.paperclip;
  manifest = owner: {
    version = 1;
    inherit owner;
    companies.example.fields = {
      name = "Native fixture";
      budgetMonthlyCents = 10000;
    };
    projects.main = {
      company = "example";
      fields.name = "Main";
    };
  };
in
pkgs.testers.nixosTest {
  name = "paperclip-declarative-instances";
  nodes.machine = { lib, ... }: {
    imports = [
      self.nixosModules.default
      home-manager.nixosModules.home-manager
    ];
    virtualisation = {
      memorySize = 8192;
      cores = 4;
      diskSize = 24576;
    };
    services.paperclip.instances = {
      closed = {
        enable = true;
        port = 3114;
        executionProfile = "remote-only";
        auth.secretFile = "/run/must-not-be-read/signing";
        database = {
          mode = "postgres";
          urlFile = "/run/must-not-be-read/database";
        };
      };
      embedded = {
        enable = true;
        port = 3111;
        database = {
          embeddedPort = 54411;
          embeddedPasswordFile = "/var/lib/paperclip-embedded/credentials/database";
        };
        auth = {
          secretFile = "/var/lib/paperclip-embedded/credentials/auth";
          publicBaseUrl = "http://localhost:3111";
        };
        bootstrap = {
          email = "operator@example.test";
          name = "Fixture operator";
          passwordFile = "/var/lib/paperclip-embedded/credentials/password";
        };
        manifest = manifest "embedded";
      };
      external = {
        enable = true;
        port = 3112;
        database.local.enable = true;
        inaccessiblePaths = [ "/srv/operator-workspaces" ];
        auth = {
          secretFile = "/var/lib/paperclip-external/credentials/auth";
          publicBaseUrl = "http://localhost:3112";
        };
        bootstrap = {
          email = "operator@example.test";
          name = "Fixture operator";
          passwordFile = "/var/lib/paperclip-external/credentials/password";
        };
        manifest = manifest "external";
      };
    };
    users.users.operator = {
      isNormalUser = true;
      linger = true;
    };
    home-manager.users.operator = { ... }: {
      imports = [ self.homeManagerModules.default ];
      home.stateVersion = "26.05";
      programs.paperclip.enable = true;
      services.paperclip.instances.home = {
        enable = true;
        port = 3113;
        auth = {
          enable = false;
          secretFile = "/home/operator/auth-secret";
        };
        database = {
          embeddedPort = 54413;
          embeddedPasswordFile = "/home/operator/database-password";
        };
        manifest = manifest "home";
      };
    };
    systemd.services.paperclip-fixture-credentials = {
      before = [
        "paperclip-embedded.service"
        "paperclip-external.service"
        "user@1000.service"
      ];
      requiredBy = [
        "paperclip-embedded.service"
        "paperclip-external.service"
        "user@1000.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        umask 0077
        install -d -m 0755 /srv/operator-workspaces
        printf 'private operator workspace\n' > /srv/operator-workspaces/probe
        chmod 0644 /srv/operator-workspaces/probe
        for instance in embedded external; do
          root=/var/lib/paperclip-$instance
          install -d -m 0700 -o paperclip-$instance -g paperclip-$instance "$root/credentials"
          for key in auth password database; do
            test -f "$root/credentials/$key" || ${pkgs.openssl}/bin/openssl rand -hex 32 > "$root/credentials/$key"
            chown paperclip-$instance:paperclip-$instance "$root/credentials/$key"
          done
        done
        test -f /home/operator/database-password || ${pkgs.openssl}/bin/openssl rand -hex 32 > /home/operator/database-password
        chown operator:users /home/operator/database-password
        test -f /home/operator/auth-secret || ${pkgs.openssl}/bin/openssl rand -hex 32 > /home/operator/auth-secret
        chown operator:users /home/operator/auth-secret
      '';
    };
    systemd.services.paperclip-embedded.serviceConfig.Restart = lib.mkForce "no";
    systemd.services.paperclip-external.serviceConfig.Restart = lib.mkForce "no";
    systemd.services.paperclip-closed.serviceConfig.Restart = lib.mkForce "no";
    systemd.sockets.paperclip-fixture-docker = {
      wantedBy = [ "sockets.target" ];
      before = [ "paperclip-external.service" ];
      listenStreams = [ "/run/docker.sock" ];
      socketConfig.SocketMode = "0666";
    };
    systemd.services.paperclip-fixture-docker.serviceConfig.ExecStart =
      "${pkgs.coreutils}/bin/sleep infinity";
    environment.systemPackages = [
      package
      pkgs.curl
      pkgs.jq
      pkgs.python3
    ];
  };
  testScript = ''
    import json
    start_all()
    machine.wait_until_succeeds("systemctl is-failed paperclip-closed.service")
    machine.succeed("journalctl -u paperclip-closed --no-pager | grep 'remote-only execution is not yet qualified'")
    machine.fail("curl -fsS --max-time 2 http://localhost:3114/api/health")
    machine.fail("test -e /var/lib/paperclip-closed/instances/closed/deployment-bindings.json")
    for port in [3111, 3112, 3113]:
        try:
            machine.wait_for_open_port(port, timeout=120)
        except Exception:
            print(machine.succeed("journalctl -b --no-pager -u paperclip-embedded -u paperclip-external -u paperclip-external-database -u home-manager-operator"))
            print(machine.succeed("journalctl -b --no-pager _UID=1000"))
            raise
        # The listener binds before startup recovery completes. Readiness, not
        # merely a successful TCP connection, is the acceptance boundary.
        machine.wait_until_succeeds(f"curl -fsS http://localhost:{port}/api/health | jq -e '.status == \"ok\"'", timeout=120)
    for name in ["embedded", "external"]:
        machine.wait_for_unit(f"paperclip-{name}.service")
    machine.succeed("runuser -u operator -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active paperclip-home.service")
    paths = {
        "embedded": "/var/lib/paperclip-embedded/instances/embedded/deployment-bindings.json",
        "external": "/var/lib/paperclip-external/instances/external/deployment-bindings.json",
        "home": "/home/operator/.local/state/paperclip/home/instances/home/deployment-bindings.json",
    }
    bindings = {name: machine.succeed(f"cat {path}") for name, path in paths.items()}
    ids = [json.loads(value)["bindings"]["company/example"] for value in bindings.values()]
    assert len(set(ids)) == 3, "instances must have separate databases and identities"
    # Password authentication uses the locally bootstrapped account, with no
    # unauthenticated setup endpoint or password on the command line.
    for name, port in [("embedded", 3111), ("external", 3112)]:
        machine.succeed(f"jq -n --rawfile password /var/lib/paperclip-{name}/credentials/password '{{email: \"operator@example.test\", password: ($password | rtrimstr(\"\\n\"))}}' > /run/login.json")
        machine.succeed(f"curl -fsS -H 'Content-Type: application/json' -H 'Origin: http://localhost:{port}' --data-binary @/run/login.json http://localhost:{port}/api/auth/sign-in/email | jq -e '.user.email == \"operator@example.test\"'")
        machine.fail(f"curl -fsS http://localhost:{port}/api/companies")
        machine.succeed(f"pid=$(systemctl show paperclip-{name} -p MainPID --value); ! tr '\\0' '\\n' < /proc/$pid/environ | grep -E '^(BETTER_AUTH_SECRET|DATABASE_URL|DATABASE_MIGRATION_URL)='")
    # Real runtime role cannot perform schema changes; migration role can.
    # The file is readable to this UID outside the service. Inside the actual
    # service mount namespace even read access is denied (not merely writes).
    machine.succeed("runuser -u paperclip-external -- cat /srv/operator-workspaces/probe")
    pid = machine.succeed("systemctl show paperclip-external -p MainPID --value").strip()
    machine.fail(f"nsenter -t {pid} -m -- runuser -u paperclip-external -- cat /srv/operator-workspaces/probe")
    machine.fail(f"nsenter -t {pid} -m -- runuser -u paperclip-external -- ls /nix/var/nix/daemon-socket")
    for socket_path in ["/run/docker.sock", "/nix/var/nix/daemon-socket/socket"]:
        socket_probe = f"python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(\"{socket_path}\")'"
        machine.succeed(f"runuser -u paperclip-external -- {socket_probe}")
        machine.fail(f"nsenter -t {pid} -m -- runuser -u paperclip-external -- {socket_probe}")
    machine.fail("runuser -u paperclip-external -- psql 'postgresql://paperclip-external@localhost/paperclip_external?host=/run/postgresql' -c 'create table runtime_must_not_create (id int)'")
    external_command = machine.succeed("systemctl cat paperclip-external | sed -n 's/^ExecStart=//p'").strip()
    machine.succeed(f"runuser -u paperclip-external -- {external_command} check")
    machine.fail(f"runuser -u paperclip-external -- {external_command} apply")
    machine.succeed("systemctl stop paperclip-external.service")
    machine.succeed(f"runuser -u paperclip-external -- {external_command} apply")
    for name in ["embedded", "external"]:
        machine.succeed(f"systemctl restart paperclip-{name}.service")
    for port in [3111, 3112]:
        machine.wait_for_open_port(port, timeout=120)
    for name, path in paths.items():
        assert machine.succeed(f"cat {path}") == bindings[name], "restart changed stable identities"
    machine.shutdown()
    machine.start()
    for port in [3111, 3112, 3113]:
        machine.wait_for_open_port(port, timeout=600)
    for name, path in paths.items():
        assert machine.succeed(f"cat {path}") == bindings[name], "reboot changed stable identities"
  '';
}
