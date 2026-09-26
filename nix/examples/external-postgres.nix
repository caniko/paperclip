# Same staging contract with operator-managed PostgreSQL. Runtime files contain
# separate connection URLs for the restricted application and migration roles.
{ lib, ... }:
{
  imports = [ ./split-controller.nix ];
  services.paperclip.instances.control.database = {
    local.enable = lib.mkForce false;
    mode = "postgres";
    urlFile = "/run/secrets/paperclip-database-runtime-url";
    migrationUrlFile = "/run/secrets/paperclip-database-migration-url";
  };
}
