# Import the Paperclip Home Manager module alongside this client-only example.
{ config, ... }:
{
  programs.paperclip = {
    enable = true;
    apiUrl = "https://control.example.invalid";
    apiKeyFile = "${config.xdg.configHome}/paperclip/api-key";
  };
}
