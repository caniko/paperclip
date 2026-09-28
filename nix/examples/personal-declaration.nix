# NixOS configuration, with Paperclip and Home Manager system modules imported.
{ ... }: {
  imports = [ ../modules/nixos/home-manager.nix ];
  home-manager.users.operator = {
    programs.paperclip = {
      enable = true;
      apiUrl = "https://paperclip.example.test";
      apiKeyFile = "/run/user/1000/credentials/paperclip";
      deployments.work = {
        version = 1;
        owner = "operator-work";
        companies.example.fields = {
          name = "Example";
          budgetMonthlyCents = 1000;
        };
      };
    };
  };
  services.paperclip.homeManager.deployments.work = {
    user = "operator";
    deployment = "work";
  };
  # Configure instances.work's package, database, authentication and runtime
  # credentials separately at the system layer, then explicitly enable it.
}
