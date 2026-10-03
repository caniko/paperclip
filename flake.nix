{
  description = "Paperclip development tooling — powered by Harbor";

  inputs = {
    harbor-js.url = "git+https://github.com/caniko/harbor-js.git?ref=trunk&rev=25935487646992db132557f526a8b00c460ccfdc";
    nixpkgs.follows = "harbor-js/nixpkgs";
  };

  outputs = {
    harbor-js,
    nixpkgs,
    ...
  }: {
    # Optional Nix integration. Packages and secret stores are supplied by the
    # consumer; these modules do not select a host or enable a controller.
    homeManagerModules.paperclip = import ./nix/modules/home-manager/paperclip.nix;
    nixosModules.homeManager = import ./nix/modules/nixos/home-manager.nix;
    lib.mkHermesWorkerEnv = import ./nix/lib/hermes-worker-env.nix;
    checks = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux"] (system: {
      hermes-worker-env = import ./nix/tests/hermes-worker-env.nix {
        pkgs = nixpkgs.legacyPackages.${system};
      };
    });
    devShells = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"] (system: let
      pkgs = nixpkgs.legacyPackages.${system};
      packageJson = ./package.json;
      pnpm = harbor-js.lib.node.mkPnpmPackage {
        inherit pkgs;
        version = harbor-js.lib.node.readPnpmVersion {inherit packageJson;};
        hash = "sha512-stwg4vxys+GISEWbNzWaMgZGY+VielHkx0ssKd2OjgSRSDw6u0B4nP1Xi/Ni+2uoJhsF8Dh9dnku1uI+o7G2oA==";
      };
    in {
      default = harbor-js.lib.node.mkNodeDevShell {
        inherit pkgs pnpm packageJson;
        extraPackages =
          [pkgs.git pkgs.openssh pkgs.lsof]
          ++ pkgs.lib.optionals pkgs.stdenv.isLinux [pkgs.procps];
      };
    });
  };
}
