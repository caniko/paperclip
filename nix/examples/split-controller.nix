# Staging contract only: remote-only currently fails closed before startup.
# Import the Paperclip NixOS module alongside this example on a host or test VM.
{ ... }:
{
  services.paperclip.instances.control = {
    enable = true;
    executionProfile = "remote-only";
    database.local.enable = true;
    auth = {
      secretFile = "/run/secrets/paperclip-signing";
      publicBaseUrl = "https://control.example.invalid";
    };
    encryptionKeyFile = "/run/secrets/paperclip-encryption";
    bootstrap = {
      email = "operator@example.invalid";
      name = "Operator";
      passwordFile = "/run/secrets/paperclip-bootstrap";
    };
    # This directory must exist before the service starts. The downstream
    # operator supplies every other private workspace/mount that needs hiding.
    inaccessiblePaths = [ "/srv/operator-workspaces" ];
    credentialFiles.gateway = "/run/secrets/paperclip-hermes-gateway";
    manifest = {
      version = 1;
      owner = "control";
      companies.example.fields.name = "Example company";
      agents.hermes = {
        company = "example";
        fields = {
          name = "Hermes worker";
          adapterType = "hermes_gateway";
          adapterConfig = {
            apiBaseUrl = "https://worker.example.invalid";
            paperclipApiUrl = "https://control.example.invalid";
            sessionKeyStrategy = "issue";
          };
        };
        credentials.apiKey = "gateway";
      };
    };
  };
}
