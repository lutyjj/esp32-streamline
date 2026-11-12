{
  description = "ESP32 StreamLine host development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # The host prerequisites the Makefiles run outside containers. Build
      # toolchains stay pinned in each component's image, and the container
      # runtime stays a system service.
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.gnumake
            pkgs.espflash
            # Serial capture and the device smoke run tools modules on the host.
            (pkgs.python3.withPackages (python: [ python.requests ]))
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);

      checks = forAllSystems (pkgs: {
        format = pkgs.runCommand "flake-format" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
          nixfmt --check ${./flake.nix}
          touch $out
        '';
      });
    };
}
